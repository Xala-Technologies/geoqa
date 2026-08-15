import { describe, expect, it } from "vitest";
import type { Measured, RunView } from "../types.ts";
import {
  DEFAULT_PAGE_SIZE,
  deviceOf,
  filterRuns,
  nextSort,
  pageRuns,
  sortRuns,
  type RunSortKey,
} from "./run-list.ts";

const reading = <T>(value: T, text: string): Measured<T> => ({ measured: true, value, text });
const absent = (reason: string): Measured<number> => ({ measured: false, reason, text: "not measured" });

const run = (over: Partial<RunView> & Pick<RunView, "runId" | "startedAt">): RunView => ({
  target: "https://digilist.no",
  profileId: "bergen-mobile",
  marketId: "bergen",
  journeyId: "landing-page",
  verdict: "PASS",
  evidenceId: null,
  seed: 1,
  findings: { total: 0, bySeverity: {}, byCategory: {}, labels: [] },
  durationMs: 1000,
  confidence: {
    overall: reading(100, "100"),
    geo: reading(100, "100"),
    browser: reading(100, "100"),
    journey: reading(100, "100"),
    evidence: reading(100, "100"),
    search: absent("no SERP source"),
  },
  vitals: {
    lcp: reading(280, "280ms"),
    cls: reading(0.09, "0.09"),
    ttfb: reading(150, "150ms"),
    inp: absent("not measured"),
  },
  geo: {
    requested: "NO/Bergen",
    observed: "NO/Bergen",
    country: "match",
    city: "match",
    egressHeld: "match",
    agreement: "match",
  },
  latency: reading(1000, "1000ms"),
  steps: [],
  screenshots: [],
  ...over,
});

const sample = [
  run({
    runId: "old",
    startedAt: "2026-08-01T10:00:00.000Z",
    marketId: "oslo",
    profileId: "oslo-desktop",
    verdict: "FAIL",
    findings: { total: 2, bySeverity: {}, byCategory: {}, labels: ["title"] },
    vitals: { lcp: reading(800, "800ms"), cls: reading(0.09, "0.09"), ttfb: reading(150, "150ms"), inp: absent("x") },
  }),
  run({ runId: "mid", startedAt: "2026-08-10T10:00:00.000Z", journeyId: "search", vitals: { lcp: absent("no LCP"), cls: reading(0, "0"), ttfb: reading(1, "1ms"), inp: absent("x") } }),
  run({ runId: "new", startedAt: "2026-08-15T10:00:00.000Z", target: "https://other.test", geo: { requested: "NO/Alta", observed: "NO/Alta", country: "match", city: "match", egressHeld: "match", agreement: "match" } }),
];

describe("deviceOf", () => {
  it("reads the device from the profile id, and leaves an unknown id alone", () => {
    expect(deviceOf("bergen-mobile")).toBe("mobile");
    expect(deviceOf("oslo-desktop")).toBe("desktop");
    expect(deviceOf("lab")).toBe("lab");
  });
});

describe("sortRuns — latest first is the default the list opens on", () => {
  it("orders by startedAt descending", () => {
    expect(sortRuns(sample, "startedAt", true).map((r) => r.runId)).toEqual(["new", "mid", "old"]);
  });

  it("orders by startedAt ascending when asked", () => {
    expect(sortRuns(sample, "startedAt", false).map((r) => r.runId)).toEqual(["old", "mid", "new"]);
  });

  it("puts an unmeasured LCP last in both directions", () => {
    // An absence is not a fast page. Sorting it as 0 would put unread runs at the top of "fastest".
    expect(sortRuns(sample, "lcp", false).map((r) => r.runId)).toEqual(["new", "old", "mid"]);
    expect(sortRuns(sample, "lcp", true).map((r) => r.runId)).toEqual(["old", "new", "mid"]);
  });

  it("sorts a string column and a measured CLS the same way a header click does", () => {
    expect(sortRuns(sample, "target", false).map((r) => r.target)).toEqual([
      "https://digilist.no",
      "https://digilist.no",
      "https://other.test",
    ]);
    expect(sortRuns(sample, "cls", false).map((r) => r.runId)).toEqual(["mid", "old", "new"]);
    expect(sortRuns(sample, "observed", false).map((r) => r.runId)).toEqual(["new", "old", "mid"]);
    expect(sortRuns(sample, "findings", true).map((r) => r.runId)[0]).toBe("old");
    expect(sortRuns(sample, "confidence", true)[0]?.confidence.overall.measured).toBe(true);
    expect(sortRuns(sample, "durationMs", false).every((r) => r.durationMs === 1000)).toBe(true);
  });

  it("ties two absences and still puts them after a reading", () => {
    const blank = {
      lcp: absent("x"),
      cls: absent("x"),
      ttfb: reading(1, "1ms"),
      inp: absent("x"),
    };
    const quiet = {
      overall: absent("x"),
      geo: reading(100, "100"),
      browser: reading(100, "100"),
      journey: reading(100, "100"),
      evidence: reading(100, "100"),
      search: absent("x"),
    };
    const a = run({ runId: "a", startedAt: "2026-08-01T00:00:00.000Z", vitals: blank, confidence: quiet });
    const b = run({ runId: "b", startedAt: "2026-08-02T00:00:00.000Z", vitals: blank, confidence: quiet });
    const c = run({ runId: "c", startedAt: "2026-08-03T00:00:00.000Z" });
    expect(sortRuns([a, b, c], "cls", true).map((r) => r.runId)).toEqual(["c", "a", "b"]);
    expect(sortRuns([a, b, c], "confidence", false).map((r) => r.runId)).toEqual(["c", "a", "b"]);
    expect(sortRuns([a, b], "lcp", true).map((r) => r.runId)).toEqual(["a", "b"]);
  });
});

describe("filterRuns", () => {
  const none = { q: "", market: "", verdict: "", journey: "", device: "" };

  it("keeps every run when nothing is selected", () => {
    expect(filterRuns(sample, none)).toHaveLength(3);
  });

  it("filters on market, verdict, journey, device and free text independently", () => {
    expect(filterRuns(sample, { ...none, market: "oslo" }).map((r) => r.runId)).toEqual(["old"]);
    expect(filterRuns(sample, { ...none, verdict: "FAIL" }).map((r) => r.runId)).toEqual(["old"]);
    expect(filterRuns(sample, { ...none, journey: "search" }).map((r) => r.runId)).toEqual(["mid"]);
    expect(filterRuns(sample, { ...none, device: "desktop" }).map((r) => r.runId)).toEqual(["old"]);
    expect(filterRuns(sample, { ...none, q: "other.test" }).map((r) => r.runId)).toEqual(["new"]);
  });
});

describe("pageRuns", () => {
  it("defaults to 25 and returns the first page", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(25);
    const ids = Array.from({ length: 38 }, (_, i) => `r${String(i).padStart(2, "0")}`);
    const page = pageRuns(ids, 0, 25);
    expect(page.rows).toHaveLength(25);
    expect(page.rows[0]).toBe("r00");
    expect(page.from).toBe(1);
    expect(page.to).toBe(25);
    expect(page.total).toBe(38);
    expect(page.pages).toBe(2);
    expect(page.page).toBe(0);
  });

  it("clamps a page past the end rather than showing an empty table", () => {
    const page = pageRuns(["a", "b", "c"], 9, 2);
    expect(page.rows).toEqual(["c"]);
    expect(page.page).toBe(1);
    expect(page.from).toBe(3);
    expect(page.to).toBe(3);
  });

  it("reports an empty match as page 0 of 1, with no rows", () => {
    const page = pageRuns([], 3, 25);
    expect(page).toEqual({ rows: [], page: 0, pages: 1, from: 0, to: 0, total: 0 });
  });

  it("treats a zero page size as one and a negative page as the first", () => {
    const page = pageRuns(["a", "b"], -2, 0);
    expect(page.rows).toEqual(["a"]);
    expect(page.page).toBe(0);
    expect(page.pages).toBe(2);
  });
});

describe("nextSort", () => {
  it("flips direction on the same column and starts descending on a new one", () => {
    expect(nextSort("startedAt", true, "startedAt")).toEqual({ sort: "startedAt", desc: false });
    expect(nextSort("startedAt", false, "lcp")).toEqual({ sort: "lcp" as RunSortKey, desc: true });
  });
});
