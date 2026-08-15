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
import { boundedPool, resolveConcurrency } from "./pool.js";
import { executeRun, type ExecuteOptions } from "./execute.js";
import { describeThrown } from "../errors.js";

/**
 * The concurrency bound and the pool that enforces it live in `run/pool.ts`.
 *
 * Moved there, not copied: invariant 12 says two execution modes and ONE implementation, and
 * the durable matrix workflow needs the same bound and the same loop. It cannot import THIS
 * file — `runMatrix` reaches `executeRun`, which reaches a browser — and a Temporal workflow
 * runs in a deterministic sandbox, so `pool.ts` has no imports at all.
 *
 * The measurement that produced the number, and the reasoning for taking 4 rather than 16,
 * moved with it. Re-exported here so every existing caller keeps its import.
 */
export { DEFAULT_MATRIX_CONCURRENCY, resolveConcurrency } from "./pool.js";

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
// Exported so the durable path maps a workflow's verdicts the same way the in-process one
// does. Two tables would drift, and a matrix that counted a FAIL as a pass on one execution
// mode and not the other is the divergence invariant 12 exists to prevent.
export const OUTCOME_BY_VERDICT: Record<GeoQaRunResult["verdict"], MatrixOutcome> = {
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
  /**
   * Fires when a scenario is about to be planned, before the browser opens.
   *
   * The live board needs to show a session the moment it is claimed, not the
   * moment it finishes — `onScenario` is completion order and is too late for
   * screening.
   */
  onStart?: (scenario: MatrixScenario) => void;
  /**
   * Run these instead of expanding `axes`.
   *
   * Continuous sampling walks a cursor through the cartesian product and
   * hands a slice here. Expanding `axes` from that slice would re-form the
   * rectangle and launch combinations the cursor had not reached.
   */
  scenarios?: MatrixScenario[];
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
  return describeThrown(thrown);
}

/** The whole matrix. Never throws for a scenario's sake. */
export async function runMatrix(options: MatrixOptions): Promise<MatrixResult> {
  const now = options.now ?? Date.now;
  const run = options.run ?? executeRun;
  const limit = resolveConcurrency(options.concurrency);
  const scenarios = options.scenarios ?? expandMatrix(options.axes);
  const startedMs = now();

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
    options.onStart?.(scenario);
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

  // The SHARED pool: the same loop and the same bound the durable matrix workflow uses. It
  // lives in `run/pool.ts` with no imports, because a Temporal workflow cannot pull in this
  // file's dependency graph and invariant 12 does not accept two copies of one rule.
  //
  // `attempt` never throws — see its comment — which is the pool's stated contract rather than
  // something it defends against: a rejected task would reject the pool and leave every queued
  // scenario unattempted, so the gaps would be indistinguishable from markets that were fine.
  const pooled = await boundedPool(scenarios, limit, async (scenario) => {
    const outcome = await attempt(scenario);
    options.onScenario?.(outcome);
    return outcome;
  });
  const collected = pooled.results;
  const peakInFlight = pooled.peakInFlight;

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
