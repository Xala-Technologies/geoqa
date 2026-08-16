import { describe, expect, it } from "vitest";
import { analyseSite, describeLatencySpread, marketOf } from "../site.js";
import type { RunRecord } from "../../history/records.js";

const record = (over: Partial<RunRecord> & { profileId: string; target: string }): RunRecord => ({
  schemaVersion: 1,
  runId: `run_${Date.parse(over.startedAt ?? "2026-08-13T10:00:00.000Z")}_x`,
  tenantId: null,
  journeyId: "sweep",
  verdict: "PASS",
  startedAt: "2026-08-13T10:00:00.000Z",
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
  vitals: { lcp: null, cls: null, ttfb: null, inp: null },
  ...over,
});

describe("marketOf", () => {
  it("reads the market out of a <market>-<device> profile id", () => {
    expect(marketOf("oslo-desktop")).toBe("oslo");
    expect(marketOf("bodo-mobile")).toBe("bodo");
    // The returning-visitor profile has a third segment and is still Oslo.
    expect(marketOf("oslo-desktop-returning")).toBe("oslo");
  });

  it("gives an unrecognised profile a market of its OWN rather than folding it into another", () => {
    // The safe direction: a profile named differently lands somewhere harmless instead of
    // corrupting a real market's readings.
    expect(marketOf("something-else")).toBe("something-else");
  });
});

describe("analyseSite", () => {
  it("compares one page across markets and reports the TTFB spread", () => {
    const report = analyseSite([
      record({ profileId: "oslo-desktop", target: "https://a.test/x", vitals: { lcp: 400, cls: 0, ttfb: 100, inp: null } }),
      record({ profileId: "bodo-desktop", target: "https://a.test/x", vitals: { lcp: 900, cls: 0, ttfb: 400, inp: null } }),
    ]);
    expect(report.pages).toBe(1);
    expect(report.markets).toEqual(["bodo", "oslo"]);
    expect(report.perPage[0]?.ttfbSpreadMs).toBe(300);
  });

  it("reports the spread as NULL with fewer than two readings, never 0", () => {
    // "One market measured" and "every market identical" are different facts, and a spread
    // of 0 claims the second.
    const report = analyseSite([record({ profileId: "oslo-desktop", target: "https://a.test/x", vitals: { lcp: null, cls: null, ttfb: 100, inp: null } })]);
    expect(report.perPage[0]?.ttfbSpreadMs).toBeNull();
    expect(report.widestLatencyGaps).toEqual([]);
  });

  it("takes the MEDIAN across repeats in one market, not the latest run", () => {
    // A single slow run is noise, and the latest is whichever happened to finish last.
    const report = analyseSite([
      record({ profileId: "oslo-desktop", target: "https://a.test/x", startedAt: "2026-08-13T10:00:00.000Z", vitals: { lcp: null, cls: null, ttfb: 100, inp: null } }),
      record({ profileId: "oslo-desktop", target: "https://a.test/x", startedAt: "2026-08-13T11:00:00.000Z", vitals: { lcp: null, cls: null, ttfb: 200, inp: null } }),
      record({ profileId: "oslo-desktop", target: "https://a.test/x", startedAt: "2026-08-13T12:00:00.000Z", vitals: { lcp: null, cls: null, ttfb: 9000, inp: null } }),
    ]);
    expect(report.perPage[0]?.markets.oslo?.ttfbMs).toBe(200);
  });

  it("ROUNDS to whole milliseconds, because sub-millisecond precision here is noise", () => {
    // performance.timing arrives as a float, so an unrounded reading prints as
    // 467.19999998807907ms and makes a report look unread.
    const report = analyseSite([record({ profileId: "oslo-desktop", target: "https://a.test/x", vitals: { lcp: null, cls: null, ttfb: 467.19999998807907, inp: null } })]);
    expect(report.perPage[0]?.markets.oslo?.ttfbMs).toBe(467);
  });

  it("EXCLUDES errored runs from every comparison, and says how many", () => {
    // An ERROR means geoqa could not read the page. Counting it would make our own
    // instrumentation failure look like a market where the site behaves differently.
    const report = analyseSite([
      record({ profileId: "oslo-desktop", target: "https://a.test/x" }),
      record({ profileId: "bodo-desktop", target: "https://a.test/x", verdict: "ERROR" }),
    ]);
    expect(report.markets).toEqual(["oslo"]);
    expect(report.geographicallyDivergent).toEqual([]);
    expect(report.warnings[0]).toContain("1 run(s) errored");
    expect(report.warnings[0]).toContain("look like a market where the site behaves differently");
  });

  it("finds the pages where GEOGRAPHY changed the outcome", () => {
    // The finding this analysis exists for: one URL, one set of HTML, different results.
    const report = analyseSite([
      record({ profileId: "oslo-desktop", target: "https://a.test/x", verdict: "PASS" }),
      record({ profileId: "berlin-desktop", target: "https://a.test/x", verdict: "PASS" }),
      record({ profileId: "bodo-desktop", target: "https://a.test/x", verdict: "FAIL" }),
    ]);
    expect(report.geographicallyDivergent).toHaveLength(1);
    expect(report.geographicallyDivergent[0]?.divergentMarkets).toEqual(["bodo"]);
  });

  it("says nothing is divergent when every market agrees", () => {
    const report = analyseSite([
      record({ profileId: "oslo-desktop", target: "https://a.test/x", verdict: "FAIL" }),
      record({ profileId: "bodo-desktop", target: "https://a.test/x", verdict: "FAIL" }),
    ]);
    expect(report.geographicallyDivergent).toEqual([]);
  });

  it("reports a page measured in SOME markets as a coverage gap", () => {
    // A page nobody measured in Bodø is not a page that works in Bodø, and omitting it
    // would read as full coverage.
    const report = analyseSite([
      record({ profileId: "oslo-desktop", target: "https://a.test/x" }),
      record({ profileId: "bodo-desktop", target: "https://a.test/y" }),
    ]);
    expect(report.coverageGaps).toHaveLength(2);
    expect(report.coverageGaps.find((g) => g.target === "https://a.test/x")?.missing).toEqual(["bodo"]);
  });

  it("orders the widest latency gap first", () => {
    const report = analyseSite([
      record({ profileId: "oslo-desktop", target: "https://a.test/small", vitals: { lcp: null, cls: null, ttfb: 100, inp: null } }),
      record({ profileId: "bodo-desktop", target: "https://a.test/small", vitals: { lcp: null, cls: null, ttfb: 150, inp: null } }),
      record({ profileId: "oslo-desktop", target: "https://a.test/big", vitals: { lcp: null, cls: null, ttfb: 100, inp: null } }),
      record({ profileId: "bodo-desktop", target: "https://a.test/big", vitals: { lcp: null, cls: null, ttfb: 900, inp: null } }),
    ]);
    expect(report.widestLatencyGaps[0]?.target).toBe("https://a.test/big");
  });

  it("survives an empty history", () => {
    const report = analyseSite([]);
    expect(report).toMatchObject({ pages: 0, markets: [], perPage: [], coverageGaps: [], geographicallyDivergent: [] });
  });
});

describe("describeLatencySpread", () => {
  const page = (markets: Record<string, number | null>) => ({
    target: "https://a.test/x",
    markets: Object.fromEntries(
      Object.entries(markets).map(([id, ttfb]) => [id, { verdict: "PASS", ttfbMs: ttfb, lcpMs: null, confidence: 100 }]),
    ),
    ttfbSpreadMs: null,
    divergentMarkets: [],
  });

  it("names the fastest and slowest market with the factor between them", () => {
    expect(describeLatencySpread(page({ oslo: 148, bodo: 1923 }))).toBe(
      "https://a.test/x: TTFB 148ms in oslo vs 1923ms in bodo — 13x",
    );
  });

  it("says there is no spread when fewer than two markets produced a reading", () => {
    expect(describeLatencySpread(page({ oslo: 100 }))).toContain("fewer than two markets");
    expect(describeLatencySpread(page({ oslo: 100, bodo: null }))).toContain("fewer than two markets");
  });

  it("omits the factor rather than dividing by zero", () => {
    // Asserted on the factor SUFFIX, not on the letter x — the URL contains one, which is
    // how the first version of this test failed against correct code.
    const described = describeLatencySpread(page({ oslo: 0, bodo: 500 }));
    expect(described).toContain("TTFB 0ms in oslo");
    expect(described).not.toMatch(/— [\d.]+x$/);
    // And the factor IS present when it can be computed.
    expect(describeLatencySpread(page({ oslo: 100, bodo: 500 }))).toMatch(/— 5x$/);
  });
});

describe("which run in a market represents it", () => {
  /**
   * The reduce that picks the LATEST run of a market, in both directions.
   *
   * Its ternary had one arm untested, which matters more than it sounds: a market measured
   * twice reports one verdict, and picking the wrong one means the dashboard shows a verdict
   * that was superseded. Both orderings are asserted because a reduce that always kept the
   * first would pass a test where the newest happened to come first.
   */
  const at = (startedAt: string, verdict: "PASS" | "FAIL") =>
    record({ startedAt, verdict, profileId: "oslo-mobile", target: "https://x" });

  it("keeps the newest when it arrives LAST", () => {
    const report = analyseSite([at("2026-01-01T00:00:00Z", "FAIL"), at("2026-01-02T00:00:00Z", "PASS")]);
    expect(report.perPage[0]?.markets["oslo"]?.verdict).toBe("PASS");
  });

  it("keeps the newest when it arrives FIRST", () => {
    const report = analyseSite([at("2026-01-02T00:00:00Z", "PASS"), at("2026-01-01T00:00:00Z", "FAIL")]);
    expect(report.perPage[0]?.markets["oslo"]?.verdict).toBe("PASS");
  });
});

describe("the median across repeats of one market", () => {
  /**
   * The MEDIAN, not the latest, and both parities of it.
   *
   * A single slow run is noise; the latest is whichever happened to finish last. The even case
   * was untested because every fixture had one reading per market — and an even-length median
   * averages the middle PAIR, which is a different code path from picking a middle element.
   */
  const withTtfb = (ttfb: number) =>
    record({ profileId: "oslo-mobile", target: "https://x", vitals: { lcp: null, cls: null, ttfb, inp: null } });

  it("averages the middle pair for an EVEN number of readings", () => {
    // 100 and 300 → 200. Picking a middle element would give one of them.
    const report = analyseSite([withTtfb(100), withTtfb(300)]);
    expect(report.perPage[0]?.markets["oslo"]?.ttfbMs).toBe(200);
  });

  it("takes the middle element for an ODD number", () => {
    const report = analyseSite([withTtfb(100), withTtfb(300), withTtfb(1000)]);
    expect(report.perPage[0]?.markets["oslo"]?.ttfbMs).toBe(300);
  });

  it("is null when nothing measured it, rather than 0", () => {
    // "one market measured nothing" and "every reading was zero" are different facts.
    expect(analyseSite([record({ profileId: "oslo-mobile", target: "https://x" })]).perPage[0]?.markets["oslo"]?.ttfbMs).toBeNull();
  });
});
