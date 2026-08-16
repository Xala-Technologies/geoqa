/**
 * Filter, sort and page the visit list.
 *
 * The console has no server to ask ([R-147]), so this is the whole query
 * engine: in-memory over the loaded document. Latest-first is the opening
 * order because a list that starts with last week's PASS hides the visit
 * somebody just ran.
 *
 * An unmeasured number sorts LAST in both directions. Treating it as 0
 * would put every unread LCP at the top of "fastest", which is the
 * conflation this product exists to refuse.
 */
import type { RunView } from "../types.ts";

export type RunSortKey =
  | "startedAt"
  | "verdict"
  | "marketId"
  | "journeyId"
  | "target"
  | "observed"
  | "lcp"
  | "cls"
  | "confidence"
  | "findings"
  | "durationMs";

export const DEFAULT_PAGE_SIZE = 25;
export const PAGE_SIZES = [25, 50, 100] as const;

export const deviceOf = (profileId: string): string =>
  profileId.includes("-mobile") ? "mobile" : profileId.includes("-desktop") ? "desktop" : profileId;

export interface RunFilters {
  q: string;
  market: string;
  verdict: string;
  journey: string;
  device: string;
}

export function filterRuns(runs: readonly RunView[], f: RunFilters): RunView[] {
  const needle = f.q.toLowerCase();
  return runs.filter(
    (r) =>
      (f.market === "" || r.marketId === f.market) &&
      (f.verdict === "" || r.verdict === f.verdict) &&
      (f.journey === "" || r.journeyId === f.journey) &&
      (f.device === "" || deviceOf(r.profileId) === f.device) &&
      (needle === "" ||
        `${r.target} ${r.runId} ${r.profileId} ${r.geo.observed}`.toLowerCase().includes(needle)),
  );
}

export function sortKeyOf(r: RunView, key: RunSortKey): number | string | null {
  switch (key) {
    case "lcp":
      return r.vitals.lcp.measured ? r.vitals.lcp.value : null;
    case "cls":
      return r.vitals.cls.measured ? r.vitals.cls.value : null;
    case "confidence":
      return r.confidence.overall.measured ? r.confidence.overall.value : null;
    case "findings":
      return r.findings.total;
    case "durationMs":
      return r.durationMs;
    case "target":
      return r.target;
    case "observed":
      return r.geo.observed;
    default:
      return r[key];
  }
}

export function sortRuns(runs: readonly RunView[], key: RunSortKey, desc: boolean): RunView[] {
  return [...runs].sort((a, b) => {
    const av = sortKeyOf(a, key);
    const bv = sortKeyOf(b, key);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return desc ? -cmp : cmp;
  });
}

export interface Page<T> {
  rows: T[];
  page: number;
  pages: number;
  from: number;
  to: number;
  total: number;
}

export function pageRuns<T>(rows: readonly T[], page: number, pageSize: number): Page<T> {
  const size = pageSize < 1 ? 1 : pageSize;
  const total = rows.length;
  if (total === 0) return { rows: [], page: 0, pages: 1, from: 0, to: 0, total: 0 };
  const pages = Math.ceil(total / size);
  const clamped = Math.min(Math.max(0, page), pages - 1);
  const start = clamped * size;
  const slice = rows.slice(start, start + size);
  return { rows: slice, page: clamped, pages, from: start + 1, to: start + slice.length, total };
}

export function nextSort(current: RunSortKey, desc: boolean, clicked: RunSortKey): { sort: RunSortKey; desc: boolean } {
  if (clicked === current) return { sort: current, desc: !desc };
  return { sort: clicked, desc: true };
}
