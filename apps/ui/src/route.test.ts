import { describe, expect, it } from "vitest";
import { findingHref, routeFromHash } from "./route.ts";

describe("routeFromHash", () => {
  it("opens a finding by its ticket key, even when the key has spaces and colons", () => {
    const key = "site:has a search box:xala.no";
    expect(routeFromHash(findingHref(key))).toEqual({ view: "findings", findingKey: key });
    expect(routeFromHash("#/findings")).toEqual({ view: "findings" });
  });

  it("keeps a finished visit and a live session on their own routes", () => {
    expect(routeFromHash("#/run/run_1")).toEqual({ view: "runs", runId: "run_1" });
    expect(routeFromHash("#/live/sess_1")).toEqual({ view: "live", liveId: "sess_1" });
    expect(routeFromHash("#/geography")).toEqual({ view: "geography" });
    expect(routeFromHash("#/unknown")).toEqual({ view: "runs" });
    expect(routeFromHash("#/")).toEqual({ view: "runs" });
    expect(routeFromHash("#/run")).toEqual({ view: "runs" });
  });
});
