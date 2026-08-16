import { describe, expect, it } from "vitest";
import type { GeoQaRunResult } from "../../findings/types.js";
import type { ExecuteOptions } from "../execute.js";
import {
  DEFAULT_MATRIX_CONCURRENCY,
  countScenarios,
  expandMatrix,
  matrixVerdict,
  resolveConcurrency,
  runMatrix,
  type MatrixAxes,
  type MatrixScenario,
  type MatrixScenarioResult,
} from "../matrix.js";

/**
 * The matrix reads exactly two fields of a run result — `verdict` and, for a
 * caller's benefit, whatever it passes through untouched. Building a full
 * `GeoQaRunResult` (a whole GeoVerification and ConfidenceReport) would be noise
 * around the property under test, so the fake is cast, as the browser fakes are.
 */
const runResult = (runId: string, verdict: GeoQaRunResult["verdict"]): GeoQaRunResult =>
  ({ runId, verdict }) as unknown as GeoQaRunResult;

/** `plan` normally resolves profiles and opens a network session; here it labels. */
const plan = (scenario: MatrixScenario): Promise<ExecuteOptions> =>
  Promise.resolve({ spec: { runId: scenario.key } } as unknown as ExecuteOptions);

const axes = (over: Partial<MatrixAxes> = {}): MatrixAxes => ({
  markets: ["oslo"],
  devices: ["mobile"],
  journeys: ["landing-page"],
  ...over,
});

/** Yield the microtask queue N times. No timers: the suite must never sleep. */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const keys = (results: MatrixScenarioResult[]): string[] => results.map((r) => r.scenario.key);
const keysOf = (scenarios: MatrixScenario[]): string[] => scenarios.map((s) => s.key);

describe("expandMatrix", () => {
  it("expands market x device x journey into every combination exactly once", () => {
    const scenarios = expandMatrix({
      markets: ["oslo", "berlin"],
      devices: ["mobile", "desktop"],
      journeys: ["browse", "reader"],
    });
    expect(scenarios).toHaveLength(8);
    expect(new Set(keysOf(scenarios)).size).toBe(8);
    expect(scenarios.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("orders by the SET of axis values, so argument order cannot show up as a diff", () => {
    const one = expandMatrix({ markets: ["oslo", "berlin"], devices: ["mobile"], journeys: ["a", "b"] });
    const other = expandMatrix({ markets: ["berlin", "oslo"], devices: ["mobile"], journeys: ["b", "a"] });
    expect(keysOf(other)).toEqual(keysOf(one));
    expect(keysOf(one)).toEqual(["berlin/mobile/a", "berlin/mobile/b", "oslo/mobile/a", "oslo/mobile/b"]);
  });

  it("REFUSES to pay for a duplicated axis value twice", () => {
    const scenarios = expandMatrix({ markets: ["oslo", "oslo"], devices: ["mobile"], journeys: ["browse"] });
    expect(keysOf(scenarios)).toEqual(["oslo/mobile/browse"]);
  });
});

describe("resolveConcurrency", () => {
  it("defaults to a bound that is measured, and still safe on a small machine", () => {
    // Was `< 4` while the number was a placeholder. EXP-007 now measures it: on a
    // 14-core laptop, completion, verdict agreement and egress-held were all 100% from
    // 2 to 16, with wall clock per session at x1.01 (4), x1.14 (8) and x1.30 (16).
    //
    // The upper bound here is 8 rather than 16 because the default has to be safe on the
    // SMALLEST machine that will run this — a 2-core CI runner is worse at 16 than at 2
    // — and because `peak-memory-per-session` is permanently unmeasurable from this
    // process, so the OOM risk that originally kept this at 1 is still unquantified.
    expect(resolveConcurrency()).toBe(DEFAULT_MATRIX_CONCURRENCY);
    expect(DEFAULT_MATRIX_CONCURRENCY).toBeGreaterThan(0);
    expect(DEFAULT_MATRIX_CONCURRENCY).toBeLessThanOrEqual(8);
  });

  it("reads an unparseable request as the default, never as unlimited", () => {
    expect(resolveConcurrency(Number.NaN)).toBe(DEFAULT_MATRIX_CONCURRENCY);
    expect(resolveConcurrency(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MATRIX_CONCURRENCY);
  });

  it("clamps a nonsensical bound up to one whole scenario at a time", () => {
    expect(resolveConcurrency(0)).toBe(1);
    expect(resolveConcurrency(-5)).toBe(1);
    expect(resolveConcurrency(3.9)).toBe(3);
  });
});

describe("matrixVerdict", () => {
  const counts = (over: Partial<ReturnType<typeof countScenarios>> = {}): ReturnType<typeof countScenarios> => ({
    total: 1,
    passed: 1,
    warned: 0,
    siteFailed: 0,
    unmeasured: 0,
    ...over,
  });

  it("ranks what we could not measure above what we found broken", () => {
    expect(matrixVerdict(counts({ total: 2, passed: 0, siteFailed: 1, unmeasured: 1 }))).toBe("ERROR");
    expect(matrixVerdict(counts({ total: 2, passed: 1, siteFailed: 1 }))).toBe("FAIL");
    expect(matrixVerdict(counts({ total: 2, passed: 1, warned: 1 }))).toBe("PASS_WITH_WARNINGS");
    expect(matrixVerdict(counts())).toBe("PASS");
  });

  it("REFUSES to call an empty matrix a pass", () => {
    expect(matrixVerdict(counts({ total: 0, passed: 0 }))).toBe("ERROR");
  });
});

describe("runMatrix", () => {
  it("hands each scenario the run options ITS OWN plan produced", async () => {
    const seen: string[] = [];
    const matrix = await runMatrix({
      axes: axes({ markets: ["oslo", "berlin"], journeys: ["a", "b"] }),
      plan,
      concurrency: 1,
      run: (options) => {
        seen.push(options.spec.runId);
        return Promise.resolve(runResult(options.spec.runId, "PASS"));
      },
    });
    expect(seen.sort()).toEqual(["berlin/mobile/a", "berlin/mobile/b", "oslo/mobile/a", "oslo/mobile/b"]);
    expect(matrix.scenarios.map((s) => s.result?.runId)).toEqual(keys(matrix.scenarios));
  });

  it("NEVER puts more scenarios in flight than the bound allows", async () => {
    let inFlight = 0;
    let peak = 0;
    const matrix = await runMatrix({
      axes: axes({ markets: ["a", "b", "c", "d"], devices: ["mobile", "desktop"] }),
      plan,
      concurrency: 3,
      run: async (options) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await settle(3);
        inFlight--;
        return runResult(options.spec.runId, "PASS");
      },
    });
    expect(matrix.scenarios).toHaveLength(8);
    expect(peak).toBe(3);
    // Recorded on the result because this is the number EXP-007 exists to
    // measure: a matrix that OOMs must still be able to say what it attempted.
    expect(matrix.concurrency).toEqual({ limit: 3, peakInFlight: 3 });
  });

  it("runs strictly one at a time when the bound is one", async () => {
    let inFlight = 0;
    let peak = 0;
    const matrix = await runMatrix({
      axes: axes({ journeys: ["a", "b", "c"] }),
      plan,
      concurrency: 1,
      run: async (options) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await settle(2);
        inFlight--;
        return runResult(options.spec.runId, "PASS");
      },
    });
    expect(peak).toBe(1);
    expect(matrix.concurrency.peakInFlight).toBe(1);
  });

  it("RECORDS a scenario that threw and keeps running the rest", async () => {
    const matrix = await runMatrix({
      axes: axes({ journeys: ["a", "boom", "c"] }),
      plan,
      concurrency: 2,
      run: (options) => {
        if (options.spec.runId.includes("boom")) return Promise.reject(new Error("chrome died"));
        return Promise.resolve(runResult(options.spec.runId, "PASS"));
      },
    });
    expect(keys(matrix.scenarios)).toHaveLength(3);
    const failed = matrix.scenarios[1];
    expect(failed?.scenario.journey).toBe("boom");
    expect(failed?.outcome).toBe("unmeasured");
    expect(failed?.error).toBe("chrome died");
    expect(failed?.result).toBeNull();
    expect(matrix.counts).toMatchObject({ total: 3, passed: 2, unmeasured: 1 });
  });

  it("records a REFUSED preparation as unmeasured rather than dropping the scenario", async () => {
    // `prepareRun` throws rather than silently degrading a market it cannot
    // serve to direct egress. That refusal must survive into the matrix as a
    // market we could not look at — not as a hole, and never as a pass.
    const matrix = await runMatrix({
      axes: axes({ markets: ["oslo", "tokyo"] }),
      plan: (scenario) =>
        scenario.market === "tokyo"
          ? Promise.reject(new Error(`provider cannot serve ${scenario.market}`))
          : plan(scenario),
      run: (options) => Promise.resolve(runResult(options.spec.runId, "PASS")),
    });
    expect(matrix.scenarios).toHaveLength(2);
    const refused = matrix.scenarios.find((s) => s.scenario.market === "tokyo");
    expect(refused?.outcome).toBe("unmeasured");
    expect(refused?.error).toBe("provider cannot serve tokyo");
    expect(matrix.verdict).toBe("ERROR");
  });

  it("keeps a non-Error throw readable instead of losing it", async () => {
    const matrix = await runMatrix({
      axes: axes(),
      plan,
      run: () => Promise.reject("string thrown from a daemon wrapper"),
    });
    expect(matrix.scenarios[0]?.error).toBe("string thrown from a daemon wrapper");
    expect(matrix.scenarios[0]?.outcome).toBe("unmeasured");
  });

  it("distinguishes a wrong SITE from our own blindness in the aggregate", async () => {
    const verdicts: Record<string, GeoQaRunResult["verdict"]> = {
      "oslo/mobile/a": "PASS",
      "oslo/mobile/b": "PASS_WITH_WARNINGS",
      "oslo/mobile/c": "FAIL",
      "oslo/mobile/d": "ERROR",
    };
    const matrix = await runMatrix({
      axes: axes({ journeys: ["a", "b", "c", "d", "throws"] }),
      plan,
      run: (options) => {
        const verdict = verdicts[options.spec.runId];
        if (verdict === undefined) return Promise.reject(new Error("no reading"));
        return Promise.resolve(runResult(options.spec.runId, verdict));
      },
    });
    expect(matrix.counts).toEqual({ total: 5, passed: 1, warned: 1, siteFailed: 1, unmeasured: 2 });
    // The ERROR run and the throw land in the same bucket — both are "we could
    // not look" — while the FAIL stays its own count.
    expect(matrix.scenarios.filter((s) => s.outcome === "unmeasured").map((s) => s.scenario.journey)).toEqual([
      "d",
      "throws",
    ]);
    expect(matrix.verdict).toBe("ERROR");
  });

  it("reports FAIL when the site was wrong and nothing was unreadable", async () => {
    const matrix = await runMatrix({
      axes: axes({ journeys: ["a", "b"] }),
      plan,
      run: (options) =>
        Promise.resolve(runResult(options.spec.runId, options.spec.runId.endsWith("a") ? "FAIL" : "PASS")),
    });
    expect(matrix.verdict).toBe("FAIL");
    expect(matrix.counts.unmeasured).toBe(0);
  });

  it("orders results by the matrix, not by who finished first", async () => {
    const finished: string[] = [];
    const matrix = await runMatrix({
      axes: axes({ journeys: ["a", "b", "c", "d"] }),
      plan,
      concurrency: 4,
      run: async (options) => {
        // Reverse the completion order: "d" resolves first, "a" last.
        const distance = "abcd".length - "abcd".indexOf(options.spec.runId.slice(-1));
        await settle(distance * 2);
        finished.push(options.spec.runId);
        return runResult(options.spec.runId, "PASS");
      },
    });
    expect(finished).toEqual(["oslo/mobile/d", "oslo/mobile/c", "oslo/mobile/b", "oslo/mobile/a"]);
    expect(keys(matrix.scenarios)).toEqual([
      "oslo/mobile/a",
      "oslo/mobile/b",
      "oslo/mobile/c",
      "oslo/mobile/d",
    ]);
  });

  it("announces progress in completion order while the result stays sorted", async () => {
    const announced: string[] = [];
    const matrix = await runMatrix({
      axes: axes({ journeys: ["a", "b"] }),
      plan,
      concurrency: 2,
      run: async (options) => {
        await settle(options.spec.runId.endsWith("b") ? 1 : 3);
        return runResult(options.spec.runId, "PASS");
      },
      onScenario: (outcome) => announced.push(outcome.scenario.key),
    });
    expect(announced).toEqual(["oslo/mobile/b", "oslo/mobile/a"]);
    expect(keys(matrix.scenarios)).toEqual(["oslo/mobile/a", "oslo/mobile/b"]);
  });

  it("runs an explicit slice instead of re-expanding the axes into a rectangle", async () => {
    const seen: string[] = [];
    const slice = [
      { index: 0, key: "oslo/mobile/a", market: "oslo", device: "mobile", journey: "a", target: "https://a.test" },
      { index: 1, key: "bergen/desktop/b", market: "bergen", device: "desktop", journey: "b", target: "https://b.test" },
    ];
    await runMatrix({
      axes: { markets: ["oslo", "bergen"], devices: ["mobile", "desktop"], journeys: ["a", "b"] },
      scenarios: slice,
      plan: (scenario) => Promise.resolve({ spec: { runId: scenario.key } } as unknown as ExecuteOptions),
      run: async (options) => {
        seen.push(options.spec.runId);
        return runResult(options.spec.runId, "PASS");
      },
    });
    expect(seen).toEqual(["oslo/mobile/a", "bergen/desktop/b"]);
  });

  it("announces a scenario at START, before the browser opens", async () => {
    const started: string[] = [];
    await runMatrix({
      axes: axes({ journeys: ["a"] }),
      plan,
      onStart: (scenario) => started.push(scenario.key),
      run: () => Promise.resolve(runResult("x", "PASS")),
    });
    expect(started).toEqual(["oslo/mobile/a"]);
  });

  it("times the matrix from the INJECTED clock, so no test waits on a wall clock", async () => {
    let tick = 1_700_000_000_000;
    const matrix = await runMatrix({
      axes: axes({ journeys: ["a", "b"] }),
      plan,
      concurrency: 1,
      now: () => (tick += 1_000),
      run: (options) => Promise.resolve(runResult(options.spec.runId, "PASS")),
    });
    expect(matrix.startedAt).toBe("2023-11-14T22:13:21.000Z");
    expect(matrix.durationMs).toBeGreaterThan(0);
    expect(matrix.scenarios.every((s) => s.durationMs > 0)).toBe(true);
    expect(matrix.scenarios[0]?.startedAt).not.toBe(matrix.scenarios[1]?.startedAt);
  });

  it("returns an ERROR over an empty matrix without ever calling the runner", async () => {
    let called = 0;
    const matrix = await runMatrix({
      axes: axes({ journeys: [] }),
      plan,
      run: () => {
        called++;
        return Promise.resolve(runResult("never", "PASS"));
      },
    });
    expect(called).toBe(0);
    expect(matrix.scenarios).toEqual([]);
    expect(matrix.counts.total).toBe(0);
    expect(matrix.verdict).toBe("ERROR");
    expect(matrix.concurrency.peakInFlight).toBe(0);
  });

  it("defaults its runner to executeRun, so a caller cannot forget to pass one", async () => {
    // Proven without a browser: the default is only reached when `run` is
    // omitted, and a plan that refuses means executeRun is never entered.
    const matrix = await runMatrix({
      axes: axes(),
      plan: () => Promise.reject(new Error("planning refused before any browser")),
    });
    expect(matrix.scenarios[0]?.error).toBe("planning refused before any browser");
  });
});

describe("countScenarios", () => {
  it("counts every outcome separately, including the ones nobody wants to see", () => {
    const at = (index: number, outcome: MatrixScenarioResult["outcome"]): MatrixScenarioResult => ({
      scenario: { index, key: `k${index}`, market: "oslo", device: "mobile", journey: "a", target: null },
      outcome,
      result: null,
      error: null,
      startedAt: "1970-01-01T00:00:00.000Z",
      durationMs: 0,
    });
    expect(countScenarios([at(0, "passed"), at(1, "warned"), at(2, "siteFailed"), at(3, "unmeasured")])).toEqual({
      total: 4,
      passed: 1,
      warned: 1,
      siteFailed: 1,
      unmeasured: 1,
    });
  });
});

describe("the target axis", () => {
  it("expands one scenario per page, so a sweep runs inside the bounded pool", () => {
    // 430 pages were driven from a shell loop with no bound, alongside three other
    // fleets, and `selector-visible` then reported a missing h1 on six pages that
    // demonstrably had one. All six passed alone. A sweep that cannot be bounded
    // eventually invents defects out of its own load.
    const s = expandMatrix({
      markets: ["oslo"], devices: ["desktop"], journeys: ["sweep"],
      targets: ["https://x/a", "https://x/b", "https://x/c"],
    });
    expect(s).toHaveLength(3);
    expect(s.map((x) => x.target)).toEqual(["https://x/a", "https://x/b", "https://x/c"]);
    expect(s[0]?.key).toBe("oslo/desktop/sweep/https://x/a");
  });

  it("multiplies across every other axis", () => {
    const s = expandMatrix({
      markets: ["oslo", "bergen"], devices: ["mobile", "desktop"], journeys: ["sweep"],
      targets: ["https://x/a", "https://x/b"],
    });
    expect(s).toHaveLength(8);
    expect(new Set(s.map((x) => x.key)).size).toBe(8);
  });

  it("keeps the old shape when there is no target axis", () => {
    for (const axes of [
      { markets: ["oslo"], devices: ["desktop"], journeys: ["sweep"] },
      { markets: ["oslo"], devices: ["desktop"], journeys: ["sweep"], targets: [] },
    ]) {
      const s = expandMatrix(axes);
      expect(s).toHaveLength(1);
      expect(s[0]?.target).toBeNull();
      expect(s[0]?.key).toBe("oslo/desktop/sweep");
    }
  });

  it("does NOT sort or de-duplicate targets", () => {
    // Sitemap order is meaningful to whoever reads the results, and a repeated URL
    // is a legitimate request for a second sample of one page.
    const s = expandMatrix({
      markets: ["oslo"], devices: ["desktop"], journeys: ["sweep"],
      targets: ["https://x/z", "https://x/a", "https://x/z"],
    });
    expect(s.map((x) => x.target)).toEqual(["https://x/z", "https://x/a", "https://x/z"]);
  });
});
