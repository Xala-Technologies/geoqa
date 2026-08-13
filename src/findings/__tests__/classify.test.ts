import { describe, expect, it } from "vitest";
import type { StepResult } from "../../journeys/engine.js";
import {
  categoryFor,
  confidenceFor,
  findingsFromSteps,
  rankFindings,
  severityFor,
  siteFindingShare,
  validationMethodFor,
  type ClassifyContext,
} from "../classify.js";
import type { Finding } from "../types.js";

const step = (over: Partial<StepResult> = {}): StepResult => ({
  index: 0,
  action: "assert",
  label: "has a primary heading",
  outcome: "failed",
  severity: "critical",
  category: null,
  check: "selector-visible",
  detail: "d",
  expected: "h1 is visible",
  observed: "not visible",
  durationMs: 5,
  ...over,
});

const ctx: ClassifyContext = {
  runId: "run_1",
  target: "https://digilist.no/blogg",
  profileId: "oslo-mobile",
  journeyId: "landing-page",
  market: "oslo",
  device: "mobile",
  detectedAt: "2026-08-12T00:00:00.000Z",
  evidence: [{ label: "hero", path: "hero.png" }],
};

describe("categoryFor", () => {
  it("derives a category from the check kind", () => {
    expect(categoryFor(step({ check: "lcp-below" }))).toBe("performance");
    expect(categoryFor(step({ check: "no-http-5xx" }))).toBe("http");
    expect(categoryFor(step({ check: "no-console-errors" }))).toBe("javascript");
    expect(categoryFor(step({ check: "no-a11y-critical" }))).toBe("accessibility");
    expect(categoryFor(step({ check: "url-matches" }))).toBe("redirect");
  });

  it("lets the step's own category win — the localization case", () => {
    // `text-absent` is `content` by default, but in the localization journey it
    // is how a leaked foreign currency is caught.
    expect(categoryFor(step({ check: "text-absent", category: "localization" }))).toBe("localization");
  });

  it("classifies an ERRORED step as instrumentation — OUR defect, not the site's", () => {
    expect(categoryFor(step({ outcome: "errored", check: "no-console-errors" }))).toBe("instrumentation");
  });

  it("falls back to unknown for an unrecognised or absent check", () => {
    expect(categoryFor(step({ check: "invented-check" }))).toBe("unknown");
    expect(categoryFor(step({ check: null }))).toBe("unknown");
  });
});

describe("severityFor", () => {
  it("uses the step's declared severity", () => {
    expect(severityFor(step({ severity: "low" }))).toBe("low");
  });

  it("forces an errored step to high, whatever the step claimed", () => {
    // We cannot say anything about the site until instrumentation is fixed.
    expect(severityFor(step({ outcome: "errored", severity: "info" }))).toBe("high");
  });

  it("defaults an unrecognised severity to medium", () => {
    expect(severityFor(step({ severity: "urgent" }))).toBe("medium");
  });
});

describe("confidenceFor", () => {
  it("is high for a single failed check that genuinely read the page", () => {
    expect(confidenceFor(step(), { attempts: 1, occurrences: 1 })).toBe(92);
  });

  it("is LOWER for an instrumentation failure — a weaker claim about the world", () => {
    expect(confidenceFor(step({ outcome: "errored" }), { attempts: 1, occurrences: 1 })).toBe(60);
  });

  it("rises when the finding reproduces every time", () => {
    const once = confidenceFor(step(), { attempts: 1, occurrences: 1 });
    const always = confidenceFor(step(), { attempts: 3, occurrences: 3 });
    expect(always).toBeGreaterThan(once);
    expect(always).toBeLessThanOrEqual(99);
  });

  it("falls hard when it happened once in three tries", () => {
    expect(confidenceFor(step(), { attempts: 3, occurrences: 1 })).toBeLessThan(
      confidenceFor(step(), { attempts: 3, occurrences: 3 }),
    );
  });

  it("never exceeds 99 or drops below 20", () => {
    expect(confidenceFor(step(), { attempts: 100, occurrences: 100 })).toBeLessThanOrEqual(99);
    expect(confidenceFor(step({ outcome: "errored" }), { attempts: 100, occurrences: 0 })).toBeGreaterThanOrEqual(20);
  });
});

describe("validationMethodFor", () => {
  it("tells a human how to check a site finding by hand", () => {
    const method = validationMethodFor(step(), "https://digilist.no", "oslo-mobile");
    expect(method).toContain("Open https://digilist.no");
    expect(method).toContain("oslo-mobile");
  });

  it("says explicitly that an instrumentation finding is NOT a site defect", () => {
    const method = validationMethodFor(step({ outcome: "errored" }), "https://x", "oslo-mobile");
    expect(method).toContain("GeoQA defect, not a site defect");
  });

  it("renders a missing expectation as a dash rather than undefined", () => {
    expect(validationMethodFor(step({ expected: null }), "https://x", "p")).toContain("expected —");
  });
});

describe("findingsFromSteps", () => {
  it("produces nothing for passing steps", () => {
    expect(findingsFromSteps([step({ outcome: "passed" })], ctx)).toEqual([]);
  });

  it("produces nothing for SKIPPED steps — they never ran, and filing them double-counts", () => {
    expect(findingsFromSteps([step({ outcome: "skipped" })], ctx)).toEqual([]);
  });

  it("carries the full context onto each finding", () => {
    const [finding] = findingsFromSteps([step()], ctx);
    expect(finding).toMatchObject({
      id: "run_1-00",
      runId: "run_1",
      category: "functional",
      severity: "critical",
      status: "observed",
      title: "has a primary heading",
      expected: "h1 is visible",
      observed: "not visible",
      affectedUrl: "https://digilist.no/blogg",
      market: "oslo",
      device: "mobile",
      journeyId: "landing-page",
      stepLabel: "has a primary heading",
      detectedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(finding?.evidence).toEqual([{ label: "hero", path: "hero.png" }]);
  });

  it("titles an errored step as an inability to verify, not as a page defect", () => {
    const [finding] = findingsFromSteps([step({ outcome: "errored" })], ctx);
    expect(finding?.title).toBe("Could not verify: has a primary heading");
    expect(finding?.category).toBe("instrumentation");
  });

  it("marks a finding reproduced only when it occurred on every attempt", () => {
    const repeated = findingsFromSteps([step()], { ...ctx, attempts: 3, occurrences: { "0:has a primary heading": 3 } });
    expect(repeated[0]?.status).toBe("reproduced");
    const flaky = findingsFromSteps([step()], { ...ctx, attempts: 3, occurrences: { "0:has a primary heading": 1 } });
    expect(flaky[0]?.status).toBe("observed");
    expect(flaky[0]?.reproducibility).toEqual({ attempts: 3, occurrences: 1 });
  });

  it("falls back to the step detail when there is no observed value", () => {
    const [finding] = findingsFromSteps([step({ observed: null, detail: "open failed: exit" })], ctx);
    expect(finding?.observed).toBe("open failed: exit");
  });

  it("pads the id so findings sort in step order", () => {
    const findings = findingsFromSteps([step({ index: 2 }), step({ index: 11 })], ctx);
    expect(findings.map((f) => f.id)).toEqual(["run_1-02", "run_1-11"]);
  });
});

describe("rankFindings", () => {
  it("orders by severity, then by confidence", () => {
    const make = (severity: Finding["severity"], confidence: number): Finding =>
      ({ severity, confidence }) as Finding;
    const ranked = rankFindings([make("low", 99), make("critical", 50), make("critical", 90), make("medium", 10)]);
    expect(ranked.map((f) => [f.severity, f.confidence])).toEqual([
      ["critical", 90],
      ["critical", 50],
      ["medium", 10],
      ["low", 99],
    ]);
  });

  it("does not mutate its input", () => {
    const input = [{ severity: "low", confidence: 1 }, { severity: "critical", confidence: 1 }] as Finding[];
    rankFindings(input);
    expect(input[0]?.severity).toBe("low");
  });
});

describe("siteFindingShare", () => {
  it("answers how much of what we reported was about the SITE", () => {
    const findings = [
      { category: "http" },
      { category: "instrumentation" },
      { category: "content" },
    ] as Finding[];
    expect(siteFindingShare(findings)).toEqual({ site: 2, instrumentation: 1, ratio: 2 / 3 });
  });

  it("treats an empty run as a clean ratio rather than dividing by zero", () => {
    expect(siteFindingShare([])).toEqual({ site: 0, instrumentation: 0, ratio: 1 });
  });
});
