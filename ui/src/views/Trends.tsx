/**
 * Metrics over time, including the series that did not qualify.
 *
 * The overview deliberately leads with only the series that changed direction — a console that
 * opened with forty rows of "not enough data" trains its reader to scroll past the four that
 * matter. But *not leading with them* is different from *never showing them*, and this view is
 * where the rest live: a reader who wants to know whether a metric is quiet or merely unmeasured
 * has somewhere to look.
 */
import { useState, type JSX } from "react";
import type { DashboardView, TrendSeries } from "../types.ts";
import { MeasuredValue } from "../Measured.tsx";

const DIRECTION_TONE: Record<string, string> = {
  worsening: "bad",
  improving: "good",
  stable: "unknown",
  "insufficient-data": "unknown",
};

export function Trends({ view }: { view: DashboardView }): JSX.Element {
  const [showAll, setShowAll] = useState(view.trends.length === 0);
  const series = showAll ? view.allTrends : view.trends;

  return (
    <>
      <div className="head">
        <h2>Trends</h2>
        <p className="hint">
          A direction is refused below six measured points, and again unless the change clears both
          a relative and an absolute floor. A 14% move on a 1ms reading is 0.15ms, and nobody has
          ever improved a page by 0.15ms.
        </p>
      </div>

      <div className="filters">
        <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--label)" }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} style={{ minWidth: 0 }} />
          show series with no direction
        </label>
        <span className="spacer">
          {series.length} / {view.allTrends.length}
        </span>
      </div>

      {view.trends.length === 0 && (
        <div className="note">
          None of the {view.allTrends.length} computed series changed direction. That is a real
          answer, not an empty one — it means nothing measured is drifting far enough to act on.
        </div>
      )}

      <div className="panel">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Metric</th>
                <th>Market</th>
                <th>Direction</th>
                <th>Trace</th>
                <th className="num">Earlier</th>
                <th className="num">Later</th>
                <th>Page</th>
              </tr>
            </thead>
            <tbody>
              {series.map((s) => (
                <tr key={`${s.metric}-${s.marketId}-${s.target}`}>
                  <td className="mono">{s.metric}</td>
                  <td className="mono dim">{s.marketId}</td>
                  <td>
                    <span className={`pill ${DIRECTION_TONE[s.direction] ?? "unknown"}`} title={s.reason}>
                      {s.direction}
                    </span>
                  </td>
                  <td>
                    <Trace series={s} />
                  </td>
                  <td className="num">
                    <MeasuredValue value={s.earlier} />
                  </td>
                  <td className="num">
                    <MeasuredValue value={s.later} />
                  </td>
                  <td className="mono dim">{s.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {series.length === 0 && (
          <div className="empty">
            <strong>Nothing to show.</strong>
            Tick the box above to include the series that did not qualify for a direction.
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The series as ticks, with a GAP drawn as a hollow slot.
 *
 * The gap is the entire point of drawing this. A run that measured nothing contributes an
 * absence, and a trace that closed over it — or drew it at zero — would fabricate exactly the
 * thing the reader came to look at.
 */
function Trace({ series }: { series: TrendSeries }): JSX.Element {
  const values = series.points.map((p) => p.value).filter((v): v is number => v !== null);
  const max = Math.max(...values, 1);
  const lastIndex = series.points.map((p) => p.value !== null).lastIndexOf(true);
  return (
    <span className="trace" title={series.reason}>
      {series.points.slice(-32).map((p, i, arr) => {
        const absolute = series.points.length - arr.length + i;
        if (p.value === null) return <i className="gap" key={p.runId} title={`${p.at.slice(0, 10)} — not measured`} />;
        return (
          <i
            key={p.runId}
            className={absolute === lastIndex ? "last" : ""}
            style={{ height: `${Math.max(8, (p.value / max) * 100)}%` }}
            title={`${p.at.slice(0, 10)} — ${p.value}`}
          />
        );
      })}
    </span>
  );
}
