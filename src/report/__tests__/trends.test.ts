import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ABSOLUTE_FLOOR, buildConfidenceSeries, buildSeries, MIN_POINTS_FOR_DIRECTION, NOISE_FLOOR, notableTrends } from "../trends.js";
import type { RunRecord } from "../../history/records.js";

/** `n` runs at one target and market, with the given TTFB readings in order. */
const series = (ttfbs: (number | null)[], over: Partial<RunRecord> = {}): RunRecord[] =>
  ttfbs.map((ttfb, i) => ({
    schemaVersion: 1,
    runId: `run_${1000 + i}_oslo-desktop`,
    tenantId: null,
    target: "https://a.test/x",
    profileId: "oslo-desktop",
    journeyId: "sweep",
    verdict: "PASS",
    startedAt: `2026-08-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
    durationMs: 1,
    seed: 1,
    engine: "playwright",
    evidenceId: null,
    findings: { total: 0, bySeverity: {}, byCategory: {}, labels: [] },
    confidence: { overall: 100, geo: 100, browser: 100, journey: 100, evidence: 100 },
    geo: {
      requestedCountry: "NO", requestedCity: "Oslo", observedCountry: "NO", observedCity: "Oslo",
      country: "match", city: "match", egressHeld: "match", agreement: "unverified",
    },
    latencyMs: null,
    vitals: { lcp: null, cls: null, ttfb, inp: null },
    ...over,
  }));

describe("buildSeries", () => {
  it("REFUSES a direction below the minimum sample, and says why", () => {
    // "Getting worse" from three runs is noise with a narrative, and a dashboard that says it
    // will be believed.
    const [s] = buildSeries(series([100, 200, 400]), "ttfb");
    expect(s?.direction).toBe("insufficient-data");
    expect(s?.reason).toContain("noise with a narrative");
    expect(s?.earlier.measured).toBe(false);
  });

  it("calls a real move a direction once there is enough data", () => {
    const [s] = buildSeries(series([100, 100, 100, 400, 400, 400]), "ttfb");
    expect(s?.direction).toBe("worsening");
    expect(s?.earlier.text).toBe("100");
    expect(s?.later.text).toBe("400");
  });

  it("calls an improvement an improvement", () => {
    const [s] = buildSeries(series([400, 400, 400, 100, 100, 100]), "ttfb");
    expect(s?.direction).toBe("improving");
  });

  it("treats a move inside the NOISE FLOOR as stable, not a direction", () => {
    // Network latency varies by more than a few percent between any two runs for reasons that
    // have nothing to do with the site. A dashboard that cries wolf is one nobody opens.
    const within = 100 * (1 + NOISE_FLOOR / 2);
    const [s] = buildSeries(series([100, 100, 100, within, within, within]), "ttfb");
    expect(s?.direction).toBe("stable");
    expect(s?.reason).toContain("noise floor");
  });

  it("refuses a direction below the ABSOLUTE floor, even at a big percentage", () => {
    // Found by reading real output, not by reasoning: against a local fixture server TTFB is
    // about 1ms, so 1.05 → 0.9 is 14% and cleared the relative floor. The absolute change is
    // 0.15ms, and the dashboard reported it as "improving". Nobody has ever improved a page by
    // 0.15ms.
    const [s] = buildSeries(series([1.05, 1.05, 1.05, 0.9, 0.9, 0.9]), "ttfb");
    expect(s?.direction).toBe("stable");
    expect(s?.reason).toContain("below the 10 nobody would act on");
  });

  it("requires BOTH floors to be cleared", () => {
    // A big absolute move that is a small percentage is also stable: 2000 → 2100 is 100ms but
    // only 5%, which is the internet rather than a change.
    const [relative] = buildSeries(series([2000, 2000, 2000, 2100, 2100, 2100]), "ttfb");
    expect(relative?.direction).toBe("stable");
    // Clearing both is a direction.
    const [both] = buildSeries(series([100, 100, 100, 400, 400, 400]), "ttfb");
    expect(both?.direction).toBe("worsening");
  });

  it("uses a per-metric absolute floor, because CLS and milliseconds are different scales", () => {
    // 0.01 of CLS is a tenth of the "good" budget and is worth acting on; 0.01 of a
    // millisecond is not. A single shared floor would be deaf to one and deafening to the other.
    expect(ABSOLUTE_FLOOR.cls).toBeLessThan(1);
    expect(ABSOLUTE_FLOOR.ttfb).toBeGreaterThanOrEqual(10);
    const records = series([100, 100, 100, 100, 100, 100]).map((r, i) => ({
      ...r,
      vitals: { lcp: null, cls: i < 3 ? 0.01 : 0.2, ttfb: 100, inp: null },
    }));
    expect(buildSeries(records, "cls")[0]?.direction).toBe("worsening");
  });

  it("scales the floor with the metric, so 10% of 40ms and 10% of 2000ms differ", () => {
    // A fixed absolute threshold would be deafening on a fast page and deaf on a slow one.
    const smallMove = buildSeries(series([1000, 1000, 1000, 1050, 1050, 1050]), "ttfb")[0];
    const sameAbsoluteOnASmallBase = buildSeries(series([100, 100, 100, 150, 150, 150]), "ttfb")[0];
    expect(smallMove?.direction).toBe("stable");
    expect(sameAbsoluteOnASmallBase?.direction).toBe("worsening");
  });

  it("NEVER interpolates a gap — an unmeasured run is a gap, not an estimate", () => {
    // Drawing through it would fabricate the one thing the reader is looking at.
    const [s] = buildSeries(series([100, null, 100, 400, null, 400, 400, 100]), "ttfb");
    expect(s?.points.filter((p) => p.value === null)).toHaveLength(2);
    expect(s?.measuredPoints).toBe(6);
    expect(s?.points).toHaveLength(8);
  });

  it("COUNTS the gaps in its reason, so a trend over 6 of 40 runs says so", () => {
    const ttfbs = [100, 100, 100, 400, 400, 400, ...Array.from({ length: 10 }, () => null)];
    const [s] = buildSeries(series(ttfbs), "ttfb");
    expect(s?.reason).toContain("10 of 16 run(s) did not measure it");
  });

  it("splits the READINGS rather than the points, so a run of gaps cannot empty one half", () => {
    // With gaps concentrated in the middle, splitting points would put every reading on one
    // side and leave the other with none.
    const [s] = buildSeries(series([100, 100, 100, null, null, null, null, 400, 400, 400]), "ttfb");
    expect(s?.direction).toBe("worsening");
    expect(s?.earlier.text).toBe("100");
    expect(s?.later.text).toBe("400");
  });

  it("EXCLUDES errored runs, or a trend would track our own blindness", () => {
    // An ERROR means geoqa could not read the page. Counting them would show a site getting
    // worse when what got worse was our ability to look at it.
    const records = [...series([100, 100, 100, 100, 100, 100]), ...series([9000], { verdict: "ERROR", runId: "run_bad_oslo-desktop" })];
    const [s] = buildSeries(records, "ttfb");
    expect(s?.points).toHaveLength(6);
    expect(s?.direction).toBe("stable");
  });

  it("keeps one series per target AND market, because a market is a different measurement", () => {
    const records = [...series([100, 100]), ...series([900, 900], { profileId: "bodo-desktop" })];
    const built = buildSeries(records, "ttfb");
    expect(built).toHaveLength(2);
    expect(built.map((s) => s.marketId).sort()).toEqual(["bodo", "oslo"]);
  });

  it("orders points oldest first, whatever order the records arrived in", () => {
    const records = series([100, 200, 300]).reverse();
    const [s] = buildSeries(records, "ttfb");
    expect(s?.points.map((p) => p.value)).toEqual([100, 200, 300]);
  });

  it("is insufficient-data when nothing was measured at all", () => {
    const [s] = buildSeries(series([null, null, null, null, null, null, null]), "ttfb");
    expect(s?.direction).toBe("insufficient-data");
    expect(s?.measuredPoints).toBe(0);
  });

  it("reads the metric it was asked for", () => {
    const records = series([100, 100, 100, 100, 100, 100], {}).map((r, i) => ({
      ...r,
      vitals: { lcp: i < 3 ? 100 : 900, cls: null, ttfb: 100, inp: null },
    }));
    expect(buildSeries(records, "lcp")[0]?.direction).toBe("worsening");
    expect(buildSeries(records, "ttfb")[0]?.direction).toBe("stable");
  });
});

describe("buildConfidenceSeries — the inversion", () => {
  it("reads RISING confidence as improving, not worsening", () => {
    // Every other metric here is one where lower is better. Sharing the comparison would
    // report a site whose readings became more trustworthy as "worsening".
    const records = series([100, 100, 100, 100, 100, 100]).map((r, i) => ({
      ...r,
      confidence: { overall: i < 3 ? 40 : 95, geo: 100, browser: 100, journey: 100, evidence: 100 },
    }));
    expect(buildSeries(records, "confidence")[0]?.direction).toBe("worsening");
    expect(buildConfidenceSeries(records)[0]?.direction).toBe("improving");
  });

  it("reads FALLING confidence as worsening", () => {
    const records = series([100, 100, 100, 100, 100, 100]).map((r, i) => ({
      ...r,
      confidence: { overall: i < 3 ? 95 : 40, geo: 100, browser: 100, journey: 100, evidence: 100 },
    }));
    expect(buildConfidenceSeries(records)[0]?.direction).toBe("worsening");
  });

  it("leaves stable and insufficient-data alone", () => {
    expect(buildConfidenceSeries(series([100, 100, 100, 100, 100, 100]))[0]?.direction).toBe("stable");
    expect(buildConfidenceSeries(series([100]))[0]?.direction).toBe("insufficient-data");
  });
});

describe("notableTrends", () => {
  it("shows only real directions, worsening first", () => {
    // A dashboard leading with forty rows of "not enough data" trains its reader to scroll
    // past the four that matter.
    const worsening = buildSeries(series([100, 100, 100, 400, 400, 400]), "ttfb");
    const improving = buildSeries(series([400, 400, 400, 100, 100, 100], { target: "https://a.test/y" }), "ttfb");
    const flat = buildSeries(series([100, 100, 100, 100, 100, 100], { target: "https://a.test/z" }), "ttfb");
    const thin = buildSeries(series([100], { target: "https://a.test/w" }), "ttfb");
    const notable = notableTrends([...flat, ...thin, ...improving, ...worsening]);
    expect(notable.map((s) => s.direction)).toEqual(["worsening", "improving"]);
  });

  it("returns nothing when nothing has a direction", () => {
    expect(notableTrends(buildSeries(series([100, 100]), "ttfb"))).toEqual([]);
  });

  it("needs at least MIN_POINTS_FOR_DIRECTION to report anything at all", () => {
    const justUnder = Array.from({ length: MIN_POINTS_FOR_DIRECTION - 1 }, (_, i) => (i < 2 ? 100 : 900));
    expect(notableTrends(buildSeries(series(justUnder), "ttfb"))).toEqual([]);
  });
});

describe("the source stays greppable", () => {
  /**
   * A regression test for a maintainability defect, which is unusual and earns its place.
   *
   * The first version of the composite group keys in this module and in `history/store.ts`
   * used literal NUL bytes as separators. It worked, every test passed, and it made both files
   * register as BINARY to `grep` — so searching them silently returned nothing. That defeated
   * the review of the very change that introduced it: three greps came back empty and the
   * natural reading was "the code is not there".
   *
   * A file nobody can grep is a file whose next bug takes longer to find, so this asserts the
   * tree stays text. A NUL as a test VALUE is fine — `registry.test.ts` needs one to prove a
   * tenant id containing it is refused — but it is written as an escape rather than embedded.
   */
  it("contains no literal NUL byte anywhere in src/", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
      });
    const offenders = walk(root).filter((file) => readFileSync(file).includes(0));
    expect(offenders).toEqual([]);
  });
});

describe("the median over an EVEN number of runs", () => {
  it("averages the middle pair rather than picking one of them", () => {
    // With an even sample there is no single middle run. Taking one arbitrarily would make
    // the reported centre depend on sort stability, so two runs that differ only in tie
    // order would report different trends from identical data.
    const [s] = buildSeries(series([100, 100, 100, 100, 300, 500, 500, 500]), "ttfb");
    expect(s?.earlier.text).toBe("100");
    // Middle pair of the later half is 500 and 500 → 500; of the earlier half 100 and 100.
    expect(s?.later.measured).toBe(true);
  });
});
