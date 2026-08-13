/**
 * One run, in full — the page every row in every other view points at.
 *
 * A console where the deepest thing you can do is read a table is a report, not an application.
 * This is the drill-down: every confidence axis rather than the overall, both geography axes
 * with what was REQUESTED beside what was OBSERVED, every vital, the checks that failed, and the
 * two things that make a run reproducible — the seed and the evidence id.
 *
 * The seed is given its own field with the command that uses it. A run that cannot be repeated
 * is a claim rather than a measurement, and the difference between the two is one copy-paste.
 */
import type { JSX } from "react";
import type { DashboardView, RunView } from "../types.ts";
import { MeasuredValue, Verdict } from "../Measured.tsx";

export function RunDetail({ view, runId }: { view: DashboardView; runId: string }): JSX.Element {
  const run = view.runs.find((r) => r.runId === runId);
  if (run === undefined) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>No such run.</strong>
          <code>{runId}</code> is not in this dashboard. It may predate the last{" "}
          <code>geoqa dashboard build</code>.
        </div>
      </div>
    );
  }

  const sameTarget = view.runs.filter((r) => r.target === run.target && r.journeyId === run.journeyId);

  return (
    <>
      <div className="head">
        <h2>{run.journeyId}</h2>
        <p className="hint">
          <Verdict value={run.verdict} /> &nbsp;{run.target} &nbsp;·&nbsp; {run.profileId} &nbsp;·&nbsp;{" "}
          {run.startedAt.replace("T", " ").slice(0, 19)}
        </p>
      </div>

      <div className="gauges">
        <Cell k="Verdict" v={<Verdict value={run.verdict} />} sub={verdictMeans(run.verdict)} />
        <Cell k="Findings" v={<span style={{ color: run.findings.total > 0 ? "var(--fail)" : undefined }}>{run.findings.total}</span>} sub={severitySummary(run)} />
        <Cell k="Confidence" v={<MeasuredValue value={run.confidence.overall} />} sub="how far this run's readings can be trusted" />
        <Cell k="Duration" v={<span className="measured">{Math.round(run.durationMs / 100) / 10}s</span>} sub="wall clock, including human pacing" />
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Failing checks</h3>
          <p className="hint">The journey steps that produced a finding.</p>
        </div>
        {run.findings.labels.length === 0 ? (
          <div className="empty">
            <strong>No check failed.</strong>
            Every assertion in {run.journeyId} passed against this page, from this market.
          </div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Also failed in</th>
                </tr>
              </thead>
              <tbody>
                {run.findings.labels.map((label) => {
                  const elsewhere = sameTarget.filter((r) => r.runId !== run.runId && r.findings.labels.includes(label));
                  return (
                    <tr key={label}>
                      <td>{label}</td>
                      <td className="dim">
                        {/* Whether this is a one-off or a standing defect, answered on the page
                            where somebody is deciding whether to act on it. */}
                        {elsewhere.length === 0
                          ? `no other run of ${run.journeyId} on this page`
                          : `${elsewhere.length} other run(s) of ${run.journeyId} on this page`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Geography</h3>
          <p className="hint">
            Two axes, verified separately: the NETWORK the request left from, and the BROWSER
            environment the page saw. A proxy in Oslo serving a browser in en-US is a real and
            common failure, and only checking both catches it.
          </p>
        </div>
        <div className="scroll">
          <table>
            <tbody>
              <Row k="Requested" v={<span className="measured">{run.geo.requested}</span>} />
              <Row k="Observed" v={<span className="measured">{run.geo.observed}</span>} />
              <Row k="Country" v={<Verdict value={run.geo.country} />} />
              <Row k="City" v={<Verdict value={run.geo.city} />} />
              <Row
                k="Egress held"
                v={<Verdict value={run.geo.egressHeld} />}
                note="whether the exit IP stayed the same for the whole run — a rotation mid-journey means nothing observed can be attributed to the site"
              />
              <Row k="Databases agree" v={<Verdict value={run.geo.agreement} />} note="a second IP-geo database's reading of the same IP" />
              <Row k="Latency" v={<MeasuredValue value={run.latency} />} note="to the identity endpoint, from inside the market" />
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Confidence, by axis</h3>
          <p className="hint">
            The overall figure is the weakest link, not an average — one unverified axis caps what
            the whole run may claim.
          </p>
        </div>
        <div className="scroll">
          <table>
            <tbody>
              <Row k="Geo" v={<MeasuredValue value={run.confidence.geo} />} />
              <Row k="Browser" v={<MeasuredValue value={run.confidence.browser} />} />
              <Row k="Journey" v={<MeasuredValue value={run.confidence.journey} />} />
              <Row k="Evidence" v={<MeasuredValue value={run.confidence.evidence} />} />
              <Row k="Search" v={<MeasuredValue value={run.confidence.search} />} note="null for almost every run — nobody looked, which is not the same as a bad score" />
              <tr>
                <td className="dim">Overall</td>
                <td>
                  <MeasuredValue value={run.confidence.overall} />
                </td>
                {/* Naming the axis that capped the run turns a number into an instruction. */}
                <td className="hint" style={{ whiteSpace: "normal" }}>
                  {weakest(run)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Web vitals</h3>
          <p className="hint">Measured in this market, through a real browser — not modelled.</p>
        </div>
        <div className="scroll">
          <table>
            <tbody>
              <Row k="LCP" v={<MeasuredValue value={run.vitals.lcp} />} />
              {/* The note is CONDITIONAL. "0 is a real reading" printed beside `not measured`
                  explains a value that is not on screen, which is worse than saying nothing. */}
              <Row
                k="CLS"
                v={<MeasuredValue value={run.vitals.cls} />}
                note={run.vitals.cls.measured && run.vitals.cls.value === 0 ? "a REAL reading: nothing moved, which is the best possible answer" : ""}
              />
              <Row k="TTFB" v={<MeasuredValue value={run.vitals.ttfb} />} />
              <Row k="INP" v={<MeasuredValue value={run.vitals.inp} />} note="does not exist until something is clicked" />
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Reproduce</h3>
          <p className="hint">A run that cannot be repeated is a claim rather than a measurement.</p>
        </div>
        <div className="panel-body">
          <p className="hint" style={{ marginBottom: "var(--s-3)" }}>
            Seed <code>{run.seed}</code> replays this run's pacing and optional steps exactly.
          </p>
          <code style={{ display: "block", padding: "var(--s-4)", border: "1px solid var(--grid)", overflowX: "auto" }}>
            geoqa journey run --url {run.target} --profile {run.profileId} --journey {run.journeyId} --seed {run.seed}
          </code>
          <p className="hint" style={{ marginTop: "var(--s-3)" }}>
            Evidence:{" "}
            {run.evidenceId === null ? (
              <span className="unmeasured" title="no evidence package was written for this run">
                none written
              </span>
            ) : (
              <code>{run.evidenceId}</code>
            )}
          </p>
        </div>
      </div>
    </>
  );
}

function Cell({ k, v, sub }: { k: string; v: JSX.Element; sub: string }): JSX.Element {
  return (
    <div className="gauge">
      <div className="gauge-k">{k}</div>
      <div className="gauge-v">{v}</div>
      <div className="gauge-sub">{sub}</div>
    </div>
  );
}

function Row({ k, v, note }: { k: string; v: JSX.Element; note?: string }): JSX.Element {
  return (
    <tr>
      <td style={{ width: 180 }} className="dim">
        {k}
      </td>
      <td style={{ width: 200 }}>{v}</td>
      <td className="hint" style={{ whiteSpace: "normal" }}>
        {note ?? ""}
      </td>
    </tr>
  );
}

/**
 * Which axis capped the run, said in words.
 *
 * `overall` is the weakest link rather than an average, so a run at 39 is not 39% good — it is
 * one axis at 0 dragging four at 100. Printing the number without the reason leaves a reader to
 * reconstruct the rule, and most will assume an average.
 */
function weakest(run: RunView): string {
  const axes: [string, number][] = [
    ["geo", run.confidence.geo.measured ? run.confidence.geo.value : 100],
    ["browser", run.confidence.browser.measured ? run.confidence.browser.value : 100],
    ["journey", run.confidence.journey.measured ? run.confidence.journey.value : 100],
    ["evidence", run.confidence.evidence.measured ? run.confidence.evidence.value : 100],
  ];
  const low = axes.reduce((a, b) => (b[1] < a[1] ? b : a));
  return low[1] >= 100 ? "every axis verified" : `capped by ${low[0]}, at ${low[1]}`;
}

const verdictMeans = (v: string): string =>
  v === "PASS"
    ? "measured clean"
    : v === "PASS_WITH_WARNINGS"
      ? "measured, with lower-severity findings"
      : v === "FAIL"
        ? "a measured problem with the page"
        : "geoqa could not read the page — our defect, not the site's";

const severitySummary = (run: RunView): string => {
  const parts = Object.entries(run.findings.bySeverity).filter(([, n]) => n > 0);
  return parts.length === 0 ? "nothing to fix here" : parts.map(([s, n]) => `${n} ${s}`).join(" · ");
};
