import { describe, expect, it } from "vitest";
import { acceptRun } from "../accept-run.js";
import type { Tenant } from "../../tenant/types.js";

const tenant = (): Tenant =>
  ({
    id: "digilist",
    name: "Digilist",
    markets: ["oslo", "bergen"],
    targets: ["https://digilist.no"],
    quota: { trafficMb: 1, runsPerDay: 1 },
    retentionDays: 1,
  }) as Tenant;

const resolve = (id: string) => () => ({ ok: true as const, id });
const journey = (writes: boolean) => () => ({ ok: true as const, writes });

describe("acceptRun", () => {
  it("accepts a body the tenant owns and a profile that exists", () => {
    expect(
      acceptRun({
        body: {},
        tenant: tenant(),
        extraTargets: [],
        resolveProfile: resolve("oslo-desktop"),
        loadJourney: journey(false),
      }).ok,
    ).toBe(false);
    const out = acceptRun({
      body: { url: "https://digilist.no", country: "NO", city: "Bergen", device: "mobile", geo: "bergen-mobile", journey: "browse" },
      tenant: tenant(),
      extraTargets: [],
      resolveProfile: resolve("bergen-mobile"),
      loadJourney: journey(false),
    });
    if (!out.ok) throw new Error(out.error);
    expect(out.profileId).toBe("bergen-mobile");
    expect(out.market).toBe("bergen");
    expect(out.device).toBe("mobile");
    expect(out.request.journey).toBe("browse");
  });

  it("treats a watch target as owned, without rewriting the tenant file", () => {
    const out = acceptRun({
      body: { url: "https://xala.no" },
      tenant: tenant(),
      extraTargets: ["https://xala.no"],
      resolveProfile: resolve("oslo-desktop"),
      loadJourney: journey(false),
    });
    expect(out.ok).toBe(true);
  });

  it("REFUSES a url the tenant does not own, a market they never asked for, and a writes journey without allowWrites", () => {
    expect(
      acceptRun({
        body: { url: "https://evil.test" },
        tenant: tenant(),
        extraTargets: [],
        resolveProfile: resolve("oslo-desktop"),
        loadJourney: journey(false),
      }).ok,
    ).toBe(false);
    expect(
      acceptRun({
        body: { url: "https://digilist.no", city: "Berlin" },
        tenant: tenant(),
        extraTargets: [],
        resolveProfile: resolve("berlin-desktop"),
        loadJourney: journey(false),
      }).ok,
    ).toBe(false);
    expect(
      acceptRun({
        body: { url: "https://digilist.no", journey: "contact-form" },
        tenant: tenant(),
        extraTargets: [],
        resolveProfile: resolve("oslo-desktop"),
        loadJourney: journey(true),
      }).ok,
    ).toBe(false);
    expect(
      acceptRun({
        body: { url: "https://digilist.no", journey: "contact-form", allowWrites: true },
        tenant: tenant(),
        extraTargets: [],
        resolveProfile: resolve("oslo-desktop"),
        loadJourney: journey(true),
      }).ok,
    ).toBe(true);
  });

  it("passes through a profile or journey the resolver could not find", () => {
    const missing = acceptRun({
      body: { url: "https://digilist.no", city: "Atlantis" },
      tenant: tenant(),
      extraTargets: [],
      resolveProfile: () => ({ ok: false, errors: ["no profile for Atlantis"] }),
      loadJourney: journey(false),
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected failure");
    expect(missing.error).toContain("Atlantis");
    const noJourney = acceptRun({
      body: { url: "https://digilist.no", journey: "nope" },
      tenant: tenant(),
      extraTargets: [],
      resolveProfile: resolve("oslo-desktop"),
      loadJourney: () => ({ ok: false, errors: ["no such journey: nope"] }),
    });
    expect(noJourney.ok).toBe(false);
  });
});
