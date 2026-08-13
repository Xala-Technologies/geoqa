/**
 * The market × device × journey matrix, in one process, with a bounded pool.
 *
 * This is the in-process half of the shape `temporal/workflows.ts` already has
 * durably: `geoQaMatrixWorkflow` fans out to CHILD workflows precisely so one
 * market failing does not take the matrix with it. A loop of `await executeRun`
 * would have neither property — the first throw would abort the remaining
 * scenarios and the matrix would report nothing about markets it never tried.
 * So the two rules that shape this file are the same two: **one scenario's
 * failure is an outcome, not the end of the run**, and **a scenario we could not
 * execute is recorded, never dropped**.
 *
 * Two things this deliberately does NOT know:
 *
 * - How a coordinate becomes a run. `plan` is injected, so this file needs no
 *   profile paths, no `prepareRun`, and no network provider. A caller maps
 *   market+device onto a profile (the repo's profiles are named
 *   `<market>-<device>`) and journey onto a journey file; a `plan` that REFUSES
 *   — `prepareRun` throws rather than silently degrading a market to direct
 *   egress — becomes an `unmeasured` scenario here, which is the honest reading:
 *   we could not look, and that is not a pass.
 * - Anything about Temporal. Importing `temporal/` would make the matrix
 *   unrunnable without a Temporal server, exactly as it would for a stage.
 */
import type { GeoQaRunResult } from "../findings/types.js";
import { executeRun, type ExecuteOptions } from "./execute.js";

/**
 * How many scenarios may be in flight at once when a caller does not say.
 *
 * Each in-flight scenario costs a browser context and, on agent-browser, an
 * ENTIRE Chrome process — one profile is one browser there, because the proxy is
 * a launch flag (architecture §13). Picking a parallelism number before
 * measuring is how the first OOM happens, so this is the smallest bound that is
 * not sequential: it proves the scheduler and at most doubles peak memory.
 *
 * MEASURED, finally, but on one machine — so raised rather than derived. EXP-007
 * now runs, and on a 14-core / 36 GB laptop against a local fixture server it
 * reported 100% completion, 100% verdict agreement and 100% egress-held at every
 * level tried, with wall clock per session barely moving:
 *
 *   concurrency  2 → x1.01     8 → x1.14
 *                4 → x1.01    12 → x1.09
 *                             16 → x1.30
 *
 * Four is the new default and not sixteen, deliberately. The measurement covers ONE
 * machine, and a default has to be safe on the smallest one that will run this — a
 * 2-core CI runner would be worse at 4 than the old 2, let alone at 16. Raising to 4
 * captures most of the win (the numbers are flat to 12 here) while staying within
 * `cores - 2` on any machine anybody would run a browser matrix on.
 *
 * `peak-memory-per-session` remains permanently unmeasurable from this process — the
 * browser is a separate daemon on one engine and an unsampled child on the other — so
 * EXP-007's overall verdict is `unmeasured` and the OOM risk that originally kept this
 * at 1 is still unquantified. That is the honest reason not to go higher on the
 * strength of wall clock alone.
 *
 * A CPU-derived bound (`min(4, max(2, cores - 2))`) is the obvious next step and is
 * NOT taken here, because it would be generalising a formula from a single data point
 * — which is the kind of unmeasured leap this file's history is a record of avoiding.
 * `MatrixResult.concurrency` still carries both the bound and the peak reached.
 */
export const DEFAULT_MATRIX_CONCURRENCY = 4;

/** The three axes. Values are ids, not paths — `plan` resolves those. */
export interface MatrixAxes {
  markets: string[];
  devices: string[];
  journeys: string[];
  /**
   * Pages to visit. Absent or empty means one scenario per market/device/journey
   * against whatever single target the caller configured.
   *
   * This axis exists because a site-wide sweep had no bounded path through the
   * engine at all: 430 pages were driven from a shell loop, which ran alongside
   * three other fleets and made `selector-visible` report a missing `h1` on six
   * pages that demonstrably had one. Every one passed when re-run alone. A sweep
   * that cannot be bounded is a sweep that eventually invents defects out of its
   * own load, so the URL list belongs inside the pool rather than outside it.
   */
  targets?: string[];
}

export interface MatrixScenario {
  /** Position in the expansion. The sort key that makes results diffable. */
  index: number;
  /** `<market>/<device>/<journey>[/<target>]` — stable, so two runs diff. */
  key: string;
  market: string;
  device: string;
  journey: string;
  /** Overrides the caller's target when the matrix carries a URL axis. */
  target: string | null;
}

/**
 * What became of one scenario.
 *
 * `unmeasured` is a separate state from `siteFailed` for the reason the whole
 * codebase exists: "the site is wrong" and "we could not look" lead a human to
 * different actions, and collapsing them is the one failure this project treats
 * as unacceptable. It covers both an `ERROR` verdict (the run happened, its
 * instrumentation did not) and a throw (no run result at all) — distinguishable
 * by whether `result` is null.
 */
export type MatrixOutcome = "passed" | "warned" | "siteFailed" | "unmeasured";

/**
 * A run verdict, as a matrix outcome.
 *
 * A record rather than a switch so that a new `GeoQaRunResult` verdict is a
 * compile error here instead of quietly falling into a default arm — the arm it
 * would fall into is a lie in one direction or the other.
 */
const OUTCOME_BY_VERDICT: Record<GeoQaRunResult["verdict"], MatrixOutcome> = {
  PASS: "passed",
  PASS_WITH_WARNINGS: "warned",
  FAIL: "siteFailed",
  ERROR: "unmeasured",
};

export interface MatrixScenarioResult {
  scenario: MatrixScenario;
  outcome: MatrixOutcome;
  /** Null exactly when no run result arrived — the scenario threw. */
  result: GeoQaRunResult | null;
  /** The throw's message, or null. Never both null and `result` null. */
  error: string | null;
  startedAt: string;
  durationMs: number;
}

export interface MatrixCounts {
  total: number;
  passed: number;
  warned: number;
  siteFailed: number;
  unmeasured: number;
}

/** Same words and the same ranking as a single run's verdict. */
export type MatrixVerdict = GeoQaRunResult["verdict"];

export interface MatrixResult {
  startedAt: string;
  durationMs: number;
  /** What EXP-007 needs: the bound applied, and the peak actually reached. */
  concurrency: { limit: number; peakInFlight: number };
  /** In expansion order, whatever order they finished in. */
  scenarios: MatrixScenarioResult[];
  counts: MatrixCounts;
  verdict: MatrixVerdict;
}

export interface MatrixOptions {
  axes: MatrixAxes;
  /**
   * Turn one coordinate into a run. Async because preparing a run opens a
   * network session for the market, and a market the provider cannot serve must
   * throw rather than degrade.
   */
  plan: (scenario: MatrixScenario) => Promise<ExecuteOptions>;
  /** Defaults to `DEFAULT_MATRIX_CONCURRENCY`. */
  concurrency?: number;
  /** Injected so the suite never launches a browser. */
  run?: (options: ExecuteOptions) => Promise<GeoQaRunResult>;
  now?: () => number;
  /**
   * Progress. Fires in COMPLETION order, which under concurrency is not the
   * order of `scenarios` — a caller that prints these is printing a race, and
   * only the returned array is diffable.
   */
  onScenario?: (outcome: MatrixScenarioResult) => void;
}

/**
 * Every combination, once, in an order that depends on the SET of axis values
 * rather than the order they were passed.
 *
 * Both halves matter for diffing two matrix runs. Duplicates are dropped
 * because a config listing `oslo` twice would otherwise pay for the same Chrome
 * twice and emit two rows with the same key; the sort is so that
 * `--market oslo,berlin` and `--market berlin,oslo` produce byte-identical
 * output instead of a diff that is entirely argument order.
 */
export function expandMatrix(axes: MatrixAxes): MatrixScenario[] {
  const distinct = (values: string[]): string[] => [...new Set(values)].sort();
  const scenarios: MatrixScenario[] = [];
  // A single `null` target keeps the no-URL-axis shape identical to before.
  // Targets are NOT sorted or de-duplicated: sitemap order is meaningful to a
  // human reading the results, and a repeated URL is a legitimate way to ask for
  // a second sample of one page.
  const targets: (string | null)[] = axes.targets && axes.targets.length > 0 ? [...axes.targets] : [null];
  for (const market of distinct(axes.markets)) {
    for (const device of distinct(axes.devices)) {
      for (const journey of distinct(axes.journeys)) {
        for (const target of targets) {
          scenarios.push({
            index: scenarios.length,
            key: target === null ? `${market}/${device}/${journey}` : `${market}/${device}/${journey}/${target}`,
            market,
            device,
            journey,
            target,
          });
        }
      }
    }
  }
  return scenarios;
}

/**
 * At least one, an integer, and never unbounded by accident.
 *
 * A non-finite request (`NaN` from a bad `--concurrency` parse) falls back to
 * the default instead of becoming `Infinity` in-flight scenarios: an argument
 * this runner could not understand must not be read as "launch everything".
 */
export function resolveConcurrency(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MATRIX_CONCURRENCY;
  return Math.max(1, Math.floor(requested));
}

export function countScenarios(results: MatrixScenarioResult[]): MatrixCounts {
  const of = (outcome: MatrixOutcome): number => results.filter((r) => r.outcome === outcome).length;
  return {
    total: results.length,
    passed: of("passed"),
    warned: of("warned"),
    siteFailed: of("siteFailed"),
    unmeasured: of("unmeasured"),
  };
}

/**
 * `ERROR` > `FAIL` > `PASS_WITH_WARNINGS` > `PASS`, the same ranking a single
 * run uses, and for the same reason: "we do not know" outranks "the page is
 * broken" because it is the answer a human has to act on first.
 *
 * An EMPTY matrix is `ERROR`, not `PASS`. Zero scenarios is zero evidence, and
 * a green verdict over nothing measured is the exact shape of lie this codebase
 * is built to refuse (see `overallVerdict` in `experiments/harness.ts`, which
 * calls zero metrics `unmeasured` for the same reason).
 */
export function matrixVerdict(counts: MatrixCounts): MatrixVerdict {
  if (counts.total === 0 || counts.unmeasured > 0) return "ERROR";
  if (counts.siteFailed > 0) return "FAIL";
  return counts.warned > 0 ? "PASS_WITH_WARNINGS" : "PASS";
}

function errorMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** The whole matrix. Never throws for a scenario's sake. */
export async function runMatrix(options: MatrixOptions): Promise<MatrixResult> {
  const now = options.now ?? Date.now;
  const run = options.run ?? executeRun;
  const limit = resolveConcurrency(options.concurrency);
  const scenarios = expandMatrix(options.axes);
  const startedMs = now();

  let peakInFlight = 0;
  let inFlight = 0;
  let next = 0;
  const collected: MatrixScenarioResult[] = [];

  /**
   * One scenario, and the reason this returns instead of throwing: a scenario
   * that threw is a RECORDED outcome with its error attached. If it propagated,
   * `Promise.all` below would reject and every scenario still queued would
   * simply never be attempted, leaving a matrix whose gaps are indistinguishable
   * from markets that were fine.
   */
  const attempt = async (scenario: MatrixScenario): Promise<MatrixScenarioResult> => {
    const scenarioStartedMs = now();
    const startedAt = new Date(scenarioStartedMs).toISOString();
    try {
      const result = await run(await options.plan(scenario));
      return {
        scenario,
        outcome: OUTCOME_BY_VERDICT[result.verdict],
        result,
        error: null,
        startedAt,
        durationMs: now() - scenarioStartedMs,
      };
    } catch (thrown) {
      // A throw is OUR blindness, never a site defect: whatever the site did,
      // this scenario produced no reading of it, so it cannot be filed against
      // the site and must not be counted as a pass.
      return {
        scenario,
        outcome: "unmeasured",
        result: null,
        error: errorMessage(thrown),
        startedAt,
        durationMs: now() - scenarioStartedMs,
      };
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const scenario = scenarios[next++];
      if (scenario === undefined) return;
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        const outcome = await attempt(scenario);
        collected.push(outcome);
        options.onScenario?.(outcome);
      } finally {
        // In a `finally` so a bug in the bookkeeping above cannot leave the pool
        // believing a slot is permanently occupied.
        inFlight--;
      }
    }
  };

  // Never more workers than scenarios, so an empty matrix starts nothing.
  await Promise.all(Array.from({ length: Math.min(limit, scenarios.length) }, worker));

  // Sorted back into expansion order, because the array is filled in completion
  // order and two runs of the same matrix have to be diffable.
  const ordered = [...collected].sort((a, b) => a.scenario.index - b.scenario.index);
  const counts = countScenarios(ordered);
  return {
    startedAt: new Date(startedMs).toISOString(),
    durationMs: now() - startedMs,
    concurrency: { limit, peakInFlight },
    scenarios: ordered,
    counts,
    verdict: matrixVerdict(counts),
  };
}
