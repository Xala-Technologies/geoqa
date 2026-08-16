import { describe, expect, it } from "vitest";
import { boundedPool, DEFAULT_MATRIX_CONCURRENCY, resolveConcurrency } from "../pool.js";

/** Resolves on the next macrotask, so interleaving is observable without a clock. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("resolveConcurrency", () => {
  it("takes the measured default when nothing is asked for", () => {
    expect(resolveConcurrency()).toBe(DEFAULT_MATRIX_CONCURRENCY);
  });

  it("refuses a non-finite request rather than becoming unbounded", () => {
    // `NaN` from a mistyped flag, `Infinity` from a clever one. "As many as possible" is not a
    // concurrency setting, it is the absence of one — and it fails as an OOM halfway through a
    // sweep rather than as an error at the start.
    expect(resolveConcurrency(Number.NaN)).toBe(DEFAULT_MATRIX_CONCURRENCY);
    expect(resolveConcurrency(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MATRIX_CONCURRENCY);
  });

  it("never returns less than one, which would run nothing at all", () => {
    expect(resolveConcurrency(0)).toBe(1);
    expect(resolveConcurrency(-5)).toBe(1);
  });

  it("floors a fraction rather than rounding up past the bound asked for", () => {
    expect(resolveConcurrency(3.9)).toBe(3);
  });
});

describe("boundedPool", () => {
  it("never exceeds the bound, and reports the peak so a test can prove it", async () => {
    // `peakInFlight` is returned rather than inferred: a pool that silently ran everything at
    // once would still produce the right results, and the bound is the whole contract.
    const out = await boundedPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      await tick();
      return n * 2;
    });
    expect(out.peakInFlight).toBe(3);
    expect(out.results.toSorted((a, b) => a - b)).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });

  it("actually runs concurrently rather than merely allowing it", async () => {
    // The other direction: a pool that ran everything sequentially would also never exceed the
    // bound, so "peak <= limit" alone proves nothing.
    let inFlight = 0;
    let peak = 0;
    await boundedPool([1, 2, 3, 4], 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  it("starts nothing at all for an empty list", async () => {
    let calls = 0;
    const out = await boundedPool([], 4, async () => {
      calls++;
    });
    expect(calls).toBe(0);
    expect(out.peakInFlight).toBe(0);
    expect(out.results).toEqual([]);
  });

  it("never starts more workers than there are items", async () => {
    // Otherwise a bound of 16 over two scenarios spins up fourteen workers that immediately
    // find nothing to do.
    const out = await boundedPool([1, 2], 16, async (n) => n);
    expect(out.peakInFlight).toBe(2);
  });

  it("returns results in COMPLETION order, which the caller is expected to sort", async () => {
    // Deliberate rather than incidental: preserving input order would mean holding a finished
    // result while a slow earlier item ran, and both callers already carry an index to sort by.
    const delays = new Map([[1, 3], [2, 1], [3, 2]]);
    const out = await boundedPool([1, 2, 3], 3, async (n) => {
      for (let i = 0; i < (delays.get(n) ?? 0); i++) await tick();
      return n;
    });
    expect(out.results).toEqual([2, 3, 1]);
  });

  it("processes every item exactly once", async () => {
    // The bookkeeping around `next++` is the one place an off-by-one would silently drop or
    // double a scenario, and a dropped scenario is a gap indistinguishable from a clean market.
    const seen: number[] = [];
    const items = Array.from({ length: 50 }, (_, i) => i);
    await boundedPool(items, 7, async (n) => {
      await tick();
      seen.push(n);
    });
    expect(seen.toSorted((a, b) => a - b)).toEqual(items);
  });
});
