/**
 * Whether a number is drifting — then the visit that last measured it.
 *
 * A table of every series trains nobody. This is the instrument: filter,
 * open a series, jump to the visit or the tickets already filed on that
 * host. A worsening TTFB is not itself a GitHub issue.
 */
import { useMemo, useState, type JSX } from "react";
import type { DashboardView, TrendSeries } from "../types.ts";
import { MeasuredValue } from "../Measured.tsx";
import { findingHref } from "../route.ts";
import { geographyHref, pageLabel } from "./geography.ts";
import {
  TREND_METRICS,
  METRIC_LABEL,
  directionCounts,
  driftBrief,
  filterSeries,
  isFilingCandidate,
  latestMeasured,
  parseTrendKey,
  relatedTickets,
  seriesKey,
  sortSeries,
  trendDelta,
  trendsHref,
  type DirectionFilter,
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
  const [direction, setDirection] = useState<DirectionFilter>(parsed.metric === undefined && view.trends.length === 0 ? "all" : "");
  const [market, setMarket] = useState(parsed.marketId ?? "");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<TrendSort>("direction");
  const [copied, setCopied] = useState(false);

  const counts = directionCounts(view.allTrends);
  const markets = [...new Set(view.allTrends.map((s) => s.marketId))].sort();
  const metric = parsed.metric ?? "";
  const rows = useMemo(
    () => sortSeries(filterSeries(view.allTrends, { metric, direction, market, page: q }), sort),
    [view.allTrends, metric, direction, market, q, sort],
  );
  const selectedKey =
    parsed.metric !== undefined && parsed.marketId !== undefined && parsed.target !== undefined
      ? seriesKey({ metric: parsed.metric, marketId: parsed.marketId, target: parsed.target })
      : null;
  const selected = selectedKey === null ? null : (view.allTrends.find((s) => seriesKey(s) === selectedKey) ?? null);

  return (
    <>
      <div className="head">
        <p className="hint">
          A direction needs six measured visits and has to clear both a 10% move and an absolute
          floor. A hollow tick is a gap — never a zero. Click a series, then the visit.
        </p>
      </div>

      <div className="gauges">
        <Gauge k="Worsening" v={String(counts.worsening)} sub="later median is worse" tone={counts.worsening > 0 ? "var(--fail)" : undefined} />
        <Gauge k="Improving" v={String(counts.improving)} sub="later median is better" />
        <Gauge k="Stable" v={String(counts.stable)} sub="moved, but inside the noise" />
        <Gauge k="Not enough" v={String(counts["insufficient-data"])} sub="fewer than six measured points" />
      </div>

      <div className="filters">
        <div className="toolbar" role="tablist" aria-label="Metric">
          <a className={`tool-text${metric === "" ? " tool-accent" : ""}`} href="#/trends">
            All
          </a>
          {TREND_METRICS.map((id) => (
            <a key={id} className={`tool-text${metric === id ? " tool-accent" : ""}`} href={trendsHref(id)}>
              {METRIC_LABEL[id]}
            </a>
          ))}
        </div>
        <select value={direction} onChange={(e) => setDirection(e.target.value as DirectionFilter)} aria-label="Direction">
          <option value="">Changed direction</option>
          <option value="all">Every series</option>
          <option value="worsening">Worsening</option>
          <option value="improving">Improving</option>
          <option value="stable">Stable</option>
          <option value="insufficient-data">Not enough data</option>
        </select>
        <select value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Market">
          <option value="">Every market</option>
          {markets.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as TrendSort)} aria-label="Sort">
          <option value="direction">Worsening first</option>
          <option value="delta">Largest move</option>
          <option value="page">Page</option>
          <option value="market">Market</option>
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
            ? "Run the same page from the same city several times."
            : "Widen the direction filter — most series are quiet on purpose."}
        </div>
      ) : (
        <div className="trend-grid">
          {rows.map((row) => (
            <TrendCard key={seriesKey(row)} row={row} selected={selected !== null && seriesKey(row) === seriesKey(selected)} />
          ))}
        </div>
      )}

      {selected !== null ? (
        <TrendDetail
          row={selected}
          tickets={relatedTickets(selected.target, view.tickets)}
          copied={copied}
          onCopy={() => {
            const text = driftBrief(selected);
            if (typeof navigator.clipboard?.writeText !== "function") return;
            void navigator.clipboard.writeText(text).then(() => setCopied(true));
          }}
        />
      ) : null}
    </>
  );
}

function TrendCard({ row, selected }: { row: TrendSeries; selected: boolean }): JSX.Element {
  const delta = trendDelta(row);
  return (
    <article className={`trend-card${selected ? " on" : ""}`}>
      <a className="trend-card-hit pressable" href={trendsHref(seriesKey(row))}>
        <div className="trend-card-k">
          {METRIC_LABEL[row.metric]} · {row.marketId}
        </div>
        <div className="trend-card-v">
          <span className={`pill ${TONE[row.direction] ?? "unknown"}`}>{row.direction}</span>
          {delta.measured ? <span className="trend-delta">{delta.text}</span> : null}
        </div>
        <div className="trend-card-sub">{pageLabel(row.target)}</div>
      </a>
      <Trace series={row} />
    </article>
  );
}

function TrendDetail({
  row,
  tickets,
  copied,
  onCopy,
}: {
  row: TrendSeries;
  tickets: ReturnType<typeof relatedTickets>;
  copied: boolean;
  onCopy: () => void;
}): JSX.Element {
  const latest = latestMeasured(row);
  const candidate = isFilingCandidate(row);
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>
            {METRIC_LABEL[row.metric]} · {row.marketId}
          </h3>
          <p className="hint">{row.reason}</p>
        </div>
      </div>
      <div className="panel-body trend-detail">
        <p>
          Earlier <MeasuredValue value={row.earlier} /> → later <MeasuredValue value={row.later} /> ·{" "}
          {row.measuredPoints} measured of {row.points.length}
        </p>
        <div className="toolbar">
          {latest !== null ? (
            <a className="tool-text tool-accent" href={`#/run/${latest.runId}`}>
              Open latest visit
            </a>
          ) : null}
          <a className="tool-text" href={geographyHref(row.target)}>
            Same page, every city
          </a>
          {candidate ? (
            <button className="tool-text" type="button" onClick={onCopy}>
              {copied ? "Brief copied" : "Copy a drift brief"}
            </button>
          ) : null}
        </div>
        <p className="hint">
          A trend is not a failed check. GitHub issues come from To fix when a journey assert
          failed. {tickets.length === 0
            ? "No ticket is open on this host yet."
            : "Tickets already filed on this host:"}
        </p>
        {tickets.length > 0 ? (
          <ul className="trend-tickets">
            {tickets.map((ticket) => (
              <li key={ticket.key}>
                <a href={findingHref(ticket.key)}>{ticket.title}</a>
                {ticket.issue.measured ? <span className="dim"> · {ticket.issue.text}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

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
          <a
            key={p.runId}
            className={absolute === lastIndex ? "last" : ""}
            style={{ height: `${Math.max(8, (p.value / max) * 100)}%` }}
            href={`#/run/${p.runId}`}
            title={`${p.at.slice(0, 10)} — ${p.value}`}
            onClick={(e) => e.stopPropagation()}
          />
        );
      })}
    </span>
  );
}

function Gauge({ k, v, sub, tone }: { k: string; v: string; sub: string; tone?: string | undefined }): JSX.Element {
  return (
    <div className="gauge">
      <div className="gauge-k">{k}</div>
      <div className="gauge-v" style={tone !== undefined ? { color: tone } : undefined}>
        {v}
      </div>
      <div className="gauge-sub">{sub}</div>
    </div>
  );
}
