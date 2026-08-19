import { describe, expect, it } from "vitest";
import { decodeHashRest, findingHref, routeFromHash } from "./route.ts";

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
    expect(routeFromHash("#/trends")).toEqual({ view: "trends" });
    expect(routeFromHash("#/unknown")).toEqual({ view: "runs" });
    expect(routeFromHash("#/")).toEqual({ view: "runs" });
    expect(routeFromHash("#/run")).toEqual({ view: "runs" });
  });

  it("opens a geography page by its URL, encoded or raw", () => {
    const target = "https://digilist.no/login";
    expect(routeFromHash(`#/geography/${encodeURIComponent(target)}`)).toEqual({
      view: "geography",
      pageTarget: target,
    });
    expect(routeFromHash(`#/geography/${target}`)).toEqual({ view: "geography", pageTarget: target });
    expect(decodeHashRest(["%"])).toBe("%");
  });

  it("opens a trend by metric or by the series key", () => {
    expect(routeFromHash("#/trends/lcp")).toEqual({ view: "trends", trendKey: "lcp" });
    const key = "ttfb:alesund:https://digilist.no/";
    expect(routeFromHash(`#/trends/${encodeURIComponent(key)}`)).toEqual({ view: "trends", trendKey: key });
  });
});
