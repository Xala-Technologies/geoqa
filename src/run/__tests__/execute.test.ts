import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCooldowns, saveCooldowns } from "../../network/cooldown.js";
import { directProvider, httpProxyProvider } from "../../network/provider.js";
import type { GeoNetworkProvider } from "../../network/types.js";
import type { RunSpec } from "../context.js";
import { executeRun, prepareRun } from "../execute.js";
import { StageError } from "../stages.js";
import { fakeRuntime } from "./fake-runtime.js";

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

const base = (over: Partial<RunSpec> = {}) => ({
  runId: "run_1",
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
