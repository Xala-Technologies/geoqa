import { describe, expect, it } from "vitest";
import { buildManifest, type Artifact } from "../../evidence/manifest.js";
import type { AxisResult, GeoVerification } from "../../geo/types.js";
import type { JourneyResult } from "../../journeys/engine.js";
import {
  browserConfidence,
  describeConfidence,
  evidenceConfidence,
  journeyConfidence,
  networkConfidence,
  scoreRun,
} from "../score.js";

const axis = (verdict: AxisResult["verdict"], why = "because"): AxisResult => ({ verdict, reasons: [why] });

const geo = (
  over: Partial<Record<"country" | "city" | "language" | "timezone" | "viewport" | "egressHeld" | "agreement" | "device", AxisResult>> = {},
): GeoVerification => ({
  profileId: "oslo-mobile",
  network: {
    requested: { country: "NO", city: "Oslo" },
    observed: { ip: null, country: "NO", city: "Oslo", region: null, org: null, timezone: null, coordinates: null, latencyMs: null },
    country: over.country ?? axis("match"),
    city: over.city ?? axis("match"),
    egressHeld: over.egressHeld ?? axis("match"),
    corroborating: null,
    agreement: over.agreement ?? axis("unverified"),
  },
  browser: {
    requested: { language: "nb-NO", timezone: "Europe/Oslo", viewport: { width: 390, height: 844 } },
    observed: {
      language: "nb-NO", languages: [], timezone: "Europe/Oslo", userAgent: null,
      viewport: { width: 390, height: 844 }, geolocation: null,
    },
    language: over.language ?? axis("match"),
    timezone: over.timezone ?? axis("match"),
    viewport: over.viewport ?? axis("match"),
    device: over.device ?? axis("unverified"),
  },
  confidence: 100,
  trustworthy: true,
});

const journey = (counts: Partial<JourneyResult["counts"]>): JourneyResult => ({
  journeyId: "j",
  verdict: "PASS",
  steps: [],
  counts: { passed: 0, failed: 0, errored: 0, skipped: 0, ...counts },
  screenshots: [],
  writes: false,
  seed: 1,
  touchedForm: false,
  durationMs: 1,
});

const art = (kind: Artifact["kind"]): Artifact => ({ kind, label: kind, path: `${kind}`, bytes: 10, mime: "x" });
const fullPassManifest = buildManifest({
  evidenceId: "e", runId: "r", createdAt: "t", verdict: "PASS",
  artifacts: [art("metadata"), art("screenshot"), art("vitals")],
});

describe("networkConfidence", () => {
  it("is 100 when country and city both match", () => {
    expect(networkConfidence(geo())).toBe(100);
  });

  it("weights country far above city", () => {
    const cityOnly = networkConfidence(geo({ city: axis("unverified") }));
    const countryOnly = networkConfidence(geo({ country: axis("unverified") }));
    expect(cityOnly).toBeGreaterThan(countryOnly);
  });

  it("collapses on a proven country mismatch", () => {
    expect(networkConfidence(geo({ country: axis("mismatch") }))).toBeLessThan(15);
  });
});

describe("browserConfidence", () => {
  it("weights language above the clock above the device, and none of them at zero", () => {
    expect(browserConfidence(geo())).toBe(100);
    expect(browserConfidence(geo({ language: axis("mismatch") }))).toBe(60);
    expect(browserConfidence(geo({ timezone: axis("mismatch") }))).toBe(65);
    // The bug this axis exists for: a mobile profile rendered at desktop width
    // with everything else correct is NOT a fully confident observation.
    expect(browserConfidence(geo({ viewport: axis("mismatch") }))).toBe(75);
  });
});

describe("journeyConfidence", () => {
  it("is 100 for an all-passing journey", () => {
    expect(journeyConfidence(journey({ passed: 10 }))).toBe(100);
  });

  it("is UNAFFECTED by failures — a failed check is the journey working", () => {
    expect(journeyConfidence(journey({ passed: 5, failed: 5 }))).toBe(100);
  });

  it("punishes errored steps hard, because they mean the journey did NOT work", () => {
    // 8 passed + 2 errored = (8 - 2×2) / 10 = 40. Two unreadable steps in ten
    // more than halve the run's credibility, which is the intended weight.
    expect(journeyConfidence(journey({ passed: 8, errored: 2 }))).toBe(40);
    expect(journeyConfidence(journey({ errored: 10 }))).toBe(0);
  });

  it("treats skipped steps as unknowns", () => {
    expect(journeyConfidence(journey({ passed: 5, skipped: 5 }))).toBe(25);
  });

  it("is 0 for a journey with no steps rather than a vacuous 100", () => {
    expect(journeyConfidence(journey({}))).toBe(0);
  });
});

describe("evidenceConfidence", () => {
  it("reads the manifest completeness, and is 0 with no manifest at all", () => {
    expect(evidenceConfidence(fullPassManifest)).toBe(100);
    expect(evidenceConfidence(null)).toBe(0);
  });
});

describe("scoreRun", () => {
  it("is 100 across every axis for a perfect run", () => {
    const report = scoreRun({ geo: geo(), journey: journey({ passed: 6 }), manifest: fullPassManifest });
    expect(report).toMatchObject({ geo: 100, browser: 100, journey: 100, evidence: 100, overall: 100 });
    expect(report.notes).toEqual(["every axis verified; evidence complete"]);
  });

  it("leaves searchObservation NULL rather than inventing a number for it", () => {
    // Phase 0 has no SERP source. A fabricated score here would be the exact
    // "a perfect score is the most suspicious number on the board" failure.
    expect(scoreRun({ geo: geo(), journey: journey({ passed: 1 }), manifest: fullPassManifest }).searchObservation).toBeNull();
  });

  it("CAPS the overall score by the weakest axis — a perfect journey from the wrong country is not 80%", () => {
    const report = scoreRun({
      geo: geo({ country: axis("mismatch", "requested NO, egressed from DE") }),
      journey: journey({ passed: 10 }),
      manifest: fullPassManifest,
    });
    expect(report.journey).toBe(100);
    expect(report.geo).toBeLessThan(15);
    expect(report.overall).toBeLessThan(70);
    expect(report.notes.join(" ")).toContain("egressed from DE");
  });

  it("explains every axis it marked down", () => {
    const report = scoreRun({
      geo: geo({ city: axis("unverified", "city was never read"), language: axis("mismatch", "wrong lang") }),
      journey: journey({ passed: 4, errored: 1, skipped: 2 }),
      manifest: buildManifest({ evidenceId: "e", runId: "r", createdAt: "t", verdict: "FAIL", artifacts: [art("metadata")] }),
    });
    const notes = report.notes.join(" | ");
    expect(notes).toContain("network identity");
    expect(notes).toContain("browser environment");
    expect(notes).toContain("could not be read");
    expect(notes).toContain("never ran");
    expect(notes).toContain("evidence missing");
  });

  it("says plainly when no evidence was captured", () => {
    const report = scoreRun({ geo: geo(), journey: journey({ passed: 1 }), manifest: null });
    expect(report.evidence).toBe(0);
    expect(report.notes.join(" ")).toContain("no evidence was captured");
  });
});

describe("describeConfidence", () => {
  it("renders every axis on one line, marking search as unavailable", () => {
    const report = scoreRun({ geo: geo(), journey: journey({ passed: 1 }), manifest: fullPassManifest });
    expect(describeConfidence(report)).toBe(
      "overall 100 · geo 100 · browser 100 · journey 100 · evidence 100 · search n/a",
    );
  });

  it("renders a search score when one exists", () => {
    expect(describeConfidence({ geo: 1, browser: 2, journey: 3, evidence: 4, searchObservation: 93, overall: 5, notes: [] })).toContain(
      "search 93",
    );
  });
});

describe("source disagreement caps the network axis", () => {
  it("caps network identity when two IP-geo databases disagree about the same IP", () => {
    // A run reporting geo: 100 while its two sources contradict each other is
    // exactly the confident, coherent lie this score exists to prevent. Measured:
    // one Decodo ISP exit read as São Paulo by one source and New York by another.
    const clean = networkConfidence(geo({ agreement: axis("match") }));
    const contradicted = networkConfidence(geo({ agreement: axis("mismatch") }));
    expect(clean).toBe(100);
    expect(contradicted).toBe(40);
  });

  it("applies the SAME cap as a proven country mismatch, and leaves the readings intact", () => {
    // The cap multiplier is identical (0.4) because both are failures of what this
    // axis is for. The resulting numbers are not: a country mismatch also zeroes
    // the country term, because we know that reading is wrong. A disagreement does
    // not — we do not know which source is wrong, so both readings stand and only
    // the confidence in them is capped. 40 versus 10 is the honest difference.
    expect(networkConfidence(geo({ agreement: axis("mismatch") }))).toBe(40);
    expect(networkConfidence(geo({ country: axis("mismatch") }))).toBe(10);
  });

  it("does NOT cap on an unverified agreement, which is the default for most commands", () => {
    // Most commands do not pay for a second lookup. "Nothing checked" must not
    // read as "something disagreed".
    expect(networkConfidence(geo({ agreement: axis("unverified") }))).toBe(100);
  });

  it("names the disagreement in the notes, because it is the one note that says do not trust the number", () => {
    const report = scoreRun({
      geo: geo({ agreement: axis("mismatch", "two IP-geo sources disagree about the same IP: BR and US") }),
      journey: journey({ passed: 3 }),
      manifest: fullPassManifest,
    });
    expect(report.notes.join(" ")).toContain("two IP-geo sources disagree");
  });
});

describe("searchObservation is real now, and still never fabricated", () => {
  it("records a measured observation", () => {
    const report = scoreRun({ geo: geo(), journey: journey({ passed: 3 }), manifest: fullPassManifest, searchObservation: 95 });
    expect(report.searchObservation).toBe(95);
  });

  it("stays NULL when nothing was measured, including when the field is absent", () => {
    // Most runs take no SERP observation, and "not measured" must not become a zero.
    expect(scoreRun({ geo: geo(), journey: journey({ passed: 3 }), manifest: fullPassManifest }).searchObservation).toBeNull();
    expect(
      scoreRun({ geo: geo(), journey: journey({ passed: 3 }), manifest: fullPassManifest, searchObservation: null }).searchObservation,
    ).toBeNull();
  });

  it("does NOT fold into overall — it answers a question about the SITE, not the reading", () => {
    // The other four axes answer "can this run's readings be believed"; this one answers
    // "is this page visible in search". Averaging them would let good search visibility
    // disguise a run that could not read the page.
    const blind = scoreRun({ geo: geo(), journey: journey({ passed: 3 }), manifest: fullPassManifest, searchObservation: 2 });
    const visible = scoreRun({ geo: geo(), journey: journey({ passed: 3 }), manifest: fullPassManifest, searchObservation: 100 });
    expect(blind.overall).toBe(visible.overall);
  });

  it("renders as 'n/a' when unmeasured and as a number when measured", () => {
    expect(describeConfidence(scoreRun({ geo: geo(), journey: journey({ passed: 1 }), manifest: fullPassManifest }))).toContain("search n/a");
    expect(
      describeConfidence(scoreRun({ geo: geo(), journey: journey({ passed: 1 }), manifest: fullPassManifest, searchObservation: 55 })),
    ).toContain("search 55");
  });
})
