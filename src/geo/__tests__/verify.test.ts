import { describe, expect, it } from "vitest";
import { UNKNOWN_BROWSER, UNKNOWN_NETWORK } from "../observe.js";
import type { BrowserObservation, GeoProfile, NetworkObservation } from "../types.js";
import {
  compareCity,
  compareCountry,
  compareEgressHeld,
  compareLanguage,
  compareTimezone,
  geoConfidence,
  verificationReasons,
  verifyGeo,
  withEgressHeld,
} from "../verify.js";

const OSLO_PROFILE: GeoProfile = {
  id: "oslo-mobile",
  label: "Oslo, mobile",
  market: {
    id: "oslo",
    country: "NO",
    city: "Oslo",
    language: "nb-NO",
    timezone: "Europe/Oslo",
    currency: "NOK",
    coordinates: [59.9139, 10.7522],
  },
  device: { id: "mobile", kind: "mobile", viewport: { width: 390, height: 844 } },
  visitorType: "anonymous",
};

/** The real Norway baseline: note the city is Lysaker, not Oslo. */
const NORWAY_BASELINE: NetworkObservation = {
  ip: "213.52.15.251",
  country: "NO",
  city: "Lysaker",
  region: "Akershus",
  org: "AS2116 GLOBALCONNECT AS",
  timezone: "Europe/Oslo",
  latencyMs: 120,
};

const NORWEGIAN_BROWSER: BrowserObservation = {
  language: "nb-NO",
  languages: ["nb-NO"],
  timezone: "Europe/Oslo",
  userAgent: "HeadlessChrome/151",
  viewport: { width: 390, height: 844 },
  geolocation: "denied",
};

describe("compareCountry", () => {
  it("matches case-insensitively", () => {
    expect(compareCountry("NO", "no").verdict).toBe("match");
  });

  it("is a MISMATCH when the country is provably wrong", () => {
    const r = compareCountry("NO", "DE");
    expect(r.verdict).toBe("mismatch");
    expect(r.reasons[0]).toContain("egressed from DE");
  });

  it("is unverified — not a pass — when nothing was read", () => {
    expect(compareCountry("NO", null).verdict).toBe("unverified");
  });
});

describe("compareCity", () => {
  it("matches exactly and case-insensitively", () => {
    expect(compareCity("Oslo", "oslo").verdict).toBe("match");
  });

  it("matches on containment either way", () => {
    expect(compareCity("Oslo", "Oslo Municipality").verdict).toBe("match");
    expect(compareCity("Greater Oslo", "Oslo").verdict).toBe("match");
  });

  it("calls the real Lysaker/Oslo case UNVERIFIED, never a mismatch", () => {
    // The genuine baseline. An exchange suburb is not proof the session is in
    // the wrong place, so we can prove a city right but not wrong.
    const r = compareCity("Oslo", "Lysaker");
    expect(r.verdict).toBe("unverified");
    expect(r.reasons[0]).toContain("unproven, not wrong");
  });

  it("is unverified when nothing was read", () => {
    expect(compareCity("Oslo", null).verdict).toBe("unverified");
  });
});

describe("compareLanguage", () => {
  it("matches exactly and on the primary subtag", () => {
    expect(compareLanguage("nb-NO", "nb-NO").verdict).toBe("match");
    expect(compareLanguage("nb-NO", "nb").verdict).toBe("match");
  });

  it("mismatches across primary subtags", () => {
    expect(compareLanguage("nb-NO", "de-DE").verdict).toBe("mismatch");
  });

  it("is unverified when nothing was read", () => {
    expect(compareLanguage("nb-NO", null).verdict).toBe("unverified");
  });
});

describe("compareTimezone", () => {
  it("requires an exact IANA zone", () => {
    expect(compareTimezone("Europe/Oslo", "Europe/Oslo").verdict).toBe("match");
    expect(compareTimezone("Europe/Oslo", "Europe/Berlin").verdict).toBe("mismatch");
    expect(compareTimezone("Europe/Oslo", null).verdict).toBe("unverified");
  });
});

describe("geoConfidence", () => {
  const all = (verdict: "match" | "mismatch" | "unverified") =>
    Array.from({ length: 4 }, () => ({ verdict, reasons: [] }));

  it("is 100 only when every axis matches", () => {
    expect(geoConfidence(all("match"))).toBe(100);
  });

  it("is 0 when every axis is a proven mismatch", () => {
    expect(geoConfidence(all("mismatch"))).toBe(0);
  });

  it("caps hard on a single proven mismatch — three good axes cannot average it away", () => {
    const axes = [
      { verdict: "mismatch" as const, reasons: [] }, // country
      { verdict: "match" as const, reasons: [] },
      { verdict: "match" as const, reasons: [] },
      { verdict: "match" as const, reasons: [] },
    ];
    // Weighted score is 0.55; the mismatch cap halves it to ~28.
    expect(geoConfidence(axes)).toBe(28);
    expect(geoConfidence(axes)).toBeLessThan(geoConfidence(all("unverified")) + 100);
  });

  it("scores an unverified axis between a match and a mismatch", () => {
    const score = geoConfidence(all("unverified"));
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it("ignores axes beyond the four weighted ones and unknown verdicts", () => {
    const extra = [...all("match"), { verdict: "match" as const, reasons: [] }];
    expect(geoConfidence(extra)).toBe(100);
    expect(geoConfidence([{ verdict: "bogus" as never, reasons: [] }])).toBe(0);
  });
});

describe("verifyGeo", () => {
  it("keeps the two axes separate in the result", () => {
    const v = verifyGeo(OSLO_PROFILE, NORWAY_BASELINE, NORWEGIAN_BROWSER);
    expect(v.network.country.verdict).toBe("match");
    expect(v.network.city.verdict).toBe("unverified");
    expect(v.browser.language.verdict).toBe("match");
    expect(v.browser.timezone.verdict).toBe("match");
    expect(v.network.requested).toEqual({ country: "NO", city: "Oslo" });
    expect(v.browser.requested).toEqual({
      language: "nb-NO",
      timezone: "Europe/Oslo",
      viewport: { width: 390, height: 844 },
    });
    expect(v.browser.viewport.verdict).toBe("match");
  });

  it("is NOT trustworthy when any axis is merely unverified", () => {
    const v = verifyGeo(OSLO_PROFILE, NORWAY_BASELINE, NORWEGIAN_BROWSER);
    expect(v.trustworthy).toBe(false);
    expect(v.confidence).toBeGreaterThan(70);
  });

  it("is trustworthy only when all four axes match", () => {
    const v = verifyGeo(OSLO_PROFILE, { ...NORWAY_BASELINE, city: "Oslo" }, NORWEGIAN_BROWSER);
    expect(v.trustworthy).toBe(true);
    expect(v.confidence).toBe(100);
  });

  it("catches the Oslo-coordinates-from-a-Frankfurt-IP profile the design exists to prevent", () => {
    const v = verifyGeo(
      OSLO_PROFILE,
      { ...NORWAY_BASELINE, country: "DE", city: "Frankfurt" },
      NORWEGIAN_BROWSER,
    );
    expect(v.network.country.verdict).toBe("mismatch");
    expect(v.browser.language.verdict).toBe("match");
    expect(v.trustworthy).toBe(false);
    expect(v.confidence).toBeLessThan(40);
  });

  it("catches a MOBILE profile that actually rendered at desktop width", () => {
    // The first live run did exactly this: oslo-mobile rendered at 1280px,
    // every check passed, and the evidence package was 100% complete. Only the
    // screenshot showed it. The axis exists so the run says so itself.
    const v = verifyGeo(OSLO_PROFILE, NORWAY_BASELINE, {
      ...NORWEGIAN_BROWSER,
      viewport: { width: 1280, height: 577 },
    });
    expect(v.browser.viewport.verdict).toBe("mismatch");
    expect(v.browser.viewport.reasons[0]).toContain("browser rendered 1280px");
    expect(v.trustworthy).toBe(false);
  });

  it("compares the viewport on width only, ignoring height", () => {
    const v = verifyGeo(OSLO_PROFILE, NORWAY_BASELINE, {
      ...NORWEGIAN_BROWSER,
      viewport: { width: 390, height: 700 },
    });
    expect(v.browser.viewport.verdict).toBe("match");
  });

  it("reports an unread viewport as unverified", () => {
    const v = verifyGeo(OSLO_PROFILE, NORWAY_BASELINE, { ...NORWEGIAN_BROWSER, viewport: null });
    expect(v.browser.viewport.verdict).toBe("unverified");
  });

  it("scores an entirely unread run low rather than passing it", () => {
    const v = verifyGeo(OSLO_PROFILE, UNKNOWN_NETWORK, UNKNOWN_BROWSER);
    expect(v.trustworthy).toBe(false);
    expect(v.confidence).toBeLessThan(40);
  });
});

describe("verificationReasons", () => {
  it("collects every axis's reason for the run summary", () => {
    const reasons = verificationReasons(verifyGeo(OSLO_PROFILE, NORWAY_BASELINE, NORWEGIAN_BROWSER));
    expect(reasons).toHaveLength(6);
    expect(reasons.join(" ")).toContain("Lysaker");
    // The stability axis is present from the start, and says it is not yet known.
    expect(reasons.join(" ")).toContain("only known once the journey has finished");
  });
});

describe("compareEgressHeld", () => {
  it("confirms one identity held across the run", () => {
    const axis = compareEgressHeld("213.52.15.251", "213.52.15.251");
    expect(axis.verdict).toBe("match");
    expect(axis.reasons[0]).toContain("held 213.52.15.251");
  });

  it("proves a mid-run rotation and names both exits", () => {
    const axis = compareEgressHeld("213.52.15.251", "45.13.98.7");
    expect(axis.verdict).toBe("mismatch");
    expect(axis.reasons[0]).toContain("213.52.15.251");
    expect(axis.reasons[0]).toContain("45.13.98.7");
  });

  it("is unverified — not a pass — when either end was never read", () => {
    expect(compareEgressHeld(null, "1.1.1.1").verdict).toBe("unverified");
    expect(compareEgressHeld("1.1.1.1", null).verdict).toBe("unverified");
  });
});

describe("withEgressHeld", () => {
  it("records the axis and keeps a fully verified run trustworthy", () => {
    const before = verifyGeo(OSLO_PROFILE, NORWAY_BASELINE, NORWEGIAN_BROWSER);
    const after = withEgressHeld({ ...before, trustworthy: true }, compareEgressHeld("1.1.1.1", "1.1.1.1"));
    expect(after.network.egressHeld.verdict).toBe("match");
    expect(after.trustworthy).toBe(true);
  });

  it("takes trustworthiness away from a run whose egress rotated", () => {
    const before = verifyGeo(OSLO_PROFILE, NORWAY_BASELINE, NORWEGIAN_BROWSER);
    const after = withEgressHeld({ ...before, trustworthy: true }, compareEgressHeld("1.1.1.1", "2.2.2.2"));
    expect(after.trustworthy).toBe(false);
  });

  it("cannot hand back trust the run never had", () => {
    const before = verifyGeo(OSLO_PROFILE, NORWAY_BASELINE, NORWEGIAN_BROWSER);
    const after = withEgressHeld({ ...before, trustworthy: false }, compareEgressHeld("1.1.1.1", "1.1.1.1"));
    expect(after.trustworthy).toBe(false);
  });
});
