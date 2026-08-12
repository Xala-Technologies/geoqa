import { describe, expect, it } from "vitest";
import { pauseMs, seedFrom, seededRandom, takesStep } from "../random.js";

describe("seededRandom", () => {
  it("gives the same sequence for the same seed — the property the whole feature rests on", () => {
    // Without this, "behaves like a human" costs reproducibility, and a failing
    // run cannot be replayed. That is the trade the seed exists to avoid.
    const a = seededRandom(42);
    const b = seededRandom(42);
    const first = [a(), a(), a(), a(), a()];
    const second = [b(), b(), b(), b(), b()];
    expect(first).toEqual(second);
  });

  it("gives different sequences for different seeds", () => {
    const a = seededRandom(1);
    const b = seededRandom(2);
    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });

  it("stays inside [0, 1)", () => {
    const random = seededRandom(seedFrom("run_1786536163015_oslo-mobile"));
    for (let i = 0; i < 500; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("spreads across the range rather than clustering", () => {
    const random = seededRandom(7);
    const buckets = [0, 0, 0, 0];
    for (let i = 0; i < 4_000; i++) buckets[Math.floor(random() * 4)]!++;
    // A generator that fed pauses but always returned ~0.5 would make every
    // "1.2 to 3.5 seconds" the same 2.35 seconds.
    for (const count of buckets) expect(count).toBeGreaterThan(700);
  });
});

describe("seedFrom", () => {
  it("is stable for the same text and different across run ids", () => {
    expect(seedFrom("run_1_oslo")).toBe(seedFrom("run_1_oslo"));
    expect(seedFrom("run_1_oslo")).not.toBe(seedFrom("run_2_oslo"));
  });

  it("returns an unsigned 32-bit integer, including for empty text", () => {
    for (const text of ["", "a", "run_1786536163015_oslo-mobile"]) {
      const seed = seedFrom(text);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 32);
    }
  });
});

describe("pauseMs", () => {
  it("stays within the declared range, inclusive", () => {
    const random = seededRandom(3);
    for (let i = 0; i < 300; i++) {
      const ms = pauseMs(random, 1_200, 3_500);
      expect(ms).toBeGreaterThanOrEqual(1_200);
      expect(ms).toBeLessThanOrEqual(3_500);
    }
  });

  it("returns whole milliseconds", () => {
    expect(Number.isInteger(pauseMs(seededRandom(1), 100, 900))).toBe(true);
  });

  it("collapses to the exact value when both ends agree", () => {
    expect(pauseMs(seededRandom(1), 500, 500)).toBe(500);
  });

  it("tolerates a reversed range rather than failing a run over argument order", () => {
    const ms = pauseMs(seededRandom(9), 3_000, 1_000);
    expect(ms).toBeGreaterThanOrEqual(1_000);
    expect(ms).toBeLessThanOrEqual(3_000);
  });
});

describe("takesStep", () => {
  it("always takes a step at probability 1 and never at 0", () => {
    const random = seededRandom(5);
    for (let i = 0; i < 50; i++) {
      expect(takesStep(random, 1)).toBe(true);
      expect(takesStep(random, 0)).toBe(false);
    }
  });

  it("does NOT consume the generator for a certain or impossible step", () => {
    // Otherwise adding a `probability: 1` step to a journey would shift every
    // later draw and silently change an otherwise identical run.
    const control = seededRandom(11);
    const expected = [control(), control()];

    const random = seededRandom(11);
    takesStep(random, 1);
    takesStep(random, 0);
    takesStep(random, 1);
    expect([random(), random()]).toEqual(expected);
  });

  it("takes roughly the declared share of a large sample", () => {
    const random = seededRandom(13);
    let taken = 0;
    for (let i = 0; i < 4_000; i++) if (takesStep(random, 0.25)) taken++;
    expect(taken / 4_000).toBeGreaterThan(0.21);
    expect(taken / 4_000).toBeLessThan(0.29);
  });

  it("is reproducible: the same seed picks the same steps", () => {
    const draw = (): boolean[] => {
      const random = seededRandom(17);
      return Array.from({ length: 20 }, () => takesStep(random, 0.5));
    };
    expect(draw()).toEqual(draw());
  });
});
