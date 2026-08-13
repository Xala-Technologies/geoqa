import { describe, expect, it } from "vitest";
import { UNKNOWN_BROWSER, UNKNOWN_NETWORK } from "../observe.js";
import type { BrowserObservation, GeoProfile, NetworkObservation } from "../types.js";
import {
  compareCity,
  compareCountry,
  compareDevice,
  compareEgressHeld,
  compareLanguage,
  compareSources,
  compareTimezone,
  geoConfidence,
  verificationReasons,
  verifyGeo,
  withCorroboration,
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

describe("compareSources", () => {
  const obs = (over: Partial<NetworkObservation>): NetworkObservation => ({ ...UNKNOWN_NETWORK, ...over });

  it("MATCHES when two independent databases agree about the country", () => {
    const result = compareSources(obs({ ip: "1.2.3.4", country: "NO", city: "Oslo" }), obs({ ip: "1.2.3.4", country: "NO", city: "Oslo" }));
    expect(result.verdict).toBe("match");
    expect(result.reasons[0]).toContain("two independent sources agree");
  });

  it("reports the São Paulo / New York case as a MISMATCH", () => {
    // The live finding this axis exists for: one Decodo ISP exit, one IP, two
    // countries. Either reading alone is confident and coherent, and one is wrong.
    const result = compareSources(
      obs({ ip: "45.1.2.3", country: "BR", city: "São Paulo" }),
      obs({ ip: "45.1.2.3", country: "US", city: "New York" }),
    );
    expect(result.verdict).toBe("mismatch");
    expect(result.reasons[0]).toContain("BR and US");
    expect(result.reasons[0]).toContain("a wrong database looks exactly like a wrong proxy");
  });

  it("does NOT call a city divergence a defect — it records it on a match", () => {
    // Measured on one machine with no proxy: ipinfo says Tønsberg, geojs Rykkin,
    // ipwho.is Oslo. Comparing cities strictly would fire on essentially every
    // run, which is an engine manufacturing defects out of its own instrumentation.
    const result = compareSources(
      obs({ ip: "1.2.3.4", country: "NO", city: "Tønsberg" }),
      obs({ ip: "1.2.3.4", country: "NO", city: "Oslo" }),
    );
    expect(result.verdict).toBe("match");
    expect(result.reasons[0]).toContain("cities differ");
    expect(result.reasons[0]).toContain("is not a defect");
  });

  it("says nothing about cities when they agree", () => {
    const result = compareSources(obs({ ip: "1.2.3.4", country: "NO", city: "Oslo" }), obs({ ip: "1.2.3.4", country: "NO", city: "oslo " }));
    expect(result.reasons[0]).not.toContain("cities differ");
  });

  it("refuses to compare two DIFFERENT IPs, and names both explanations", () => {
    // Reproduced on this laptop with no proxy at all: curl reached ipinfo over
    // IPv4 and ipwho.is over IPv6. Calling that a geographic disagreement would be
    // a finding invented out of our own probing.
    const result = compareSources(
      obs({ ip: "88.88.18.137", country: "NO", city: "Tønsberg" }),
      obs({ ip: "2001:4656::1", country: "US", city: "New York" }),
    );
    expect(result.verdict).toBe("unverified");
    expect(result.reasons[0]).toContain("different IPs");
    expect(result.reasons[0]).toContain("dual-stack");
    expect(result.reasons[0]).toContain("rotation");
  });

  it("is unverified when either source read no country, and says which", () => {
    expect(compareSources(obs({}), obs({ country: "NO" })).reasons[0]).toContain("primary source read no country");
    expect(compareSources(obs({ country: "NO" }), obs({})).reasons[0]).toContain("corroborating source read no country");
  });

  it("compares countries even when one source could not report an IP", () => {
    // A missing IP is not evidence of two visitors, so it must not block the
    // comparison — otherwise a source that omits `ip` silently disables the axis.
    expect(compareSources(obs({ country: "NO" }), obs({ ip: "1.2.3.4", country: "US" })).verdict).toBe("mismatch");
  });
});

describe("withCorroboration", () => {
  const obs = (over: Partial<NetworkObservation>): NetworkObservation => ({ ...UNKNOWN_NETWORK, ...over });
  const norwegian = obs({ ip: "1.2.3.4", country: "NO", city: "Oslo" });
  const browser: BrowserObservation = {
    language: "nb-NO",
    languages: ["nb-NO"],
    timezone: "Europe/Oslo",
    userAgent: "ua",
    viewport: { width: 390, height: 844 },
    geolocation: null,
  };

  it("starts unverified with no corroborating reading at all", () => {
    // Neither agreement nor disagreement: nothing checked.
    const v = verifyGeo(OSLO_PROFILE, norwegian, browser);
    expect(v.network.corroborating).toBeNull();
    expect(v.network.agreement.verdict).toBe("unverified");
    expect(v.network.agreement.reasons[0]).toContain("no corroborating IP-geo source");
  });

  it("keeps BOTH readings, so a report can show which two numbers disagreed", () => {
    const v = withCorroboration(verifyGeo(OSLO_PROFILE, norwegian, browser), obs({ ip: "1.2.3.4", country: "US", city: "New York" }));
    expect(v.network.observed.country).toBe("NO");
    expect(v.network.corroborating?.country).toBe("US");
  });

  it("drops trustworthiness and confidence when the sources disagree", () => {
    const agreed = withCorroboration(verifyGeo(OSLO_PROFILE, norwegian, browser), obs({ ip: "1.2.3.4", country: "NO", city: "Oslo" }));
    const disagreed = withCorroboration(verifyGeo(OSLO_PROFILE, norwegian, browser), obs({ ip: "1.2.3.4", country: "US", city: "New York" }));
    expect(agreed.trustworthy).toBe(true);
    expect(disagreed.trustworthy).toBe(false);
    expect(disagreed.confidence).toBeLessThan(agreed.confidence);
  });

  it("can only ever LOWER trust — agreement does not rescue a mismatched country", () => {
    // A second database agreeing that we are in the wrong country is not good news.
    const german = obs({ ip: "1.2.3.4", country: "DE", city: "Berlin" });
    const v = withCorroboration(verifyGeo(OSLO_PROFILE, german, browser), german);
    expect(v.network.agreement.verdict).toBe("match");
    expect(v.trustworthy).toBe(false);
  });
});

describe("geoConfidence caps", () => {
  const axis = (verdict: "match" | "mismatch" | "unverified") => ({ verdict, reasons: ["r"] });
  const perfect = [axis("match"), axis("match"), axis("match"), axis("match")];

  it("scores 100 with four matches and no caps", () => {
    expect(geoConfidence(perfect)).toBe(100);
  });

  it("lets a capping axis pull a perfect score down without weighting it", () => {
    // A disagreement does not make a run 15% less Norwegian; it makes the whole
    // geographic answer unreliable. Averaging it in would let three good readings
    // hide it.
    expect(geoConfidence(perfect, [axis("mismatch")])).toBe(50);
    expect(geoConfidence(perfect, [axis("unverified")])).toBe(85);
    expect(geoConfidence(perfect, [axis("match")])).toBe(100);
  });
});

describe("compareDevice", () => {
  it("MATCHES when the declared user agent is what the page reports", () => {
    expect(compareDevice({ userAgent: "Mozilla/5.0 (Pixel 5)" }, "Mozilla/5.0 (Pixel 5)").verdict).toBe("match");
  });

  it("MISMATCHES when the page reports a different one — the desktop-under-mobile case", () => {
    // The failure C-8 names: a profile whose emulate name was a typo produced a run
    // with no mobile user agent, a perfectly matching viewport and a clean
    // verification, and a site doing UA detection served its desktop variant.
    const result = compareDevice({ userAgent: "Mozilla/5.0 (Pixel 5)" }, "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome");
    expect(result.verdict).toBe("mismatch");
    expect(result.reasons[0]).toContain("page reports");
  });

  it("is UNVERIFIED for a profile that declares nothing, not a match", () => {
    // A claim nobody made cannot be verified. Inventing an expectation from
    // device.kind would report a mismatch on every mobile profile in this repo — all
    // of which deliberately carry no descriptor.
    const result = compareDevice({}, "Mozilla/5.0 (X11; Linux x86_64)");
    expect(result.verdict).toBe("unverified");
    expect(result.reasons[0]).toContain("no device claim to verify");
  });

  it("is UNVERIFIED for an emulate name, and says why it cannot be confirmed", () => {
    // A descriptor name is not a substring of the user-agent string it produces:
    // "Pixel 5" does not appear in the Android UA Playwright builds from it.
    const result = compareDevice({ emulate: "Pixel 5" }, "Mozilla/5.0 (Linux; Android 11; Pixel 5)");
    expect(result.verdict).toBe("unverified");
    expect(result.reasons[0]).toContain("not a substring");
  });

  it("is UNVERIFIED when the user agent was never read", () => {
    expect(compareDevice({ userAgent: "x" }, null).verdict).toBe("unverified");
  });

  it("costs a run its trustworthiness on a proven mismatch, and not otherwise", () => {
    const browser: BrowserObservation = {
      language: "nb-NO", languages: ["nb-NO"], timezone: "Europe/Oslo",
      userAgent: "Mozilla/5.0 (desktop)", viewport: { width: 390, height: 844 }, geolocation: null,
    };
    const norwegian: NetworkObservation = { ...UNKNOWN_NETWORK, ip: "1.2.3.4", country: "NO", city: "Oslo" };
    // Declares nothing: unverified, and the run can still be trustworthy.
    const silent = verifyGeo(OSLO_PROFILE, norwegian, browser);
    expect(silent.browser.device.verdict).toBe("unverified");
    expect(silent.trustworthy).toBe(true);
    // Declares a UA it did not get: not trustworthy.
    const declaring = { ...OSLO_PROFILE, device: { ...OSLO_PROFILE.device, userAgent: "Mozilla/5.0 (Pixel 5)" } };
    const wrong = verifyGeo(declaring, norwegian, browser);
    expect(wrong.browser.device.verdict).toBe("mismatch");
    expect(wrong.trustworthy).toBe(false);
  });
})
