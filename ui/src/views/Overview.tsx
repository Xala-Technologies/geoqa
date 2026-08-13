/**
 * The summary before the detail.
 *
 * A console is scanned, not read, so this answers three questions in the order somebody asks
 * them: is anything wrong, how much do I trust what I am looking at, and what is missing. The
 * detail views are for after one of those answers is unwelcome.
 */
import type { JSX } from "react";
import type { DashboardView } from "../types.ts";
import { MeasuredValue, Verdict } from "../Measured.tsx";

export function Overview({ view }: { view: DashboardView }): JSX.Element {
  const byVerdict = view.summary.byVerdict;
  const of = (k: string): number => byVerdict[k] ?? 0;
  const total = view.summary.total;
  // ERROR is counted separately from FAIL everywhere in this system, and the split is the first
  // thing worth seeing: one number is the sites' problem and the other is ours.
  const ours = of("ERROR");
  const theirs = of("FAIL");

  return (
    <>
      <div className="head">
        <h2>Overview</h2>
        <p className="hint">
          Every reading here was taken from inside the market it claims, through a real browser. A
          value the engine could not measure says so rather than reading as a zero.
        </p>
      </div>

      {view.warnings.map((w) => (
        <div className="note" key={w}>
          {w}
        </div>
      ))}

      <div className="gauges">
        <div className="gauge">
          <div className="gauge-k">Runs</div>
          <div className="gauge-v">{total}</div>
          <div className="gauge-sub">
            {view.site.pages} page(s) &middot; {view.site.markets.length} market(s)
          </div>
          <Split total={total} pass={of("PASS") + of("PASS_WITH_WARNINGS")} fail={theirs} error={ours} />
        </div>

        <div className="gauge">
          <div className="gauge-k">Site failures</div>
          <div className="gauge-v" style={{ color: theirs > 0 ? "var(--fail)" : "var(--readout)" }}>
            {theirs}
          </div>
          <div className="gauge-sub">measured problems with a page</div>
        </div>

        <div className="gauge">
          <div className="gauge-k">Could not verify</div>
          {/* Never the failure colour: an ERROR is our instrumentation, not the site. */}
          <div className="gauge-v" style={{ color: ours > 0 ? "var(--void)" : "var(--readout)" }}>
            {ours}
          </div>
          <div className="gauge-sub">our defect, excluded from comparisons</div>
        </div>

        <div className="gauge">
          <div className="gauge-k">Mean confidence</div>
          <div className="gauge-v">
            <MeasuredValue value={view.summary.meanConfidence} />
          </div>
          <div className="gauge-sub">how far these readings can be trusted</div>
        </div>

        <div className="gauge">
          <div className="gauge-k">Coverage gaps</div>
          <div className="gauge-v" style={{ color: view.site.coverageGaps.length > 0 ? "var(--warn)" : "var(--readout)" }}>
            {view.site.coverageGaps.length}
          </div>
          <div className="gauge-sub">
            {view.site.coverageGaps.length > 0 ? "page(s) never measured somewhere" : "every page seen in every market"}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Needs attention</h3>
          <p className="hint">Ranked by how badly a reader would be misled if they missed it.</p>
        </div>
        <div className="panel-body">
          <Attention view={view} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Latest runs</h3>
          <a className="tag" href="#/runs">
            all {total} &rarr;
          </a>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Verdict</th>
                <th>Started</th>
                <th>Market</th>
                <th>Journey</th>
                <th className="num">LCP</th>
                <th className="num">Conf</th>
                <th>Page</th>
              </tr>
            </thead>
            <tbody>
              {view.runs.slice(0, 8).map((r) => (
                <tr key={r.runId}>
                  <td>
                    <Verdict value={r.verdict} />
                  </td>
                  <td className="mono dim">{r.startedAt.slice(0, 19).replace("T", " ")}</td>
                  <td className="mono">{r.marketId}</td>
                  <td className="dim">{r.journeyId}</td>
                  <td className="num">
                    <MeasuredValue value={r.vitals.lcp} />
                  </td>
                  <td className="num">
                    <MeasuredValue value={r.confidence.overall} />
                  </td>
                  <td className="mono dim">{r.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/** The verdict split as form, not only as number — the shape reads before the digits do. */
function Split({ total, pass, fail, error }: { total: number; pass: number; fail: number; error: number }): JSX.Element | null {
  if (total === 0) return null;
  const pct = (n: number): string => `${(n / total) * 100}%`;
  return (
    <div className="meter" title={`${pass} passed · ${fail} failed · ${error} could not be read`}>
      <span style={{ width: pct(pass), background: "var(--pass)" }} />
      <span style={{ width: pct(fail), background: "var(--fail)" }} />
      <span style={{ width: pct(error), background: "var(--void)" }} />
    </div>
  );
}

function Attention({ view }: { view: DashboardView }): JSX.Element {
  const items: { tone: string; label: string; detail: string; href: string }[] = [];

  for (const r of view.regressions) {
    items.push({
      tone: "bad",
      label: "regression",
      detail: `${r.label} — passed at ${r.lastGood.startedAt.slice(0, 10)}, failed at ${r.firstBad.startedAt.slice(0, 10)}`,
      href: "#/runs",
    });
  }
  if (view.site.geographicallyDivergent.length > 0) {
    items.push({
      tone: "bad",
      label: "divergent",
      detail: `${view.site.geographicallyDivergent.length} page(s) behave differently depending on the market`,
      href: "#/geography",
    });
  }
  if (view.site.coverageGaps.length > 0) {
    items.push({
      tone: "warn",
      label: "coverage",
      detail: `${view.site.coverageGaps.length} page(s) were never measured in at least one market`,
      href: "#/coverage",
    });
  }
  if (view.trends.length > 0) {
    items.push({
      tone: "warn",
      label: "drift",
      detail: `${view.trends.length} metric series changed direction`,
      href: "#/trends",
    });
  }

  if (items.length === 0) {
    return (
      <div className="empty">
        <strong>Nothing is asking for attention.</strong>
        No regressions, no market divergence, no coverage gaps, and no metric drifting far enough to
        call a direction.
      </div>
    );
  }
  return (
    <table>
      <tbody>
        {items.map((i) => (
          <tr key={i.label + i.detail}>
            <td style={{ width: 110 }}>
              <span className={`pill ${i.tone}`}>{i.label}</span>
            </td>
            <td>{i.detail}</td>
            <td className="num">
              <a className="tag" href={i.href}>
                open &rarr;
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
