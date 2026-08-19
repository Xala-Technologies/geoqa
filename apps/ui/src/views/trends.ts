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

export const METRIC_LABEL: Record<TrendMetricId, string> = {
  lcp: "Largest paint",
  cls: "Layout shift",
  ttfb: "Time to first byte",
  inp: "Interaction",
  confidence: "Confidence",
};

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
  marketId?: string;
  target?: string;
} {
  if (key === undefined || key === "") return {};
  if ((TREND_METRICS as string[]).includes(key)) return { metric: key as TrendMetricId };
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
