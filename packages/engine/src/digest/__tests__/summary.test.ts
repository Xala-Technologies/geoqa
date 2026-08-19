import { describe, expect, it } from "vitest";
import type { Digest } from "../assemble.js";
import { groupFailed, summariseDigest } from "../summary.js";

const base = (): Digest => ({
  tenantId: "digilist",
  window: { since: "2026-08-18T00:00:00.000Z", until: "2026-08-19T00:00:00.000Z" },
  runs: { total: 134, pass: 82, fail: 13, error: 39, warning: 0 },
  failed: [],
  filed: [],
  repaired: [],
  mustKnow: [],
  suggestions: [],
});

describe("summariseDigest", () => {
  it("writes one honest paragraph from the counts", () => {
    expect(summariseDigest(base())).toBe(
      "134 runs in this window. 82 passed. 13 failed. 39 were our errors.",
    );
    expect(summariseDigest({ ...base(), runs: { total: 1, pass: 1, fail: 0, error: 0, warning: 0 } })).toBe(
      "1 run in this window. 1 passed. 0 failed. None were our errors.",
    );
    expect(summariseDigest({ ...base(), runs: { total: 0, pass: 0, fail: 0, error: 0, warning: 0 } })).toBe(
      "No runs in this window.",
    );
    expect(
      summariseDigest({
        ...base(),
        runs: { total: 2, pass: 1, fail: 0, error: 0, warning: 1 },
        filed: [{ key: "k", number: 9, url: "https://x/y/9", at: "t" }],
        repaired: [{ key: "k", status: "opened", at: "t" }],
      }),
    ).toBe("2 runs in this window. 1 passed. 1 passed with warnings. 0 failed. None were our errors. 1 issue recorded. 1 repair landed.");
  });
});

describe("groupFailed", () => {
  it("groups by host so the mail is a list of sites, not a spreadsheet", () => {
    const groups = groupFailed([
      {
        runId: "a",
        target: "https://app.digilist.no/search",
        market: "bergen",
        journey: "search",
        verdict: "FAIL",
        labels: ["search box"],
        href: "https://geoqa.example/#/run/a",
      },
      {
        runId: "b",
        target: "https://app.digilist.no/",
        market: "oslo",
        journey: "search",
        verdict: "FAIL",
        labels: [],
        href: null,
      },
      {
        runId: "c",
        target: "https://xala.no/",
        market: "oslo",
        journey: "browse",
        verdict: "ERROR",
        labels: [],
        href: null,
      },
      {
        runId: "d",
        target: "not a url",
        market: "oslo",
        journey: "browse",
        verdict: "ERROR",
        labels: [],
        href: null,
      },
    ]);
    expect(groups.map((g) => g.host)).toEqual(["app.digilist.no", "xala.no", "not a url"]);
    expect(groups[0]?.items).toHaveLength(2);
  });
});
