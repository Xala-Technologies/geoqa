import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionConfig } from "../../browser/types.js";
import type { EvidenceManifest } from "../../evidence/manifest.js";
import { DEFAULT_POLICY, type DirSize, type PruneFs } from "../../evidence/prune.js";
import type { GeoQaRunResult } from "../../findings/types.js";
import type { ExecuteOptions } from "../../run/execute.js";
import { fakeRuntime, bad, ok, IPINFO_OSLO } from "../../run/__tests__/fake-runtime.js";
import {
  browserVerify,
  defaultDeps,
  evidenceInspect,
  evidencePrune,
  experimentRun,
  journeyList,
  journeyPath,
  journeyRun,
  loadProfileOrThrow,
  loadUrlList,
  matrixRun,
  parsePrunePolicy,
  profileList,
  profilePath,
  proxyVerify,
  renderMatrixResult,
  renderPruneResult,
  renderRunResult,
  resolveEvidenceRoot,
  resolveProfileId,
  runtimeOptions,
  scenarioSeed,
  verificationSpec,
  type CommandDeps,
  type MatrixRunResult,
  type RuntimeRequest,
} from "../commands.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let evidenceRoot: string;
beforeEach(() => {
  evidenceRoot = mkdtempSync(path.join(tmpdir(), "geoqa-cmd-"));
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

describe("defaultDeps", () => {
  it("builds real defaults when nothing is overridden", () => {
    const d = defaultDeps(repoRoot);
    expect(d.repoRoot).toBe(repoRoot);
    expect(d.evidenceRoot).toBe(path.join(repoRoot, "evidence"));
    expect(typeof d.now()).toBe("number");
    expect(d.makeRuntime({ sessionId: "s" }).sessionId).toBe("s");
    // The default logger writes to stderr so `--json` on stdout stays clean.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    d.log("hello");
    expect(spy).toHaveBeenCalledWith("hello");
  });

  it("builds the PLAYWRIGHT engine when the request asks for it, launching nothing", () => {
    // The seam's whole point (D-1b): the factory now receives the profile, so a
    // command other than `journey run` can reach the second engine at all.
    // Constructing is safe because `playwrightOpener` returns a function without
    // calling it — the browser starts on first use, which is what keeps the unit
    // suite browser-free.
    const d = defaultDeps(repoRoot, { evidenceRoot });
    const request: RuntimeRequest = { engine: "playwright", profile: loadProfileOrThrow(d, "oslo-mobile") };
    expect(d.makeRuntime({ sessionId: "verify-1" }, request).sessionId).toBe("verify-1");
  });

  it("keeps the agent-browser branch for a request that names it, and for no request at all", () => {
    // The seven experiment samplers pass no request; they must keep measuring
    // agent-browser rather than silently changing engine.
    const d = defaultDeps(repoRoot, { evidenceRoot, browserTimeouts: { commandTimeoutMs: 5_000 } });
    const profile = loadProfileOrThrow(d, "oslo-mobile");
    expect(d.makeRuntime({ sessionId: "a" }, { engine: "agent-browser", profile }).sessionId).toBe("a");
    expect(d.makeRuntime({ sessionId: "b" }).sessionId).toBe("b");
  });
});

describe("runtimeOptions", () => {
  it("passes a configured timeout through and OMITS an unset one entirely", () => {
    // Not zero, and not undefined: exec.ts reads 0 as "no cap", so an unset
    // timeout that arrived as a number would produce a run that does not fail —
    // it hangs, and a hung run reports nothing at all.
    expect(runtimeOptions({ commandTimeoutMs: 1_000, idleTimeoutMs: 20 })).toEqual({ timeoutMs: 1_000, idleMs: 20 });
    expect(runtimeOptions({ idleTimeoutMs: 20 })).toEqual({ idleMs: 20 });
    expect(runtimeOptions({})).toEqual({});
    expect(runtimeOptions()).toEqual({});
  });
});

describe("verificationSpec", () => {
  const request = (): RuntimeRequest => ({ engine: "playwright", profile: loadProfileOrThrow(deps(), "oslo-mobile") });

  it("derives proxy, headed and init script from the session config rather than taking them twice", () => {
    const config: BrowserSessionConfig = {
      sessionId: "verify-9",
      proxy: "http://gw:1",
      proxyBypass: "localhost",
      initScripts: ["/tmp/init.js"],
      headed: true,
    };
    const spec = verificationSpec(config, request(), "/ev");
    expect(spec).toMatchObject({
      runId: "verify-9",
      engine: "playwright",
      evidenceRoot: "/ev",
      proxyUrl: "http://gw:1",
      proxyBypass: "localhost",
      initScriptPath: "/tmp/init.js",
      headed: true,
    });
  });

  it("reads an absent proxy as DIRECT egress rather than leaving it undefined", () => {
    // `null` is what the rest of the run path means by direct egress; an
    // undefined proxy would make a Playwright context ask for a proxy named
    // "undefined".
    const spec = verificationSpec({ sessionId: "verify-1" }, request(), "/ev");
    expect(spec.proxyUrl).toBeNull();
    expect(spec.proxyBypass).toBeNull();
    expect(spec.initScriptPath).toBeNull();
    expect(spec.headed).toBe(false);
  });
});

describe("resolveEvidenceRoot", () => {
  it("lets the FLAG win over the config file, which wins over the built-in default", () => {
    expect(resolveEvidenceRoot("/repo", "configured", "/flag")).toBe(path.resolve("/flag"));
    expect(resolveEvidenceRoot("/repo", "configured")).toBe(path.join("/repo", "configured"));
    expect(resolveEvidenceRoot("/repo", "/absolute/from/config")).toBe("/absolute/from/config");
  });

  it("resolves a relative configured root against the REPO root, not the working directory", () => {
    // geoqa run from a subdirectory would otherwise write its evidence somewhere
    // nobody later looks for it.
    expect(resolveEvidenceRoot("/repo", "evidence")).toBe(path.join("/repo", "evidence"));
    // A bare `--evidence-root` with no value arrives as an empty string, which
    // is not a path and must not become one.
    expect(resolveEvidenceRoot("/repo", "evidence", "")).toBe(path.join("/repo", "evidence"));
  });
});

describe("path helpers", () => {
  it("appends .yaml only when it is missing", () => {
    expect(profilePath(deps(), "oslo-mobile")).toMatch(/profiles\/oslo-mobile\.yaml$/);
    expect(profilePath(deps(), "oslo-mobile.yaml")).toMatch(/profiles\/oslo-mobile\.yaml$/);
    expect(journeyPath(deps(), "landing-page")).toMatch(/journeys\/landing-page\.yaml$/);
    expect(journeyPath(deps(), "landing-page.yaml")).toMatch(/journeys\/landing-page\.yaml$/);
  });

  it("throws a named error for a missing profile", () => {
    expect(() => loadProfileOrThrow(deps(), "atlantis")).toThrow(/profile "atlantis"/);
  });
});

describe("list commands", () => {
  it("lists the shipped profiles with their market and device", () => {
    const { profiles } = profileList(deps());
    // Listed by filename, so a market's two devices sit together and a missing
    // one is visible at a glance. Counts are derived, not hardcoded: the literal
    // roster broke twice in a day as markets were added.
    expect(profiles.length).toBeGreaterThanOrEqual(16);
    expect(profiles.length % 2).toBe(0);
    expect(profiles.map((p) => p.id)).toEqual([...profiles.map((p) => p.id)].sort());
    expect(profiles.find((p) => p.id === "oslo-mobile")).toMatchObject({ country: "NO", city: "Oslo", device: "mobile" });
    expect(profiles.find((p) => p.id === "london-desktop")).toMatchObject({ country: "GB", city: "London", device: "desktop" });
  });

  it("lists the shipped journeys with their step counts", () => {
    const { journeys } = journeyList(deps());
    expect(journeys.map((j) => j.id)).toContain("landing-page");
    expect(journeys.every((j) => j.steps > 0)).toBe(true);
  });

  it("marks an invalid file INVALID rather than throwing the whole listing away", () => {
    const brokenRoot = mkdtempSync(path.join(tmpdir(), "geoqa-broken-"));
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(path.join(brokenRoot, "profiles"), { recursive: true });
    mkdirSync(path.join(brokenRoot, "journeys"), { recursive: true });
    writeFileSync(path.join(brokenRoot, "profiles", "bad.yaml"), "id: x\n");
    writeFileSync(path.join(brokenRoot, "journeys", "bad.yaml"), "id: x\n");
    const d = deps({ repoRoot: brokenRoot });
    expect(profileList(d).profiles[0]?.label).toContain("INVALID");
    expect(journeyList(d).journeys[0]?.title).toContain("INVALID");
    rmSync(brokenRoot, { recursive: true, force: true });
  });
});

describe("browserVerify", () => {
  it("proves each primitive by USING it", () => {
    return browserVerify(deps()).then((result) => {
      expect(result.total).toBe(10);
      expect(result.passed).toBe(10);
      expect(result.launchHash).toBe("h");
      expect(result.primitives.map((p) => p.name)).toContain("vitals");
    });
  });

  it("records a failing primitive without aborting the rest", async () => {
    const result = await browserVerify(
      deps({ makeRuntime: () => fakeRuntime({ a11y: () => Promise.resolve(bad()) }) }),
    );
    expect(result.passed).toBe(9);
    expect(result.primitives.find((p) => p.name === "a11y")).toMatchObject({ ok: false, detail: "nope" });
  });

  it("counts an empty title or snapshot as a FAILED primitive, not a passing one", async () => {
    const result = await browserVerify(
      deps({
        makeRuntime: () =>
          fakeRuntime({ getTitle: () => Promise.resolve(ok("")), snapshot: () => Promise.resolve(ok("")) }),
      }),
    );
    expect(result.primitives.find((p) => p.name === "get-title")?.ok).toBe(false);
    expect(result.primitives.find((p) => p.name === "snapshot")?.ok).toBe(false);
  });

  it("records a THROWN primitive rather than failing the command", async () => {
    const result = await browserVerify(
      deps({
        makeRuntime: () =>
          fakeRuntime({
            console: () => {
              throw new Error("exploded");
            },
          }),
      }),
    );
    expect(result.primitives.find((p) => p.name === "console")).toMatchObject({ ok: false, detail: "exploded" });
  });

  it("leaves the launch hash null when open failed", async () => {
    const result = await browserVerify(deps({ makeRuntime: () => fakeRuntime({ open: () => Promise.resolve(bad()) }) }));
    expect(result.launchHash).toBeNull();
  });

  it("HONOURS --engine and reports which adapter it proved", async () => {
    // Before D-1b this command could only ever prove agent-browser, so a green
    // `browser verify` said nothing about the engine a Playwright run would use.
    let seen: RuntimeRequest | undefined;
    const result = await browserVerify(
      deps({
        makeRuntime: (_config, request) => {
          seen = request;
          return fakeRuntime();
        },
      }),
      "https://example.com",
      { engine: "playwright", profileId: "berlin-desktop" },
    );
    expect(seen?.engine).toBe("playwright");
    expect(seen?.profile.id).toBe("berlin-desktop");
    expect(result.engine).toBe("playwright");
  });

  it("leaves the agent-browser session identity untouched by --geo", async () => {
    // On that engine geography is a TZ variable and an injected script written by
    // the run path. Changing the launch identity of the command that PROVES the
    // primitives would change what EXP-000 measured.
    let config: BrowserSessionConfig | undefined;
    await browserVerify(
      deps({
        makeRuntime: (c) => {
          config = c;
          return fakeRuntime();
        },
      }),
      "https://example.com",
      { profileId: "berlin-desktop" },
    );
    expect(config).toEqual({ sessionId: "verify-1000", namespace: "verify" });
  });

  it("refuses a --geo that names no profile, on either engine", async () => {
    // The flag must mean something even where only one engine reads it, or a
    // typo would be silently ignored on agent-browser and fatal on Playwright.
    await expect(browserVerify(deps(), "https://x", { profileId: "atlantis" })).rejects.toThrow(/profile "atlantis"/);
  });
});

describe("proxyVerify", () => {
  it("reports both axes and warns that direct egress is not geographic", async () => {
    const result = await proxyVerify(deps(), { profileId: "oslo-mobile" });
    expect(result.provider).toBe("direct");
    expect(result.proxy).toBeNull();
    expect(result.verification.network.country.verdict).toBe("match");
    expect(result.verification.network.city.verdict).toBe("unverified");
    expect(result.warnings.join(" ")).toContain("egress is DIRECT");
  });

  it("REDACTS the proxy URL it reports", async () => {
    const result = await proxyVerify(
      deps({ env: { GEOQA_PROXY_NO: "http://user:s3cret@gw.io:7777" } }),
      { profileId: "oslo-mobile", providerName: "http-proxy" },
    );
    expect(result.proxy).not.toContain("s3cret");
    expect(result.proxy).toContain("gw.io");
  });

  it("warns loudly about an unknown provider name and falls back to direct", async () => {
    const result = await proxyVerify(deps(), { profileId: "oslo-mobile", providerName: "magic" });
    expect(result.warnings.join(" ")).toContain("NOT geographic");
  });

  it("refuses when the provider cannot serve the market", async () => {
    await expect(
      proxyVerify(deps({ env: { GEOQA_PROXY_SE: "http://gw:1" } }), {
        profileId: "oslo-mobile",
        providerName: "http-proxy",
      }),
    ).rejects.toThrow(/could not open a network session/);
  });

  it("HONOURS --engine, so the axes can be verified on the engine that will run the journey", async () => {
    let seen: RuntimeRequest | undefined;
    const result = await proxyVerify(
      deps({
        makeRuntime: (_config, request) => {
          seen = request;
          return fakeRuntime();
        },
      }),
      { profileId: "oslo-mobile", engine: "playwright" },
    );
    expect(seen).toMatchObject({ engine: "playwright" });
    expect(seen?.profile.id).toBe("oslo-mobile");
    expect(result.engine).toBe("playwright");
  });

  it("defaults to agent-browser, so nothing changes for a caller that says nothing", async () => {
    const result = await proxyVerify(deps(), { profileId: "oslo-mobile" });
    expect(result.engine).toBe("agent-browser");
  });
});

describe("journeyRun", () => {
  it("prepares, runs and returns the warnings alongside the result", async () => {
    const logged: string[] = [];
    const runOnce = vi.fn(async () => ({ runId: "run_1", verdict: "PASS" }) as GeoQaRunResult);
    const result = await journeyRun(deps({ log: (l) => logged.push(l), runOnce }), {
      url: "https://digilist.no",
      profileId: "oslo-mobile",
      journeyId: "landing-page",
    });
    expect(result.verdict).toBe("PASS");
    expect(result.warnings.join(" ")).toContain("egress is DIRECT");
    expect(logged.join(" ")).toContain("warning:");
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("asks for exactly ONE attempt unless --repeat says otherwise", async () => {
    // The journey never retries, so the default has to be a single attempt:
    // anything else would repeat a state-changing journey without being asked.
    let captured: ExecuteOptions | null = null;
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      captured = o;
      return { runId: "r", verdict: "PASS" } as GeoQaRunResult;
    });
    await journeyRun(deps({ runOnce }), { url: "https://x", profileId: "oslo-mobile", journeyId: "landing-page" });
    expect((captured as ExecuteOptions | null)?.repeat).toBe(1);
  });

  it("plumbs --repeat through, so flakiness is measured rather than retried away", async () => {
    let captured: ExecuteOptions | null = null;
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      captured = o;
      return { runId: "r", verdict: "FAIL" } as GeoQaRunResult;
    });
    await journeyRun(deps({ runOnce }), {
      url: "https://x",
      profileId: "oslo-mobile",
      journeyId: "landing-page",
      repeat: 5,
    });
    expect((captured as ExecuteOptions | null)?.repeat).toBe(5);
  });

  it("passes variables and the headed flag through to the spec", async () => {
    let captured: ExecuteOptions | null = null;
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      captured = o;
      return { runId: "r", verdict: "PASS" } as GeoQaRunResult;
    });
    await journeyRun(deps({ runOnce }), {
      url: "https://x",
      profileId: "oslo-mobile",
      journeyId: "localization",
      vars: { forbiddenCurrency: "EUR" },
      headed: true,
    });
    const spec = (captured as ExecuteOptions | null)?.spec;
    expect(spec?.vars).toEqual({ forbiddenCurrency: "EUR" });
    expect(spec?.headed).toBe(true);
    expect(spec?.target).toBe("https://x");
  });

  it("puts a CONFIGURED verify endpoint on the spec, and the built-in default when there is none", async () => {
    // On the spec rather than read from a constant where it is used, because a
    // Temporal Activity rebuilds everything from serialisable arguments.
    const captured: (string | undefined)[] = [];
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      captured.push(o.spec.verifyEndpoint);
      return { runId: "r", verdict: "PASS" } as GeoQaRunResult;
    });
    const base = { url: "https://x", profileId: "oslo-mobile", journeyId: "landing-page" };
    await journeyRun(deps({ runOnce }), { ...base, verifyEndpoint: "https://ipinfo.example/json" });
    await journeyRun(deps({ runOnce }), base);
    expect(captured[0]).toBe("https://ipinfo.example/json");
    expect(captured[1]).toContain("http");
  });
});

describe("matrixRun", () => {
  const passing = (runId: string): GeoQaRunResult => ({ runId, verdict: "PASS" }) as GeoQaRunResult;

  it("refuses the WHOLE matrix on a bad name, and names every bad one at once", async () => {
    // A typo discovered ninety browser launches in is not a report, it is a bill
    // — and fixing one typo per overnight run is how a tool stops being used.
    const runOnce = vi.fn(async () => passing("r"));
    await expect(
      matrixRun(deps({ runOnce }), {
        url: "https://x",
        markets: ["oslo", "atlantis"],
        devices: ["mobile"],
        journeys: ["landing-page", "no-such-journey"],
      }),
    ).rejects.toThrow(/atlantis[\s\S]*no-such-journey/);
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("refuses an empty axis rather than reporting a verdict over nothing", async () => {
    await expect(
      matrixRun(deps(), { url: "https://x", markets: [], journeys: [] }),
    ).rejects.toThrow(/at least one --market[\s\S]*at least one --journey/);
  });

  it("expands market x device x journey and covers BOTH devices by default", async () => {
    // A market covered on one device cannot catch a device-specific defect.
    const result = await matrixRun(deps(), { url: "https://x", markets: ["oslo"], journeys: ["landing-page"], dryRun: true });
    expect(result.scenarios.map((s) => s.key)).toEqual(["oslo/desktop/landing-page", "oslo/mobile/landing-page"]);
  });

  it("launches NOTHING on a dry run and says so with a null result rather than a clean verdict", async () => {
    // An empty result has counts of zero and a verdict; "nothing was executed"
    // must not be readable as "nothing failed".
    const runOnce = vi.fn(async () => passing("r"));
    const result = await matrixRun(deps({ runOnce }), {
      url: "https://x",
      markets: ["oslo", "berlin"],
      devices: ["mobile"],
      journeys: ["landing-page", "browse"],
      dryRun: true,
    });
    expect(result.result).toBeNull();
    expect(result.dryRun).toBe(true);
    expect(result.scenarios).toHaveLength(4);
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("counts the state-changing scenarios on a dry run WITHOUT demanding --allow-writes", async () => {
    // The number is exactly what a human wants before an overnight job, and the
    // dry run is how they get it for free.
    const result = await matrixRun(deps(), {
      url: "https://x",
      markets: ["oslo", "berlin"],
      journeys: ["contact-form", "landing-page"],
      dryRun: true,
    });
    expect(result.writes).toEqual({ journeys: ["contact-form"], runs: 4 });
  });

  it("REFUSES a matrix containing a writing journey until --allow-writes says so on purpose", async () => {
    // Invariant 14 says a write is announced; at matrix scale an announcement
    // alone is too late — that is 4 real contact forms.
    const runOnce = vi.fn(async () => passing("r"));
    const options = {
      url: "https://x",
      markets: ["oslo", "berlin"],
      journeys: ["contact-form"],
    };
    await expect(matrixRun(deps({ runOnce }), options)).rejects.toThrow(/4 state-changing scenario\(s\)/);
    expect(runOnce).not.toHaveBeenCalled();

    const allowed = await matrixRun(deps({ runOnce }), { ...options, allowWrites: true });
    expect(allowed.result?.counts.total).toBe(4);
  });

  it("runs every scenario through the injected runner and returns them in expansion order", async () => {
    const seen: string[] = [];
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      seen.push(o.spec.journeyPath);
      return passing(o.spec.runId);
    });
    const result = await matrixRun(deps({ runOnce }), {
      url: "https://x",
      markets: ["oslo", "berlin"],
      devices: ["mobile"],
      journeys: ["landing-page", "browse"],
      concurrency: 2,
    });
    expect(result.result?.verdict).toBe("PASS");
    expect(result.result?.scenarios.map((s) => s.scenario.key)).toEqual([
      "berlin/mobile/browse",
      "berlin/mobile/landing-page",
      "oslo/mobile/browse",
      "oslo/mobile/landing-page",
    ]);
    expect(seen).toHaveLength(4);
    expect(result.result?.concurrency.limit).toBe(2);
  });

  it("gives two journeys on ONE profile distinct run ids in the same millisecond", async () => {
    // The clock here is frozen, which is exactly the collision: `run_<ms>_<profile>`
    // would hand both scenarios the same evidence directory and the second would
    // overwrite the first's manifest — a matrix losing runs while reporting a
    // full count.
    const runIds: string[] = [];
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      runIds.push(o.spec.runId);
      return passing(o.spec.runId);
    });
    await matrixRun(deps({ runOnce }), {
      url: "https://x",
      markets: ["oslo"],
      devices: ["mobile"],
      journeys: ["landing-page", "browse"],
    });
    expect(new Set(runIds).size).toBe(2);
  });

  it("seeds each scenario differently while replaying the whole matrix from ONE base seed", async () => {
    const seeds = new Map<string, number>();
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      seeds.set(o.spec.journeyPath + o.spec.profilePath, o.spec.seed);
      return passing(o.spec.runId);
    });
    const options = {
      url: "https://x",
      markets: ["oslo", "berlin"],
      devices: ["mobile"],
      journeys: ["landing-page", "browse"],
      seed: 42,
    };
    await matrixRun(deps({ runOnce }), options);
    const first = new Map(seeds);
    seeds.clear();
    await matrixRun(deps({ runOnce }), options);
    // Different from each other — otherwise 96 scenarios measure one pacing.
    expect(new Set(first.values()).size).toBe(4);
    // And identical across invocations, which a timestamp-derived seed could not be.
    expect([...seeds.entries()].sort()).toEqual([...first.entries()].sort());
  });

  it("derives a base seed when none is given, and reports it so the run can be replayed", async () => {
    const runOnce = vi.fn(async (o: ExecuteOptions) => passing(o.spec.runId));
    const result = await matrixRun(deps({ runOnce }), {
      url: "https://x",
      markets: ["oslo"],
      devices: ["mobile"],
      journeys: ["landing-page"],
    });
    expect(Number.isInteger(result.baseSeed)).toBe(true);
    expect(result.baseSeed).toBeGreaterThanOrEqual(0);
  });

  it("records a scenario that could not be RUN as unmeasured, and keeps going", async () => {
    // "we could not look" is not "the site is fine", and one market failing must
    // not leave the rest untried.
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      if (o.spec.profilePath.includes("berlin")) throw new Error("berlin proxy is down");
      return passing(o.spec.runId);
    });
    const result = await matrixRun(deps({ runOnce }), {
      url: "https://x",
      markets: ["oslo", "berlin"],
      devices: ["mobile"],
      journeys: ["landing-page"],
    });
    expect(result.result?.counts).toMatchObject({ total: 2, passed: 1, unmeasured: 1 });
    expect(result.result?.verdict).toBe("ERROR");
    expect(result.result?.scenarios[0]?.error).toContain("berlin proxy is down");
  });

  it("carries the unknown-provider warning instead of quietly using direct egress", async () => {
    const runOnce = vi.fn(async (o: ExecuteOptions) => passing(o.spec.runId));
    const result = await matrixRun(deps({ runOnce }), {
      url: "https://x",
      markets: ["oslo"],
      devices: ["mobile"],
      journeys: ["landing-page"],
      providerName: "magic",
      dryRun: true,
    });
    expect(result.warnings.join(" ")).toContain("NOT geographic");
  });

  it("logs each scenario as it completes, prefixed so a warning can be attributed", async () => {
    const logged: string[] = [];
    const runOnce = vi.fn(async (o: ExecuteOptions) => passing(o.spec.runId));
    await matrixRun(deps({ runOnce, log: (l) => logged.push(l) }), {
      url: "https://x",
      markets: ["oslo"],
      devices: ["mobile"],
      journeys: ["landing-page"],
    });
    expect(logged.join("\n")).toContain("warning: oslo/mobile/landing-page: egress is DIRECT");
    expect(logged.join("\n")).toContain("matrix: oslo/mobile/landing-page → passed");
  });
});

describe("scenarioSeed", () => {
  it("derives a per-scenario seed from the base and the scenario KEY, not from a run id", () => {
    // A run id contains a timestamp, so seeding from one would make a failing
    // matrix unreplayable; the base seed alone would make every scenario pace
    // identically, which measures one pacing across 96 scenarios.
    expect(scenarioSeed(42, "oslo/mobile/landing-page")).toBe(scenarioSeed(42, "oslo/mobile/landing-page"));
    expect(scenarioSeed(42, "oslo/mobile/landing-page")).not.toBe(scenarioSeed(42, "oslo/desktop/landing-page"));
    expect(scenarioSeed(42, "a")).not.toBe(scenarioSeed(43, "a"));
  });

  it("stays inside 32 bits, which is the generator's state width", () => {
    const seed = scenarioSeed(4_294_967_295, "oslo/mobile/landing-page");
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(4_294_967_295);
  });
});

describe("renderMatrixResult", () => {
  const matrix = (over: Partial<MatrixRunResult> = {}): MatrixRunResult => ({
    dryRun: false,
    scenarios: [
      { index: 0, key: "oslo/mobile/landing-page", market: "oslo", device: "mobile", journey: "landing-page", target: null },
      { index: 1, key: "berlin/mobile/landing-page", market: "berlin", device: "mobile", journey: "landing-page", target: null },
    ],
    writes: { journeys: [], runs: 0 },
    baseSeed: 7,
    provider: "direct",
    engine: "agent-browser",
    warnings: [],
    result: {
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1_200,
      concurrency: { limit: 2, peakInFlight: 2 },
      scenarios: [
        {
          scenario: { index: 0, key: "oslo/mobile/landing-page", market: "oslo", device: "mobile", journey: "landing-page", target: null },
          outcome: "passed",
          result: { runId: "run_1" } as GeoQaRunResult,
          error: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          durationMs: 10,
        },
        {
          scenario: { index: 1, key: "berlin/mobile/landing-page", market: "berlin", device: "mobile", journey: "landing-page", target: null },
          outcome: "unmeasured",
          result: null,
          error: "proxy down",
          startedAt: "2026-01-01T00:00:00.000Z",
          durationMs: 10,
        },
      ],
      counts: { total: 2, passed: 1, warned: 0, siteFailed: 0, unmeasured: 1 },
      verdict: "ERROR",
    },
    ...over,
  });

  it("lists only the scenarios a human has to act on, and the seed that replays them", () => {
    // 96 lines of "passed" is how the four that matter get missed; --json carries
    // every scenario either way.
    const rendered = renderMatrixResult(matrix());
    expect(rendered).toContain("ERROR — 2 scenario(s): 1 passed");
    expect(rendered).toContain("peak in flight 2");
    expect(rendered).toContain("base seed 7");
    expect(rendered).toContain("unmeasured  berlin/mobile/landing-page");
    expect(rendered).toContain("proxy down");
    expect(rendered).not.toContain("oslo/mobile/landing-page ");
  });

  it("names a scenario by its run id when there is no error to show", () => {
    const only = matrix();
    const rendered = renderMatrixResult(
      matrix({
        result: {
          ...only.result!,
          scenarios: only.result!.scenarios.map((s) => ({ ...s, outcome: "siteFailed" as const, error: null })),
        },
      }),
    );
    expect(rendered).toContain("run_1");
    expect(rendered).toContain("no run id");
  });

  it("prints the expansion and a FUTURE-tense write warning on a dry run", () => {
    const rendered = renderMatrixResult(
      matrix({ dryRun: true, result: null, writes: { journeys: ["contact-form"], runs: 2 }, warnings: ["a warning"] }),
    );
    expect(rendered).toContain("matrix dry run — 2 scenario(s), nothing launched");
    expect(rendered).toContain("oslo/mobile/landing-page");
    expect(rendered).toContain("--allow-writes is required");
    expect(rendered).toContain("! a warning");
  });

  it("reports a completed write matrix in the PAST tense, because those forms were really sent", () => {
    const rendered = renderMatrixResult(matrix({ writes: { journeys: ["contact-form"], runs: 2 } }));
    expect(rendered).toContain("CHANGED STATE on the target");
  });
});

describe("evidenceInspect", () => {
  it("reads a manifest a run wrote", async () => {
    const runOnce = vi.fn(async () => ({ runId: "run_1", verdict: "PASS" }) as GeoQaRunResult);
    await journeyRun(deps({ runOnce }), { url: "https://x", profileId: "oslo-mobile", journeyId: "landing-page" });
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(path.join(evidenceRoot, "run_x"), { recursive: true });
    writeFileSync(path.join(evidenceRoot, "run_x", "manifest.json"), JSON.stringify({ evidenceId: "ev_x", tier: "pass" }));
    expect(evidenceInspect(deps(), "run_x").manifest).toMatchObject({ evidenceId: "ev_x" });
  });

  it("says which directory it looked in when there is no manifest", () => {
    expect(() => evidenceInspect(deps(), "run_missing")).toThrow(new RegExp(evidenceRoot));
  });
});

describe("parsePrunePolicy", () => {
  it("starts from the built-in policy when no flag says otherwise", () => {
    const parsed = parsePrunePolicy();
    expect(parsed.ok && parsed.value).toEqual(DEFAULT_POLICY);
  });

  it("overrides one tier's ceiling and leaves the others alone", () => {
    const parsed = parsePrunePolicy({ maxAge: { pass: "2" } });
    expect(parsed.ok && parsed.value.maxAgeDays).toEqual({ ...DEFAULT_POLICY.maxAgeDays, pass: 2 });
  });

  it("reads null/off/never as DISABLING age selection for that tier", () => {
    const parsed = parsePrunePolicy({ maxAge: { fail: "null", pass: "off", warning: "NEVER" } });
    expect(parsed.ok && parsed.value.maxAgeDays).toMatchObject({ fail: null, pass: null, warning: null });
  });

  it("REFUSES an unknown tier rather than silently pruning on the defaults", () => {
    // `--max-age pas=1` quietly ignored is the same shape of lie as an unread
    // config key: the person who typed it believes the policy changed.
    const parsed = parsePrunePolicy({ maxAge: { pas: "1" } });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors[0]).toContain("unknown retention tier");
  });

  it("REFUSES a non-numeric or negative age instead of reading it as the default", () => {
    const parsed = parsePrunePolicy({ maxAge: { pass: "sevendays", fail: "-1" }, privacyDays: "soon" });
    expect(!parsed.ok && parsed.errors).toHaveLength(3);
    expect(!parsed.ok && parsed.errors.join(" ")).toContain("--privacy-days");
  });

  it("lets --privacy-days be turned off, since privacy only ever SHORTENS a ceiling", () => {
    const parsed = parsePrunePolicy({ privacyDays: "off" });
    expect(parsed.ok && parsed.value.privacyMaxAgeDays).toBeNull();
    const shorter = parsePrunePolicy({ privacyDays: "3" });
    expect(shorter.ok && shorter.value.privacyMaxAgeDays).toBe(3);
  });

  it("reads a byte cap with or without a unit, so an off-by-one-thousand is harder to type", () => {
    // A cap three orders of magnitude too small sweeps every regenerable run in
    // the tree.
    expect(parsePrunePolicy({ maxTotal: "2048" })).toMatchObject({ value: { maxTotalBytes: 2048 } });
    expect(parsePrunePolicy({ maxTotal: "2kb" })).toMatchObject({ value: { maxTotalBytes: 2048 } });
    expect(parsePrunePolicy({ maxTotal: "1.5 MB" })).toMatchObject({ value: { maxTotalBytes: 1_572_864 } });
    expect(parsePrunePolicy({ maxTotal: "3GB" })).toMatchObject({ value: { maxTotalBytes: 3 * 1024 ** 3 } });
  });

  it("OMITS the cap entirely when no --max-total is given, so no size sweep runs", () => {
    const parsed = parsePrunePolicy();
    expect(parsed.ok && "maxTotalBytes" in parsed.value).toBe(false);
  });

  it("refuses a byte cap it cannot read", () => {
    const parsed = parsePrunePolicy({ maxTotal: "lots" });
    expect(!parsed.ok && parsed.errors[0]).toContain("--max-total");
  });

  it("narrows the sweep tiers, and refuses a tier name it does not know", () => {
    const parsed = parsePrunePolicy({ sweepTiers: ["pass"] });
    expect(parsed.ok && parsed.value.sizeSweepTiers).toEqual(["pass"]);
    expect(parsePrunePolicy({ sweepTiers: [] }).ok && parsePrunePolicy({ sweepTiers: [] })).toMatchObject({
      value: { sizeSweepTiers: DEFAULT_POLICY.sizeSweepTiers },
    });
    const bad = parsePrunePolicy({ sweepTiers: ["pass", "nope"] });
    expect(!bad.ok && bad.errors[0]).toContain("unknown tier(s) nope");
  });

  it("keeps deleteUnreadable OFF unless it is asked for explicitly", () => {
    // An unreadable manifest is a reason to look, not a licence to delete.
    expect(parsePrunePolicy().ok && parsePrunePolicy()).toMatchObject({ value: { deleteUnreadable: false } });
    expect(parsePrunePolicy({ deleteUnreadable: true })).toMatchObject({ value: { deleteUnreadable: true } });
  });
});

describe("evidencePrune", () => {
  const DAY = 86_400_000;
  const manifest = (over: Partial<EvidenceManifest> = {}): EvidenceManifest =>
    ({
      schemaVersion: 1,
      evidenceId: "ev",
      runId: "run",
      createdAt: new Date(1_000_000_000_000 - 30 * DAY).toISOString(),
      verdict: "PASS",
      tier: "pass",
      artifacts: [],
      missing: [],
      completeness: 100,
      privacyNote: null,
      ...over,
    }) as EvidenceManifest;

  /** A tree in a plain object: nothing here can reach the repo's real evidence/. */
  const fakeFs = (runs: Record<string, { manifest: EvidenceManifest | null; size: DirSize }>, removed: string[] = []): PruneFs => ({
    listRunDirs: () => Object.keys(runs).sort(),
    readManifest: (dir) => runs[path.basename(dir)]?.manifest ?? null,
    measure: (dir) => runs[path.basename(dir)]?.size ?? { bytes: 0, files: 0 },
    removeDir: (dir) => removed.push(dir),
  });

  const tree = (): Record<string, { manifest: EvidenceManifest | null; size: DirSize }> => ({
    run_old_pass: { manifest: manifest(), size: { bytes: 2_048, files: 3 } },
    run_new_pass: {
      manifest: manifest({ createdAt: new Date(1_000_000_000_000 - 1 * DAY).toISOString() }),
      size: { bytes: 1_024, files: 3 },
    },
    run_broken: { manifest: null, size: { bytes: 512, files: 1 } },
  });

  const pruneDeps = (removed: string[]): CommandDeps =>
    deps({ pruneFs: fakeFs(tree(), removed), now: () => 1_000_000_000_000 });

  it("PLANS by default and deletes nothing, because a destructive default loses the one trace that mattered", () => {
    const removed: string[] = [];
    const result = evidencePrune(pruneDeps(removed), { policy: DEFAULT_POLICY });
    expect(result.execution.dryRun).toBe(true);
    expect(removed).toEqual([]);
    expect(result.plan.doomed.map((d) => d.runId)).toEqual(["run_old_pass"]);
    expect(result.plan.reclaimedBytes).toBe(2_048);
  });

  it("leaves a run it cannot identify on disk and says why", () => {
    const result = evidencePrune(pruneDeps([]), { policy: DEFAULT_POLICY });
    expect(result.plan.unknown.map((u) => u.runId)).toEqual(["run_broken"]);
  });

  it("deletes only when handed apply, and reports the bytes actually reclaimed", () => {
    const removed: string[] = [];
    const result = evidencePrune(pruneDeps(removed), { policy: DEFAULT_POLICY, apply: true });
    expect(result.execution.dryRun).toBe(false);
    expect(result.execution.deletedRunIds).toEqual(["run_old_pass"]);
    expect(removed).toHaveLength(1);
    expect(result.execution.reclaimedBytes).toBe(2_048);
  });

  it("falls back to the built-in policy and the real filesystem when neither is supplied", () => {
    // The real `nodePruneFs` reads an ABSENT root as knowably nothing, which is
    // what makes this safe to cover without a fixture tree.
    const result = evidencePrune(deps({ evidenceRoot: path.join(evidenceRoot, "no-such-tree") }));
    expect(result.plan.runCount).toBe(0);
    expect(result.execution.dryRun).toBe(true);
  });
});

describe("renderPruneResult", () => {
  it("says NOTHING WAS DELETED out loud, so a dry run is not mistaken for a completed one", () => {
    const result = evidencePrune(deps({ evidenceRoot: path.join(evidenceRoot, "empty") }));
    const rendered = renderPruneResult(result);
    expect(rendered).toContain("planning deletes nothing");
    expect(rendered).toContain("DRY RUN — nothing was deleted");
  });

  it("reports what was applied, and every delete that FAILED rather than counting it as reclaimed", () => {
    const failing: PruneFs = {
      listRunDirs: () => ["run_x"],
      readManifest: () =>
        ({
          schemaVersion: 1,
          evidenceId: "ev",
          runId: "run_x",
          createdAt: new Date(0).toISOString(),
          verdict: "PASS",
          tier: "pass",
          artifacts: [],
          missing: [],
          completeness: 100,
          privacyNote: null,
        }) as EvidenceManifest,
      measure: () => ({ bytes: 10, files: 1 }),
      removeDir: () => {
        throw new Error("permission denied");
      },
    };
    const result = evidencePrune(deps({ pruneFs: failing, now: () => 1_000_000_000_000 }), { apply: true });
    const rendered = renderPruneResult(result);
    expect(rendered).toContain("applied: deleted 0 run(s)");
    expect(rendered).toContain("FAILED run_x: permission denied");
  });
});

describe("experimentRun", () => {
  const sampler = async (): Promise<Record<string, unknown>> => ({ ok: true });
  const summariser = () => ({
    metrics: [
      { key: "connection-success", description: "d", value: 100, target: 97, unit: "percent" as const, direction: "min" as const, verdict: "pass" as const, reason: "100%" },
    ],
    notes: ["a note"],
  });

  it("writes results.jsonl and summary.json under the experiment id", async () => {
    const d = deps({ repoRoot: evidenceRoot });
    const result = await experimentRun(
      d,
      { id: "EXP-001", samples: 3, profileId: "oslo-mobile", url: "https://x" },
      sampler,
      summariser,
    );
    expect(result.summary.samples).toBe(3);
    expect(readFileSync(result.paths.results, "utf8").trim().split("\n")).toHaveLength(3);
    expect(JSON.parse(readFileSync(result.paths.summary, "utf8")).verdict).toBe("pass");
    expect(result.rendered).toContain("EXP-001-geo-ip");
  });

  it("writes each sample AS IT HAPPENS, so a killed run keeps what it measured", async () => {
    const d = deps({ repoRoot: evidenceRoot });
    const seen: string[] = [];
    let paths = "";
    await experimentRun(
      { ...d, log: (l) => seen.push(l) },
      { id: "EXP-001", samples: 2, profileId: "oslo-mobile", url: "https://x" },
      async (deps2, o, i) => {
        if (i === 1) {
          // By now sample 0 must already be on disk.
          paths = readFileSync(path.join(evidenceRoot, "experiments", "EXP-001-geo-ip", "results.jsonl"), "utf8");
        }
        return { i };
      },
      summariser,
    );
    expect(paths.trim().split("\n")).toHaveLength(1);
    expect(seen.join(" ")).toContain("sample 1/2");
  });

  it("rejects an unknown experiment id", async () => {
    await expect(
      experimentRun(deps(), { id: "EXP-999", samples: 1, profileId: "p", url: "u" }, sampler, summariser),
    ).rejects.toThrow(/unknown experiment/);
  });
});

describe("renderRunResult", () => {
  const result = (over: Partial<GeoQaRunResult> = {}): GeoQaRunResult =>
    ({
      runId: "run_1",
      target: "https://digilist.no",
      profileId: "oslo-mobile",
      verdict: "PASS_WITH_WARNINGS",
      confidence: { geo: 85, browser: 100, journey: 100, evidence: 100, searchObservation: null, overall: 91, notes: ["a note"] },
      findings: [],
      evidenceId: "ev_1",
      ...over,
    }) as GeoQaRunResult;

  it("renders the verdict, confidence line, notes and evidence id", () => {
    const rendered = renderRunResult(result());
    expect(rendered).toContain("PASS_WITH_WARNINGS — https://digilist.no via oslo-mobile");
    expect(rendered).toContain("overall 91");
    expect(rendered).toContain("· a note");
    expect(rendered).toContain("evidence: ev_1");
  });

  it("lists up to ten findings and counts the rest", () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      severity: "low", title: `f${i}`, expected: "e", observed: "o",
    })) as GeoQaRunResult["findings"];
    const rendered = renderRunResult(result({ findings }));
    expect(rendered).toContain("[low] f0");
    expect(rendered).toContain("and 2 more");
  });

  it("omits the evidence line when nothing was captured", () => {
    expect(renderRunResult(result({ evidenceId: null }))).not.toContain("evidence:");
  });
});

describe("loadUrlList", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "geoqa-urls-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a file into the target axis", () => {
    const file = path.join(dir, "sitemap.txt");
    writeFileSync(file, "# pages\nhttps://digilist.no/faq\nhttps://digilist.no/priser\n");
    expect(loadUrlList(file)).toEqual({ ok: true, urls: ["https://digilist.no/faq", "https://digilist.no/priser"] });
  });

  it("reports an unreadable file as an ERROR, never as an empty list", () => {
    // An empty list would run the matrix against the single --url and report a
    // clean pass over one page while the operator believed they had swept a
    // sitemap.
    const result = loadUrlList(path.join(dir, "absent.txt"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors[0]).toContain("--urls-file");
  });

  it("attributes a bad line to the file it came from", () => {
    const file = path.join(dir, "bad.txt");
    writeFileSync(file, "https://ok.no\nnope\n");
    const result = loadUrlList(file);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors[0]).toContain(file);
    expect(result.errors[0]).toContain("line 2");
  });
});

describe("resolveProfileId", () => {
  it("resolves a place to the profile that exists", () => {
    expect(resolveProfileId(deps(), { country: "NO", city: "Oslo" })).toEqual({ ok: true, id: "oslo-desktop" });
  });

  it("is case-insensitive about both, because a country code is not a spelling test", () => {
    expect(resolveProfileId(deps(), { country: "no", city: "oslo" })).toEqual({ ok: true, id: "oslo-desktop" });
  });

  it("takes the device from --device and defaults to desktop", () => {
    expect(resolveProfileId(deps(), { city: "Oslo", device: "mobile" })).toEqual({ ok: true, id: "oslo-mobile" });
    expect(resolveProfileId(deps(), { city: "Oslo" })).toEqual({ ok: true, id: "oslo-desktop" });
  });

  it("passes --geo straight through, and defaults when nothing names an identity", () => {
    expect(resolveProfileId(deps(), { geo: "bergen-mobile" })).toEqual({ ok: true, id: "bergen-mobile" });
    expect(resolveProfileId(deps(), {})).toEqual({ ok: true, id: "oslo-desktop" });
  });

  it("REFUSES both forms at once rather than ranking them", () => {
    // Two identities have no correct answer, and picking either silently means a
    // run reporting a city it was not asked about.
    const result = resolveProfileId(deps(), { geo: "bergen-desktop", city: "Oslo" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors[0]).toContain("give one");
  });

  it("refuses a place with no profile and LISTS the places there are", () => {
    // Without the list, "no profile for NO/Atlantis" sends someone to read the
    // profiles directory; the answer is a flag away.
    const result = resolveProfileId(deps(), { country: "NO", city: "Atlantis" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors[0]).toContain("available:");
    expect(result.errors[0]).toContain("NO/Oslo");
  });

  it("refuses an ambiguous country rather than letting directory order pick the identity", () => {
    // A bare --country NO matches every Norwegian city.
    const result = resolveProfileId(deps(), { country: "NO" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors[0]).toContain("--geo");
  });
});

describe("matrixRun with a page axis", () => {
  const passing = (runId: string): GeoQaRunResult => ({ runId, verdict: "PASS" }) as GeoQaRunResult;

  it("visits each page, not --url once per page", async () => {
    // The axis landed with nothing reaching it, so every scenario got its own key
    // and its own seed and all of them visited --url: a sweep reporting 430 clean
    // pages having loaded one of them 430 times.
    const targets: string[] = [];
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      targets.push(o.spec.target);
      return passing(o.spec.runId);
    });
    await matrixRun(deps({ runOnce }), {
      url: "https://fallback.no",
      markets: ["oslo"],
      devices: ["desktop"],
      journeys: ["landing-page"],
      targets: ["https://a.no/1", "https://a.no/2", "https://a.no/3"],
    });
    expect(targets.sort()).toEqual(["https://a.no/1", "https://a.no/2", "https://a.no/3"]);
  });

  it("falls back to --url for a scenario with no target of its own", async () => {
    const targets: string[] = [];
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      targets.push(o.spec.target);
      return passing(o.spec.runId);
    });
    await matrixRun(deps({ runOnce }), {
      url: "https://fallback.no",
      markets: ["oslo"],
      devices: ["desktop"],
      journeys: ["landing-page"],
    });
    expect(targets).toEqual(["https://fallback.no"]);
  });

  it("gives two PAGES distinct run ids in the same millisecond", async () => {
    // Same collision as two journeys on one profile: `run_<ms>_<slug>` would hand
    // both scenarios one evidence directory and the second would overwrite the
    // first's manifest. The clock here is frozen, which is the collision.
    const runIds: string[] = [];
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      runIds.push(o.spec.runId);
      return passing(o.spec.runId);
    });
    await matrixRun(deps({ runOnce }), {
      url: "",
      markets: ["oslo"],
      devices: ["desktop"],
      journeys: ["landing-page"],
      targets: ["https://a.no/1", "https://a.no/2"],
      concurrency: 2,
    });
    expect(new Set(runIds).size).toBe(2);
    // Never the URL itself: a run id becomes a directory name.
    for (const id of runIds) expect(id).not.toContain("/");
  });

  it("keeps the run ids a plain matrix already had", async () => {
    const runIds: string[] = [];
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      runIds.push(o.spec.runId);
      return passing(o.spec.runId);
    });
    await matrixRun(deps({ runOnce }), {
      url: "https://x",
      markets: ["oslo"],
      devices: ["desktop"],
      journeys: ["landing-page"],
    });
    expect(runIds).toEqual(["run_1000_oslo-desktop-landing-page"]);
  });

  it("refuses a matrix with neither --url nor a page axis", async () => {
    // An empty target reaches the browser as a navigation to nothing, once per
    // scenario: N unmeasured scenarios instead of one refused argument.
    await expect(
      matrixRun(deps(), { url: "", markets: ["oslo"], journeys: ["landing-page"] }),
    ).rejects.toThrow(/needs --url, or --urls-file/);
  });

  it("multiplies the page axis into every market and device", async () => {
    const result = await matrixRun(deps(), {
      url: "",
      markets: ["oslo", "berlin"],
      journeys: ["landing-page"],
      targets: ["https://a.no/1", "https://a.no/2"],
      dryRun: true,
    });
    expect(result.scenarios).toHaveLength(8);
    expect(result.scenarios[0]?.key).toBe("berlin/desktop/landing-page/https://a.no/1");
  });

  it("says how many PAGES, because 43 scenarios could be 43 markets or 43 pages", async () => {
    // The difference is a smoke test versus half a gigabyte of proxy traffic.
    const result = await matrixRun(deps(), {
      url: "",
      markets: ["oslo"],
      devices: ["desktop"],
      journeys: ["landing-page"],
      targets: ["https://a.no/1", "https://a.no/2"],
      dryRun: true,
    });
    expect(renderMatrixResult(result)).toContain("2 page(s) from the URL axis");
  });

  it("says nothing about pages when there is no page axis", async () => {
    const result = await matrixRun(deps(), {
      url: "https://x",
      markets: ["oslo"],
      devices: ["desktop"],
      journeys: ["landing-page"],
      dryRun: true,
    });
    expect(renderMatrixResult(result)).not.toContain("URL axis");
  });
});

describe("proxyVerify corroboration", () => {
  const twoSources = (second: string) => {
    const bodies = [IPINFO_OSLO, second];
    let call = 0;
    return () => fakeRuntime({ getText: () => Promise.resolve(ok(bodies[call++] ?? "")) });
  };

  it("reads a second IP-geo source BY DEFAULT — this command's whole question is where the session is", async () => {
    const agreeing = JSON.stringify({ ip: "213.52.15.251", country_code: "NO", city: "Oslo" });
    const result = await proxyVerify(deps({ makeRuntime: twoSources(agreeing) }), { profileId: "oslo-mobile" });
    expect(result.verification.network.agreement.verdict).toBe("match");
    expect(result.verification.network.corroborating?.city).toBe("Oslo");
  });

  it("skips it when told to, and then says nothing checked rather than nothing disagreed", async () => {
    const result = await proxyVerify(deps(), { profileId: "oslo-mobile", corroborate: false });
    expect(result.verification.network.corroborating).toBeNull();
    expect(result.verification.network.agreement.verdict).toBe("unverified");
  });

  it("surfaces the São Paulo / New York shape of failure", async () => {
    // The live finding: one IP, two databases, two countries. Either reading alone
    // is confident and coherent.
    const contradicting = JSON.stringify({ ip: "213.52.15.251", country_code: "US", city: "New York" });
    const result = await proxyVerify(deps({ makeRuntime: twoSources(contradicting) }), { profileId: "oslo-mobile" });
    expect(result.verification.network.agreement.verdict).toBe("mismatch");
    expect(result.verification.trustworthy).toBe(false);
  });
});
