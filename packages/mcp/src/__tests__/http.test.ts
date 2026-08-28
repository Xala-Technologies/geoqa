import { describe, expect, it } from "vitest";
import { parseAllowedHosts } from "../http.js";

describe("parseAllowedHosts", () => {
  it("splits GEOQA_MCP_ALLOWED_HOSTS", () => {
    expect(
      parseAllowedHosts({ GEOQA_MCP_ALLOWED_HOSTS: "a.example.com, b.example.com" }, null),
    ).toEqual(["a.example.com", "b.example.com"]);
  });

  it("derives hostname from GEOQA_SERVER_URL", () => {
    expect(parseAllowedHosts({}, "https://geoqa.xala.no")).toEqual([
      "geoqa.xala.no",
      "127.0.0.1",
      "localhost",
    ]);
  });

  it("returns undefined when no hosts configured", () => {
    expect(parseAllowedHosts({}, null)).toBeUndefined();
  });
});
