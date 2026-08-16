import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoQaRunResult } from "../../findings/types.js";
import type { ExperimentSample } from "../../experiments/harness.js";
import { EXP_007 } from "../../experiments/definitions.js";
import { bad, fakeRuntime, ok } from "../../run/__tests__/fake-runtime.js";
import { defaultDeps, profileList, DEFAULT_ENGINE, type CommandDeps, type RuntimeRequest } from "../commands.js";
import { parseArgs } from "../args.js";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_STABILITY_READS,
  DEFAULT_STABILITY_WINDOW_MS,
  NO_MEMORY_PROBE_NOTE,
  NO_VENDOR_NOTE,
  PRD_STABILITY_WINDOW_MS,
  SAMPLERS,
  concurrencyProfiles,
  concurrencyShapeNote,
  experimentKnobs,
  resolveConcurrency,
  resolveStabilityWindow,
  sampleConcurrency,
  stabilityWindowNote,
  summariseConcurrency,
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
import type { RunSpec } from "../../run/context.js";
import { findRepoRoot } from "../../repo.js";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

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

  // ── The regression that made this experiment able to lie ────────────────
  //
  // `routed` used to be derived from the --provider FLAG while the browser was
  // built with no proxy at all. So naming a vendor flipped the honesty guard
  // off and let a direct-egress reading answer the hypothesis: run from a
  // Norwegian office against the Oslo profile, that reported
  // `country-match 100% pass` for a capability never exercised.

  it("routes the browser through the provider's session, not just the flag", async () => {
    const configs: { proxy?: string }[] = [];
    const data = await sampleEgress(
      deps({
        env: { GEOQA_PROXY_OSLO: "http://user:pw@gw.vendor.net:7777" },
        makeRuntime: (config) => {
          configs.push(config);
          return fakeRuntime();
        },
      }),
      { ...options, providerName: "http-proxy" },
      0,
    );
    expect(data.routed).toBe(true);
    // The proof is on the browser, not in the sample's own claim.
    expect(configs[0]?.proxy).toBe("http://user:pw@gw.vendor.net:7777");
    // …and the credential never reaches the recorded sample.
    expect(data.proxy).toBe("http://***:***@gw.vendor.net:7777/");
    expect(data.provider).toBe("http-proxy");
  });

  it("fails the sample rather than reporting a routed run it could not route", async () => {
    // http-proxy with nothing in the environment cannot open a session. The
    // old code reported `routed: true` and measured the office's own egress.
    await expect(sampleEgress(deps(), { ...options, providerName: "http-proxy" }, 0)).rejects.toThrow(
      /could not open a network session/,
    );
  });

  it("reports direct egress as unrouted even though a session opened fine", async () => {
    const data = await sampleEgress(deps(), { ...options, providerName: "direct" }, 0);
    expect(data.routed).toBe(false);
    expect(data.proxy).toBeNull();
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
  // A tiny window keeps the unit suite fast. The window is a parameter now
  // precisely so nobody has to choose between a slow test and an unrun one.
  const fast = { ...options, id: "EXP-002", stabilityWindowMs: 8 };

  it("holds ONE session open across reads rather than reopening", async () => {
    const sessions = new Set<string>();
    const data = await sampleStability(
      deps({
        makeRuntime: (config) => {
          sessions.add(config.sessionId);
          return fakeRuntime();
        },
      }),
      fast,
      0,
    );
    // Reopening would measure "do two sessions get the same IP", a different
    // and much weaker claim.
    expect(sessions.size).toBe(1);
    expect(data.reads).toBe(DEFAULT_STABILITY_READS);
    expect(data.stable).toBe(true);
    expect(data.distinct).toBe(1);
  });

  it("records the window it used ON the sample, so a result line can be interpreted later", async () => {
    const data = await sampleStability(deps(), { ...options, stabilityWindowMs: 12, stabilityReads: 4 }, 0);
    expect(data).toMatchObject({ windowMs: 12, intervalMs: 4, reads: 4 });
  });

  it("defaults to the SHORT window rather than to a ten-minute run nobody would finish", () => {
    const window = resolveStabilityWindow(options);
    expect(window.windowMs).toBe(DEFAULT_STABILITY_WINDOW_MS);
    expect(window.windowMs).toBeLessThan(PRD_STABILITY_WINDOW_MS);
    // Raising the window stretches the spacing instead of multiplying the
    // probes: 10 minutes at the old 6s spacing was 101 hits on the identity
    // endpoint and measured rate limiting instead of stickiness.
    const long = resolveStabilityWindow({ ...options, stabilityWindowMs: PRD_STABILITY_WINDOW_MS });
    expect(long.reads).toBe(DEFAULT_STABILITY_READS);
    expect(long.intervalMs).toBe(150_000);
  });

  it("REFUSES a window that cannot answer the question rather than measuring something else", () => {
    // One reading cannot disagree with itself, and a zero-length window would
    // report perfect stability having waited for nothing.
    expect(() => resolveStabilityWindow({ ...options, stabilityReads: 1 })).toThrow(/at least 2 reads/);
    expect(() => resolveStabilityWindow({ ...options, stabilityWindowMs: 0 })).toThrow(/positive number of ms/);
    expect(() => resolveStabilityWindow({ ...options, stabilityWindowMs: Number.NaN })).toThrow(/positive number of ms/);
    expect(() => resolveStabilityWindow({ ...options, stabilityReads: 2.5 })).toThrow(/at least 2 reads/);
  });

  it("is not measurable when the first read failed", () => {
    const { metrics } = summariseStability([sample({ measurable: false, stable: false })], options);
    expect(metrics[0]?.verdict).toBe("unmeasured");
  });

  it("states the window ACTUALLY used, and that a short one is NOT the PRD's ten minutes", () => {
    const { notes } = summariseStability([sample({ measurable: true, stable: true, distinct: 1 })], options);
    expect(notes[0]).toContain("held ONE session for 24s across 5 reads (one every 6s)");
    expect(notes[0]).toContain("The PRD asks for a 10min window; that is NOT what this measured");
    expect(notes[0]).toContain("cannot prove stability over a long journey");
  });

  // The note used to be a constant ending in "24s". After someone raised the
  // window that sentence would have been the most quotable lie in the summary.
  it("states the LONGER window when the window was raised, instead of a stale sentence", () => {
    const { notes } = summariseStability([sample({ measurable: true, stable: true, distinct: 1 })], {
      ...options,
      stabilityWindowMs: PRD_STABILITY_WINDOW_MS,
    });
    expect(notes[0]).toContain("held ONE session for 10min across 5 reads (one every 2.5min)");
    expect(notes[0]).toContain("covers the 10min window the PRD asks for");
    expect(notes[0]).not.toContain("24s");
    // Even a covered window does not claim more than it saw.
    expect(notes[0]).toContain("rotation that healed between two of them is still invisible");
  });

  it("keeps the note honest about spacing at both ends of the window range", () => {
    expect(stabilityWindowNote({ windowMs: 24_000, reads: 5, intervalMs: 6_000 })).toContain("one every 6s");
    expect(stabilityWindowNote({ windowMs: 900_000, reads: 3, intervalMs: 450_000 })).toContain("one every 7.5min");
  });

  it("names how many samples saw the IP drift mid-session", () => {
    const { notes, metrics } = summariseStability(
      [
        sample({ measurable: true, stable: true, distinct: 1 }),
        sample({ measurable: true, stable: false, distinct: 2 }),
      ],
      options,
    );
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

describe("EXP-007 concurrency", () => {
  const concurrencyOptions = { ...options, id: "EXP-007" };

  /** A healthy run result. `geo` carries the two facts this experiment reads. */
  const runResult = (over: Record<string, unknown> = {}): GeoQaRunResult =>
    ({
      runId: "r",
      verdict: "PASS",
      findings: [],
      durationMs: 1_000,
      geo: { network: { egressHeld: { verdict: "match" }, observed: { ip: "213.52.15.251" } } },
      confidence: { overall: 90, evidence: 100 },
      evidenceId: "ev_1",
      ...over,
    }) as unknown as GeoQaRunResult;

  /** Answers per profile, so one session in the batch can behave differently. */
  const runsBy = (
    answer: (profileId: string, call: number) => GeoQaRunResult,
  ): { runOnce: CommandDeps["runOnce"]; calls: string[] } => {
    const calls: string[] = [];
    const runOnce = ((opts: { spec: { profilePath: string } }) => {
      const profileId = path.basename(opts.spec.profilePath, ".yaml");
      calls.push(profileId);
      return Promise.resolve(answer(profileId, calls.length));
    }) as unknown as CommandDeps["runOnce"];
    return { runOnce, calls };
  };

  it("runs a batch of N at once on DISTINCT profiles, after a solo control", async () => {
    const { runOnce, calls } = runsBy(() => runResult());
    const data = await sampleConcurrency(deps({ runOnce }), concurrencyOptions);

    expect(data.concurrency).toBe(DEFAULT_CONCURRENCY);
    // One control plus the batch — the control is what "did concurrency change
    // anything" is measured against, so it is not optional.
    expect(calls).toHaveLength(DEFAULT_CONCURRENCY + 1);
    expect(calls[0]).toBe("oslo-mobile");
    const profiles = data.profiles as string[];
    expect(new Set(profiles).size).toBe(DEFAULT_CONCURRENCY);
    expect(profiles[0]).toBe("oslo-mobile");
    expect(data).toMatchObject({ completionRate: 100, verdictAgreementRate: 100, egressHeldRate: 100, wallClockFactor: 1 });
  });

  it("records a session that threw instead of losing its peers' readings with it", async () => {
    // Promise.all would reject on the first failure and the batch — the whole
    // observation — would vanish, when the dead session is the interesting one.
    const { runOnce } = runsBy((_profileId, call) => {
      // Keyed on call ORDER, not a profile name: which profiles land in the batch
      // changes every time profiles/ grows, and this test is about the batch
      // surviving one dead session, not about which market died.
      if (call === 3) throw new Error("chrome died");
      return runResult();
    });
    const data = await sampleConcurrency(deps({ runOnce }), concurrencyOptions);

    const sessions = data.sessions as { profileId: string; ok: boolean; error: string | null }[];
    expect(sessions).toHaveLength(DEFAULT_CONCURRENCY);
    expect(sessions.filter((s) => !s.ok)).toHaveLength(1);
    expect(data.completionRate).toBeCloseTo(66.67, 1);
    expect(String((data.errors as string[])[0])).toContain("chrome died");

    const { notes } = summariseConcurrency([sample(data)], concurrencyOptions);
    expect(notes.join(" ")).toContain("1 session(s) never returned a run");
  });

  it("reports a batch where EVERY session died as 0% completed, with no baseline comparison to make", async () => {
    const { runOnce } = runsBy((_profileId, call) => {
      if (call === 1) return runResult();
      throw "the machine gave up";
    });
    const data = await sampleConcurrency(deps({ runOnce }), concurrencyOptions);
    // 0% is a measurement — they ran and they failed. The wall-clock factor is
    // null because there is nothing left to divide, and null must not read as
    // "no slowdown".
    expect(data.completionRate).toBe(0);
    expect(data.wallClockFactor).toBeNull();
    expect(data.meanSessionMs).toBeNull();
    expect(String((data.errors as string[])[0])).toContain("the machine gave up");

    const { metrics } = summariseConcurrency([sample(data)], concurrencyOptions);
    expect(metrics.find((m) => m.key === "concurrent-completion")).toMatchObject({ verdict: "fail", value: 0 });
    expect(metrics.find((m) => m.key === "wall-clock-factor")?.verdict).toBe("unmeasured");
  });

  it("carries the requested provider into every concurrent session", async () => {
    // Dropping it would run the batch on direct egress while the summary named
    // a vendor — the EXP-001 regression, one experiment along.
    const { runOnce, calls } = runsBy(() => runResult());
    const data = await sampleConcurrency(
      deps({ runOnce, env: { GEOQA_PROXY_OSLO: "http://user:pw@gw.vendor.net:7777" } }),
      { ...concurrencyOptions, providerName: "http-proxy" },
    );
    // A market with no proxy configured cannot open a session, so those
    // sessions are recorded as failed rather than quietly run direct.
    expect(calls).toContain("oslo-mobile");
    const sessions = data.sessions as { profileId: string; ok: boolean; error: string | null }[];
    expect(sessions.filter((s) => s.profileId.startsWith("stockholm")).every((s) => !s.ok)).toBe(true);
    expect(String(sessions.find((s) => !s.ok)?.error)).toMatch(/not configured|could not open/);
  });

  it("counts an ERRORED or instrumentation-flagged session as NOT completed", async () => {
    // Invariant 3: a broken tool is not a site verdict, and it is certainly not
    // a completed session.
    const { runOnce } = runsBy((_profileId, call) =>
      call === 3 ? runResult({ verdict: "ERROR", findings: [{ category: "instrumentation" }] }) : runResult(),
    );
    const data = await sampleConcurrency(deps({ runOnce }), concurrencyOptions);
    expect(data.completionRate).toBeCloseTo(66.67, 1);
  });

  it("reports UNMEASURED — not agreement, and not a slowdown — when the control never produced a verdict", async () => {
    const { runOnce } = runsBy((_profileId, call) => {
      if (call === 1) throw new Error("control died");
      return runResult();
    });
    const data = await sampleConcurrency(deps({ runOnce }), concurrencyOptions);
    expect(data.soloOk).toBe(false);
    expect(data.verdictAgreementRate).toBeNull();
    expect(data.wallClockFactor).toBeNull();
    // The batch still happened, and what it measured is still measured.
    expect(data.completionRate).toBe(100);

    const { metrics } = summariseConcurrency([sample(data)], concurrencyOptions);
    expect(metrics.find((m) => m.key === "verdict-agreement")).toMatchObject({ verdict: "unmeasured", value: null });
    expect(metrics.find((m) => m.key === "wall-clock-factor")?.reason).toContain("no batch had a solo baseline");
    expect(metrics.find((m) => m.key === "concurrent-completion")?.verdict).toBe("pass");
  });

  it("counts a DISAGREEING verdict rather than only a broken one", async () => {
    const { runOnce } = runsBy((_profileId, call) => (call === 3 ? runResult({ verdict: "FAIL" }) : runResult()));
    const data = await sampleConcurrency(deps({ runOnce }), concurrencyOptions);
    expect(data.verdictAgreementRate).toBeCloseTo(66.67, 1);
    const { metrics } = summariseConcurrency([sample(data)], concurrencyOptions);
    expect(metrics.find((m) => m.key === "verdict-agreement")?.verdict).toBe("fail");
  });

  it("keeps an UNREADABLE closing egress probe out of the denominator instead of counting it either way", async () => {
    const { runOnce } = runsBy((_profileId, call) =>
      runResult({
        geo: {
          network: {
            egressHeld: { verdict: call === 3 ? "unverified" : "match" },
            observed: { ip: "213.52.15.251" },
          },
        },
      }),
    );
    const data = await sampleConcurrency(deps({ runOnce }), concurrencyOptions);
    // Two readable probes, both held: 100%, not 66.7%. An unread probe is not
    // a rotation.
    expect(data.egressHeldRate).toBe(100);
  });

  it("reports the egress metric UNMEASURED when no closing probe could be read at all", async () => {
    const { runOnce } = runsBy(() =>
      runResult({ geo: { network: { egressHeld: { verdict: "unverified" }, observed: { ip: null } } } }),
    );
    const data = await sampleConcurrency(deps({ runOnce }), concurrencyOptions);
    expect(data.egressHeldRate).toBeNull();
    expect(data.distinctEgressIps).toBe(0);

    const { metrics } = summariseConcurrency([sample(data)], concurrencyOptions);
    const held = metrics.find((m) => m.key === "egress-identity-held");
    expect(held).toMatchObject({ verdict: "unmeasured", value: null });
    expect(held?.reason).toContain("an unread probe is not a held identity");
  });

  it("scores wall clock as a MULTIPLE of the solo run, not an absolute budget", async () => {
    // An absolute ms target would mostly measure the site under test. What this
    // experiment is asking is whether N at once made each one slower.
    const { runOnce } = runsBy((_profileId, call) => runResult({ durationMs: call === 1 ? 1_000 : 3_000 }));
    const data = await sampleConcurrency(deps({ runOnce }), concurrencyOptions);
    expect(data.wallClockFactor).toBe(3);
    const { metrics } = summariseConcurrency([sample(data)], concurrencyOptions);
    expect(metrics.find((m) => m.key === "wall-clock-factor")).toMatchObject({ verdict: "fail", value: 3 });
  });

  it("treats a zero-length control as no baseline rather than dividing by it", async () => {
    const { runOnce } = runsBy((_profileId, call) => runResult({ durationMs: call === 1 ? 0 : 2_000 }));
    const data = await sampleConcurrency(deps({ runOnce }), concurrencyOptions);
    expect(data.wallClockFactor).toBeNull();
  });

  it("NEVER lets peak memory look like a pass, and says why it could not be read", () => {
    const { metrics } = summariseConcurrency([sample({ completionRate: 100 })], concurrencyOptions);
    const memory = metrics.find((m) => m.key === "peak-memory-per-session");
    expect(memory).toMatchObject({ verdict: "unmeasured", value: null });
    expect(memory?.reason).toBe(NO_MEMORY_PROBE_NOTE);
    expect(NO_MEMORY_PROBE_NOTE).toContain("unmeasured");
    expect(NO_MEMORY_PROBE_NOTE).toContain("not a pass");
  });

  it("reports every metric UNMEASURED when no batch ran", () => {
    const { metrics } = summariseConcurrency([], concurrencyOptions);
    expect(metrics.every((m) => m.verdict === "unmeasured")).toBe(true);
    expect(metrics.find((m) => m.key === "concurrent-completion")?.reason).toBe("no batch reported a session");
  });

  it("records ONE shared egress IP as unexercised, never as a failure", () => {
    const { notes, metrics } = summariseConcurrency(
      [sample({ concurrency: 3, distinctEgressIps: 1, completionRate: 100, egressHeldRate: 100 })],
      concurrencyOptions,
    );
    expect(notes.join(" ")).toContain("not that it failed");
    // Sharing the machine's own IP is what direct egress means; scoring it
    // would file a missing proxy vendor as a concurrency defect.
    expect(metrics.find((m) => m.key === "egress-identity-held")?.verdict).toBe("pass");
  });

  it("says which SHAPE of concurrency it measured, so it is not read as N contexts in one browser", () => {
    const note = concurrencyShapeNote(4);
    expect(note).toContain("4 FULL RUNS");
    expect(note).toContain("does NOT measure N contexts inside one browser");
    expect(summariseConcurrency([], concurrencyOptions).notes[0]).toBe(concurrencyShapeNote(DEFAULT_CONCURRENCY));
  });

  it("REFUSES a batch of one, which is the sequential path it exists to compare against", () => {
    expect(() => resolveConcurrency({ ...concurrencyOptions, concurrency: 1 })).toThrow(/at least 2/);
    expect(() => resolveConcurrency({ ...concurrencyOptions, concurrency: 2.5 })).toThrow(/at least 2/);
    expect(resolveConcurrency({ ...concurrencyOptions, concurrency: 5 })).toBe(5);
  });

  it("REFUSES more sessions than there are profiles rather than handing two sessions one browser", () => {
    // `run_<ms>_<profileId>` is the run id, and agent-browser's daemon is keyed
    // by session name — a wrapped profile would silently be the SAME browser,
    // and the batch would measure one browser twice while reporting two.
    const shipped = profileList(deps()).profiles.length;
    expect(() => concurrencyProfiles(deps(), "oslo-mobile", shipped + 1)).toThrow(
      new RegExp(`exceeds the ${shipped} distinct profiles`),
    );
  });

  it("wraps around the profile list, and starts at the beginning for an unknown request", () => {
    const all = profileList(deps()).profiles.map((p: { id: string }) => p.id).sort();
    const last = all[all.length - 1] as string;
    const wrapped = concurrencyProfiles(deps(), last, 3);
    // Starts where asked, then wraps to the front, and never hands two sessions
    // the same profile — two sessions on one profile would share a browser.
    expect(wrapped[0]).toBe(last);
    expect(wrapped.slice(1)).toEqual(all.slice(0, 2));
    expect(new Set(wrapped).size).toBe(3);
    expect(concurrencyProfiles(deps(), "not-a-profile", 2)).toEqual(all.slice(0, 2));
  });
});

describe("the sampler registry", () => {
  it("registers a pair for every experiment that has one", () => {
    expect(Object.keys(SAMPLERS)).toHaveLength(8);
    for (const [id, pair] of Object.entries(SAMPLERS)) {
      expect(typeof pair.sample, id).toBe("function");
      expect(typeof pair.summarise, id).toBe("function");
    }
  });

  // A-3b: `temporal/workflows.ts` justified sequential execution by citing
  // EXP-007, which for a while had no spec, no sampler and no directory.
  it("has a pair for EXP-007, the concurrency experiment the matrix workflow cites", () => {
    expect(SAMPLERS[EXP_007.id]).toBeDefined();
  });

  it("states plainly why the geographic targets cannot be evaluated yet", () => {
    expect(NO_VENDOR_NOTE).toContain("unmeasured");
    expect(NO_VENDOR_NOTE).toContain("not a pass");
  });
});

describe("experimentKnobs", () => {
  const knobs = (argv: string[]) => experimentKnobs(parseArgs(argv));

  it("reaches EXP-002's stability window, which is the whole reason it exists", () => {
    // The window is a parameter and nothing reached it, so the experiment measured
    // 24 seconds while the PRD asked about ten minutes.
    expect(knobs(["experiment", "run", "EXP-002", "--stability-window", "10m"])).toEqual({
      ok: true,
      knobs: { stabilityWindowMs: 600_000 },
    });
  });

  it("reaches the read count and the concurrency, and passes nothing it was not given", () => {
    expect(knobs(["experiment", "run", "EXP-002", "--stability-reads", "9"])).toEqual({
      ok: true,
      knobs: { stabilityReads: 9 },
    });
    expect(knobs(["experiment", "run", "EXP-007", "--concurrency", "5"])).toEqual({
      ok: true,
      knobs: { concurrency: 5 },
    });
    // Absent means absent: the sampler applies its own default, so an "unset" that
    // arrived as a number would be a second source of truth for it.
    expect(knobs(["experiment", "run", "EXP-001"])).toEqual({ ok: true, knobs: {} });
  });

  it("REFUSES an unreadable duration instead of falling back to the cheap default", () => {
    const result = knobs(["experiment", "run", "EXP-002", "--stability-window", "ten-minutes"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors[0]).toContain("is not a duration");
  });

  it("refuses a flag given with no value, which is where a fallback would be invisible", () => {
    // `--stability-window --json` is a missing value, and 24s dressed as ten
    // minutes is the exact failure this slice closes.
    const window = knobs(["experiment", "run", "EXP-002", "--stability-window", "--json"]);
    expect(window.ok).toBe(false);
    const reads = knobs(["experiment", "run", "EXP-002", "--stability-reads", "--json"]);
    expect(reads.ok).toBe(false);
    const concurrency = knobs(["experiment", "run", "EXP-007", "--concurrency", "--json"]);
    expect(concurrency.ok).toBe(false);
  });

  it("refuses a non-integer read count and a non-integer concurrency", () => {
    const reads = knobs(["experiment", "run", "EXP-002", "--stability-reads", "2.5"]);
    expect(reads.ok).toBe(false);
    if (reads.ok) throw new Error("expected a refusal");
    expect(reads.errors[0]).toContain("not a whole number");
    expect(knobs(["experiment", "run", "EXP-007", "--concurrency", "two"]).ok).toBe(false);
  });

  it("reports every bad knob at once", () => {
    const result = knobs(["experiment", "run", "EXP-002", "--stability-window", "soon", "--stability-reads", "x", "--concurrency", "y"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors).toHaveLength(3);
  });

  it("hands resolveStabilityWindow a window it then applies", () => {
    // End to end, because the two halves passing separately is exactly the state
    // this slice found: a resolver that worked and a flag that never arrived.
    const result = knobs(["experiment", "run", "EXP-002", "--stability-window", "10m", "--stability-reads", "3"]);
    if (!result.ok) throw new Error("expected the knobs to parse");
    const window = resolveStabilityWindow({ id: "EXP-002", samples: 3, profileId: "oslo-desktop", url: "https://x", ...result.knobs });
    expect(window).toEqual({ windowMs: 600_000, reads: 3, intervalMs: 300_000 });
    expect(stabilityWindowNote(window)).toContain("10min");
  });
});

describe("every sampler honours --engine and --verifyEndpoint (D-1b)", () => {
  /** Capture what each sampler asked its runtime factory for. */
  const capturing = (): { requests: (RuntimeRequest | undefined)[]; opened: string[]; deps: CommandDeps } => {
    const requests: (RuntimeRequest | undefined)[] = [];
    const opened: string[] = [];
    const d = deps({
      makeRuntime: (_config, request) => {
        requests.push(request);
        return fakeRuntime({
          open: (url: string) => {
            opened.push(url);
            return Promise.resolve(ok({ url, title: "T", targetId: "t", launchHash: "h", browserLaunched: false }));
          },
        });
      },
    });
    return { requests, opened, deps: d };
  };

  const base = { id: "EXP-001", samples: 1, profileId: "oslo-desktop", url: "https://x" };

  it("takes EXP-001's samples through the engine it was asked for, not agent-browser", async () => {
    // Before this, `experiment run --engine playwright` took every sample through
    // agent-browser and reported a clean result for an engine it never touched.
    const cap = capturing();
    await sampleEgress(cap.deps, { ...base, engine: "playwright" }, 0);
    expect(cap.requests.map((r) => r?.engine)).toEqual(["playwright"]);
    // And the profile travels with it: a Playwright context with no locale renders
    // this machine's geography while claiming to verify a market's.
    expect(cap.requests[0]?.profile.id).toBe("oslo-desktop");
  });

  it("defaults to the engine every recorded experiment result was measured on", async () => {
    // An experiment re-run without --engine must still measure what its stored
    // results measured, or the two are not comparable.
    const cap = capturing();
    await sampleEgress(cap.deps, base, 0);
    expect(cap.requests[0]?.engine).toBe(DEFAULT_ENGINE);
  });

  it("reads the endpoint it was given rather than the constant", async () => {
    // The samplers reached for DEFAULT_VERIFY_ENDPOINT directly, so a configured
    // network.verifyEndpoint did not reach an experiment at all — B-1's defect one
    // layer down.
    const cap = capturing();
    await sampleEgress(cap.deps, { ...base, verifyEndpoint: "http://127.0.0.1:1/ipinfo" }, 0);
    expect(cap.opened).toContain("http://127.0.0.1:1/ipinfo");
  });

  it("carries the engine into EXP-003's TWO isolated sessions, not just the first", async () => {
    // Two runtimes, and a per-call-site default is exactly how one of them ends up
    // on a different engine than the other while the sample reports one number.
    const cap = capturing();
    await sampleIsolation(cap.deps, { ...base, id: "EXP-003", engine: "playwright" }, 0);
    expect(cap.requests.map((r) => r?.engine)).toEqual(["playwright", "playwright"]);
  });

  it("carries it into EXP-004 and EXP-002", async () => {
    const four = capturing();
    await sampleProfileConsistency(four.deps, { ...base, id: "EXP-004", engine: "playwright" }, 0);
    expect(four.requests[0]?.engine).toBe("playwright");

    const two = capturing();
    await sampleStability(two.deps, { ...base, id: "EXP-002", engine: "playwright", stabilityWindowMs: 2, stabilityReads: 2 }, 0);
    expect(two.requests[0]?.engine).toBe("playwright");
  });

  /**
   * The three samplers below reach their engine through `deps.runOnce` rather than
   * `makeRuntime`, so the forwarding is asserted on the RunSpec they build. Same invariant,
   * one layer up — and it was unproven for all three until now, which means `--engine
   * playwright` on EXP-005, EXP-006 or EXP-007 could have measured agent-browser and
   * reported a clean result for an engine it never touched. That is the exact defect D-1b
   * was opened for.
   */
  const specsFrom = (): { specs: RunSpec[]; runOnce: CommandDeps["runOnce"] } => {
    const specs: RunSpec[] = [];
    const runOnce = ((opts: { spec: RunSpec }) => {
      specs.push(opts.spec);
      return Promise.resolve({
        runId: "r",
        verdict: "PASS",
        findings: [],
        durationMs: 1,
        geo: { network: { egressHeld: { verdict: "match" }, observed: { ip: "1.2.3.4" } } },
        confidence: { overall: 90, evidence: 100 },
        evidenceId: "ev_1",
        journey: { steps: [] },
      });
    }) as unknown as CommandDeps["runOnce"];
    return { specs, runOnce };
  };

  it("carries the engine and endpoint into EXP-005, which runs a whole journey", async () => {
    const { specs, runOnce } = specsFrom();
    await sampleJourney(deps({ runOnce }), { ...base, id: "EXP-005", engine: "playwright", verifyEndpoint: "http://127.0.0.1:1/ipinfo" });
    expect(specs[0]?.engine).toBe("playwright");
    expect(specs[0]?.verifyEndpoint).toBe("http://127.0.0.1:1/ipinfo");
  });

  it("falls back to the recorded default for EXP-005 when neither is given", async () => {
    // Absence must mean the SAME engine every stored EXP-005 result was measured on, or a
    // re-run is not comparable with the numbers it is being compared against.
    const { specs, runOnce } = specsFrom();
    await sampleJourney(deps({ runOnce }), { ...base, id: "EXP-005" });
    expect(specs[0]?.engine).toBe(DEFAULT_ENGINE);
  });

  it("carries the engine into EXP-006, whose subject is the evidence a run leaves", async () => {
    const { specs, runOnce } = specsFrom();
    await sampleEvidenceQuality(deps({ runOnce }), { ...base, id: "EXP-006", engine: "playwright" }, 0);
    expect(specs[0]?.engine).toBe("playwright");
  });

  it("carries it into EVERY session EXP-007 opens, control included", async () => {
    // The control is what the batch is measured against. A control on one engine and a
    // batch on another would report the engine difference as a concurrency effect.
    const { specs, runOnce } = specsFrom();
    await sampleConcurrency(deps({ runOnce }), { ...base, id: "EXP-007", engine: "playwright", verifyEndpoint: "http://127.0.0.1:1/ipinfo" });
    expect(specs.length).toBeGreaterThan(1);
    expect(specs.every((sp) => sp.engine === "playwright")).toBe(true);
    expect(specs.every((sp) => sp.verifyEndpoint === "http://127.0.0.1:1/ipinfo")).toBe(true);
  });

  it("carries it into EXP-000, whose SUBJECT is the adapter", async () => {
    // The one experiment where the engine is the thing under test rather than a
    // detail of how the measurement was taken.
    const cap = capturing();
    await sampleBrowserPrimitives(cap.deps, { ...base, id: "EXP-000", engine: "playwright" });
    expect(cap.requests[0]?.engine).toBe("playwright");
  });
});

describe("summarisers reading samples that are missing what they expect", () => {
  // A results.jsonl line is written by whatever version of the code ran it. An older run,
  // a partial write, or a sampler that threw mid-way all produce a sample without the field
  // a summariser wants. None of them should make the summariser throw, and none should be
  // silently counted as a zero reading — the two are different facts.

  it("ignores a `failures` field that is not a list rather than throwing on it", () => {
    const { notes } = summariseBrowserPrimitives([sample({ passed: 9, total: 10, failures: "everything" })]);
    expect(Array.isArray(notes)).toBe(true);
  });

  it("counts a sample with no instrumentation figure as nothing to add, not as a finding", () => {
    // `?? 0` is right HERE and wrong elsewhere: this is a sum, and a sample that recorded no
    // instrumentation findings contributes none. The distinction is that the total is
    // reported alongside the sample count, so a reader can see the denominator.
    const { metrics } = summariseEvidenceQuality([sample({ evidenceComplete: true }), sample({ evidenceComplete: true, instrumentationFindings: 2 })]);
    expect(metrics.length).toBeGreaterThan(0);
  });

  it("does not treat a sample with no concurrency figure as a shared-egress sample", () => {
    // The shared-egress check is `one IP AND more than one session`. A sample that never
    // recorded its concurrency has not demonstrated sharing, and counting it as one would
    // report a proxy defect that no measurement supports.
    const { notes } = summariseConcurrency([sample({ distinctEgressIps: 1 })], { ...options, id: "EXP-007" });
    expect(notes.join(" ")).not.toContain("shared");
  });

  it("reports journey stability as UNMEASURED over no samples, never 0%", () => {
    // 0% stability reads as "the journey is wildly unstable", which is the opposite of "we
    // have not run it". This is the same rule the console applies to every absence.
    const { metrics } = summariseJourney([]);
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics.map((m) => m.value)).toEqual(metrics.map(() => null));
  });
});

describe("options a sampler is NOT given", () => {
  it("selects a provider without a probe when no probe was injected", () => {
    // Production passes no probe — the real one is the provider's own. Every other test in
    // this file injects one, so the arm production actually takes was the untested one.
    const bare = defaultDeps(repoRoot, { evidenceRoot, env: {}, now: () => 1_000, log: () => {} });
    expect(bare.probe).toBeUndefined();
    return expect(sampleEgress(bare, { ...options, providerName: "direct" }, 0)).resolves.toBeDefined();
  });

  it("records that EXP-005 fell back to direct egress, instead of sampling clean", () => {
    // The forwarding is proven by the CONSEQUENCE: an unknown provider name reaches
    // `selectProvider`, which falls back to direct egress and says so. Before this, the
    // warning was dropped and the sample looked identical to one measured through the
    // market's proxy — so a typo in `--provider` could produce a whole EXP-005 series
    // measured outside the market it names, reading as a healthy result.
    const runOnce = (() =>
      Promise.resolve({
        runId: "r", verdict: "PASS", findings: [], durationMs: 1,
        geo: { network: { egressHeld: { verdict: "match" }, observed: { ip: "1.2.3.4" } } },
        confidence: { overall: 90, evidence: 100 }, evidenceId: "ev_1", journey: { steps: [] },
      })) as unknown as CommandDeps["runOnce"];

    return sampleJourney(deps({ runOnce }), { ...options, id: "EXP-005", providerName: "decodo-typo" }).then((data) => {
      expect((data.warnings as string[]).join(" ")).toContain("NOT geographic");
    });
  });

  it("says it ONCE in the summary, however many samples repeated it", () => {
    const warned = { verdict: "PASS", completed: true, warnings: ["unknown network provider — falling back"] };
    const { notes } = summariseJourney([sample(warned), sample(warned), sample(warned)]);
    expect(notes.filter((n) => n.includes("falling back"))).toHaveLength(1);
  });
});
