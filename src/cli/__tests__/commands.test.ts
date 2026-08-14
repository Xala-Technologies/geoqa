import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionConfig } from "../../browser/types.js";
import type { EvidenceManifest } from "../../evidence/manifest.js";
import { DEFAULT_POLICY, type DirSize, type PruneFs } from "../../evidence/prune.js";
import type { GeoQaRunResult } from "../../findings/types.js";
import type { Tenant } from "../../tenant/types.js";
import type { SearchProvider } from "../../search/types.js";
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
  resolveDataPath,
  renderMatrixResult,
  renderPruneResult,
  renderRunResult,
  renderRunsList,
  runsList,
  runsRebuild,
  checkTenantScope,
  contentAnalyse,
  dashboardBuild,
  enforceQuota,
  gateCheck,
  keywordsResearch,
  renderContentAnalysis,
  renderDashboardBuild,
  renderGateResult,
  renderKeywordReport,
  renderSiteAnalysis,
  siteAnalyse,
  resolveEvidenceRoot,
  resolveProfileId,
  resolveTenant,
  tenantList,
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
    // Names the profile AND where it looked. The old message was the loader's ENOENT,
    // which tells a reader about the filesystem rather than about their typo.
    expect(() => loadProfileOrThrow(deps(), "atlantis")).toThrow(/no profile named "atlantis"/);
    expect(() => loadProfileOrThrow(deps(), "atlantis")).toThrow(/looked in/);
  });
});

describe("list commands", () => {
  it("lists the shipped profiles with their market and device", () => {
    const { profiles } = profileList(deps());
    // Listed by filename, so a market's two devices sit together and a missing
    // one is visible at a glance. Counts are derived, not hardcoded: the literal
    // roster broke twice in a day as markets were added.
    expect(profiles.length).toBeGreaterThanOrEqual(16);
    // The real invariant is R-67 — every market is declared on BOTH device kinds —
    // and it is asserted directly rather than through an even count. `% 2 === 0`
    // stood in for it until a third KIND of profile existed (the returning visitor),
    // at which point an odd total was correct and the test was wrong. An assertion
    // that only holds while a coincidence holds is a trap for whoever trips it.
    const anonymous = profiles.filter((p) => p.visitorType === "anonymous");
    const marketsWithDesktop = anonymous.filter((p) => p.device === "desktop").map((p) => `${p.country}/${p.city}`);
    const marketsWithMobile = new Set(anonymous.filter((p) => p.device === "mobile").map((p) => `${p.country}/${p.city}`));
    for (const market of marketsWithDesktop) expect([...marketsWithMobile], market).toContain(market);
    // The claim in the comment above is ADJACENCY, so adjacency is what is asserted.
    // "ids are sorted" stood in for it and held only by coincidence: filenames sort
    // by `-` before `.`, so `oslo-desktop-returning` precedes `oslo-desktop` in the
    // directory while sorting after it by id. The listing was right and the proxy
    // assertion was wrong.
    const positions = new Map<string, number[]>();
    profiles.forEach((p, i) => {
      const market = `${p.country}/${p.city}`;
      positions.set(market, [...(positions.get(market) ?? []), i]);
    });
    for (const [market, seen] of positions) {
      expect(Math.max(...seen) - Math.min(...seen), market).toBe(seen.length - 1);
    }
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

  it("reports EVERY primitive's failure detail, which is the command's whole job", async () => {
    /**
     * `browser verify` exists to say which primitives work on this host and engine. Its failure
     * arms — one per probe — were untested: the suite proved it reports success and never that
     * it reports the reason for a failure. A verifier that goes quiet when the thing it verifies
     * breaks is the one shape it must not have.
     *
     * One runtime where every primitive fails covers all of them, and asserts the property that
     * matters: each row carries the ADAPTER's detail, not a generic message invented here.
     */
    const failing = fakeRuntime({
      open: () => Promise.resolve(bad()),
      getTitle: () => Promise.resolve(bad()),
      getText: () => Promise.resolve(bad()),
      snapshot: () => Promise.resolve(bad()),
      evaluate: <T,>() => Promise.resolve(bad<T>()),
      console: () => Promise.resolve(bad()),
      errors: () => Promise.resolve(bad()),
      networkRequests: () => Promise.resolve(bad()),
      vitals: () => Promise.resolve(bad()),
      a11y: () => Promise.resolve(bad()),
      screenshot: () => Promise.resolve(bad()),
    });
    const result = await browserVerify(deps({ makeRuntime: () => failing }));

    expect(result.passed).toBe(0);
    expect(result.total).toBe(10);
    // No launch hash to report when the open itself failed — and null rather than a guess.
    expect(result.launchHash).toBeNull();
    // Every row says WHY, using the failure the adapter produced.
    for (const p of result.primitives) {
      expect(p.ok, p.name).toBe(false);
      expect(p.detail, p.name).not.toBe("");
    }
  });

  it("counts a primitive that SUCCEEDS but returns nothing as a failure", async () => {
    // `get-title` returning an empty string is a successful call and a useless answer. Reporting
    // it as a working primitive would tell an operator the host is fine when the page has no
    // title — the check is `out.ok && out.data.length > 0` for that reason.
    const result = await browserVerify(
      deps({ makeRuntime: () => fakeRuntime({ getTitle: () => Promise.resolve(ok("")) }) }),
    );
    expect(result.primitives.find((p) => p.name === "get-title")?.ok).toBe(false);
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
    await expect(browserVerify(deps(), "https://x", { profileId: "atlantis" })).rejects.toThrow(/no profile named "atlantis"/);
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

  it("puts every INERT config key onto the run — the defect B-1 is named for", async () => {
    // Each of these was parsed, validated, defaulted and then read by nobody, which is worse
    // than not offering the key: the user edits it, nothing contradicts them, and they believe
    // the setting took. `grep -rn "cooldownMs|\.retention" src/cli src/run` used to return
    // nothing at all.
    let captured: ExecuteOptions | null = null;
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      captured = o;
      return { runId: "r", verdict: "PASS" } as GeoQaRunResult;
    });
    const narrowed = { pass: ["metadata" as const], warning: ["metadata" as const], fail: ["metadata" as const], investigation: ["metadata" as const] };
    await journeyRun(
      deps({
        runOnce,
        retention: narrowed,
        cooldownPath: "/tmp/cooldowns.json",
        cooldownMs: 111,
        browserTimeouts: { commandTimeoutMs: 222, idleTimeoutMs: 333 },
      }),
      { url: "https://x", profileId: "oslo-mobile", journeyId: "landing-page" },
    );
    const o = captured as ExecuteOptions | null;
    expect(o?.spec.retention).toEqual(narrowed);
    // Both halves of the cooldown. Without the write half a failed vendor is never recorded;
    // without the read half it is recorded and then ignored.
    expect(o?.cooldownPath).toBe("/tmp/cooldowns.json");
    expect(o?.cooldownMs).toBe(111);
    // These reached `browser verify` and `proxy verify` and NOT this command — a cap on a hung
    // command applied to the two commands least likely to hang.
    expect(o?.spec.commandTimeoutMs).toBe(222);
    expect(o?.spec.idleTimeoutMs).toBe(333);
  });

  it("OMITS an unconfigured key rather than passing a zero", async () => {
    // `exec.ts` reads 0 as "no cap", so an unset timeout arriving as a number produces a run
    // that does not fail — it hangs, and a hung run reports nothing at all.
    let captured: ExecuteOptions | null = null;
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      captured = o;
      return { runId: "r", verdict: "PASS" } as GeoQaRunResult;
    });
    await journeyRun(deps({ runOnce }), { url: "https://x", profileId: "oslo-mobile", journeyId: "landing-page" });
    const o = captured as ExecuteOptions | null;
    expect(o?.spec).not.toHaveProperty("commandTimeoutMs");
    expect(o?.spec).not.toHaveProperty("retention");
    expect(o).not.toHaveProperty("cooldownMs");
  });

  it("REFUSES --durable when no Temporal client is wired, rather than running here", async () => {
    // The honesty property of the whole durable path. A `--durable` sweep that quietly ran
    // in-process would produce exactly what a durable one produces, with none of the
    // durability — undetectable from the output, which is what makes it worse than a crash.
    await expect(
      matrixRun(deps({}), { url: "https://x", markets: ["oslo"], journeys: ["landing-page"], durable: true }),
    ).rejects.toThrow(/will NOT fall back/);
  });

  it("hands the durable path the SAME scenarios and seeds as the in-process one", async () => {
    // Invariant 12 as a code path: only who executes them changes. The base spec omits the
    // network resolution because `prepareRun` runs inside the workflow's `prepare` activity —
    // which is what puts the proxy choice in the durable history rather than in this process.
    let captured: { runs: { base: { runId: string; seed: number; target: string } }[]; opts: { workflowId: string } } | null = null;
    const result = await matrixRun(
      deps({
        startDurable: async (runs, opts) => {
          captured = { runs, opts } as never;
          return {
            workflowId: opts.workflowId,
            address: "127.0.0.1:7233",
            namespace: "default",
            results: runs.map(() => ({ result: { verdict: "PASS" } as never, warnings: [] })),
          };
        },
      }),
      { url: "https://x", markets: ["oslo"], journeys: ["landing-page"], devices: ["mobile"], durable: true },
    );
    const seen = captured as unknown as { runs: { base: { seed: number; target: string } }[] };
    expect(seen.runs).toHaveLength(1);
    expect(seen.runs[0]?.base.target).toBe("https://x");
    expect(seen.runs[0]?.base.seed).toEqual(expect.any(Number));
    // Rendered through the SAME MatrixResult shape, so a reader cannot tell the modes apart.
    expect(result.result?.scenarios[0]?.outcome).toBe("passed");
    // The matrix verdict uses the run vocabulary (PASS/FAIL/ERROR), not the scenario outcome
    // vocabulary — and it comes from the same `matrixVerdict` the in-process path uses.
    expect(result.result?.verdict).toBe("PASS");
  });

  it("does not let --durable slip past the WRITE guard", async () => {
    // The highest-consequence ordering in this command. `contact-form` declares writes:true, so
    // a durable sweep that started before the guard would submit one real form per scenario —
    // and unlike the in-process path, those would keep going after the terminal closed.
    const startDurable = vi.fn();
    await expect(
      matrixRun(deps({ startDurable }), {
        url: "https://x",
        markets: ["oslo"],
        journeys: ["contact-form"],
        devices: ["mobile"],
        durable: true,
      }),
    ).rejects.toThrow(/--allow-writes/);
    expect(startDurable).not.toHaveBeenCalled();
  });

  it("does not start a workflow for a --dry-run", async () => {
    // The dry run answers the question you have BEFORE an overnight job, and it answers it for
    // free. Starting a workflow to tell somebody how many scenarios there are would be neither.
    const startDurable = vi.fn();
    const out = await matrixRun(deps({ startDurable }), {
      url: "https://x",
      markets: ["oslo"],
      journeys: ["landing-page"],
      devices: ["mobile"],
      durable: true,
      dryRun: true,
    });
    expect(out.result).toBeNull();
    expect(startDurable).not.toHaveBeenCalled();
  });

  it("passes every run-shaping value to the durable path, not just some", async () => {
    // The defect D-5 is about, reappearing in the fix for it: a value the in-process path sends
    // and the durable one does not. `--repeat 3 --durable` would have run once, silently, and
    // reported three findings as `observed`.
    let runs: { repeat?: number; cooldownMs?: number; tenantId?: string | null }[] = [];
    await matrixRun(
      deps({
        cooldownMs: 999,
        tenantId: "digilist",
        startDurable: async (given, opts) => {
          runs = given as never;
          return { workflowId: opts.workflowId, address: "a", namespace: "default", results: given.map(() => ({ result: { verdict: "PASS" } as never, warnings: [] })) };
        },
      }),
      { url: "https://x", markets: ["oslo"], journeys: ["landing-page"], devices: ["mobile"], durable: true, repeat: 3 },
    );
    expect(runs[0]?.repeat).toBe(3);
    expect(runs[0]?.cooldownMs).toBe(999);
    expect(runs[0]?.tenantId).toBe("digilist");
  });

  it("REFUSES a durable result that does not line up with the scenarios", async () => {
    // Results are matched by POSITION, so a short array would attribute every later result to
    // the wrong market — a sweep quietly reporting Bergen's verdict against Oslo.
    await expect(
      matrixRun(
        deps({
          startDurable: async (_runs, opts) => ({
            workflowId: opts.workflowId,
            address: "a",
            namespace: "default",
            results: [],
          }),
        }),
        { url: "https://x", markets: ["oslo"], journeys: ["landing-page"], devices: ["mobile"], durable: true },
      ),
    ).rejects.toThrow(/matched by position/);
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

  it("resolves a place to the FIRST-TIME visitor by default, and to the returning one on request", () => {
    // Oslo has both an anonymous and a returning desktop profile. Without a default
    // every `--country NO --city Oslo` became ambiguous the moment the second one
    // existed — the refusal working correctly and the feature becoming useless. A
    // first-time visitor is the neutral subject: it carries nothing in and keeps
    // nothing out.
    expect(resolveProfileId(deps(), { country: "NO", city: "Oslo" })).toEqual({ ok: true, id: "oslo-desktop" });
    expect(resolveProfileId(deps(), { country: "NO", city: "Oslo", visitor: "returning" })).toEqual({
      ok: true,
      id: "oslo-desktop-returning",
    });
  });

  it("names the visitor kind when no profile matches, so the reason is not mysterious", () => {
    const result = resolveProfileId(deps(), { country: "SE", city: "Stockholm", visitor: "returning" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors[0]).toContain("returning");
    // And the list offered is the returning ones, not every profile.
    expect(result.errors[0]).toContain("NO/Oslo");
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

describe("tenant scoping", () => {
  it("lists the tenants that ship", () => {
    const { tenants } = tenantList(deps());
    expect(tenants.map((t) => t.id)).toContain("digilist");
    const zero = tenants.find((t) => t.id === "digilist");
    expect(zero?.markets).toBeGreaterThan(0);
    expect(zero?.targets).toBeGreaterThan(0);
  });

  it("REPLACES the evidence root with the tenant's own, rather than leaving it to callers", () => {
    // Every path below this derives from the root. A caller that forgot to nest would
    // write one tenant's run into the shared tree, which is the cross-tenant read the
    // whole slice exists to prevent.
    const resolved = resolveTenant(deps(), "digilist");
    if (!resolved.ok) throw new Error(resolved.errors.join("\n"));
    expect(resolved.tenant?.id).toBe("digilist");
    expect(resolved.evidenceRoot).toBe(path.join(evidenceRoot, "digilist"));
  });

  it("leaves the shared root alone and returns a NULL tenant when none was named", () => {
    // Not an error and not a default tenant: single-target use is still the common
    // case, and no tenant rule applies then — which is the honest consequence.
    const resolved = resolveTenant(deps(), undefined);
    if (!resolved.ok) throw new Error(resolved.errors.join("\n"));
    expect(resolved.tenant).toBeNull();
    expect(resolved.evidenceRoot).toBe(evidenceRoot);
  });

  it("refuses a mistyped tenant rather than creating a directory for one that does not exist", () => {
    // A run whose evidence lands under `evidence/digilst/` is lost, and lost quietly.
    const resolved = resolveTenant(deps(), "digilst");
    expect(resolved.ok).toBe(false);
  });

  it("refuses a target the tenant does not own, and names the declared ones", () => {
    const loaded = resolveTenant(deps(), "digilist");
    if (!loaded.ok || loaded.tenant === null) throw new Error("expected tenant zero");
    const errors = checkTenantScope(loaded.tenant, { url: "https://example.com" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("does not own");
    expect(errors[0]).toContain("https://digilist.no");
  });

  it("refuses a LOOKALIKE host, which a prefix test would have authorised", () => {
    const loaded = resolveTenant(deps(), "digilist");
    if (!loaded.ok || loaded.tenant === null) throw new Error("expected tenant zero");
    expect(checkTenantScope(loaded.tenant, { url: "https://digilist.no.evil.test/" })).toHaveLength(1);
    expect(checkTenantScope(loaded.tenant, { url: "https://digilist.no/faq" })).toEqual([]);
  });

  it("refuses a market the tenant never asked for, and reports EVERY problem at once", () => {
    // Fixing one refusal per invocation is how a tool stops being used.
    const loaded = resolveTenant(deps(), "digilist");
    if (!loaded.ok || loaded.tenant === null) throw new Error("expected tenant zero");
    const errors = checkTenantScope(loaded.tenant, { url: "https://example.com", markets: ["oslo", "berlin", "tokyo"] });
    expect(errors).toHaveLength(3);
    expect(errors.filter((e) => e.includes("has not asked for market"))).toHaveLength(2);
  });

  it("says nothing about an empty url, so a matrix using --urls-file is not refused for it", () => {
    const loaded = resolveTenant(deps(), "digilist");
    if (!loaded.ok || loaded.tenant === null) throw new Error("expected tenant zero");
    expect(checkTenantScope(loaded.tenant, { url: "" })).toEqual([]);
  });
})

describe("enforceQuota", () => {
  const digilist = (): Tenant => {
    const loaded = resolveTenant(deps(), "digilist");
    if (!loaded.ok || loaded.tenant === null) throw new Error("expected tenant zero");
    return loaded.tenant;
  };

  const withUsage = (over: Partial<CommandDeps>, traffic: number | null, subUserName = "sub-1"): CommandDeps =>
    deps({
      env: { DECODO_API_KEY: "key", GEOQA_SUBUSER_DIGILIST: subUserName },
      usageProbe: () => Promise.resolve(traffic === null ? null : [{ username: "sub-1", trafficMb: traffic, trafficLimitMb: null, status: "active" }]),
      ...over,
    });

  it("allows a run that fits inside the tenant's budget", async () => {
    const decision = await enforceQuota(withUsage({}, 10), digilist(), 5);
    expect(decision.state).toBe("within");
    expect(decision.estimateMb).toBe(5);
  });

  it("REFUSES a sweep that would not fit, with the real page count", async () => {
    // Tenant zero's budget is 5000 MB. Already spent 4900, and 430 pages is ~430 MB.
    const decision = await enforceQuota(withUsage({}, 4900), digilist(), 430);
    expect(decision.state).toBe("refused");
    expect(decision.errors[0]).toContain("430 MB");
  });

  it("treats an unreadable vendor as UNMEASURED and says the guard is not in force", async () => {
    // Never zero. An unread figure read as nothing spent authorises exactly the
    // unbounded sweep this exists to prevent.
    const decision = await enforceQuota(withUsage({}, null), digilist(), 100);
    expect(decision.state).toBe("unknown");
    expect(decision.warnings.join(" ")).toContain("NOT being enforced");
  });

  it("is unmeasurable when the sub-account variable is not set, rather than unlimited", async () => {
    // The tenant names a variable; an unset variable is the same state as naming none
    // — and both are distinct from measuring zero.
    const probe = vi.fn(() => Promise.resolve([]));
    const decision = await enforceQuota(deps({ env: { DECODO_API_KEY: "key" }, usageProbe: probe }), digilist(), 1);
    expect(decision.state).toBe("unknown");
    // Not even asked: there is nothing to attribute a figure to.
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not call the vendor without an API key", async () => {
    const probe = vi.fn(() => Promise.resolve([]));
    const decision = await enforceQuota(deps({ env: { GEOQA_SUBUSER_DIGILIST: "sub-1" }, usageProbe: probe }), digilist(), 1);
    expect(decision.state).toBe("unknown");
    expect(probe).not.toHaveBeenCalled();
  });

  it("counts the tenant's own runs today toward its run ceiling", async () => {
    // Derived from the evidence tree rather than a ledger: a counter file drifts, and
    // every way it drifts lets work through.
    const root = path.join(evidenceRoot, "digilist");
    mkdirSync(root, { recursive: true });
    const now = 1_800_000_000_000;
    for (let i = 0; i < 3; i++) mkdirSync(path.join(root, `run_${now - i * 1000}_oslo-desktop`), { recursive: true });
    // A directory that is not a run must not count.
    mkdirSync(path.join(root, "visitors"), { recursive: true });
    const scoped = withUsage({ evidenceRoot: root, now: () => now }, 10);
    const decision = await enforceQuota(scoped, digilist(), 1);
    expect(decision.state).toBe("within");

    const capped = { ...digilist(), quota: { trafficMb: 5000, runsPerDay: 3 } };
    const refused = await enforceQuota(scoped, capped, 1);
    expect(refused.state).toBe("refused");
    expect(refused.errors[0]).toContain("3 run(s) today");
  });

  it("treats a tenant's first run as zero runs rather than an error", async () => {
    // The tenant's directory does not exist yet. Refusing here would make the quota
    // check the thing that stops a tenant ever starting.
    const decision = await enforceQuota(withUsage({ evidenceRoot: path.join(evidenceRoot, "never-written") }, 10), digilist(), 1);
    expect(decision.state).toBe("within");
  });
})

describe("tenant-scoped profiles and journeys", () => {
  it("REFUSES an id that is a path — a traversal that predates multi-tenancy", () => {
    // Verified against the old code before the fix: `--geo ../../../../etc/hosts`
    // resolved to /Volumes/etc/hosts.yaml and tried to read it. Only .yaml files were
    // reachable and a parse failure was the usual outcome, but the id came from the
    // command line, the resolved path was echoed back, and a YAML parse error can quote
    // the line it failed on. An attacker-controlled read attempt with a disclosure
    // channel is enough.
    for (const id of ["../../../../etc/hosts", "../oslo-desktop", "a/b", "..", "oslo/../../x", "/etc/passwd"]) {
      const result = resolveDataPath(deps(), "profiles", id);
      expect(result.ok, id).toBe(false);
      if (!result.ok) expect(result.errors[0]).toContain("refused");
    }
    expect(() => profilePath(deps(), "../../etc/hosts")).toThrow(/refused/);
    expect(() => journeyPath(deps(), "../../etc/hosts")).toThrow(/refused/);
  });

  it("resolves a shared profile and journey, with or without the .yaml suffix", () => {
    const withSuffix = resolveDataPath(deps(), "profiles", "oslo-desktop.yaml");
    const without = resolveDataPath(deps(), "profiles", "oslo-desktop");
    expect(withSuffix).toEqual(without);
    expect(resolveDataPath(deps(), "journeys", "landing-page").ok).toBe(true);
  });

  it("says WHERE it looked when a name matches nothing", () => {
    // The old behaviour returned a path that did not exist and let the loader report
    // ENOENT, which tells a reader about the filesystem rather than about their typo.
    const result = resolveDataPath(deps(), "profiles", "oslo-desktopp");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors[0]).toContain("looked in");
  });

  it("prefers the TENANT's file over the shared one, and falls back for everything else", () => {
    // The point of the feature: a tenant customises one journey without forking the
    // engine, and still gets the other seven.
    const scoped = deps({ tenantId: "digilist" });
    const own = resolveDataPath(scoped, "journeys", "landing-page");
    if (!own.ok) throw new Error(own.errors.join("\n"));
    expect(own.value).toContain(path.join("tenants", "digilist", "journeys"));

    const shared = resolveDataPath(scoped, "journeys", "browse");
    if (!shared.ok) throw new Error(shared.errors.join("\n"));
    expect(shared.value).toContain(path.join(repoRoot, "journeys"));
  });

  it("lists the tenant's overriding file INSTEAD of the shared one, never both", () => {
    // A listing that disagreed with the resolver would be worse than no listing.
    const scoped = journeyList(deps({ tenantId: "digilist" })).journeys.filter((j) => j.id === "landing-page");
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.title).toContain("digilist");
    const shared = journeyList(deps()).journeys.filter((j) => j.id === "landing-page");
    expect(shared[0]?.title).not.toContain("digilist");
  });

  it("treats a tenant with no data directory as using the shared set", () => {
    // Normal, not an error: most tenants customise nothing.
    const scoped = deps({ tenantId: "acme" });
    const result = resolveDataPath(scoped, "profiles", "oslo-desktop");
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.value).toContain(path.join(repoRoot, "profiles"));
    expect(profileList(scoped).profiles.length).toBeGreaterThan(0);
  });

  it("refuses a traversing id even WITH a tenant scoped, before trying either root", () => {
    // A refusal is not "try the next root": it means the id got past the pattern and is
    // trying to leave.
    expect(resolveDataPath(deps({ tenantId: "digilist" }), "profiles", "../../../etc/hosts").ok).toBe(false);
  });
})

describe("runs history", () => {
  const line = (over: Record<string, unknown>): string =>
    JSON.stringify({
      schemaVersion: 1,
      runId: "run_1000_oslo-desktop",
      tenantId: null,
      target: "https://a.test/",
      profileId: "oslo-desktop",
      journeyId: "landing-page",
      verdict: "PASS",
      startedAt: "2026-08-13T10:00:00.000Z",
      durationMs: 5,
      seed: 7,
      engine: "playwright",
      evidenceId: "ev_1",
      findings: { total: 0, bySeverity: {}, byCategory: {}, labels: [] },
      confidence: { overall: 100, geo: 100, browser: 100, journey: 100, evidence: 100 },
      geo: { requestedCountry: "NO", requestedCity: "Oslo", observedCountry: "NO", observedCity: "Oslo", country: "match", city: "match", egressHeld: "match", agreement: "unverified" },
      latencyMs: 100,
      vitals: { lcp: null, cls: null, ttfb: null, inp: null },
      ...over,
    });

  const withIndex = (text: string, dirs: Record<string, string[]> = {}, files: Record<string, string> = {}): CommandDeps => {
    const store: Record<string, string> = { [path.join(evidenceRoot, "runs.jsonl")]: text, ...files };
    return deps({
      historyFs: {
        exists: (p) => p in store,
        read: (p) => {
          if (!(p in store)) throw new Error(`ENOENT ${p}`);
          return store[p] as string;
        },
        append: (p, t) => { store[p] = (store[p] ?? "") + t; },
        write: (p, t) => { store[p] = t; },
        mkdir: () => {},
        listDirs: (p) => dirs[p] ?? [],
      },
    });
  };

  it("summarises and lists, newest first", () => {
    const result = runsList(withIndex(`${line({ runId: "r1" })}\n${line({ runId: "r2", startedAt: "2026-08-13T11:00:00.000Z", verdict: "FAIL" })}\n`));
    expect(result.summary.runs).toBe(2);
    expect(result.summary.byVerdict).toEqual({ PASS: 1, FAIL: 1 });
    expect(result.runs.map((r) => r.runId)).toEqual(["r2", "r1"]);
  });

  it("applies the limit to the LIST and never to the summary or regressions", () => {
    // "The last 20 runs" is a display preference; "how many runs have there been" and
    // "what broke" are questions about all of them. Truncating the answer to match the
    // display would be a quieter version of reporting an unmeasured metric as fine.
    const lines = Array.from({ length: 5 }, (_, i) => line({ runId: `r${i}`, startedAt: `2026-08-13T1${i}:00:00.000Z` })).join("\n");
    const result = runsList(withIndex(`${lines}\n`), { limit: 2 });
    expect(result.runs).toHaveLength(2);
    expect(result.summary.runs).toBe(5);
  });

  it("filters, and the summary describes the FILTERED set", () => {
    const result = runsList(withIndex(`${line({ runId: "r1", journeyId: "landing-page" })}\n${line({ runId: "r2", journeyId: "browse" })}\n`), {
      journeyId: "browse",
    });
    expect(result.summary.runs).toBe(1);
    expect(result.runs[0]?.runId).toBe("r2");
  });

  it("reports skipped lines and points at the rebuild, without failing", () => {
    // A half-written final line is normal after an interrupted run, and the evidence is
    // still on disk.
    const result = runsList(withIndex(`${line({ runId: "r1" })}\n{"half\n`));
    expect(result.summary.runs).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.warnings[0]).toContain("runs rebuild");
  });

  it("surfaces a regression, and renders it", () => {
    const good = line({ runId: "r1", startedAt: "2026-08-13T10:00:00.000Z" });
    const bad = line({
      runId: "r2",
      startedAt: "2026-08-13T11:00:00.000Z",
      verdict: "FAIL",
      findings: { total: 1, bySeverity: { critical: 1 }, byCategory: { functional: 1 }, labels: ["has a primary heading"] },
    });
    const result = runsList(withIndex(`${good}\n${bad}\n`));
    expect(result.regressions).toHaveLength(1);
    const rendered = renderRunsList(result);
    expect(rendered).toContain("1 regression(s)");
    expect(rendered).toContain("has a primary heading");
    expect(rendered).toContain("last good");
  });

  it("renders an empty history without inventing a confidence number", () => {
    const rendered = renderRunsList(runsList(withIndex("")));
    expect(rendered).toContain("no runs recorded yet");
    expect(rendered).not.toContain("mean overall confidence");
  });

  it("rebuilds the index from the runs on disk", () => {
    // What makes the index safe to treat as a cache: run.json is the authority on its
    // own run, so a corrupt or deleted index costs nothing permanent.
    const runJson = JSON.stringify({ runId: "run_1000_oslo-desktop", target: "https://a.test/", profile: { id: "oslo-desktop" }, journey: { id: "landing-page", verdict: "PASS", seed: 3 } });
    const scoped = withIndex("garbage\n", { [evidenceRoot]: ["run_1000_oslo-desktop"] }, { [path.join(evidenceRoot, "run_1000_oslo-desktop", "run.json")]: runJson });
    const rebuilt = runsRebuild(scoped);
    expect(rebuilt.written).toBe(1);
    expect(rebuilt.unreadable).toEqual([]);
    // And the corrupt line is gone, because rebuild OVERWRITES.
    const after = runsList(scoped);
    expect(after.skipped).toBe(0);
    expect(after.runs[0]?.seed).toBe(3);
  });

  it("reports a run.json it could not read rather than dropping the run silently", () => {
    const scoped = withIndex("", { [evidenceRoot]: ["run_1_a"] });
    const rebuilt = runsRebuild(scoped);
    expect(rebuilt.written).toBe(0);
    expect(rebuilt.unreadable[0]).toContain("no run.json");
  });

  it("reports a run.json with no runId as not describing a run", () => {
    const scoped = withIndex("", { [evidenceRoot]: ["run_1_a"] }, { [path.join(evidenceRoot, "run_1_a", "run.json")]: "{}" });
    expect(runsRebuild(scoped).unreadable[0]).toContain("did not describe a run");
  });

  it("derives a rebuilt run's start time from its run id", () => {
    // A run id is `run_<epochMs>_<slug>`, which is also why the history sorts
    // chronologically by id.
    const runJson = JSON.stringify({ runId: "run_1700000000000_x", journey: { verdict: "FAIL" } });
    const scoped = withIndex("", { [evidenceRoot]: ["run_1700000000000_x"] }, { [path.join(evidenceRoot, "run_1700000000000_x", "run.json")]: runJson });
    runsRebuild(scoped);
    expect(runsList(scoped).runs[0]?.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
})

describe("keywordsResearch", () => {
  const digilist = (): Tenant => {
    const loaded = resolveTenant(deps(), "digilist");
    if (!loaded.ok || loaded.tenant === null) throw new Error("expected tenant zero");
    return loaded.tenant;
  };

  const fakeSearch = (results: string[]): SearchProvider => ({
    name: "fake",
    health: () => Promise.resolve({ state: "usable", detail: "ok", searchesLeft: 1000 }),
    search: () =>
      Promise.resolve({ ok: true, totalResults: 10, results: results.map((url, i) => ({ position: i + 1, url, title: "t" })) }),
  });

  it("resolves each market's geography from its PROFILE, and reports rankings", async () => {
    const report = await keywordsResearch(deps({ searchProvider: fakeSearch(["https://rival.test/", "https://digilist.no/x"]) }), digilist(), {
      markets: ["oslo"],
    });
    expect(report.tenantId).toBe("digilist");
    expect(report.observations[0]?.marketId).toBe("oslo");
    expect(report.observations[0]?.position).toBe(2);
    expect(report.observations[0]?.topCompetitor).toBe("rival.test");
  });

  it("REFUSES a market with no profile rather than querying invented geography", async () => {
    // A market's country, city and language come from its profile. Querying without them
    // would produce a worldwide SERP labelled as a city.
    const tenant = { ...digilist(), markets: ["atlantis"] };
    await expect(keywordsResearch(deps({ searchProvider: fakeSearch([]) }), tenant, {})).rejects.toThrow(/no desktop profile|invented geography/);
  });

  it("looks for the tenant's own declared target, not a guess", async () => {
    const report = await keywordsResearch(deps({ searchProvider: fakeSearch(["https://digilist.no/priser"]) }), digilist(), {
      markets: ["oslo"],
    });
    expect(report.observations[0]?.position).toBe(1);
  });

  it("renders unmeasured, absent and ranked rows distinguishably", () => {
    const rendered = renderKeywordReport({
      tenantId: "acme",
      queried: 3,
      measured: 2,
      meanScore: 51,
      warnings: ["a warning"],
      observations: [
        { term: "ranked", intent: "local", audience: null, marketId: "oslo", score: 100, position: 1, examined: 9, reason: "", topCompetitor: "acme.test" },
        { term: "gone", intent: "local", audience: null, marketId: "oslo", score: 2, position: null, examined: 9, reason: "", topCompetitor: "rival.test" },
        { term: "blind", intent: "local", audience: null, marketId: "oslo", score: null, position: null, examined: null, reason: "", topCompetitor: null },
      ],
    });
    expect(rendered).toContain("#1");
    expect(rendered).toContain("absent");
    expect(rendered).toContain("unmeasured");
    expect(rendered).toContain("mean visibility 51");
    expect(rendered).toContain("! a warning");
    // The gap list names the competitor, which is the actionable half of "you are not there".
    expect(rendered).toContain("top: rival.test");
  });

  it("does not print a mean when nothing was measured", () => {
    // Null, not 0: "no readings" and "readings that scored zero" are different facts.
    const rendered = renderKeywordReport({ tenantId: "acme", queried: 1, measured: 0, meanScore: null, warnings: [], observations: [] });
    expect(rendered).not.toContain("mean visibility");
  });

  it("says so plainly when no queries ran at all", () => {
    expect(renderKeywordReport({ tenantId: "acme", queried: 0, measured: 0, meanScore: null, warnings: [], observations: [] })).toContain(
      "no keyword queries ran",
    );
  });
})

describe("gateCheck", () => {
  const passing = (): GeoQaRunResult =>
    ({
      runId: "run_1_oslo-desktop",
      evidenceId: "ev_1",
      verdict: "PASS",
      findings: [],
      confidence: { overall: 100, geo: 100, browser: 100, journey: 100, evidence: 100, searchObservation: null, notes: [] },
    }) as unknown as GeoQaRunResult;

  const failing = (): GeoQaRunResult =>
    ({
      ...passing(),
      verdict: "FAIL",
      findings: [
        { id: "f1", title: "has a primary heading", severity: "critical", category: "functional", expected: "h1 is visible", observed: "not visible" },
        { id: "f2", title: "slow", severity: "low", category: "performance", expected: "fast", observed: "slow" },
      ],
    }) as unknown as GeoQaRunResult;

  const base = { url: "https://digilist.no/faq", profileId: "oslo-desktop", journeyId: "landing-page" };

  it("ALLOWS a clean run and returns no actionable findings", async () => {
    const result = await gateCheck(deps({ runOnce: async () => passing() }), base);
    expect(result.gate.decision).toBe("allow");
    expect(result.actionable).toEqual([]);
  });

  it("BLOCKS a measured problem and hands back findings a producer can act on", async () => {
    const result = await gateCheck(deps({ runOnce: async () => failing() }), base);
    expect(result.gate.decision).toBe("block");
    // Worst first, and the low-severity one is still available rather than discarded.
    expect(result.actionable.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("forwards every option it was given to the run it gates on", async () => {
    // Each of these is a conditional spread, and an option that is accepted and then dropped is
    // the B-1 defect: the caller sets it, nothing contradicts them, and the gate decides on a
    // run configured differently from the one they asked for.
    let captured: ExecuteOptions | null = null;
    await gateCheck(
      deps({
        runOnce: async (o: ExecuteOptions) => {
          captured = o;
          return passing();
        },
      }),
      {
        ...base,
        // `direct` rather than `http-proxy`: the spread fires on any truthy value, and
        // http-proxy with no credentials refuses before a run happens — which would test the
        // refusal rather than the forwarding.
        providerName: "direct",
        engine: "playwright",
        verifyEndpoint: "https://example.test/ip",
        seed: 4242,
        tenantId: "digilist",
        blockAtOrAbove: "medium",
      },
    );
    const o = captured as unknown as ExecuteOptions;
    expect(o.spec.engine).toBe("playwright");
    expect(o.spec.verifyEndpoint).toBe("https://example.test/ip");
    expect(o.spec.seed).toBe(4242);
    expect(o.tenantId).toBe("digilist");
  });

  it("is UNKNOWN when the run THROWS — an exception must not be catchable as a pass", async () => {
    // The one place this could go wrong is a publisher wrapping the call in a try/catch and
    // treating the absence of a decision as permission.
    const result = await gateCheck(
      deps({
        runOnce: async () => {
          throw new Error("proxy refused the connection");
        },
      }),
      base,
    );
    expect(result.gate.decision).toBe("unknown");
    expect(result.gate.reason).toContain("absence of a verdict is not a verdict");
    expect(result.gate.blockers[0]).toContain("proxy refused");
  });

  it("passes the thresholds through", async () => {
    const lowConfidence = {
      ...passing(),
      confidence: { overall: 60, geo: 30, browser: 100, journey: 100, evidence: 100, searchObservation: null, notes: [] },
    } as unknown as GeoQaRunResult;
    const d = deps({ runOnce: async () => lowConfidence });
    expect((await gateCheck(d, { ...base, minConfidence: 50 })).gate.decision).toBe("allow");
    expect((await gateCheck(d, { ...base, minConfidence: 80 })).gate.decision).toBe("block");
    expect((await gateCheck(d, { ...base, minConfidence: 50, minGeoConfidence: 70 })).gate.decision).toBe("block");
  });

  it("renders each decision with its blockers and the run it came from", async () => {
    const blocked = renderGateResult(await gateCheck(deps({ runOnce: async () => failing() }), base));
    expect(blocked).toContain("BLOCK");
    expect(blocked).toContain("✗ [critical] has a primary heading");
    expect(blocked).toContain("run run_1_oslo-desktop");
    const allowed = renderGateResult(await gateCheck(deps({ runOnce: async () => passing() }), base));
    expect(allowed).toContain("ALLOW");
  });

  it("renders an unknown with no run id rather than inventing one", async () => {
    const rendered = renderGateResult(
      await gateCheck(
        deps({
          runOnce: async () => {
            throw new Error("nothing ran");
          },
        }),
        base,
      ),
    );
    expect(rendered).toContain("UNKNOWN");
    expect(rendered).not.toContain("run run_");
  });
})

describe("siteAnalyse", () => {
  const line = (over: Record<string, unknown>): string =>
    JSON.stringify({
      schemaVersion: 1, runId: "run_1000_x", tenantId: null, target: "https://a.test/x",
      profileId: "oslo-desktop", journeyId: "sweep", verdict: "PASS",
      startedAt: "2026-08-13T10:00:00.000Z", durationMs: 1, seed: 1, engine: "playwright", evidenceId: null,
      findings: { total: 0, bySeverity: {}, byCategory: {}, labels: [] },
      confidence: { overall: 100, geo: 100, browser: 100, journey: 100, evidence: 100 },
      geo: { requestedCountry: "NO", requestedCity: "Oslo", observedCountry: "NO", observedCity: "Oslo", country: "match", city: "match", egressHeld: "match", agreement: "unverified" },
      latencyMs: null, vitals: { lcp: null, cls: null, ttfb: null, inp: null },
      ...over,
    });

  const withIndex = (text: string): CommandDeps => {
    const store: Record<string, string> = { [path.join(evidenceRoot, "runs.jsonl")]: text };
    return deps({
      historyFs: {
        exists: (p) => p in store,
        read: (p) => store[p] as string,
        append: () => {},
        write: () => {},
        mkdir: () => {},
        listDirs: () => [],
      },
    });
  };

  it("compares markets from the run index and reports the latency gap", () => {
    const result = siteAnalyse(
      withIndex(
        `${line({ profileId: "oslo-desktop", vitals: { lcp: null, cls: null, ttfb: 148, inp: null } })}\n` +
          `${line({ profileId: "bodo-desktop", vitals: { lcp: null, cls: null, ttfb: 1923, inp: null } })}\n`,
      ),
    );
    expect(result.report.markets).toEqual(["bodo", "oslo"]);
    expect(result.report.widestLatencyGaps[0]?.ttfbSpreadMs).toBe(1775);
    const rendered = renderSiteAnalysis(result);
    expect(rendered).toContain("a crawler from one datacentre sees none of this");
    expect(rendered).toContain("13x");
  });

  it("WARNS when there is only one market, because the cross-market half is the point", () => {
    const result = siteAnalyse(withIndex(`${line({})}\n`));
    expect(result.warnings.join(" ")).toContain("nothing to compare ACROSS markets");
  });

  it("surfaces a geographic divergence in the rendering", () => {
    const result = siteAnalyse(
      withIndex(`${line({ profileId: "oslo-desktop" })}\n${line({ profileId: "bodo-desktop", verdict: "FAIL" })}\n`),
    );
    const rendered = renderSiteAnalysis(result);
    expect(rendered).toContain("GEOGRAPHY CHANGED THE OUTCOME");
    expect(rendered).toContain("bodo=FAIL");
  });

  it("reports a coverage gap, because an unmeasured market is not a working market", () => {
    const result = siteAnalyse(
      withIndex(`${line({ profileId: "oslo-desktop", target: "https://a.test/x" })}\n${line({ profileId: "bodo-desktop", target: "https://a.test/y" })}\n`),
    );
    expect(renderSiteAnalysis(result)).toContain("NOT measured in every market");
  });

  it("points at the rebuild when index lines could not be parsed", () => {
    const result = siteAnalyse(withIndex(`${line({})}\n{"half\n`));
    expect(result.skipped).toBe(1);
    expect(result.warnings.join(" ")).toContain("runs rebuild");
  });

  it("renders an empty history without claiming anything", () => {
    const rendered = renderSiteAnalysis(siteAnalyse(withIndex("")));
    expect(rendered).toContain("0 page(s) across 0 market(s)");
    expect(rendered).not.toContain("GEOGRAPHY CHANGED");
  });
})

describe("dashboardBuild", () => {
  const line = (over: Record<string, unknown>): string =>
    JSON.stringify({
      schemaVersion: 1, runId: "run_1000_x", tenantId: null, target: "https://a.test/x",
      profileId: "oslo-desktop", journeyId: "sweep", verdict: "PASS",
      startedAt: "2026-08-13T10:00:00.000Z", durationMs: 1, seed: 1, engine: "playwright", evidenceId: "ev_1",
      findings: { total: 0, bySeverity: {}, byCategory: {}, labels: [] },
      confidence: { overall: 100, geo: 100, browser: 100, journey: 100, evidence: 100 },
      geo: { requestedCountry: "NO", requestedCity: "Oslo", observedCountry: "NO", observedCity: "Oslo", country: "match", city: "match", egressHeld: "match", agreement: "unverified" },
      latencyMs: null, vitals: { lcp: 400, cls: 0, ttfb: 100, inp: null },
      ...over,
    });

  const withIndex = (text: string): { deps: CommandDeps; store: Record<string, string> } => {
    const store: Record<string, string> = { [path.join(evidenceRoot, "runs.jsonl")]: text };
    return {
      store,
      deps: deps({
        now: () => Date.parse("2026-08-13T12:00:00.000Z"),
        historyFs: {
          exists: (p) => p in store,
          read: (p) => store[p] as string,
          append: () => {},
          write: (p, t) => { store[p] = t; },
          mkdir: () => {},
          listDirs: () => [],
        },
      }),
    };
  };

  it("writes one JSON file beside the evidence, so the UI needs no server", () => {
    const { deps: d, store } = withIndex(`${line({})}\n`);
    const result = dashboardBuild(d);
    expect(result.path).toBe(path.join(evidenceRoot, "dashboard.json"));
    // Actually written, and parseable.
    const written = JSON.parse(store[result.path] as string) as { summary: { total: number } };
    expect(written.summary.total).toBe(1);
  });

  it("stamps the view from the injected clock, so the output is reproducible", () => {
    const { deps: d } = withIndex(`${line({})}\n`);
    expect(dashboardBuild(d).view.generatedAt).toBe("2026-08-13T12:00:00.000Z");
  });

  it("COUNTS the values that must render as absences, so the honesty rule is visible", () => {
    // A dashboard is where a number gets believed. This line is the reminder that some of
    // what it shows is not a number at all.
    const { deps: d } = withIndex(`${line({})}\n`);
    const rendered = renderDashboardBuild(dashboardBuild(d));
    expect(rendered).toContain('value(s) marked "not measured"');
    expect(rendered).toContain("MUST render distinctly from zero");
  });

  it("reports mean confidence as an absence for an empty history", () => {
    const { deps: d } = withIndex("");
    expect(renderDashboardBuild(dashboardBuild(d))).toContain("mean confidence not measured");
  });

  it("points at the rebuild when index lines could not be parsed", () => {
    const { deps: d } = withIndex(`${line({})}\n{"half\n`);
    expect(dashboardBuild(d).view.warnings.join(" ")).toContain("runs rebuild");
  });
})

describe("contentAnalyse", () => {
  const write = (dir: string, files: Record<string, unknown>): void => {
    mkdirSync(path.join(evidenceRoot, dir), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(path.join(evidenceRoot, dir, name), JSON.stringify(body));
    }
  };
  const content = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    wordCount: 800, shingles: ["a b c d e"], headings: ["H"], h1Count: 1, internalLinks: [], title: "T", ...over,
  });

  it("reads content.json back from the evidence and analyses it", () => {
    write("run_1000_a", { "run.json": { target: "https://a.test/" }, "content.json": content({ internalLinks: ["/x"] }) });
    write("run_2000_b", { "run.json": { target: "https://a.test/x" }, "content.json": content({ wordCount: 20 }) });
    const result = contentAnalyse(deps());
    expect(result.pages).toBe(2);
    expect(result.findings.thin).toEqual([{ target: "https://a.test/x", wordCount: 20 }]);
  });

  it("keeps the NEWEST run per target, so a repeated sweep describes the site as it is now", () => {
    // Averaging a page against its own history would report a problem that was fixed.
    write("run_1000_a", { "run.json": { target: "https://a.test/p" }, "content.json": content({ wordCount: 20 }) });
    write("run_2000_a", { "run.json": { target: "https://a.test/p" }, "content.json": content({ wordCount: 900 }) });
    const result = contentAnalyse(deps());
    expect(result.pages).toBe(1);
    expect(result.findings.thin).toEqual([]);
  });

  it("SKIPS a run with no content.json and counts it, rather than failing", () => {
    // The artifact is a bonus, and a sweep from before it existed should still analyse.
    write("run_1000_a", { "run.json": { target: "https://a.test/" }, "content.json": content() });
    write("run_2000_b", { "run.json": { target: "https://a.test/x" } });
    const result = contentAnalyse(deps());
    expect(result.pages).toBe(1);
    expect(result.runsWithoutContent).toBe(1);
  });

  it("counts a run whose content PARSES but describes nothing", () => {
    // Valid JSON with no word count is not a content record, and treating it as one would put a
    // page with an invented length into a thin-page report.
    write("run_4000_d", { "run.json": { target: "https://a.test/z" }, "content.json": { headings: [] } });
    // And a run.json with no target: there is nothing to attribute the content to.
    write("run_5000_e", { "run.json": {}, "content.json": content() });
    const result = contentAnalyse(deps());
    expect(result.pages).toBe(0);
    expect(result.runsWithoutContent).toBe(2);
  });

  it("counts an unreadable run rather than throwing", () => {
    mkdirSync(path.join(evidenceRoot, "run_3000_c"), { recursive: true });
    writeFileSync(path.join(evidenceRoot, "run_3000_c", "content.json"), "{ not json");
    writeFileSync(path.join(evidenceRoot, "run_3000_c", "run.json"), "{}");
    expect(contentAnalyse(deps()).runsWithoutContent).toBe(1);
  });

  it("survives an evidence root that does not exist yet", () => {
    const result = contentAnalyse(deps({ evidenceRoot: path.join(evidenceRoot, "never-written") }));
    expect(result.pages).toBe(0);
  });

  it("renders each finding, and says plainly when nothing was captured", () => {
    write("run_1000_a", { "run.json": { target: "https://a.test/" }, "content.json": content({ internalLinks: ["/x"] }) });
    write("run_2000_b", { "run.json": { target: "https://a.test/x" }, "content.json": content({ wordCount: 20, h1Count: 0 }) });
    write("run_3000_c", { "run.json": { target: "https://a.test/y" }, "content.json": content() });
    const rendered = renderContentAnalysis(contentAnalyse(deps()));
    expect(rendered).toContain("under 200 words");
    expect(rendered).toContain("a list to look at, not a verdict");
    expect(rendered).toContain("without exactly one h1");
    expect(rendered).toContain("near-duplicate pair(s)");
    // The orphan claim always states its scope.
    expect(rendered).toContain("nothing else in this sweep links to");

    const empty = renderContentAnalysis(contentAnalyse(deps({ evidenceRoot: path.join(evidenceRoot, "nope") })));
    expect(empty).toContain("no page content was captured");
  });
})
