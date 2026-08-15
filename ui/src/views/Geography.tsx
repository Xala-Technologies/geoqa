/**
 * The half of the picture no crawler running from one datacentre can produce.
 *
 * One URL, one set of HTML, different results by market. That is the product's entire claim, so
 * it gets a view rather than a panel somebody scrolls past.
 */
import type { JSX } from "react";
import type { DashboardView, PageAcrossMarkets } from "../types.ts";
import { Verdict } from "../Measured.tsx";

export function Geography({ view }: { view: DashboardView }): JSX.Element {
  const { site } = view;
  return (
    <>
      <div className="head">
        <p className="hint">
          The same page, measured from inside each market. A latency spread is not a slow site — it
          is a site that is slow <em>somewhere</em>, which is a different problem with a different fix.
        </p>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Geography changed the outcome</h3>
          <p className="hint">Pages whose verdict is not the same everywhere.</p>
        </div>
        {site.geographicallyDivergent.length === 0 ? (
          <div className="empty">
            <strong>No page diverged.</strong>
            Every page measured reached the same verdict in every market that measured it.
          </div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Markets</th>
                  <th>Diverging</th>
                </tr>
              </thead>
              <tbody>
                {site.geographicallyDivergent.map((p) => (
                  <tr key={p.target}>
                    <td className="mono">{p.target}</td>
                    <td>
                      {Object.entries(p.markets).map(([id, m]) => (
                        <span className="mkt" key={id}>
                          <span className="dim">
                            {id}
                          </span>
                          <Verdict value={m.verdict} />
                        </span>
                      ))}
                    </td>
                    <td className="mono" style={{ color: "var(--fail)" }}>
                      {p.divergentMarkets.join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Latency spread</h3>
          <p className="hint">
            Slowest minus fastest TTFB for one page. Only pages measured in two or more markets — a
            spread needs two readings, and one market is not a spread of zero.
          </p>
        </div>
        {site.widestLatencyGaps.length === 0 ? (
          <div className="empty">
            <strong>No page has two markets yet.</strong>
            Run the same page from a second market to get a spread.
          </div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Page</th>
                  <th className="num">Spread</th>
                  <th>By market (TTFB)</th>
                </tr>
              </thead>
              <tbody>
                {site.widestLatencyGaps.map((p) => (
                  <Spread key={p.target} p={p} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Spread({ p }: { p: PageAcrossMarkets }): JSX.Element {
  const readings = Object.entries(p.markets)
    .filter((e): e is [string, { verdict: string; ttfbMs: number; lcpMs: number | null; confidence: number }] => e[1].ttfbMs !== null)
    .sort((a, b) => a[1].ttfbMs - b[1].ttfbMs);
  const slowest = readings[readings.length - 1]?.[1].ttfbMs ?? 1;
  return (
    <tr>
      <td className="mono">{p.target}</td>
      <td className="num">{p.ttfbSpreadMs === null ? <span className="unmeasured">not measured</span> : `${p.ttfbSpreadMs}ms`}</td>
      <td>
        {readings.map(([id, m]) => (
          <span className="mkt" key={id}>
            <span className="dim">{id}</span>
            {/* A bar as well as a number: the ratio between markets reads before the digits do. */}
            <span className="mkt-bar">
              <span style={{ width: `${Math.max(4, (m.ttfbMs / slowest) * 100)}%` }} />
            </span>
            <span className="measured">{m.ttfbMs}ms</span>
          </span>
        ))}
      </td>
    </tr>
  );
}
