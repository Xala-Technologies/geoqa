import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoQaRunResult } from "../../findings/types.js";
import type { ExperimentSample } from "../../experiments/harness.js";
import { bad, fakeRuntime, ok } from "../../run/__tests__/fake-runtime.js";
import { defaultDeps, type CommandDeps } from "../commands.js";
import {
  NO_VENDOR_NOTE,
  SAMPLERS,
  SHORT_WINDOW_NOTE,
  STABILITY_READS,
  sampleEvidenceQuality,
  sampleStability,
  summariseEvidenceQuality,
  summariseStability,
  sampleBrowserPrimitives,
  sampleEgress,
  sampleIsolation,
  sampleJourney,
  sampleProfileConsistency,
  summariseBrowserPrimitives,
  summariseEgress,
  summariseIsolation,
  summariseJourney,
  summariseProfileConsistency,
} from "../samplers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let evidenceRoot: string;
beforeEach(() => {
  evidenceRoot = mkdtempSync(path.join(tmpdir(), "geoqa-samplers-"));
});
afterEach(() => {
  rmSync(evidenceRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const deps = (over: Partial<CommandDeps> = {}): CommandDeps =>
  defaultDeps(repoRoot, {
    evidenceRoot,
    env: {},
    now: () => 1_000,
    log: () => {},
    makeRuntime: () => fakeRuntime(),
    probe: () => Promise.resolve(true),
    ...over,
  });

const options = { id: "EXP-001", samples: 1, profileId: "oslo-mobile", url: "https://example.com" };

const sample = (data: Record<string, unknown>): ExperimentSample => ({
  index: 0, at: 0, ok: true, durationMs: 1, data, error: null,
});

describe("EXP-000 browser primitives", () => {
  it("reports every primitive passing", async () => {
    const data = await sampleBrowserPrimitives(deps(), options);
    expect(data).toMatchObject({ passed: 10, total: 10, allPassed: true, launched: true });
    expect(data.failures).toEqual([]);
  });

  it("names the primitives that failed", async () => {
    const data = await sampleBrowserPrimitives(
      deps({ makeRuntime: () => fakeRuntime({ vitals: () => Promise.resolve(bad()) }) }),
      options,
    );
    expect(data.allPassed).toBe(false);
    expect((data.failures as string[]).join()).toContain("vitals");
  });

  it("summarises the pass rate and collects the distinct failures", () => {
    const { metrics, notes } = summariseBrowserPrimitives([
      sample({ allPassed: true, launched: true, failures: [] }),
      sample({ allPassed: false, launched: true, failures: ["a11y: nope"] }),
    ]);
    expect(metrics[0]).toMatchObject({ key: "primitive-success", value: 50, verdict: "fail" });
    expect(metrics[1]).toMatchObject({ key: "browser-launch", value: 100, verdict: "pass" });
    expect(notes[0]).toContain("a11y: nope");
  });

  it("reports UNMEASURED rather than a pass when nothing ran", () => {
    const { metrics, notes } = summariseBrowserPrimitives([]);
    expect(metrics.every((m) => m.verdict === "unmeasured")).toBe(true);
    expect(notes).toEqual([]);
  });
});

describe("EXP-001 egress", () => {
  it("reads the egress identity and compares it to the market", async () => {
    const data = await sampleEgress(deps(), options, 0);
    expect(data).toMatchObject({
      routed: false,
      connected: true,
      observedCountry: "NO",
      observedCity: "Lysaker",
      countryVerdict: "match",
      cityVerdict: "unverified",
      countryMatched: true,
      cityMatched: false,
    });
  });

  it("marks a run as routed when a real provider was named", async () => {
    const data = await sampleEgress(deps(), { ...options, providerName: "http-proxy" }, 0);
    expect(data.routed).toBe(true);
  });

  it("reports not-connected when the browser could not read", async () => {
    const data = await sampleEgress(
      deps({ makeRuntime: () => fakeRuntime({ open: () => Promise.resolve(bad()) }) }),
      options,
      0,
    );
    expect(data.connected).toBe(false);
  });

  it("computes match rates over CONNECTED samples only, when actually routed", () => {
    const { metrics } = summariseEgress([
      sample({ routed: true, connected: true, countryMatched: true, cityMatched: false, ip: "1.1.1.1", latencyMs: 100 }),
      sample({ routed: true, connected: true, countryMatched: false, cityMatched: false, ip: "2.2.2.2", latencyMs: 300 }),
      sample({ routed: true, connected: false }),
    ]);
    expect(metrics.find((m) => m.key === "connection-success")?.value).toBeCloseTo(66.67, 1);
    expect(metrics.find((m) => m.key === "country-match")?.value).toBe(50);
    expect(metrics.find((m) => m.key === "latency")?.value).toBe(200);
  });

  it("reports UNMEASURED — never 100% — when no routed session produced a reading", () => {
    const { metrics } = summariseEgress([sample({ routed: true, connected: false })]);
    const country = metrics.find((m) => m.key === "country-match");
    expect(country?.verdict).toBe("unmeasured");
    expect(country?.value).toBeNull();
    expect(country?.reason).toContain("no session produced an egress reading");
  });

  it("refuses to score geography at all on DIRECT egress, however good the observation looks", () => {
    // The trap this rule exists for: running the Oslo profile from a Norwegian
    // office observes country NO and would report a green 100% for a routing
    // capability that does not exist. The same run against Berlin would report
    // 0% for the same reason. Neither measures the system under test.
    const { metrics, notes } = summariseEgress([
      sample({ routed: false, connected: true, countryMatched: true, cityMatched: true, ip: "213.52.15.251", observedCountry: "NO", observedCity: "Lysaker", latencyMs: 200 }),
    ]);
    expect(metrics.find((m) => m.key === "country-match")?.verdict).toBe("unmeasured");
    expect(metrics.find((m) => m.key === "city-match")?.verdict).toBe("unmeasured");
    // What we CAN honestly measure on the path we used is still measured.
    expect(metrics.find((m) => m.key === "connection-success")?.verdict).toBe("pass");
    expect(metrics.find((m) => m.key === "latency")?.verdict).toBe("pass");
    expect(notes.join(" ")).toContain("Baseline only");
    expect(notes.join(" ")).toContain("where is this machine");
  });

  it("counts the distinct egress IPs it saw", () => {
    const { notes } = summariseEgress([
      sample({ routed: true, connected: true, ip: "1.1.1.1" }),
      sample({ routed: true, connected: true, ip: "1.1.1.1" }),
    ]);
    expect(notes[0]).toContain("1 distinct egress IP(s)");
  });
});

describe("EXP-003 isolation", () => {
  it("reports isolated when the second session sees neither cookie nor storage", async () => {
    const data = await sampleIsolation(deps(), options, 0);
    expect(data).toMatchObject({ cookieIsolated: true, storageIsolated: true });
  });

  it("detects a BLEED between sessions", async () => {
    // Both sessions share one fake, so whatever A wrote, B "sees".
    const stamp = "1000-0";
    const leaky = fakeRuntime({
      evaluate: <T,>(expr: string) =>
        Promise.resolve(ok((expr.includes("document.cookie=") ? "set" : `geoqa=${stamp}`) as unknown as T)),
    });
    const data = await sampleIsolation(deps({ makeRuntime: () => leaky }), options, 0);
    expect(data.cookieIsolated).toBe(false);
  });

  it("treats an unreadable probe as NOT isolated rather than assuming the best", async () => {
    const data = await sampleIsolation(
      deps({ makeRuntime: () => fakeRuntime({ evaluate: <T,>() => Promise.resolve(bad<T>()) }) }),
      options,
      0,
    );
    expect(data.observedCookie).toBe("");
    expect(data.cookieIsolated).toBe(true);
  });

  it("summarises both isolation rates", () => {
    const { metrics } = summariseIsolation([
      sample({ cookieIsolated: true, storageIsolated: true }),
      sample({ cookieIsolated: false, storageIsolated: true }),
    ]);
    expect(metrics[0]).toMatchObject({ key: "cookie-isolation", value: 50, verdict: "fail" });
    expect(metrics[1]).toMatchObject({ key: "storage-isolation", value: 100, verdict: "pass" });
  });
});

describe("EXP-004 profile consistency", () => {
  it("applies the profile and reads back what the page believes", async () => {
    const data = await sampleProfileConsistency(deps(), options, 0);
    expect(data).toMatchObject({
      languageMatched: true,
      timezoneMatched: true,
      viewportMatched: true,
      observedLanguage: "nb-NO",
      observedTimezone: "Europe/Oslo",
    });
  });

  it("records a DENIED geolocation as its own state and explains it", () => {
    const { metrics, notes } = summariseProfileConsistency([
      sample({ languageMatched: true, timezoneMatched: true, viewportMatched: true, geolocation: "denied" }),
    ]);
    expect(metrics.every((m) => m.verdict === "pass")).toBe(true);
    expect(notes[0]).toContain("DENIED");
    expect(notes[0]).toContain("no permission grant");
  });

  it("adds no geolocation note when every sample read a position", () => {
    const { notes } = summariseProfileConsistency([
      sample({ languageMatched: true, timezoneMatched: true, viewportMatched: true, geolocation: { latitude: 1, longitude: 2 } }),
    ]);
    expect(notes).toEqual([]);
  });
});

describe("EXP-005 journey stability", () => {
  it("reports the verdict, findings and confidence of one run", async () => {
    const runOnce = vi.fn(async () =>
      ({
        runId: "r",
        verdict: "PASS_WITH_WARNINGS",
        findings: [{ category: "performance" }, { category: "instrumentation" }],
        confidence: { overall: 91 },
        evidenceId: "ev_1",
      }) as unknown as GeoQaRunResult,
    );
    const data = await sampleJourney(deps({ runOnce }), options);
    expect(data).toMatchObject({
      verdict: "PASS_WITH_WARNINGS",
      completed: true,
      findings: 2,
      instrumentationFindings: 1,
      confidence: 91,
    });
  });

  it("marks an ERROR run as not completed", async () => {
    const runOnce = vi.fn(async () =>
      ({ runId: "r", verdict: "ERROR", findings: [], confidence: { overall: 10 }, evidenceId: null }) as unknown as GeoQaRunResult,
    );
    expect((await sampleJourney(deps({ runOnce }), options)).completed).toBe(false);
  });

  it("measures stability as agreement with the commonest verdict", () => {
    const { metrics, notes } = summariseJourney([
      sample({ verdict: "PASS", completed: true }),
      sample({ verdict: "PASS", completed: true }),
      sample({ verdict: "FAIL", completed: true }),
    ]);
    expect(metrics.find((m) => m.key === "verdict-stability")?.value).toBeCloseTo(66.67, 1);
    expect(notes[0]).toContain("PASS×2");
    expect(notes[0]).toContain("FAIL×1");
  });

  it("labels a THREW sample rather than dropping it from the tally", () => {
    const { notes } = summariseJourney([sample({})]);
    expect(notes[0]).toContain("THREW");
  });

  it("reports unmeasured with no runs at all", () => {
    const { metrics } = summariseJourney([]);
    expect(metrics.every((m) => m.verdict === "unmeasured")).toBe(true);
  });
});

describe("EXP-002 session stability", () => {
  it("holds ONE session open across reads rather than reopening", async () => {
    const sessions = new Set<string>();
    const data = await sampleStability(
      deps({
        makeRuntime: (config) => {
          sessions.add(config.sessionId);
          return fakeRuntime();
        },
      }),
      { ...options, id: "EXP-002" },
      0,
    );
    // Reopening would measure "do two sessions get the same IP", a different
    // and much weaker claim.
    expect(sessions.size).toBe(1);
    expect(data.reads).toBe(STABILITY_READS);
    expect(data.stable).toBe(true);
    expect(data.distinct).toBe(1);
  }, 60_000);

  it("is not measurable when the first read failed", () => {
    const { metrics } = summariseStability([sample({ measurable: false, stable: false })]);
    expect(metrics[0]?.verdict).toBe("unmeasured");
  });

  it("always states that the short window is NOT the PRD's ten minutes", () => {
    const { notes } = summariseStability([sample({ measurable: true, stable: true, distinct: 1 })]);
    expect(notes[0]).toBe(SHORT_WINDOW_NOTE);
    expect(notes[0]).toContain("cannot prove stability over a long journey");
  });

  it("names how many samples saw the IP drift mid-session", () => {
    const { notes, metrics } = summariseStability([
      sample({ measurable: true, stable: true, distinct: 1 }),
      sample({ measurable: true, stable: false, distinct: 2 }),
    ]);
    expect(metrics[0]?.value).toBe(50);
    expect(notes.join(" ")).toContain("1 sample(s) saw the IP change");
  });
});

describe("EXP-006 evidence quality", () => {
  it("counts the CONTROL as detected only when it produced NO site findings", () => {
    const { metrics } = summariseEvidenceQuality([
      sample({ defect: "/healthy", isControl: true, detected: true, evidenceCompleteness: 100, instrumentationFindings: 0 }),
      sample({ defect: "/status-404", isControl: false, detected: true, evidenceCompleteness: 100, instrumentationFindings: 0 }),
    ]);
    expect(metrics.find((m) => m.key === "defect-detection")?.value).toBe(100);
  });

  it("names each undetected defect with what it expected and what it got", () => {
    const { notes } = summariseEvidenceQuality([
      sample({ defect: "/missing-cta", detected: false, expectedCategory: "functional", categories: ["http"], evidenceCompleteness: 100, instrumentationFindings: 1 }),
    ]);
    expect(notes[0]).toContain("/missing-cta");
    expect(notes[0]).toContain("expected functional");
    expect(notes.join(" ")).toContain("OUR defects, excluded from detection");
  });

  it("averages evidence completeness across the fixtures", () => {
    const { metrics } = summariseEvidenceQuality([
      sample({ detected: true, evidenceCompleteness: 100, instrumentationFindings: 0 }),
      sample({ detected: true, evidenceCompleteness: 80, instrumentationFindings: 0 }),
    ]);
    expect(metrics.find((m) => m.key === "evidence-completeness")?.value).toBe(90);
  });

  it("runs a fixture end to end and attributes the finding to it", async () => {
    const runOnce = vi.fn(async () =>
      ({
        runId: "r",
        verdict: "FAIL",
        findings: [{ category: "http" }, { category: "instrumentation" }],
        confidence: { evidence: 100 },
        evidenceId: "ev_1",
      }) as unknown as GeoQaRunResult,
    );
    const data = await sampleEvidenceQuality(deps({ runOnce }), { ...options, id: "EXP-006" }, 1);
    expect(data).toMatchObject({
      defect: "/status-404",
      isControl: false,
      detected: true,
      findings: 1,
      instrumentationFindings: 1,
      expectedCategory: "http",
    });
  }, 60_000);

  it("marks the control as UNDETECTED when it produced a site finding", async () => {
    const runOnce = vi.fn(async () =>
      ({ runId: "r", verdict: "FAIL", findings: [{ category: "http" }], confidence: { evidence: 100 }, evidenceId: null }) as unknown as GeoQaRunResult,
    );
    const data = await sampleEvidenceQuality(deps({ runOnce }), { ...options, id: "EXP-006" }, 0);
    expect(data.isControl).toBe(true);
    expect(data.detected).toBe(false);
  }, 60_000);
});

describe("the sampler registry", () => {
  it("registers a pair for every experiment that has one", () => {
    expect(Object.keys(SAMPLERS)).toHaveLength(7);
    for (const [id, pair] of Object.entries(SAMPLERS)) {
      expect(typeof pair.sample, id).toBe("function");
      expect(typeof pair.summarise, id).toBe("function");
    }
  });

  it("states plainly why the geographic targets cannot be evaluated yet", () => {
    expect(NO_VENDOR_NOTE).toContain("unmeasured");
    expect(NO_VENDOR_NOTE).toContain("not a pass");
  });
});
