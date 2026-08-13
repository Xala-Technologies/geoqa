import { useEffect, useState, type JSX } from "react";
import { MeasuredValue, Verdict } from "./Measured.tsx";
import type { DashboardView } from "./types.ts";

/**
 * Fetches the one file `geoqa dashboard build` wrote and renders it.
 *
 * One request, so the UI cannot assemble a half-loaded picture out of several. And the three
 * load states are explicit — a dashboard stuck on "loading" forever because a fetch failed
 * silently is worse than an error message.
 */
export function App(): JSX.Element {
  const [view, setView] = useState<DashboardView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("./dashboard.json", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`dashboard.json responded ${response.status}`);
        return (await response.json()) as DashboardView;
      })
      .then(setView)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error !== null) {
    return (
      <main>
        <h1>geoqa</h1>
        <p className="error">
          Could not load <code>dashboard.json</code>: {error}
        </p>
        <p className="hint">
          Run <code>geoqa dashboard build</code> and serve this app from the same directory as the file it writes.
        </p>
      </main>
    );
  }
  if (view === null) return <main><h1>geoqa</h1><p className="hint">loading…</p></main>;

  return (
    <main>
      <header>
        <h1>geoqa</h1>
        <p className="hint">
          {view.summary.total} run(s) · mean confidence <MeasuredValue value={view.summary.meanConfidence} /> · generated{" "}
          {view.generatedAt}
        </p>
        {view.warnings.map((w) => (
          <p className="warning" key={w}>
            {w}
          </p>
        ))}
      </header>

      {view.regressions.length > 0 && (
        <section>
          <h2>Regressions</h2>
          <p className="hint">A check that used to pass in the same profile, journey and target, and now does not.</p>
          <table>
            <thead>
              <tr><th>check</th><th>profile</th><th>journey</th><th>last good</th><th>first bad</th></tr>
            </thead>
            <tbody>
              {view.regressions.map((r) => (
                <tr key={`${r.label}${r.profileId}${r.target}`}>
                  <td>{r.label}</td><td>{r.profileId}</td><td>{r.journeyId}</td>
                  <td>{r.lastGood.startedAt}</td><td className="bad-text">{r.firstBad.startedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {view.site.geographicallyDivergent.length > 0 && (
        <section>
          <h2>Geography changed the outcome</h2>
          <p className="hint">
            One URL, one set of HTML, different results by market. No crawler running from a single datacentre can see
            this.
          </p>
          {view.site.geographicallyDivergent.map((page) => (
            <div className="page" key={page.target}>
              <code>{page.target}</code>
              <div className="markets">
                {Object.entries(page.markets).map(([id, m]) => (
                  <span className="market" key={id}>
                    {id} <Verdict value={m.verdict} />
                  </span>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {view.site.widestLatencyGaps.length > 0 && (
        <section>
          <h2>Latency by market</h2>
          <p className="hint">TTFB for the same page, measured from inside each market.</p>
          <table>
            <thead>
              <tr><th>page</th>{view.site.markets.map((m) => <th key={m}>{m}</th>)}<th>spread</th></tr>
            </thead>
            <tbody>
              {view.site.widestLatencyGaps.map((page) => (
                <tr key={page.target}>
                  <td><code>{page.target}</code></td>
                  {view.site.markets.map((m) => (
                    <td key={m}>
                      {/* A market with no reading is an absence, not a blank cell and not a zero. */}
                      <MeasuredValue
                        value={
                          page.markets[m]?.ttfbMs != null
                            ? { measured: true, value: page.markets[m]!.ttfbMs!, text: `${page.markets[m]!.ttfbMs}ms` }
                            : { measured: false, reason: `this page was not measured in ${m}`, text: "not measured" }
                        }
                      />
                    </td>
                  ))}
                  <td>{page.ttfbSpreadMs === null ? <span className="unmeasured">not measured</span> : `${page.ttfbSpreadMs}ms`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2>Runs</h2>
        <table>
          <thead>
            <tr>
              <th>verdict</th><th>started</th><th>market</th><th>journey</th>
              <th>LCP</th><th>CLS</th><th>TTFB</th><th>INP</th>
              <th>conf</th><th>geo</th><th>page</th>
            </tr>
          </thead>
          <tbody>
            {view.runs.map((run) => (
              <tr key={run.runId}>
                <td><Verdict value={run.verdict} /></td>
                <td className="mono">{run.startedAt}</td>
                <td>{run.marketId}</td>
                <td>{run.journeyId}</td>
                <td><MeasuredValue value={run.vitals.lcp} /></td>
                <td><MeasuredValue value={run.vitals.cls} /></td>
                <td><MeasuredValue value={run.vitals.ttfb} /></td>
                <td><MeasuredValue value={run.vitals.inp} /></td>
                <td><MeasuredValue value={run.confidence.overall} /></td>
                <td><Verdict value={run.geo.country} /> <Verdict value={run.geo.city} /></td>
                <td><code>{run.target}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
