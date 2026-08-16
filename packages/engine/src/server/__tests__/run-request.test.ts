import { describe, expect, it } from "vitest";
import { parseRunRequest } from "../run-request.js";

describe("parseRunRequest", () => {
  it("reads a control-plane body and defaults the journey", () => {
    const parsed = parseRunRequest({
      url: "https://digilist.no",
      country: "NO",
      city: "Bergen",
      device: "mobile",
    });
    if (!parsed.ok) throw new Error(parsed.errors.join());
    expect(parsed.value).toMatchObject({
      url: "https://digilist.no",
      country: "NO",
      city: "Bergen",
      device: "mobile",
      journey: "landing-page",
    });
  });

  it("REFUSES a missing url, a non-http url, and an unknown key", () => {
    expect(parseRunRequest({}).ok).toBe(false);
    expect(parseRunRequest({ url: "ftp://x" }).ok).toBe(false);
    expect(parseRunRequest({ url: "http://[" }).ok).toBe(false);
    expect(parseRunRequest({ url: "https://digilist.no", extra: true }).ok).toBe(false);
  });

  it("REFUSES rotateIp or evidence set false — both are how a run already works", () => {
    expect(parseRunRequest({ url: "https://digilist.no", rotateIp: false }).ok).toBe(false);
    expect(parseRunRequest({ url: "https://digilist.no", evidence: false }).ok).toBe(false);
  });

  it("REFUSES a device that is not mobile or desktop, and a duration that is not a minute count", () => {
    expect(parseRunRequest({ url: "https://digilist.no", device: "tablet" }).ok).toBe(false);
    expect(parseRunRequest({ url: "https://digilist.no", sessionDurationMinutes: 0 }).ok).toBe(false);
    const ok = parseRunRequest({ url: "https://digilist.no", sessionDurationMinutes: 10, journey: "browse" });
    if (!ok.ok) throw new Error(ok.errors.join());
    expect(ok.value.journey).toBe("browse");
    expect(ok.value.sessionDurationMinutes).toBe(10);
    const full = parseRunRequest({
      url: "https://digilist.no",
      locale: "nb-NO",
      timezone: "Europe/Oslo",
      rotateIp: true,
      evidence: true,
      allowWrites: true,
    });
    if (!full.ok) throw new Error(full.errors.join());
    expect(full.value).toMatchObject({
      locale: "nb-NO",
      timezone: "Europe/Oslo",
      rotateIp: true,
      evidence: true,
      allowWrites: true,
    });
  });

  it("names a bad optional field rather than dropping it", () => {
    expect(parseRunRequest({ url: "https://digilist.no", country: "" }).ok).toBe(false);
    expect(parseRunRequest({ url: "https://digilist.no", allowWrites: "yes" }).ok).toBe(false);
    expect(parseRunRequest({ url: "https://digilist.no", rotateIp: "yes" }).ok).toBe(false);
    expect(parseRunRequest({ url: "https://digilist.no", evidence: "yes" }).ok).toBe(false);
  });

  it("refuses a body that is not an object", () => {
    expect(parseRunRequest(null).ok).toBe(false);
    expect(parseRunRequest(["https://x"]).ok).toBe(false);
  });
});
