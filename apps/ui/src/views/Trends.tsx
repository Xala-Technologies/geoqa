/**
 * Whether a number is drifting — then the visit that last measured it.
 *
 * The list is a cut. A series opens as its own page, the same way a
 * finding does, so "not enough visits yet" has somewhere to be explained.
 */
import { useMemo, useState, type JSX } from "react";
import type { DashboardView, TrendDirection, TrendSeries } from "../types.ts";
import { MeasuredValue } from "../Measured.tsx";
import { findingHref } from "../route.ts";
import { geographyHref, pageLabel } from "./geography.ts";
import {
  DIRECTION_LABEL,
  METRIC_LABEL,
  MIN_POINTS_FOR_DIRECTION,
  TREND_METRICS,
  driftBrief,
  explainSeries,
  filterSeries,
  isFilingCandidate,
  latestMeasured,
  parseTrendKey,
  pointsNeeded,
  relatedTickets,
  seriesKey,
  sortSeries,
  trendDelta,
  trendsHref,
  visitRows,
  type TrendSort,
} from "./trends.ts";

const TONE: Record<string, string> = {
  worsening: "bad",
  improving: "good",
  stable: "unknown",
  "insufficient-data": "unknown",
};

export function Trends({ view, trendKey }: { view: DashboardView; trendKey?: string }): JSX.Element {
  const parsed = parseTrendKey(trendKey);
  const selectedKey =
    parsed.metric !== undefined && parsed.marketId !== undefined && parsed.target !== undefined
      ? seriesKey({ metric: parsed.metric, marketId: parsed.marketId, target: parsed.target })
      : null;
  const selected = selectedKey === null ? null : (view.allTrends.find((s) => seriesKey(s) === selectedKey) ?? null);

  if (selectedKey !== null) {
    if (selected === null) {
      return (
        <div className="empty">
          <strong>This series is not in the current dashboard.</strong>
          Rebuild, or go back to{" "}
          <a className="tag" href="#/trends">
            Over time
          </a>
          .
        </div>
      );
    }
    return <TrendDetail view={view} row={selected} />;
  }

  return <TrendList view={view} metric={parsed.metric ?? ""} direction={parsed.direction ?? "all"} />;
}

function TrendList({
  view,
  metric,
  direction,
}: {
  view: DashboardView;
  metric: string;
  direction: "all" | TrendDirection;
}): JSX.Element {
  const [market, setMarket] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<TrendSort>("direction");
  const markets = [...new Set(view.allTrends.map((s) => s.marketId))].sort();
  const rows = useMemo(
    () => sortSeries(filterSeries(view.allTrends, { metric, direction, market, page: q }), sort),
    [view.allTrends, metric, direction, market, q, sort],
  );

  return (
    <>
      <div className="head">
        <p className="hint">
          One number, one city, over the visits we already have. Click a card to read what the
          label means. A direction needs {MIN_POINTS_FOR_DIRECTION} measured visits — fewer than
          that is not a trend.
        </p>
      </div>

      <div className="gauges">
        <GaugeLink href={trendsHref("worsening")} k="Getting worse" v={String(view.allTrends.filter((s) => s.direction === "worsening").length)} sub="Later visits measured a worse number" on={direction === "worsening"} tone="var(--fail)" />
        <GaugeLink href={trendsHref("improving")} k="Getting better" v={String(view.allTrends.filter((s) => s.direction === "improving").length)} sub="Later visits measured a better number" on={direction === "improving"} />
        <GaugeLink href={trendsHref("stable")} k="No real change" v={String(view.allTrends.filter((s) => s.direction === "stable").length)} sub="Moved, but inside the noise" on={direction === "stable"} />
        <GaugeLink href={trendsHref("insufficient-data")} k="Not enough visits yet" v={String(view.allTrends.filter((s) => s.direction === "insufficient-data").length)} sub={`Fewer than ${MIN_POINTS_FOR_DIRECTION} readings — we will not guess`} on={direction === "insufficient-data"} />
      </div>

      {direction === "insufficient-data" ? (
        <div className="note">
          <strong>Not enough visits yet</strong> means this city has not produced {MIN_POINTS_FOR_DIRECTION}{" "}
          readings of that number. Open a card: it says how many more visits it needs. It is not a
          failure, and it is not a pass.
        </div>
      ) : null}

      <div className="filters">
        <div className="toolbar" role="tablist" aria-label="Metric">
          <a className={`tool-text${metric === "" ? " tool-accent" : ""}`} href="#/trends">
            All numbers
          </a>
          {TREND_METRICS.map((id) => (
            <a key={id} className={`tool-text${metric === id ? " tool-accent" : ""}`} href={trendsHref(id)}>
              {METRIC_LABEL[id]}
            </a>
          ))}
        </div>
        <select value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Market">
          <option value="">Every city</option>
          {markets.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as TrendSort)} aria-label="Sort">
          <option value="direction">Worse first</option>
          <option value="delta">Largest move</option>
          <option value="page">Page</option>
          <option value="market">City</option>
        </select>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter pages" aria-label="Filter pages" />
        <span className="spacer">
          {rows.length} / {view.allTrends.length}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <strong>Nothing in this cut.</strong>
          {view.allTrends.length === 0
            ? "The same page has to be visited from the same city several times."
            : "Clear the city filter, or open Not enough visits yet."}
        </div>
      ) : (
        <div className="trend-grid">
          {rows.map((row) => (
            <TrendCard key={seriesKey(row)} row={row} />
          ))}
        </div>
      )}
    </>
  );
}

function TrendCard({ row }: { row: TrendSeries }): JSX.Element {
  const delta = trendDelta(row);
  const short =
    row.direction === "insufficient-data"
      ? `${row.measuredPoints} of ${MIN_POINTS_FOR_DIRECTION} readings`
      : delta.measured
        ? delta.text
        : DIRECTION_LABEL[row.direction];
  return (
    <a className="trend-card trend-card-hit pressable" href={trendsHref(seriesKey(row))}>
      <div className="trend-card-k">
        {METRIC_LABEL[row.metric]} · {row.marketId}
      </div>
      <div className="trend-card-v">
        <span className={`pill ${TONE[row.direction] ?? "unknown"}`}>{DIRECTION_LABEL[row.direction]}</span>
        <span className="trend-delta">{short}</span>
      </div>
      <div className="trend-card-sub">{pageLabel(row.target)} · Open to see why</div>
    </a>
  );
}

function TrendDetail({ view, row }: { view: DashboardView; row: TrendSeries }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const latest = latestMeasured(row);
  const needed = pointsNeeded(row);
  const tickets = relatedTickets(row.target, view.tickets);
  const visits = visitRows(row);
  return (
    <>
      <div className="head">
        <p className="hint">
          <a className="tag" href="#/trends">
            ← Over time
          </a>{" "}
          {METRIC_LABEL[row.metric]} · {row.marketId} · {pageLabel(row.target)}
        </p>
      </div>

      <div className="gauges">
        <Gauge k="Verdict" v={DIRECTION_LABEL[row.direction]} sub={row.reason} />
        <Gauge
          k="Readings"
          v={`${row.measuredPoints} / ${row.points.length}`}
          sub={needed > 0 ? `${needed} more before a direction` : "enough to name a direction"}
        />
        <Gauge k="Earlier → later" v={<><MeasuredValue value={row.earlier} /> → <MeasuredValue value={row.later} /></>} sub="median of each half" />
        <Gauge k="City" v={row.marketId} sub={pageLabel(row.target)} />
      </div>

      {explainSeries(row).map((section) => (
        <div className="panel" key={section.heading}>
          <div className="panel-head">
            <h3>{section.heading}</h3>
          </div>
          <div className="panel-body brief-prose">
            <p>{section.text}</p>
          </div>
        </div>
      ))}

      <div className="panel">
        <div className="panel-head">
          <h3>Each visit</h3>
          <p className="hint">A gap is a visit that did not measure this number. Click a row.</p>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Reading</th>
                <th>Visit</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((visit) => (
                <tr key={visit.runId}>
                  <td className="dim">{visit.at.replace("T", " ").slice(0, 16)}</td>
                  <td>{visit.gap ? <span className="unmeasured">not measured</span> : visit.reading}</td>
                  <td>
                    <a className="tag" href={`#/run/${visit.runId}`}>
                      Open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="filters">
        {latest !== null ? (
          <a className="tool-text tool-accent" href={`#/run/${latest.runId}`}>
            Latest visit
          </a>
        ) : null}
        <a className="tool-text" href={geographyHref(row.target)}>
          Same page, every city
        </a>
        {isFilingCandidate(row) ? (
          <button
            className="tool-text"
            type="button"
            onClick={() => {
              if (typeof navigator.clipboard?.writeText !== "function") return;
              void navigator.clipboard.writeText(driftBrief(row)).then(() => setCopied(true));
            }}
          >
            {copied ? "Brief copied" : "Copy a drift brief"}
          </button>
        ) : null}
      </div>

      {tickets.length > 0 ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Already on To fix</h3>
            <p className="hint">Failed checks on this host — those are the GitHub issues.</p>
          </div>
          <ul className="trend-tickets">
            {tickets.map((ticket) => (
              <li key={ticket.key}>
                <a href={findingHref(ticket.key)}>{ticket.title}</a>
                {ticket.issue.measured ? <span className="dim"> · {ticket.issue.text}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function Gauge({ k, v, sub }: { k: string; v: JSX.Element | string; sub: string }): JSX.Element {
  return (
    <div className="gauge">
      <div className="gauge-k">{k}</div>
      <div className="gauge-v brief-gauge">{v}</div>
      <div className="gauge-sub">{sub}</div>
    </div>
  );
}

function GaugeLink({
  href,
  k,
  v,
  sub,
  on,
  tone,
}: {
  href: string;
  k: string;
  v: string;
  sub: string;
  on: boolean;
  tone?: string;
}): JSX.Element {
  return (
    <a className={`gauge pressable${on ? " on" : ""}`} href={href}>
      <div className="gauge-k">{k}</div>
      <div className="gauge-v" style={tone !== undefined && Number(v) > 0 ? { color: tone } : undefined}>
        {v}
      </div>
      <div className="gauge-sub">{sub}</div>
    </a>
  );
}
