/**
 * Compare one page across markets. The console has no server to ask, so
 * this is the whole query: pick a page, sort the cities, compare two.
 *
 * An unmeasured reading is never sorted or heated as zero — that is how
 * a hole would look like the fastest city.
 */
import type { PageAcrossMarkets, RunView } from "../types.ts";

export type GeoMetric = "verdict" | "ttfb" | "lcp" | "confidence";
export type GeoSort = "name" | "ttfb" | "lcp" | "confidence" | "verdict";

export interface GeoCell {
  marketId: string;
  target: string;
  verdict: string | null;
  ttfbMs: number | null;
  lcpMs: number | null;
  confidence: number | null;
  runId: string | null;
  requested: string | null;
  observed: string | null;
  cityAxis: string | null;
  errored: boolean;
  divergent: boolean;
  heat: number | null;
}

export interface CompareRow {
  target: string;
  left: PageAcrossMarkets["markets"][string] | null;
  right: PageAcrossMarkets["markets"][string] | null;
  ttfbDeltaMs: number | null;
  sameVerdict: boolean;
}

export function geographyHref(target?: string): string {
  return target === undefined || target === "" ? "#/geography" : `#/geography/${encodeURIComponent(target)}`;
}

export function pageLabel(target: string): string {
  try {
    const url = new URL(target);
    return url.pathname.replace(/\/$/, "") === "" ? url.host : `${url.host}${url.pathname}`;
  } catch {
    return target;
  }
}

export function latestRun(runs: RunView[], target: string, marketId: string): RunView | null {
  let found: RunView | null = null;
  for (const run of runs) {
    if (run.target !== target || run.marketId !== marketId) continue;
    if (found === null || run.startedAt > found.startedAt) found = run;
  }
  return found;
}

export function marketsInView(siteMarkets: string[], runs: RunView[]): string[] {
  return [...new Set([...siteMarkets, ...runs.map((run) => run.marketId)])].sort();
}

export function heatFor(value: number | null, min: number, max: number, invert = false): number | null {
  if (value === null) return null;
  if (min === max) return 0.5;
  const raw = (value - min) / (max - min);
  return invert ? 1 - raw : raw;
}

export function buildCells(
  page: PageAcrossMarkets,
  allMarkets: string[],
  runs: RunView[],
  metric: GeoMetric,
): GeoCell[] {
  const numeric = (id: string): number | null => {
    const reading = page.markets[id];
    if (reading === undefined) return null;
    if (metric === "ttfb") return reading.ttfbMs;
    if (metric === "lcp") return reading.lcpMs;
    if (metric === "confidence") return reading.confidence;
    return null;
  };
  const values = allMarkets.map(numeric).filter((v): v is number => v !== null);
  const min = values.length === 0 ? 0 : Math.min(...values);
  const max = values.length === 0 ? 0 : Math.max(...values);
  const invert = metric === "confidence";
  return allMarkets.map((marketId) => {
    const reading = page.markets[marketId];
    const run = latestRun(runs, page.target, marketId);
    const errored = reading === undefined && run?.verdict === "ERROR";
    return {
      marketId,
      target: page.target,
      verdict: reading?.verdict ?? null,
      ttfbMs: reading?.ttfbMs ?? null,
      lcpMs: reading?.lcpMs ?? null,
      confidence: reading?.confidence ?? null,
      runId: run?.runId ?? null,
      requested: run?.geo.requested ?? null,
      observed: run?.geo.observed ?? null,
      cityAxis: run?.geo.city ?? null,
      errored,
      divergent: page.divergentMarkets.includes(marketId),
      heat: metric === "verdict" ? null : heatFor(numeric(marketId), min, max, invert),
    };
  });
}

export function sortCells(cells: GeoCell[], sort: GeoSort, desc: boolean): GeoCell[] {
  const rank = (verdict: string | null): number =>
    verdict === "FAIL" ? 3 : verdict === "PASS_WITH_WARNINGS" ? 2 : verdict === "PASS" ? 1 : 0;
  const value = (cell: GeoCell): number | null => {
    if (sort === "verdict") return cell.verdict === null && !cell.errored ? null : rank(cell.verdict);
    if (sort === "ttfb") return cell.ttfbMs;
    if (sort === "lcp") return cell.lcpMs;
    return cell.confidence;
  };
  return [...cells].sort((a, b) => {
    if (sort === "name") return desc ? b.marketId.localeCompare(a.marketId) : a.marketId.localeCompare(b.marketId);
    return cmpNullable(value(a), value(b), desc, a.marketId.localeCompare(b.marketId));
  });
}

/** Unmeasured sorts last in both directions. A missing TTFB is not a fast TTFB. */
export function cmpNullable(av: number | null, bv: number | null, desc: boolean, tie: number): number {
  if (av === null && bv === null) return tie;
  if (av === null) return 1;
  if (bv === null) return -1;
  const diff = av - bv;
  return diff === 0 ? tie : desc ? -diff : diff;
}

export function filterCells(cells: GeoCell[], q: string): GeoCell[] {
  const needle = q.trim().toLowerCase();
  if (needle === "") return cells;
  return cells.filter((cell) =>
    [cell.marketId, cell.requested ?? "", cell.observed ?? ""].join(" ").toLowerCase().includes(needle),
  );
}

export function compareRows(pages: PageAcrossMarkets[], left: string, right: string): CompareRow[] {
  if (left === right) return [];
  return pages.map((page) => {
    const a = page.markets[left];
    const b = page.markets[right];
    const leftReading = a === undefined ? null : a;
    const rightReading = b === undefined ? null : b;
    const ttfbDeltaMs =
      leftReading !== null && rightReading !== null && leftReading.ttfbMs !== null && rightReading.ttfbMs !== null
        ? Math.abs(leftReading.ttfbMs - rightReading.ttfbMs)
        : null;
    return {
      target: page.target,
      left: leftReading,
      right: rightReading,
      ttfbDeltaMs,
      sameVerdict: leftReading !== null && rightReading !== null && leftReading.verdict === rightReading.verdict,
    };
  });
}

export function verdictMix(page: PageAcrossMarkets): { pass: number; warn: number; fail: number; total: number } {
  const verdicts = Object.values(page.markets).map((m) => m.verdict);
  return {
    pass: verdicts.filter((v) => v === "PASS").length,
    warn: verdicts.filter((v) => v === "PASS_WITH_WARNINGS").length,
    fail: verdicts.filter((v) => v === "FAIL").length,
    total: verdicts.length,
  };
}

export function worstSpread(pages: PageAcrossMarkets[]): number | null {
  const spreads = pages.map((p) => p.ttfbSpreadMs).filter((n): n is number => n !== null);
  return spreads.length === 0 ? null : Math.max(...spreads);
}

export function spreadText(page: PageAcrossMarkets): string {
  if (page.ttfbSpreadMs === null) return "spread not measured — fewer than two markets produced a TTFB";
  return `${page.ttfbSpreadMs}ms between the fastest and slowest TTFB`;
}
