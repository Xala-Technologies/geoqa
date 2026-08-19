import { describe, expect, it } from "vitest";
import type { PageAcrossMarkets, RunView } from "../types.ts";
import {
  buildCells,
  cmpNullable,
  compareRows,
  filterCells,
  geographyHref,
  heatFor,
  latestRun,
  marketsInView,
  pageLabel,
  sortCells,
  spreadText,
  verdictMix,
  worstSpread,
} from "./geography.ts";

const page = (over: Partial<PageAcrossMarkets> = {}): PageAcrossMarkets => ({
  target: "https://digilist.no/",
  markets: {
    oslo: { verdict: "PASS", ttfbMs: 80, lcpMs: 400, confidence: 90 },
    bergen: { verdict: "FAIL", ttfbMs: 240, lcpMs: 900, confidence: 70 },
  },
  ttfbSpreadMs: 160,
  divergentMarkets: ["bergen"],
  ...over,
});

const run = (over: Partial<RunView> & Pick<RunView, "runId" | "target" | "marketId">): RunView =>
  ({
    profileId: `${over.marketId}-desktop`,
    journeyId: "browse",
    verdict: "PASS",
    startedAt: "2026-08-19T06:00:00.000Z",
    evidenceId: null,
    seed: 1,
    findings: { total: 0, bySeverity: {}, byCategory: {}, labels: [] },
    durationMs: 1,
    confidence: {
      overall: { measured: true, value: 90, text: "90" },
      geo: { measured: true, value: 90, text: "90" },
      browser: { measured: true, value: 90, text: "90" },
      journey: { measured: true, value: 90, text: "90" },
      evidence: { measured: true, value: 90, text: "90" },
      search: { measured: false, reason: "no SERP", text: "not measured" },
    },
    vitals: {
      lcp: { measured: true, value: 400, text: "400ms" },
      cls: { measured: true, value: 0, text: "0" },
      ttfb: { measured: true, value: 80, text: "80ms" },
      inp: { measured: false, reason: "no interaction", text: "not measured" },
    },
    geo: {
      requested: "NO/Oslo",
      observed: "NO/Oslo",
      country: "match",
      city: "match",
      egressHeld: "match",
      agreement: "match",
    },
    latency: { measured: true, value: 80, text: "80ms" },
    steps: [],
    screenshots: [],
    ...over,
  }) as RunView;

describe("pageLabel", () => {
  it("shows host alone on the homepage, and host plus path otherwise", () => {
    expect(pageLabel("https://digilist.no/")).toBe("digilist.no");
    expect(pageLabel("https://app.digilist.no/login")).toBe("app.digilist.no/login");
    expect(pageLabel("not a url")).toBe("not a url");
  });
});

describe("latestRun", () => {
  it("picks the newest run for that page and market, never another cell", () => {
    const runs = [
      run({ runId: "new", target: "https://digilist.no/", marketId: "oslo", startedAt: "2026-08-19T08:00:00.000Z" }),
      run({ runId: "old", target: "https://digilist.no/", marketId: "oslo", startedAt: "2026-08-18T08:00:00.000Z" }),
      run({ runId: "bergen", target: "https://digilist.no/", marketId: "bergen" }),
    ];
    expect(latestRun(runs, "https://digilist.no/", "oslo")?.runId).toBe("new");
    expect(
      latestRun(
        [runs[1] as RunView, runs[0] as RunView],
        "https://digilist.no/",
        "oslo",
      )?.runId,
    ).toBe("new");
    expect(latestRun(runs, "https://digilist.no/", "tromso")).toBeNull();
  });
});

describe("heatFor", () => {
  it("leaves an absence unheated, and never treats a lone reading as the extreme", () => {
    expect(heatFor(null, 10, 80)).toBeNull();
    expect(heatFor(80, 80, 80)).toBe(0.5);
    expect(heatFor(80, 80, 240)).toBe(0);
    expect(heatFor(240, 80, 240)).toBe(1);
  });

  it("inverts confidence so the weakest axis is the hottest", () => {
    expect(heatFor(70, 70, 90, true)).toBe(1);
    expect(heatFor(90, 70, 90, true)).toBe(0);
  });
});

describe("buildCells", () => {
  it("marks a divergence, an ERROR-only market, and a hole as three different cells", () => {
    const cells = buildCells(
      page(),
      ["oslo", "bergen", "tromso", "alesund"],
      [
        run({ runId: "o", target: "https://digilist.no/", marketId: "oslo" }),
        run({ runId: "b", target: "https://digilist.no/", marketId: "bergen", verdict: "FAIL" }),
        run({
          runId: "t",
          target: "https://digilist.no/",
          marketId: "tromso",
          verdict: "ERROR",
          geo: {
            requested: "NO/Tromso",
            observed: "?/?",
            country: "unverified",
            city: "unverified",
            egressHeld: "unverified",
            agreement: "unverified",
          },
        }),
      ],
      "ttfb",
    );
    expect(cells.find((c) => c.marketId === "oslo")).toMatchObject({
      verdict: "PASS",
      divergent: false,
      errored: false,
      runId: "o",
      heat: 0,
    });
    expect(cells.find((c) => c.marketId === "bergen")).toMatchObject({
      verdict: "FAIL",
      divergent: true,
      heat: 1,
    });
    expect(cells.find((c) => c.marketId === "tromso")).toMatchObject({
      verdict: null,
      errored: true,
      runId: "t",
      heat: null,
    });
    expect(cells.find((c) => c.marketId === "alesund")).toMatchObject({
      verdict: null,
      errored: false,
      runId: null,
      heat: null,
    });
  });
});

describe("sortCells and filterCells", () => {
  it("puts an unmeasured cell last in both directions, and filters by city name", () => {
    const cells = buildCells(page(), ["oslo", "bergen", "tromso"], [], "ttfb");
    expect(sortCells(cells, "ttfb", false).map((c) => c.marketId)).toEqual(["oslo", "bergen", "tromso"]);
    expect(sortCells(cells, "ttfb", true).map((c) => c.marketId)).toEqual(["bergen", "oslo", "tromso"]);
    expect(
      sortCells(buildCells(page(), ["oslo", "tromso", "alesund"], [], "ttfb"), "ttfb", false).map((c) => c.marketId),
    ).toEqual(["oslo", "alesund", "tromso"]);
    expect(filterCells(cells, "OSLO").map((c) => c.marketId)).toEqual(["oslo"]);
    expect(filterCells(cells, "").map((c) => c.marketId)).toEqual(["oslo", "bergen", "tromso"]);
    const withGeo = buildCells(
      page(),
      ["oslo"],
      [run({ runId: "o", target: "https://digilist.no/", marketId: "oslo" })],
      "ttfb",
    );
    expect(filterCells(withGeo, "NO/Oslo").map((c) => c.marketId)).toEqual(["oslo"]);
    const withError = buildCells(
      page(),
      ["oslo", "tromso"],
      [run({ runId: "t", target: "https://digilist.no/", marketId: "tromso", verdict: "ERROR" })],
      "verdict",
    );
    expect(sortCells(withError, "verdict", true)[0]?.marketId).toBe("oslo");
    expect(sortCells(withError, "verdict", true)[1]?.errored).toBe(true);
  });
});

describe("compareRows", () => {
  it("reports a TTFB delta only when both markets produced a reading", () => {
    const rows = compareRows(
      [
        page(),
        page({
          target: "https://xala.no/",
          markets: { oslo: { verdict: "PASS", ttfbMs: 50, lcpMs: null, confidence: 80 } },
          ttfbSpreadMs: null,
          divergentMarkets: [],
        }),
      ],
      "oslo",
      "bergen",
    );
    expect(rows[0]).toMatchObject({ target: "https://digilist.no/", ttfbDeltaMs: 160, sameVerdict: false });
    expect(rows[1]?.ttfbDeltaMs).toBeNull();
    expect(
      compareRows(
        [
          page({
            markets: {
              oslo: { verdict: "PASS", ttfbMs: null, lcpMs: null, confidence: 80 },
              bergen: { verdict: "PASS", ttfbMs: 40, lcpMs: null, confidence: 80 },
            },
            ttfbSpreadMs: null,
            divergentMarkets: [],
          }),
        ],
        "oslo",
        "bergen",
      )[0]?.ttfbDeltaMs,
    ).toBeNull();
    expect(
      compareRows(
        [
          page({
            markets: {
              oslo: { verdict: "PASS", ttfbMs: 40, lcpMs: null, confidence: 80 },
              bergen: { verdict: "PASS", ttfbMs: null, lcpMs: null, confidence: 80 },
            },
            ttfbSpreadMs: null,
            divergentMarkets: [],
          }),
        ],
        "oslo",
        "bergen",
      )[0]?.ttfbDeltaMs,
    ).toBeNull();
    expect(
      compareRows(
        [page({ markets: { bergen: { verdict: "FAIL", ttfbMs: 240, lcpMs: 900, confidence: 70 } }, ttfbSpreadMs: null, divergentMarkets: [] })],
        "oslo",
        "bergen",
      )[0]?.left,
    ).toBeNull();
    expect(compareRows([page()], "oslo", "oslo")).toEqual([]);
    expect(cmpNullable(null, null, false, 0)).toBe(0);
    expect(cmpNullable(null, 1, false, 0)).toBe(1);
    expect(cmpNullable(1, null, false, 0)).toBe(-1);
    expect(cmpNullable(1, 2, false, 0)).toBe(-1);
    expect(cmpNullable(1, 2, true, 0)).toBe(1);
    expect(cmpNullable(2, 2, false, 7)).toBe(7);
  });
});

describe("summaries", () => {
  it("counts verdicts without inventing a spread from one market", () => {
    expect(verdictMix(page())).toEqual({ pass: 1, warn: 0, fail: 1, total: 2 });
    expect(worstSpread([page(), page({ ttfbSpreadMs: null })])).toBe(160);
    expect(worstSpread([page({ ttfbSpreadMs: null })])).toBeNull();
    expect(spreadText(page())).toContain("160ms");
    expect(spreadText(page({ ttfbSpreadMs: null, markets: { oslo: page().markets.oslo! } }))).toContain("not measured");
    expect(marketsInView(["oslo"], [run({ runId: "x", target: "https://a", marketId: "bergen" })])).toEqual([
      "bergen",
      "oslo",
    ]);
    expect(geographyHref()).toBe("#/geography");
    expect(geographyHref("")).toBe("#/geography");
    expect(geographyHref("https://digilist.no/")).toBe(`#/geography/${encodeURIComponent("https://digilist.no/")}`);
    expect(verdictMix(page({ markets: { oslo: { verdict: "PASS_WITH_WARNINGS", ttfbMs: 1, lcpMs: 1, confidence: 1 } } }))).toEqual({
      pass: 0,
      warn: 1,
      fail: 0,
      total: 1,
    });
  });

  it("sorts by name and by verdict without promoting an empty cell", () => {
    const cells = buildCells(page(), ["oslo", "bergen", "tromso"], [], "verdict");
    expect(sortCells(cells, "name", false).map((c) => c.marketId)).toEqual(["bergen", "oslo", "tromso"]);
    expect(sortCells(cells, "name", true).map((c) => c.marketId)).toEqual(["tromso", "oslo", "bergen"]);
    expect(sortCells(cells, "verdict", true)[0]?.marketId).toBe("bergen");
    expect(sortCells(buildCells(page(), ["oslo", "bergen"], [], "lcp"), "lcp", true)[0]?.marketId).toBe("bergen");
    expect(sortCells(buildCells(page(), ["oslo", "bergen"], [], "confidence"), "confidence", false)[0]?.marketId).toBe(
      "bergen",
    );
    const tied = page({
      markets: {
        oslo: { verdict: "PASS_WITH_WARNINGS", ttfbMs: 100, lcpMs: 400, confidence: 80 },
        bergen: { verdict: "PASS_WITH_WARNINGS", ttfbMs: 100, lcpMs: 400, confidence: 80 },
      },
      divergentMarkets: [],
    });
    expect(sortCells(buildCells(tied, ["oslo", "bergen"], [], "ttfb"), "ttfb", false).map((c) => c.marketId)).toEqual([
      "bergen",
      "oslo",
    ]);
    expect(sortCells(buildCells(tied, ["oslo", "bergen"], [], "verdict"), "verdict", true)[0]?.verdict).toBe(
      "PASS_WITH_WARNINGS",
    );
  });
});
