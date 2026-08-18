import { describe, expect, it } from "vitest";
import { decodoHeaders } from "../decodo-headers.js";

describe("decodoHeaders", () => {
  it("sends the raw API key and a User-Agent, never a Token prefix", () => {
    // Cloudflare 1010's a client with no User-Agent (python-urllib) as a
    // banned browser signature, which we read as "the key is dead". Prefixing
    // Token is a different 401. The live contract is Authorization: <key>.
    const headers = decodoHeaders("k");
    expect(headers.authorization).toBe("k");
    expect(headers.accept).toBe("application/json");
    expect(headers["user-agent"]).toContain("geoqa/");
    expect(headers.authorization.startsWith("Token ")).toBe(false);
  });
});
