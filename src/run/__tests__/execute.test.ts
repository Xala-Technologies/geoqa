import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserRuntime } from "../../browser/types.js";
import { loadCooldowns, saveCooldowns } from "../../network/cooldown.js";
import { directProvider, httpProxyProvider } from "../../network/provider.js";
import type { GeoNetworkProvider } from "../../network/types.js";
import type { RunSpec } from "../context.js";
import { executeRun, prepareRun } from "../execute.js";
import { StageError } from "../stages.js";
import { bad, fakeRuntime, ok } from "./fake-runtime.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const profilePath = path.join(repoRoot, "profiles", "oslo-mobile.yaml");
const journeyPath = path.join(repoRoot, "journeys", "landing-page.yaml");

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "geoqa-execute-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const base = (
  over: Partial<RunSpec> = {},
): Omit<RunSpec, "proxyUrl" | "proxyBypass" | "initScriptPath"> => ({
  runId: "run_1",
  engine: "agent-browser",
  seed: 7,
  corroborateGeo: false,
  target: "https://digilist.no",
  profilePath,
  journeyPath,
  evidenceRoot: root,
  vars: {},
  headed: false,
  verifyEndpoint: "https://ipinfo.io/json",
  ...over,
});

const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  ...base(),
  proxyUrl: null,
  proxyBypass: null,
  initScriptPath: null,
  ...over,
});

/** Replace the real browser with the fake one for whole-run tests. */
async function withFakeBrowser(over = {}): Promise<void> {
  const context = await import("../context.js");
  vi.spyOn(context, "buildRuntime").mockReturnValue(fakeRuntime(over));
}

describe("prepareRun", () => {
  it("warns loudly that direct egress is not geographic", async () => {
    const prepared = await prepareRun(base(), directProvider(), 0);
    expect(prepared.warnings.join(" ")).toContain("egress is DIRECT");
    expect(prepared.warnings.join(" ")).toContain("unproven");
    expect(prepared.spec.proxyUrl).toBeNull();
  });

  it("writes the init script before the browser could ever launch", () => {
    return prepareRun(base(), directProvider(), 0).then((prepared) => {
      expect(prepared.spec.initScriptPath).toBe(path.join(root, "run_1", "init-locale.js"));
      expect(existsSync(prepared.spec.initScriptPath as string)).toBe(true);
    });
  });

  it("carries a resolved proxy URL onto the spec", async () => {
    const provider = httpProxyProvider({
      env: { GEOQA_PROXY_NO: "http://u:p@gw.io:7777" },
      probe: () => Promise.resolve(true),
    });
    const prepared = await prepareRun(base(), provider, 0);
    expect(prepared.spec.proxyUrl).toBe("http://u:p@gw.io:7777");
    expect(prepared.warnings).toEqual([]);
  });

  it("REFUSES rather than silently downgrading when the provider is unusable", async () => {
    // A silent fallback to direct egress would produce a run that looks like a
    // Berlin run, carries a full evidence package, and ran from Norway.
    const store = path.join(root, "cool.json");
    saveCooldowns(store, { "http-proxy": 9_999_999 });
    const provider = httpProxyProvider({ env: { GEOQA_PROXY_NO: "http://gw:1" }, cooldownPath: store });
    await expect(prepareRun(base(), provider, 1_000)).rejects.toThrow(/unusable/);
  });

  it("refuses an unconfigured non-direct provider", async () => {
    await expect(prepareRun(base(), httpProxyProvider({ env: {} }), 0)).rejects.toThrow(/not configured/);
  });

  it("refuses when the provider cannot serve the market", async () => {
    const provider: GeoNetworkProvider = {
      name: "stub",
      health: () => Promise.resolve({ state: "usable", detail: "", cooldownUntil: null }),
      createSession: () => Promise.resolve({ ok: false, reason: "no exit node in NO" }),
      close: () => Promise.resolve(),
    };
    await expect(prepareRun(base(), provider, 0)).rejects.toThrow(/no exit node in NO/);
  });

  it("rejects an invalid profile with a named stage", async () => {
    try {
      await prepareRun(base({ profilePath: "/nope.yaml" }), directProvider(), 0);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as StageError).stage).toBe("prepare");
    }
  });
});

describe("executeRun", () => {
  it("runs every stage and returns a complete result", async () => {
    await withFakeBrowser();
    const prepared = await prepareRun(base(), directProvider(), 0);
    const lines: string[] = [];
    const result = await executeRun({
      spec: prepared.spec,
      provider: directProvider(),
      log: (l) => lines.push(l),
    });

    expect(result.runId).toBe("run_1");
    expect(result.verdict).toBe("PASS");
    expect(result.evidenceId).toBe("ev_1");
    expect(result.geo.network.country.verdict).toBe("match");
    expect(result.confidence.overall).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("verifying both axes");
    expect(existsSync(path.join(root, "run_1", "manifest.json"))).toBe(true);
  });

  it("arms tracing before the first navigation, so a failure can keep one", async () => {
    let started = 0;
    await withFakeBrowser({
      traceStart: () => {
        started++;
        return Promise.resolve(ok(null));
      },
    });
    const prepared = await prepareRun(base(), directProvider(), 0);
    await executeRun({ spec: prepared.spec, provider: directProvider() });
    expect(started).toBe(1);
  });

  it("warns rather than aborting when the engine cannot trace", async () => {
    // An engine without tracing still produces a valid run; it just cannot hand
    // a human the artifact that makes a non-reproducing failure diagnosable.
    await withFakeBrowser({ traceStart: () => Promise.resolve(bad()) });
    const prepared = await prepareRun(base(), directProvider(), 0);
    const lines: string[] = [];
    const result = await executeRun({
      spec: prepared.spec,
      provider: directProvider(),
      log: (l) => lines.push(l),
    });
    expect(result.verdict).toBe("PASS");
    expect(lines.join("\n")).toContain("tracing unavailable");
  });

  it("ANNOUNCES a write-declaring journey before it runs", async () => {
    // A run that registers an account or submits a contact form must say so
    // up front, not leave it to be discovered in the evidence afterwards.
    await withFakeBrowser();
    const prepared = await prepareRun(
      base({ journeyPath: path.join(repoRoot, "journeys", "contact-form.yaml") }),
      directProvider(),
      0,
    );
    const lines: string[] = [];
    await executeRun({
      spec: prepared.spec,
      provider: directProvider(),
      log: (l) => lines.push(l),
    });
    expect(lines.join("\n")).toContain("DECLARES WRITES");
    expect(lines.join("\n")).toContain("will change state on https://digilist.no");
  });

  it("says nothing of the sort for a read-only journey", async () => {
    await withFakeBrowser();
    const prepared = await prepareRun(base(), directProvider(), 0);
    const lines: string[] = [];
    await executeRun({ spec: prepared.spec, provider: directProvider(), log: (l) => lines.push(l) });
    expect(lines.join("\n")).not.toContain("DECLARES WRITES");
    // The seed is always logged: it is how a varied run gets replayed.
    expect(lines.join("\n")).toContain("seed 7");
  });

  it("CLEARS the provider cooldown when the egress verified correctly", async () => {
    // Topping up a vendor account is the whole recovery; a store that only ever
    // adds would keep a healthy provider frozen forever.
    await withFakeBrowser();
    const store = path.join(root, "cool.json");
    saveCooldowns(store, { direct: 9_999_999 });
    const prepared = await prepareRun(base(), directProvider(), 0);
    await executeRun({ spec: prepared.spec, provider: directProvider(), cooldownPath: store });
    expect(loadCooldowns(store)).toEqual({});
  });

  it("cools the provider down when the egress country was provably wrong", async () => {
    await withFakeBrowser({
      getText: () => Promise.resolve({ ok: true, data: '{"country":"DE","city":"Frankfurt"}', stdout: "", stderr: "", durationMs: 1, command: "c" }),
    });
    const store = path.join(root, "cool.json");
    const prepared = await prepareRun(base(), directProvider(), 0);
    await executeRun({ spec: prepared.spec, provider: directProvider(), cooldownPath: store, now: () => 1_000 });
    expect(loadCooldowns(store).direct).toBeGreaterThan(1_000);
  });

  it("closes the browser even when a stage throws", async () => {
    const close = vi.fn(() => Promise.resolve({ ok: true as const, data: null, stdout: "", stderr: "", durationMs: 1, command: "c" }));
    await withFakeBrowser({
      close,
      evaluate: () => {
        throw new Error("browser exploded");
      },
    });
    const prepared = await prepareRun(base(), directProvider(), 0);
    await expect(executeRun({ spec: prepared.spec, provider: directProvider() })).rejects.toThrow("browser exploded");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("leaves the browser open when asked to", async () => {
    const close = vi.fn(() => Promise.resolve({ ok: true as const, data: null, stdout: "", stderr: "", durationMs: 1, command: "c" }));
    await withFakeBrowser({ close });
    const prepared = await prepareRun(base(), directProvider(), 0);
    await executeRun({ spec: prepared.spec, provider: directProvider(), keepOpen: true });
    expect(close).not.toHaveBeenCalled();
  });

  it("throws before touching a browser when the journey is invalid", async () => {
    await withFakeBrowser();
    await expect(
      executeRun({ spec: spec({ journeyPath: "/nope.yaml" }), provider: directProvider() }),
    ).rejects.toThrow(/invalid journey/);
  });

  it("defaults its clock and logger", async () => {
    await withFakeBrowser();
    const prepared = await prepareRun(base(), directProvider(), 0);
    const result = await executeRun({ spec: prepared.spec, provider: directProvider() });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(new Date(result.startedAt).getTime()).toBeGreaterThan(0);
  });
});

describe("executeRun with --repeat", () => {
  /**
   * Counts attempts by counting title reads: `title-exists` is asserted exactly
   * once per attempt by landing-page, and nothing else in a run reads the title.
   */
  const attemptCounter = (
    over: Partial<BrowserRuntime> = {},
  ): { titles: number[]; over: Partial<BrowserRuntime> } => {
    const titles: number[] = [];
    return {
      titles,
      over: {
        getTitle: () => {
          titles.push(1);
          return Promise.resolve(ok("Digilist"));
        },
        ...over,
      },
    };
  };

  it("runs the journey N times inside ONE session, closing the browser once", async () => {
    // Repeats are the reason this does NOT violate one-journey-one-session: all
    // three attempts are the same visitor on the same egress, so what they
    // measure can still be attributed to one identity.
    const close = vi.fn(() => Promise.resolve(ok(null)));
    const counter = attemptCounter({ close });
    await withFakeBrowser(counter.over);
    const prepared = await prepareRun(base(), directProvider(), 0);
    const result = await executeRun({ spec: prepared.spec, provider: directProvider(), repeat: 3 });
    expect(counter.titles).toHaveLength(3);
    expect(close).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe("PASS");
  });

  it("paces each attempt from seed + attemptIndex and logs every one of them", async () => {
    // Repeating the identical pacing measures flakiness under one timing rather
    // than the site's flakiness; the base seed still replays the whole set.
    await withFakeBrowser();
    const prepared = await prepareRun(base({ seed: 7 }), directProvider(), 0);
    const lines: string[] = [];
    await executeRun({
      spec: prepared.spec,
      provider: directProvider(),
      repeat: 3,
      log: (l) => lines.push(l),
    });
    const log = lines.join("\n");
    expect(log).toContain("3 attempts in ONE session");
    expect(log).toContain("MEASURE flakiness, they never mask it");
    expect(log).toContain("attempt 1/3 (seed 7)");
    expect(log).toContain("attempt 2/3 (seed 8)");
    expect(log).toContain("attempt 3/3 (seed 9)");
  });

  it("still reports a step that failed on only ONE attempt — the merge never hides it", async () => {
    // The whole point of the feature. A merge that took the last attempt would
    // return PASS here, file no finding, and throw away the intermittent defect
    // the three runs were paid for.
    let visibleCalls = 0;
    await withFakeBrowser({
      isVisible: () => {
        visibleCalls++;
        return Promise.resolve(ok(visibleCalls > 1));
      },
    });
    const prepared = await prepareRun(base(), directProvider(), 0);
    const result = await executeRun({ spec: prepared.spec, provider: directProvider(), repeat: 3 });
    expect(visibleCalls).toBe(3);
    expect(result.verdict).toBe("FAIL");
    const finding = result.findings.find((f) => f.title === "has a primary heading");
    // Filed — and filed HONESTLY. Before reproducibility was fed through, every
    // real run reported `observed` at a flat 92 whatever it had actually seen.
    expect(finding?.reproducibility).toEqual({ attempts: 3, occurrences: 1 });
    expect(finding?.status).toBe("observed");
    expect(finding?.confidence).toBeLessThan(92);
  });

  it("reports a step that failed in EVERY attempt as reproduced, at near-certain confidence", async () => {
    await withFakeBrowser({ isVisible: () => Promise.resolve(ok(false)) });
    const prepared = await prepareRun(base(), directProvider(), 0);
    const result = await executeRun({ spec: prepared.spec, provider: directProvider(), repeat: 3 });
    const finding = result.findings.find((f) => f.title === "has a primary heading");
    expect(finding?.reproducibility).toEqual({ attempts: 3, occurrences: 3 });
    expect(finding?.status).toBe("reproduced");
    expect(finding?.confidence).toBeGreaterThan(92);
  });

  it("leaves a single-attempt run's findings exactly as they were", async () => {
    // The default path must not change: one attempt, one observation, no claim
    // about repetition that the run is not entitled to make.
    await withFakeBrowser({ isVisible: () => Promise.resolve(ok(false)) });
    const prepared = await prepareRun(base(), directProvider(), 0);
    const result = await executeRun({ spec: prepared.spec, provider: directProvider() });
    const finding = result.findings.find((f) => f.title === "has a primary heading");
    expect(finding?.reproducibility).toEqual({ attempts: 1, occurrences: 1 });
    expect(finding?.status).toBe("observed");
    expect(finding?.confidence).toBe(92);
  });

  it("says nothing about attempts, and asks for exactly one, when repeat is absent or nonsense", async () => {
    const counter = attemptCounter();
    await withFakeBrowser(counter.over);
    const prepared = await prepareRun(base(), directProvider(), 0);
    const lines: string[] = [];
    await executeRun({ spec: prepared.spec, provider: directProvider(), repeat: 0, log: (l) => lines.push(l) });
    await executeRun({ spec: prepared.spec, provider: directProvider(), log: (l) => lines.push(l) });
    expect(counter.titles).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("attempt");
  });

  it("states how many TIMES a write-declaring journey will change state", async () => {
    // Three attempts at a contact form send three real messages. A human is
    // entitled to that number before it happens, not after.
    await withFakeBrowser();
    const prepared = await prepareRun(
      base({ journeyPath: path.join(repoRoot, "journeys", "contact-form.yaml") }),
      directProvider(),
      0,
    );
    const lines: string[] = [];
    await executeRun({
      spec: prepared.spec,
      provider: directProvider(),
      repeat: 3,
      log: (l) => lines.push(l),
    });
    expect(lines.join("\n")).toContain("DECLARES WRITES — this run will change state on https://digilist.no 3 TIMES");
  });
});
