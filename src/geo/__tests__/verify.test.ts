import { describe, expect, it } from "vitest";
import { UNKNOWN_BROWSER, UNKNOWN_NETWORK } from "../observe.js";
import type { BrowserObservation, GeoProfile, NetworkObservation } from "../types.js";
import {
  compareCity,
  compareCountry,
  compareLanguage,
  compareTimezone,
  geoConfidence,
  verificationReasons,
  verifyGeo,
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
    expect(v.browser.requested).toEqual({ language: "nb-NO", timezone: "Europe/Oslo" });
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

  it("scores an entirely unread run low rather than passing it", () => {
    const v = verifyGeo(OSLO_PROFILE, UNKNOWN_NETWORK, UNKNOWN_BROWSER);
    expect(v.trustworthy).toBe(false);
    expect(v.confidence).toBeLessThan(40);
  });
});

describe("verificationReasons", () => {
  it("collects every axis's reason for the run summary", () => {
    const reasons = verificationReasons(verifyGeo(OSLO_PROFILE, NORWAY_BASELINE, NORWEGIAN_BROWSER));
    expect(reasons).toHaveLength(4);
    expect(reasons.join(" ")).toContain("Lysaker");
  });
});
