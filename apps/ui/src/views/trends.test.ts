import { describe, expect, it } from "vitest";
import type { FindingTicket, TrendSeries } from "../types.ts";
import {
  DIRECTION_LABEL,
  directionCounts,
  driftBrief,
  explainSeries,
  filterSeries,
  isFilingCandidate,
  latestMeasured,
  parseTrendKey,
  pointsNeeded,
  relatedTickets,
  seriesKey,
  sortSeries,
  trendDelta,
  trendsHref,
  visitRows,
} from "./trends.ts";

const measured = (value: number) => ({ measured: true as const, value, text: String(value) });
const absent = (reason: string) => ({ measured: false as const, reason, text: "not measured" as const });

const series = (over: Partial<TrendSeries> = {}): TrendSeries => ({
  target: "https://digilist.no/",
  marketId: "alesund",
  metric: "ttfb",
  points: [
    { at: "2026-08-18T08:00:00.000Z", runId: "run_a", value: 80 },
    { at: "2026-08-18T09:00:00.000Z", runId: "run_b", value: null },
    { at: "2026-08-19T08:00:00.000Z", runId: "run_c", value: 240 },
  ],
  measuredPoints: 2,
  earlier: measured(80),
  later: measured(240),
  direction: "worsening",
  reason: "80 → 240 across 6 measured run(s).",
  ...over,
});

const ticket = (over: Partial<FindingTicket> = {}): FindingTicket => ({
  key: "site:lcp-below:digilist.no",
  title: "LCP is slow",
  site: "digilist.no",
  hosts: ["digilist.no"],
  urgent: false,
  runIds: ["run_c"],
  issue: absent("not filed"),
  pr: absent("no PR"),
  fixed: false,
  body: "## Problem\nLCP",
  ...over,
});

describe("parseTrendKey / trendsHref", () => {
  it("treats a bare metric as a filter, and a three-part key as a selected series", () => {
    expect(parseTrendKey(undefined)).toEqual({});
    expect(parseTrendKey("")).toEqual({});
    expect(parseTrendKey("lcp")).toEqual({ metric: "lcp" });
    expect(parseTrendKey("insufficient-data")).toEqual({ direction: "insufficient-data" });
    expect(parseTrendKey("nope")).toEqual({});
    expect(parseTrendKey("ttfb:alesund:https://digilist.no/login")).toEqual({
      metric: "ttfb",
      marketId: "alesund",
      target: "https://digilist.no/login",
    });
    expect(trendsHref()).toBe("#/trends");
    expect(trendsHref("lcp")).toBe("#/trends/lcp");
    expect(seriesKey(series())).toBe("ttfb:alesund:https://digilist.no/");
  });
});

describe("trendDelta / latestMeasured", () => {
  it("computes a delta only when both halves were measured, and never treats a gap as zero", () => {
    expect(trendDelta(series())).toEqual({ measured: true, value: 160, text: "+160" });
    expect(trendDelta(series({ later: measured(40), earlier: measured(80) }))).toEqual({
      measured: true,
      value: -40,
      text: "-40",
    });
    expect(trendDelta(series({ earlier: absent("only 2 points"), later: absent("only 2 points") })).measured).toBe(
      false,
    );
    expect(latestMeasured(series())).toEqual({ at: "2026-08-19T08:00:00.000Z", runId: "run_c", value: 240 });
    expect(latestMeasured(series({ points: [{ at: "t", runId: "r", value: null }] }))).toBeNull();
  });
});

describe("filterSeries / sortSeries / directionCounts", () => {
  const rows = [
    series(),
    series({ metric: "lcp", marketId: "oslo", direction: "improving", target: "https://xala.no/" }),
    series({
      metric: "cls",
      direction: "stable",
      earlier: measured(0.01),
      later: measured(0.01),
      target: "https://app.digilist.no/",
    }),
    series({ direction: "insufficient-data", earlier: absent("thin"), later: absent("thin"), measuredPoints: 2 }),
  ];

  it("defaults to series that changed direction, and can show the rest", () => {
    expect(filterSeries(rows, {}).map((s) => s.direction)).toEqual(["worsening", "improving"]);
    expect(filterSeries(rows, { direction: "all" })).toHaveLength(4);
    expect(filterSeries(rows, { metric: "lcp", direction: "all" })).toHaveLength(1);
    expect(filterSeries(rows, { market: "oslo", direction: "all" })[0]?.target).toBe("https://xala.no/");
    expect(filterSeries(rows, { page: "app.digilist", direction: "all" })).toHaveLength(1);
    expect(filterSeries(rows, { direction: "worsening" })).toHaveLength(1);
    expect(filterSeries(rows, { metric: "", market: "", direction: "improving" })).toHaveLength(1);
    expect(parseTrendKey("nope:alesund:https://x")).toEqual({});
    expect(parseTrendKey("ttfb::https://x")).toEqual({});
    expect(directionCounts(rows)).toEqual({
      worsening: 1,
      improving: 1,
      stable: 1,
      "insufficient-data": 1,
    });
  });

  it("sorts worsening first, then by how far the medians moved", () => {
    const byDir = sortSeries(rows, "direction");
    expect(byDir[0]?.direction).toBe("worsening");
    expect(byDir[1]?.direction).toBe("improving");
    const byDelta = sortSeries(
      [series({ later: measured(90) }), series({ later: measured(400) })],
      "delta",
    );
    expect(byDelta[0]?.later.measured && byDelta[0].later.value).toBe(400);
    expect(
      sortSeries(
        [series({ target: "https://z.test/" }), series({ target: "https://a.test/" })],
        "direction",
      )[0]?.target,
    ).toBe("https://a.test/");
    expect(sortSeries(rows, "market")[0]?.marketId).toBe("alesund");
    expect(sortSeries(rows, "page").map((s) => s.target)[0]).toContain("app.digilist");
    const thin = series({ earlier: absent("thin"), later: absent("thin") });
    expect(sortSeries([thin, thin], "delta")).toHaveLength(2);
    expect(sortSeries([thin, series()], "delta")[0]?.direction).toBe("worsening");
    expect(sortSeries([series(), thin], "delta")[0]?.direction).toBe("worsening");
    expect(filterSeries(rows, { page: "no-such-page", direction: "all" })).toEqual([]);
  });
});

describe("relatedTickets / driftBrief", () => {
  it("links tickets on the same host, and refuses to treat a drift as a failed check", () => {
    const tickets = [
      ticket(),
      ticket({ key: "site:search:xala.no", site: "xala.no", hosts: ["xala.no"], title: "search" }),
    ];
    expect(relatedTickets("https://digilist.no/login", tickets).map((t) => t.key)).toEqual([
      "site:lcp-below:digilist.no",
    ]);
    expect(relatedTickets("not a url", tickets)).toEqual([]);
    expect(
      relatedTickets("https://digilist.no/", [ticket({ hosts: [], site: "digilist.no" })]).map((t) => t.site),
    ).toEqual(["digilist.no"]);
    expect(isFilingCandidate(series())).toBe(true);
    expect(isFilingCandidate(series({ direction: "improving" }))).toBe(false);
    expect(isFilingCandidate(series({ earlier: absent("thin") }))).toBe(false);
    expect(driftBrief(series({ earlier: absent("thin"), later: absent("thin") }))).toContain("not measured");
    const brief = driftBrief(series());
    expect(brief).toContain("## Problem");
    expect(brief).toContain("not a failed journey check");
    expect(brief).toContain("alesund");
    const ours = driftBrief(series({ metric: "confidence" }));
    expect(ours).toContain("Not a site defect");
    expect(ours).toContain("Confidence");
  });
});

describe("explainSeries", () => {
  it("says how many more visits a thin series needs, in words a reader can act on", () => {
    const thin = series({
      direction: "insufficient-data",
      measuredPoints: 2,
      earlier: absent("only 2"),
      later: absent("only 2"),
    });
    expect(pointsNeeded(thin)).toBe(4);
    expect(DIRECTION_LABEL["insufficient-data"]).toBe("Not enough visits yet");
    const sections = explainSeries(thin);
    expect(sections.map((s) => s.heading)).toEqual(["What this means", "What this number is", "What we saw", "What to do next"]);
    expect(sections[0]?.text).toContain("2 of the 6");
    expect(sections[0]?.text).toContain("4 more");
    expect(sections[1]?.text).toContain("first byte");
    expect(explainSeries(series())[0]?.text).toContain("Getting worse");
    expect(explainSeries(series())[3]?.text).toContain("Open the latest visit");
    expect(explainSeries(series({ direction: "stable" }))[0]?.text).toContain("noise");
    expect(explainSeries(series({ direction: "improving" }))[0]?.text).toContain("Getting better");
    expect(explainSeries(series({ direction: "improving" }))[3]?.text).toContain("Nothing to file");
    expect(explainSeries(thin)[3]?.text).toContain("4 more");
    expect(explainSeries(series({ metric: "inp", direction: "insufficient-data", measuredPoints: 0 }))[0]?.text).toContain(
      "no visit that measured it",
    );
    expect(visitRows(thin).some((row) => row.gap)).toBe(true);
    expect(explainSeries(series({ direction: "insufficient-data", measuredPoints: 0 }))[3]?.text).toContain(
      "Until a reading exists",
    );
  });
});
