/**
 * What was NOT measured, and where.
 *
 * **This view exists because the dashboard was silently omitting it.** `analyseSite` has computed
 * `coverageGaps` since it was written, with a comment saying exactly why it matters — *a page
 * nobody measured in Bodo is not a page that works in Bodo, and a report that silently omitted it
 * would read as full coverage* — and the UI rendered every other field of that report and not
 * this one. Found by running the app against real data: two live sites had never been measured in
 * `porsgrunn`, and the dashboard showed a clean bill of health.
 *
 * The matrix is the point. A list of gaps tells you what is missing; a grid tells you whether the
 * hole is a market nobody covers or a page nobody sweeps, and those have different fixes.
 */
import type { JSX } from "react";
import type { DashboardView } from "../types.ts";
import { Verdict } from "../Measured.tsx";

export function Coverage({ view }: { view: DashboardView }): JSX.Element {
  const { site } = view;
  const missingFor = new Map(site.coverageGaps.map((g) => [g.target, new Set(g.missing)]));

  return (
    <>
      <div className="head">
        <p className="hint">
          Which pages were measured in which markets. An empty cell is not a passing cell: a page
          nobody measured in a market is not a page that works there, and a report that showed only
          the readings it had would read as full coverage.
        </p>
      </div>

      {site.coverageGaps.length > 0 && (
        <div className="note">
          {site.coverageGaps.length} page(s) were never measured in at least one market. Those
          markets are blank below — they are unknown, not clean.
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h3>Page &times; market</h3>
          <p className="hint">
            {site.pages} page(s) across {site.markets.length} market(s).
          </p>
        </div>
        {site.perPage.length === 0 ? (
          <div className="empty">
            <strong>No pages yet.</strong>
            Run a journey to populate this.
          </div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Page</th>
                  {site.markets.map((m) => (
                    <th key={m} className="center">
                      {m}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {site.perPage.map((p) => (
                  <tr key={p.target}>
                    <td className="mono">{p.target}</td>
                    {site.markets.map((m) => {
                      const cell = p.markets[m];
                      const missing = missingFor.get(p.target)?.has(m) === true;
                      return (
                        <td key={m} className="center">
                          {cell ? (
                            <Verdict value={cell.verdict} />
                          ) : (
                            // Never blank, and never a dash that could read as "fine": the words
                            // say what is true, and the title says why it matters.
                            <span
                              className="unmeasured"
                              title={
                                missing
                                  ? `${p.target} has never been measured in ${m}. That is unknown, not clean.`
                                  : `no run for ${m}`
                              }
                            >
                              never measured
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Gaps</h3>
          <p className="hint">Scoped to the markets that appear anywhere in this data.</p>
        </div>
        {site.coverageGaps.length === 0 ? (
          <div className="empty">
            <strong>Every page was measured in every market.</strong>
            Nothing here is inferred — this is coverage that exists, not coverage assumed.
          </div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Never measured in</th>
                </tr>
              </thead>
              <tbody>
                {site.coverageGaps.map((g) => (
                  <tr key={g.target}>
                    <td className="mono">{g.target}</td>
                    <td>
                      {g.missing.map((m) => (
                        <span key={m} className="tag" style={{ marginRight: "var(--s-2)", color: "var(--warn)", borderColor: "var(--warn)" }}>
                          {m}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {site.warnings.map((w) => (
        <div className="note" key={w}>
          {w}
        </div>
      ))}
    </>
  );
}
