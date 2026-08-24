/**
 * Query the metric series the dashboard already computed.
 *
 * A trend is a direction, not a defect. Filing one as a site bug is how
 * a slow residential exit becomes a Digilist ticket. Related tickets
 * are the failed checks on the same host — those are what GitHub gets.
 */
import type { FindingTicket, TrendDirection, TrendSeries } from "../types.ts";
import { pageLabel } from "./geography.ts";

export type TrendMetricId = TrendSeries["metric"];
export type DirectionFilter = "" | "all" | TrendDirection;
export type TrendSort = "direction" | "delta" | "page" | "market";

export const TREND_METRICS: TrendMetricId[] = ["lcp", "cls", "ttfb", "inp", "confidence"];
export const TREND_DIRECTIONS: TrendDirection[] = ["worsening", "improving", "stable", "insufficient-data"];

/** Same floor as the engine. A direction from fewer readings is a story, not a measurement. */
export const MIN_POINTS_FOR_DIRECTION = 6;

export const METRIC_LABEL: Record<TrendMetricId, string> = {
  lcp: "Largest paint",
  cls: "Layout shift",
  ttfb: "Time to first byte",
  inp: "Interaction",
  confidence: "Confidence",
};

export const METRIC_MEANING: Record<TrendMetricId, string> = {
  lcp: "When the main content appeared, in milliseconds. Lower is better.",
  cls: "How much the page jumped while it loaded. Zero means nothing moved.",
  ttfb: "How long until the browser saw the first byte. Lower is better.",
  inp: "How long a click took to show a response. It does not exist until something is clicked.",
  confidence: "How far this visit's readings can be trusted. Ours, not the page's.",
};

export const DIRECTION_LABEL: Record<TrendDirection, string> = {
  worsening: "Getting worse",
  improving: "Getting better",
  stable: "No real change",
  "insufficient-data": "Not enough visits yet",
};

export interface TrendSection {
  heading: string;
  text: string;
}

export interface TrendVisit {
  at: string;
  runId: string;
  reading: string;
  gap: boolean;
}

const DIR_RANK: Record<TrendDirection, number> = {
  worsening: 0,
  improving: 1,
  stable: 2,
  "insufficient-data": 3,
};

export function trendsHref(key?: string): string {
  return key === undefined || key === "" ? "#/trends" : `#/trends/${encodeURIComponent(key)}`;
}

export function seriesKey(series: Pick<TrendSeries, "metric" | "marketId" | "target">): string {
  return `${series.metric}:${series.marketId}:${series.target}`;
}

export function parseTrendKey(key: string | undefined): {
  metric?: TrendMetricId;
  direction?: TrendDirection;
  marketId?: string;
  target?: string;
} {
  if (key === undefined || key === "") return {};
  if ((TREND_METRICS as string[]).includes(key)) return { metric: key as TrendMetricId };
  if ((TREND_DIRECTIONS as string[]).includes(key)) return { direction: key as TrendDirection };
  const first = key.indexOf(":");
  const second = key.indexOf(":", first + 1);
  if (first < 0 || second < 0) return {};
  const metric = key.slice(0, first);
  const marketId = key.slice(first + 1, second);
  const target = key.slice(second + 1);
  if (!(TREND_METRICS as string[]).includes(metric) || marketId === "" || target === "") return {};
  return { metric: metric as TrendMetricId, marketId, target };
}

export function trendDelta(
  series: TrendSeries,
): { measured: true; value: number; text: string } | { measured: false; reason: string; text: "not measured" } {
  if (!series.earlier.measured || !series.later.measured) {
    return { measured: false, reason: "both halves must have a median", text: "not measured" };
  }
  const value = Math.round((series.later.value - series.earlier.value) * 1000) / 1000;
  return { measured: true, value, text: `${value > 0 ? "+" : ""}${value}` };
}

export function latestMeasured(series: TrendSeries): { at: string; runId: string; value: number } | null {
  for (let i = series.points.length - 1; i >= 0; i -= 1) {
    const point = series.points[i];
    if (point !== undefined && point.value !== null) {
      return { at: point.at, runId: point.runId, value: point.value };
    }
  }
  return null;
}

export function directionCounts(series: TrendSeries[]): Record<TrendDirection, number> {
  const counts: Record<TrendDirection, number> = {
    worsening: 0,
    improving: 0,
    stable: 0,
    "insufficient-data": 0,
  };
  for (const row of series) counts[row.direction] += 1;
  return counts;
}

export function filterSeries(
  series: TrendSeries[],
  q: { metric?: string; direction?: DirectionFilter; market?: string; page?: string },
): TrendSeries[] {
  const needle = q.page?.toLowerCase() ?? "";
  return series.filter((row) => {
    if (q.metric !== undefined && q.metric !== "" && row.metric !== q.metric) return false;
    if (q.direction === undefined || q.direction === "") {
      if (row.direction !== "worsening" && row.direction !== "improving") return false;
    } else if (q.direction !== "all" && row.direction !== q.direction) {
      return false;
    }
    if (q.market !== undefined && q.market !== "" && row.marketId !== q.market) return false;
    if (needle !== "") {
      const hay = `${row.target} ${pageLabel(row.target)} ${row.marketId} ${row.metric}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export function sortSeries(series: TrendSeries[], sort: TrendSort): TrendSeries[] {
  return [...series].sort((a, b) => {
    if (sort === "direction") {
      return DIR_RANK[a.direction] - DIR_RANK[b.direction] || pageLabel(a.target).localeCompare(pageLabel(b.target));
    }
    if (sort === "delta") {
      const left = trendDelta(a);
      const right = trendDelta(b);
      if (!left.measured && !right.measured) return 0;
      if (!left.measured) return 1;
      if (!right.measured) return -1;
      return Math.abs(right.value) - Math.abs(left.value);
    }
    if (sort === "market") return a.marketId.localeCompare(b.marketId) || pageLabel(a.target).localeCompare(pageLabel(b.target));
    return pageLabel(a.target).localeCompare(pageLabel(b.target)) || a.marketId.localeCompare(b.marketId);
  });
}

export function hostOf(target: string): string | null {
  try {
    return new URL(target).host;
  } catch {
    return null;
  }
}

export function relatedTickets(target: string, tickets: FindingTicket[]): FindingTicket[] {
  const host = hostOf(target);
  if (host === null) return [];
  return tickets.filter((ticket) => ticket.hosts.includes(host) || ticket.site === host);
}

export function pointsNeeded(series: TrendSeries): number {
  return Math.max(0, MIN_POINTS_FOR_DIRECTION - series.measuredPoints);
}

export function visitRows(series: TrendSeries): TrendVisit[] {
  return series.points.map((point) => ({
    at: point.at,
    runId: point.runId,
    reading: point.value === null ? "not measured" : String(point.value),
    gap: point.value === null,
  }));
}

export function explainSeries(series: TrendSeries): TrendSection[] {
  const page = pageLabel(series.target);
  const needed = pointsNeeded(series);
  const meaning =
    series.direction === "insufficient-data"
      ? series.measuredPoints === 0
        ? `Not enough visits yet. ${METRIC_LABEL[series.metric]} in ${series.marketId} on ${page} has no visit that measured it. A direction needs ${MIN_POINTS_FOR_DIRECTION} readings. Two or three visits would be a story, not a measurement.`
        : `Not enough visits yet. ${METRIC_LABEL[series.metric]} in ${series.marketId} on ${page} has ${series.measuredPoints} of the ${MIN_POINTS_FOR_DIRECTION} readings a direction needs. ${needed} more measured visit(s) from this city and we can say whether it moved.`
      : series.direction === "stable"
        ? `No real change. The number moved, but inside the noise — a few percent, or less than anyone would act on. That is the internet, not a regression.`
        : series.direction === "improving"
          ? `Getting better. The later half of visits measured a lower ${METRIC_LABEL[series.metric].toLowerCase()} than the earlier half, by enough to clear both floors.`
          : `Getting worse. The later half of visits measured a higher ${METRIC_LABEL[series.metric].toLowerCase()} than the earlier half, by enough to clear both floors.`;
  const next =
    series.direction === "insufficient-data"
      ? needed === MIN_POINTS_FOR_DIRECTION
        ? `Wait for the watch to visit this page from ${series.marketId}. Until a reading exists, there is nothing to file.`
        : `Let the watch visit this page from ${series.marketId} ${needed} more time(s). Do not treat the current number as a trend.`
      : series.direction === "worsening"
        ? `Open the latest visit. If a journey check failed, that ticket is already on To fix. If every check passed, keep watching — a slower TTFB is often the exit, not the page.`
        : `Nothing to file. Open a visit if you want the stills; the number is not asking for a change.`;
  return [
    { heading: "What this means", text: meaning },
    { heading: "What this number is", text: METRIC_MEANING[series.metric] },
    {
      heading: "What we saw",
      text: `${series.measuredPoints} of ${series.points.length} visit(s) produced a reading. A hollow tick is a visit that did not measure this number — never a zero.`,
    },
    { heading: "What to do next", text: next },
  ];
}

export function isFilingCandidate(series: TrendSeries): boolean {
  return series.direction === "worsening" && series.earlier.measured && series.later.measured;
}

export function driftBrief(series: TrendSeries): string {
  const page = pageLabel(series.target);
  const earlier = series.earlier.measured ? series.earlier.text : "not measured";
  const later = series.later.measured ? series.later.text : "not measured";
  const metric = METRIC_LABEL[series.metric];
  if (series.metric === "confidence") {
    return [
      `## Problem`,
      `**${metric}** in ${series.marketId} on ${page} moved from ${earlier} to ${later}.`,
      ``,
      `## What this is`,
      `Our readings became less trustworthy. Confidence is an axis about the visit, not about the page.`,
      ``,
      `## What this is not`,
      `Not a site defect. Do not file Digilist or xala.no to 'fix' a weaker confidence score.`,
      ``,
      `## Suggested next step`,
      `Open the latest visit and read which axis capped it — geo, browser, journey, or evidence.`,
      ``,
      `## Evidence`,
      series.reason,
    ].join("\n");
  }
  return [
    `## Problem`,
    `**${metric}** in ${series.marketId} on ${page} moved from ${earlier} to ${later}.`,
    ``,
    `## What this is`,
    `A measured drift over ${series.measuredPoints} visits. It is a candidate for a human to look at, not a failed journey check.`,
    ``,
    `## What this is not`,
    `Not proof the markup is wrong. Residential egress, CDN, and time of day move TTFB and LCP. Do not file this as a site bug unless a check failed.`,
    ``,
    `## Suggested next step`,
    `Open the latest visit. If a threshold check failed, that ticket is already on To fix. If nothing failed, keep watching.`,
    ``,
    `## Evidence`,
    series.reason,
  ].join("\n");
}
