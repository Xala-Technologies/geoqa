/**
 * Site-level analysis across a sweep — and specifically the half of SEO that only this
 * engine can answer.
 *
 * **What this deliberately does NOT compute, checked rather than assumed.** The slice
 * named thin pages, orphans, soft 404s and near-duplicate cannibalisation. Those need
 * page TEXT and the internal LINK GRAPH, and the evidence carries neither: a run records
 * verdicts, findings, vitals, geography and confidence, and the journey's `getText` result
 * is used for a check and then discarded. Computing them would mean inventing the inputs,
 * so they are named in `docs/gaps.md` with the evidence change that would close them
 * rather than approximated here. A thin-page report built on a guess about page length is
 * worse than no thin-page report, because somebody would rewrite a page over it.
 *
 * What IS computable is the part no other SEO tool has, because no other tool measures
 * from inside the market: **the same page, compared across markets.** A page that is fast
 * in Oslo and slow in Bodø is one page with one URL and one set of HTML, and the
 * difference is entirely about where the visitor is. That is invisible to any crawler
 * running from one datacentre, and it is sitting in the run history already.
 */
import type { RunRecord } from "../history/records.js";

/** One page, as every market saw it. */
export interface PageAcrossMarkets {
  target: string;
  /** Per-market readings, market id → reading. */
  markets: Record<string, { verdict: string; ttfbMs: number | null; lcpMs: number | null; confidence: number }>;
  /**
   * Slowest minus fastest TTFB, in ms, or null when fewer than two markets produced one.
   *
   * Null rather than 0 for a single market: "one market measured" and "every market
   * identical" are different facts, and a spread of 0 claims the second.
   */
  ttfbSpreadMs: number | null;
  /** Markets whose verdict differs from the most common one. The interesting list. */
  divergentMarkets: string[];
}

export interface SiteReport {
  /** Distinct pages seen. */
  pages: number;
  /** Market ids that appear anywhere in the data. */
  markets: string[];
  perPage: PageAcrossMarkets[];
  /**
   * Pages measured in SOME markets but not all, with the missing ones.
   *
   * A coverage gap, and it matters more than it looks: a page nobody measured in Bodø is
   * not a page that works in Bodø, and a report that silently omitted it would read as
   * full coverage.
   */
  coverageGaps: { target: string; missing: string[] }[];
  /** Pages whose verdict is not the same everywhere — where geography changed the outcome. */
  geographicallyDivergent: PageAcrossMarkets[];
  /** The widest TTFB spreads, worst first. Only pages measured in 2+ markets. */
  widestLatencyGaps: PageAcrossMarkets[];
  warnings: string[];
}

/**
 * Which market a run was in.
 *
 * Derived from the profile id, because a `RunRecord` stores `profileId` rather than a
 * market id — and the repo's profiles are named `<market>-<device>`. That coupling is
 * worth stating: a profile named differently would land in a market of its own here
 * rather than corrupting another one, which is the safe direction.
 */
export function marketOf(profileId: string): string {
  const match = /^(.+?)-(?:mobile|desktop)(?:-.+)?$/.exec(profileId);
  return match?.[1] ?? profileId;
}

/**
 * The median, ROUNDED to whole milliseconds.
 *
 * Rounded here rather than at render time so every consumer gets the same number — and
 * because `performance.timing` values arrive as floats, so an unrounded reading prints as
 * `467.19999998807907ms`. Sub-millisecond precision in a network measurement is noise
 * dressed as rigour, and it makes a report look like it was never read by anybody.
 */
const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
  return Math.round(value);
};

/**
 * Build the report.
 *
 * `ERROR` runs are EXCLUDED from every comparison, and that is the load-bearing decision.
 * An `ERROR` means geoqa could not read the page, so including it would make our own
 * instrumentation failure look like a market where the site behaves differently — which is
 * precisely the false geographic finding this whole project exists to avoid. They are
 * counted in a warning instead, so their absence is visible rather than silent.
 */
export function analyseSite(records: RunRecord[]): SiteReport {
  const warnings: string[] = [];
  const errored = records.filter((r) => r.verdict === "ERROR");
  if (errored.length > 0) {
    warnings.push(
      `${errored.length} run(s) errored and are excluded from every comparison: an ERROR means geoqa could not read the page, so counting it would make our own instrumentation failure look like a market where the site behaves differently.`,
    );
  }
  const usable = records.filter((r) => r.verdict !== "ERROR");

  const allMarkets = [...new Set(usable.map((r) => marketOf(r.profileId)))].sort();
  const byTarget = new Map<string, RunRecord[]>();
  for (const record of usable) byTarget.set(record.target, [...(byTarget.get(record.target) ?? []), record]);

  const perPage: PageAcrossMarkets[] = [];
  for (const [target, runs] of [...byTarget.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const markets: PageAcrossMarkets["markets"] = {};
    const byMarket = new Map<string, RunRecord[]>();
    for (const run of runs) {
      const id = marketOf(run.profileId);
      byMarket.set(id, [...(byMarket.get(id) ?? []), run]);
    }
    for (const [id, marketRuns] of byMarket) {
      // The MEDIAN across repeats of one market, not the latest: a single slow run is
      // noise, and the latest is whichever happened to finish last.
      const latest = marketRuns.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
      markets[id] = {
        verdict: latest.verdict,
        ttfbMs: median(marketRuns.map((r) => r.vitals.ttfb).filter((v): v is number => v !== null)),
        lcpMs: median(marketRuns.map((r) => r.vitals.lcp).filter((v): v is number => v !== null)),
        confidence: latest.confidence.overall,
      };
    }

    const ttfbs = Object.values(markets).map((m) => m.ttfbMs).filter((v): v is number => v !== null);
    const verdicts = Object.values(markets).map((m) => m.verdict);
    const commonest = mostCommon(verdicts);
    perPage.push({
      target,
      markets,
      // Null with fewer than two readings: "one market measured" and "every market
      // identical" are different facts, and 0 claims the second.
      ttfbSpreadMs: ttfbs.length < 2 ? null : Math.max(...ttfbs) - Math.min(...ttfbs),
      divergentMarkets: Object.entries(markets).filter(([, m]) => m.verdict !== commonest).map(([id]) => id),
    });
  }

  const coverageGaps = perPage
    .map((page) => ({ target: page.target, missing: allMarkets.filter((m) => !(m in page.markets)) }))
    .filter((gap) => gap.missing.length > 0);

  return {
    pages: perPage.length,
    markets: allMarkets,
    perPage,
    coverageGaps,
    geographicallyDivergent: perPage.filter((p) => p.divergentMarkets.length > 0),
    widestLatencyGaps: perPage
      .filter((p) => p.ttfbSpreadMs !== null)
      .sort((a, b) => (b.ttfbSpreadMs ?? 0) - (a.ttfbSpreadMs ?? 0))
      .slice(0, 10),
    warnings,
  };
}

const mostCommon = (values: string[]): string | null => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  // Ties resolve to the first in insertion order, which is deterministic for a sorted
  // input — so a page split evenly across markets reports the same divergent set every
  // run rather than flapping.
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
};

/**
 * The sentence a local-numbers-are-fine argument dies on.
 *
 * Kept as its own function because it is the single most useful output of the whole
 * analysis and it deserves to be quotable: a page's latency measured from one place says
 * nothing about the others, and this puts a number on how much.
 */
export function describeLatencySpread(page: PageAcrossMarkets): string {
  const entries = Object.entries(page.markets)
    .filter((e): e is [string, { verdict: string; ttfbMs: number; lcpMs: number | null; confidence: number }] => e[1].ttfbMs !== null)
    .sort((a, b) => a[1].ttfbMs - b[1].ttfbMs);
  if (entries.length < 2) return `${page.target}: measured in fewer than two markets, so there is no spread to report`;
  const [fastest] = entries;
  const slowest = entries[entries.length - 1];
  if (fastest === undefined || slowest === undefined) return `${page.target}: no latency readings`;
  const factor = fastest[1].ttfbMs === 0 ? null : Math.round((slowest[1].ttfbMs / fastest[1].ttfbMs) * 10) / 10;
  return `${page.target}: TTFB ${fastest[1].ttfbMs}ms in ${fastest[0]} vs ${slowest[1].ttfbMs}ms in ${slowest[0]}${factor === null ? "" : ` — ${factor}x`}`;
}
