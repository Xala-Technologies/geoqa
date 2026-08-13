/**
 * Ask the SERP where a tenant actually stands, per term and per market.
 *
 * The whole file is a loop over `SearchProvider.search()`, and almost all of its
 * substance is about what NOT to claim:
 *
 * - A query that failed produces `score: null`, never `0`. Absent from a populated SERP
 *   is a real low score; unable to look is not a score at all.
 * - `meanScore` averages the MEASURED observations only. Averaging in the failures would
 *   let an exhausted account read as a tenant with poor visibility.
 * - A run that would exceed the search budget is REFUSED before it starts, with the
 *   number it would have spent. Same lesson as the proxy quota, and it is a sharper one
 *   here: a SERP account exhausted halfway through leaves the second half of a report
 *   silently unmeasured, and a report with a hole in it that averages the rest is worse
 *   than no report.
 *
 * Seeds arrive as data — from a tenant's own `keywords.yaml` — so nothing about one
 * company's vocabulary lives in the engine.
 */
import type { Market } from "../geo/types.js";
import { observeSearch } from "../search/observation.js";
import type { SearchProvider } from "../search/types.js";
import type { KeywordObservation, KeywordReport, KeywordSeed } from "./types.js";

/** One (term, market) pair to look up. */
export interface KeywordTask {
  seed: KeywordSeed;
  market: Market;
}

/**
 * Expand seeds × markets into the queries that will actually run.
 *
 * A seed naming `markets` is checked only there. That is not an optimisation: a term
 * about winter access is a real question in Tromsø and noise in Berlin, and querying it
 * everywhere spends credits to learn nothing. A seed naming a market the tenant does not
 * have is dropped with a warning rather than silently ignored — it is a typo in a config
 * file, and the alternative is a term that quietly stops being tracked.
 */
export function expandKeywordTasks(
  seeds: KeywordSeed[],
  markets: Market[],
): { tasks: KeywordTask[]; warnings: string[] } {
  const byId = new Map(markets.map((m) => [m.id, m]));
  const tasks: KeywordTask[] = [];
  const warnings: string[] = [];
  for (const seed of seeds) {
    const wanted = seed.markets ?? markets.map((m) => m.id);
    for (const id of wanted) {
      const market = byId.get(id);
      if (market === undefined) {
        warnings.push(`term "${seed.term}" names market "${id}", which this tenant does not have — skipped`);
        continue;
      }
      tasks.push({ seed, market });
    }
  }
  return { tasks, warnings };
}

export interface ResearchOptions {
  tenantId: string;
  /** The tenant's own site, to look for in the results. */
  ownUrl: string;
  seeds: KeywordSeed[];
  markets: Market[];
  provider: SearchProvider;
  /**
   * How many searches this run may spend. Absent means no ceiling of our own — the
   * provider's `health()` still reports what is left.
   */
  budget?: number | undefined;
  /** How many organic results to examine per query. */
  limit?: number | undefined;
  log?: ((line: string) => void) | undefined;
}

/**
 * Run the research.
 *
 * `health()` is checked FIRST and an unusable provider refuses the whole run. That
 * ordering matters: without it, an exhausted account produces a report of N unmeasured
 * observations, which looks like a tenant with no search presence rather than like a
 * billing problem. One probe up front turns that into one honest sentence.
 */
export async function researchKeywords(options: ResearchOptions): Promise<KeywordReport> {
  const log = options.log ?? ((): void => {});
  const { tasks, warnings } = expandKeywordTasks(options.seeds, options.markets);

  const health = await options.provider.health();
  if (health.state !== "usable") {
    return {
      tenantId: options.tenantId,
      queried: 0,
      measured: 0,
      observations: [],
      meanScore: null,
      warnings: [
        ...warnings,
        `refusing to research: the search provider is ${health.state} — ${health.detail}. Running anyway would produce ${tasks.length} unmeasured observations, which reads like a tenant with no search presence rather than like a provider problem.`,
      ],
    };
  }

  // Refused BEFORE spending anything, with both numbers, so the choice is informed.
  const ceiling = options.budget ?? health.searchesLeft;
  if (ceiling !== null && tasks.length > ceiling) {
    return {
      tenantId: options.tenantId,
      queried: 0,
      measured: 0,
      observations: [],
      meanScore: null,
      warnings: [
        ...warnings,
        `refusing to research: ${tasks.length} query(ies) would exceed the ${ceiling} search(es) available. A provider exhausted halfway through leaves the second half of a report silently unmeasured, and a report with a hole in it that averages the rest is worse than no report. Narrow the seeds or their markets.`,
      ],
    };
  }

  const observations: KeywordObservation[] = [];
  for (const task of tasks) {
    const outcome = await options.provider.search({
      query: task.seed.term,
      country: task.market.country,
      city: task.market.city,
      language: task.market.language,
      limit: options.limit ?? 10,
    });
    const observed = observeSearch(outcome, options.ownUrl);
    observations.push({
      term: task.seed.term,
      intent: task.seed.intent,
      audience: task.seed.audience ?? null,
      marketId: task.market.id,
      score: observed.score,
      position: observed.position,
      examined: observed.examined,
      reason: observed.reason,
      // Who is winning, which is the actionable half of "you are not there". Null when
      // the query failed, because there is no top result to name.
      topCompetitor: outcome.ok ? hostOf(outcome.results[0]?.url) : null,
    });
    log(
      `keywords: ${task.seed.term} @ ${task.market.id} → ${observed.position === null ? (observed.score === null ? "unmeasured" : "absent") : `#${observed.position}`}`,
    );
  }

  const measured = observations.filter((o) => o.score !== null);
  return {
    tenantId: options.tenantId,
    queried: observations.length,
    measured: measured.length,
    observations,
    // Over the MEASURED ones only. Averaging in the failures would let a broken account
    // read as poor visibility.
    meanScore: measured.length === 0 ? null : Math.round(measured.reduce((sum, o) => sum + (o.score ?? 0), 0) / measured.length),
    warnings,
  };
}

const hostOf = (url: string | undefined): string | null => {
  if (url === undefined) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/**
 * The terms worth acting on first: measured, and the tenant is not on the page.
 *
 * Deliberately excludes the unmeasured ones. A list of "things to fix" that includes
 * queries nobody managed to run would send somebody to rewrite a page over a billing
 * problem — and it is exactly the kind of list that gets acted on without being read
 * closely.
 *
 * Ordered by how contested the term is, most results first: a term with a full page of
 * competitors is a real market, while one with two results may be a phrase nobody
 * searches.
 */
export function opportunities(report: KeywordReport): KeywordObservation[] {
  return report.observations
    .filter((o) => o.score !== null && o.position === null)
    .sort((a, b) => (b.examined ?? 0) - (a.examined ?? 0));
}
