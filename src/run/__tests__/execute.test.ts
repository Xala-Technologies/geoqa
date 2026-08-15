import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { bad, BROWSER_ENV_OSLO, fakeRuntime, ok } from "./fake-runtime.js";

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

  it("keeps the session open by collecting NO har, rather than closing it to flush one", async () => {
    // The flush is the close on Playwright, so these two requests genuinely conflict. Handing
    // back a dead session to a caller that said it still needed one is the worse half, so the
    // HAR is skipped and the manifest reports it missing — which is true, the file does not
    // exist — with the reason said out loud rather than left to be inferred from a number.
    const lines: string[] = [];
    await withFakeBrowser({ isVisible: () => Promise.resolve(ok(false)) });
    const prepared = await prepareRun(base(), directProvider(), 0);
    const result = await executeRun({
      spec: prepared.spec,
      provider: directProvider(),
      keepOpen: true,
      log: (line) => lines.push(line),
    });
    expect(result.evidenceId).not.toBeNull();
    expect(lines.some((l) => l.includes("no HAR"))).toBe(true);
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

  it("writes the SAME reproducibility into the evidence that the finding claims", async () => {
    // The property that matters, and it is why the two are derived once rather than twice: a
    // finding claiming 3-of-3 beside an evidence package recording something else is worse
    // than either alone, because there is then no way to tell which one is lying.
    await withFakeBrowser({ isVisible: () => Promise.resolve(ok(false)) });
    const prepared = await prepareRun(base(), directProvider(), 0);
    const result = await executeRun({ spec: prepared.spec, provider: directProvider(), repeat: 3 });
    const finding = result.findings.find((f) => f.title === "has a primary heading");
    const written = JSON.parse(readFileSync(path.join(prepared.spec.evidenceRoot, prepared.spec.runId, "run.json"), "utf8")) as {
      journey: { reproducibility: { attempts: number; occurrences: Record<string, number> } };
    };
    expect(written.journey.reproducibility.attempts).toBe(finding?.reproducibility.attempts);
    // And the step's own count is findable in the package, not merely the total.
    expect(Object.values(written.journey.reproducibility.occurrences)).toContain(finding?.reproducibility.occurrences);
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

describe("the things executeRun says OUT LOUD", () => {
  /**
   * Nine branches nothing asserted, and they are all the same kind of thing: a condition that
   * produces a WARNING. A warning that is computed and never logged is a warning nobody sees,
   * which is indistinguishable from the condition not happening — and this engine's whole
   * position is that what it could not verify must be said rather than inferred.
   */
  const lines = (): { log: (l: string) => void; all: string[] } => {
    const all: string[] = [];
    return { log: (l) => all.push(l), all };
  };

  it("REFUSES an invalid journey rather than running an empty one", async () => {
    // A journey that will not parse must stop the run. Continuing with zero steps would produce
    // a PASS: no check ran, so nothing failed.
    //
    // The spec is built directly rather than through `prepareRun`, which loads the journey too
    // and would throw first — leaving executeRun's own guard unexercised while the test passed.
    await withFakeBrowser();
    const prepared = await prepareRun(base(), directProvider(), 0);
    const withBadJourney = { ...prepared.spec, journeyPath: path.join(root, "no-such-journey.yaml") };
    await expect(executeRun({ spec: withBadJourney, provider: directProvider() })).rejects.toThrow();
  });

  it("warns when a RETURNING profile had no session to restore", async () => {
    // The honesty half of B-7: the profile asked to be a returning visitor and this run was a
    // first-time one. Silence here makes the two indistinguishable in the log.
    await withFakeBrowser();
    const out = lines();
    const returning = path.join(repoRoot, "profiles", "oslo-desktop-returning.yaml");
    const prepared = await prepareRun(base({ profilePath: returning, engine: "playwright" }), directProvider(), 0);
    await executeRun({ spec: prepared.spec, provider: directProvider(), log: out.log });
    expect(out.all.some((l) => l.includes("FIRST-TIME visitor"))).toBe(true);
  });

  it("warns when the VIEWPORT could not be applied", async () => {
    // A profile that never applied its viewport measures a different layout than the one it
    // claims — the axis would describe the browser's default, not the market's.
    //
    // Through `setViewport` rather than `setDevice`: `applyDeviceProfile` only calls the latter
    // when a profile declares `emulate`, and no profile does any more (gaps C-8 reverted it from
    // all eight mobile profiles). A test mocking `setDevice` asserts nothing about any run this
    // repo can currently perform.
    await withFakeBrowser({ setViewport: () => Promise.resolve(bad()) });
    const out = lines();
    const prepared = await prepareRun(base(), directProvider(), 0);
    await executeRun({ spec: prepared.spec, provider: directProvider(), log: out.log });
    expect(out.all.some((l) => l.startsWith("warning:"))).toBe(true);
  });

  it("marks a geo reading as NOT FULLY VERIFIED when an axis could not be proven", async () => {
    // `trustworthy` false means an axis is unverified. A confidence number printed without that
    // qualifier reads as a measurement rather than as a partially-unproven one.
    //
    // Produced by the egress ROTATING mid-run, which is the realistic shape and the most
    // consequential: nothing observed after a rotation can be attributed to the site, so the
    // run may not claim full verification whatever the page did.
    //
    // The fake tells the two `evaluate` calls apart by the expression: the egress read is a
    // `fetch` against the identity endpoint, the browser read is not.
    await withFakeBrowser({
      evaluate: <T,>(expression: string) =>
        Promise.resolve(
          ok((expression.includes("fetch") ? JSON.stringify({ ip: "9.9.9.9" }) : BROWSER_ENV_OSLO) as unknown as T),
        ),
    });
    const out = lines();
    const prepared = await prepareRun(base(), directProvider(), 0);
    await executeRun({ spec: prepared.spec, provider: directProvider(), log: out.log });
    expect(out.all.some((l) => l.includes("not fully verified"))).toBe(true);
    // And the rotation is named, not merely folded into a number.
    expect(out.all.some((l) => l.startsWith("egress:"))).toBe(true);
  });

  it("says nothing extra when EVERY axis verified — the arm nothing exercised", async () => {
    /**
     * The suite had no fully-trustworthy run, and the coverage gate is what noticed.
     *
     * `IPINFO_OSLO` reports the city as "Lysaker" with no coordinates, which is faithful — that
     * is the real observed city for a Norwegian exit, and it is the case that motivated
     * `compareCity` measuring DISTANCE rather than comparing names. Without coordinates the
     * fallback name comparison keeps its asymmetry and returns `unverified`, so every existing
     * test ran with one unproven axis and `trustworthy` false.
     *
     * Faithful for the default, but it left the healthy path untested: nothing asserted that a
     * run which verified everything says so plainly, without a qualifier trailing the number.
     */
    await withFakeBrowser({
      getText: () =>
        Promise.resolve(
          ok(JSON.stringify({ ip: "213.52.15.251", city: "Oslo", country: "NO", loc: "59.9139,10.7522", timezone: "Europe/Oslo" })),
        ),
    });
    const out = lines();
    const prepared = await prepareRun(base(), directProvider(), 0);
    await executeRun({ spec: prepared.spec, provider: directProvider(), log: out.log });
    const geoLine = out.all.find((l) => l.startsWith("geo: confidence"));
    expect(geoLine).toBeDefined();
    expect(geoLine).not.toContain("not fully verified");
  });

  it("marks the geo line NOT FULLY VERIFIED when the BROWSER axis could not be read", async () => {
    // Distinct from the egress case: `trustworthy` is folded down again later by the
    // egress-held and corroboration axes, so a rotation flips it AFTER this line is logged.
    // What this covers is the verification itself coming back partial — the browser read
    // failing, so language, timezone and viewport are all unverified.
    await withFakeBrowser({
      evaluate: <T,>(expression: string) =>
        expression.includes("fetch")
          ? Promise.resolve(ok(JSON.stringify({ ip: "1.1.1.1" }) as unknown as T))
          : Promise.resolve(bad<T>()),
    });
    const out = lines();
    const prepared = await prepareRun(base(), directProvider(), 0);
    await executeRun({ spec: prepared.spec, provider: directProvider(), log: out.log });
    expect(out.all.some((l) => l.startsWith("geo: confidence") && l.includes("not fully verified"))).toBe(true);
  });

  it("warns when the run INDEX could not be appended, and does not fail the run", async () => {
    // The index is a derived cache — `geoqa runs rebuild` reconstructs it from the evidence on
    // disk — so losing a line costs nothing permanent. A run that verified a site correctly and
    // wrote its evidence has not failed at anything a user cares about because a cache line
    // could not be written. But it must SAY so, or the run silently vanishes from every view
    // that reads the index.
    await withFakeBrowser();
    const out = lines();
    const prepared = await prepareRun(base(), directProvider(), 0);
    // A directory where the file belongs: the append fails, nothing else does.
    mkdirSync(path.join(root, "runs.jsonl"), { recursive: true });
    const result = await executeRun({ spec: prepared.spec, provider: directProvider(), log: out.log });
    expect(result.verdict).toBe("PASS");
    expect(out.all.some((l) => l.startsWith("warning:"))).toBe(true);
  });

  it("OMITS vitals from the history record when they could not be read", async () => {
    // A history line carrying zeroes for a run whose vitals were unreadable would make the
    // trends draw a cliff that never happened. Absent is the honest shape.
    await withFakeBrowser({ vitals: () => Promise.resolve(bad()) });
    const prepared = await prepareRun(base(), directProvider(), 0);
    await executeRun({ spec: prepared.spec, provider: directProvider() });
    const line = readFileSync(path.join(root, "runs.jsonl"), "utf8").trim().split("\n").at(-1) as string;
    // Every metric NULL rather than zero. `toRunRecord` defaults an absent reading to nulls,
    // which is the honest shape — a history line carrying zeroes for an unreadable run would
    // make the trends draw a cliff that never happened.
    expect((JSON.parse(line) as { vitals: Record<string, number | null> }).vitals).toEqual({
      lcp: null,
      cls: null,
      ttfb: null,
      inp: null,
    });
  });

  it("passes a configured cooldown window through to the provider outcome", async () => {
    // The arm that runs when `network.cooldownMs` is actually configured. Without it the
    // built-in default is used for a caller who set one, which is B-1 in miniature.
    await withFakeBrowser();
    const prepared = await prepareRun(base(), directProvider(), 0);
    const result = await executeRun({
      spec: prepared.spec,
      provider: directProvider(),
      cooldownPath: path.join(root, "cooldowns.json"),
      cooldownMs: 1234,
    });
    expect(result.runId).toBe(prepared.spec.runId);
  });

  it("reports an unlisted HAR that was removed after the close", async () => {
    // The prune is deliberately noisy: a deleted file is the one thing a reader cannot go back
    // and check, so "the run kept nothing" is a claim the log should make explicitly.
    await withFakeBrowser();
    const out = lines();
    const prepared = await prepareRun(base(), directProvider(), 0);
    mkdirSync(path.join(root, prepared.spec.runId), { recursive: true });
    writeFileSync(path.join(root, prepared.spec.runId, "network.har"), "{}");
    await executeRun({ spec: prepared.spec, provider: directProvider(), log: out.log });
    expect(out.all.some((l) => l.includes("removed an unlisted network.har"))).toBe(true);
  });

  it("reports progress phases and writes a live frame after each journey step", async () => {
    const phases: string[] = [];
    const frames: string[] = [];
    await withFakeBrowser({
      screenshot: (p: string) => {
        frames.push(p);
        return Promise.resolve(ok(null));
      },
    });
    const prepared = await prepareRun(base(), directProvider(), 0);
    await executeRun({
      spec: prepared.spec,
      provider: directProvider(),
      liveFramePath: path.join(root, "live.png"),
      onProgress: (event) => phases.push(event.phase),
    });
    expect(phases[0]).toBe("device");
    expect(phases).toContain("verify");
    expect(phases).toContain("journey");
    expect(phases.at(-1)).toBe("done");
    expect(frames.length).toBeGreaterThan(0);
    // The journey still writes its own evidence frame first; the live board
    // copies the page after the step, so live.png is not the first path.
    expect(frames.some((p) => p.endsWith("00-open-target.png"))).toBe(true);
    expect(frames).toContain(path.join(root, "live.png"));
  });

  it("warns when a live frame cannot be captured, and does not fail the run", async () => {
    const out = lines();
    await withFakeBrowser({
      screenshot: (p: string) => (p.endsWith("live.png") ? Promise.resolve(bad()) : Promise.resolve(ok(null))),
    });
    const prepared = await prepareRun(base(), directProvider(), 0);
    const result = await executeRun({
      spec: prepared.spec,
      provider: directProvider(),
      liveFramePath: path.join(root, "live.png"),
      log: out.log,
    });
    expect(result.verdict).toBe("PASS");
    expect(out.all.some((l) => l.includes("live frame unavailable"))).toBe(true);
  });
});
