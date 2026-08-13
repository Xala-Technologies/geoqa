/**
 * The commands. Each returns a JSON-able result; `index.ts` only parses
 * arguments, calls one, and prints.
 *
 * Every dependency that touches the world — the clock, the filesystem root,
 * the browser factory, the network provider — arrives through `CommandDeps`.
 * That is what lets these be covered without launching Chrome, while keeping
 * `index.ts` thin enough to be honestly coverage-excluded.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseUrlList } from "./args.js";
import { AgentBrowserRuntime, type RuntimeOptions } from "../browser/agent-browser.js";
import type { BrowserRuntime, BrowserSessionConfig } from "../browser/types.js";
import { DEFAULT_EVIDENCE_DIRNAME, DEFAULT_PROVIDER, type GeoQaConfig } from "../config/schema.js";
import type { RetentionTier } from "../evidence/manifest.js";
import {
  DEFAULT_POLICY,
  describePrunePlan,
  executePrune,
  formatBytes,
  nodePruneFs,
  planPrune,
  type PruneExecution,
  type PruneFs,
  type PrunePlan,
  type RetentionPolicy,
} from "../evidence/prune.js";
import { readManifest } from "../evidence/store.js";
import { findExperiment } from "../experiments/definitions.js";
import {
  appendSample,
  ensureExperimentDir,
  evaluateMetric,
  experimentPaths,
  meanOf,
  rate,
  renderSummary,
  runSamples,
  summarize,
  writeSummary,
  type ExperimentSample,
  type ExperimentSummary,
  type MetricResult,
} from "../experiments/harness.js";
import { observeBrowser, observeNetwork, observeNetworkVia, DEFAULT_VERIFY_ENDPOINT, GEOJS_SOURCE } from "../geo/observe.js";
import { loadGeoProfile, toSessionConfig, type ParseResult } from "../geo/profile.js";
import type { GeoProfile } from "../geo/types.js";
import { verifyGeo, withCorroboration } from "../geo/verify.js";
import { loadJourney } from "../journeys/spec.js";
import { seedFrom } from "../journeys/random.js";
import { redactProxyUrl, selectProvider, type TcpProbe } from "../network/provider.js";
import { buildRuntime, newRunId, type RunEngine, type RunSpec } from "../run/context.js";
import { executeRun, prepareRun } from "../run/execute.js";
import {
  expandMatrix,
  runMatrix,
  type MatrixResult,
  type MatrixScenario,
  type MatrixScenarioResult,
} from "../run/matrix.js";
import { applyDeviceProfile } from "../run/stages.js";
import type { GeoQaRunResult } from "../findings/types.js";
import { describeConfidence } from "../confidence/score.js";

/** The profile a command falls back to when nothing names one. */
/**
 * Desktop first, and Oslo because it is the home market.
 *
 * Two reasons, in order. The first live finding this engine produced was CLS 0.76
 * on DESKTOP while mobile passed — so desktop is where the known defect lives, and
 * a default that skips it wastes the cheapest run anyone will make.
 *
 * The second is that a desktop profile carries no device descriptor, so Chromium's
 * `isMobile` is off and `window.innerWidth` equals the configured viewport
 * regardless of the page's markup. Under emulation the rendered viewport becomes a
 * property of the page (980 without a viewport meta tag, 390 with it), and the
 * viewport axis is read on the identity-probe page — so a mobile default makes the
 * engine's most safety-critical axis depend on markup it does not control.
 */
export const DEFAULT_PROFILE_ID = "oslo-desktop";

/** The engine Phase 0 shipped, and still the default everywhere. */
export const DEFAULT_ENGINE: RunEngine = "agent-browser";

/**
 * What a runtime factory needs BEYOND a `BrowserSessionConfig` to build either
 * engine (gap D-1b).
 *
 * `BrowserSessionConfig` structurally cannot carry it: that type is the
 * agent-browser launch identity — session, proxy, user agent, init scripts, env
 * — and geography reaches that engine as a `TZ` variable plus an injected
 * script. Playwright takes locale, timezone, coordinates and viewport as CONTEXT
 * options, so a factory that is handed only the session config can build exactly
 * one of the two engines. It therefore gets the profile.
 *
 * A separate, optional SECOND argument rather than a widened first one, for two
 * reasons. The seven experiment samplers pass a session config and measure
 * agent-browser specifically, so they keep compiling and keep meaning what they
 * meant. And the agent-browser branch is then provably unaffected by this
 * change: it never reads the request at all.
 */
export interface RuntimeRequest {
  engine: RunEngine;
  /**
   * The identity the browser must present. Required rather than optional
   * because there is no honest default: a Playwright context with no locale or
   * timezone renders this machine's geography while the command claims to be
   * verifying a market's.
   */
  profile: GeoProfile;
}

export interface CommandDeps {
  repoRoot: string;
  evidenceRoot: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  log: (line: string) => void;
  /**
   * Injectable so tests never launch a browser — the entire suite depends on
   * substituting a fake here, so the second parameter is optional and the first
   * is unchanged.
   */
  makeRuntime: (config: BrowserSessionConfig, request?: RuntimeRequest) => BrowserRuntime;
  /** Injectable so tests never execute a full run. */
  runOnce: typeof executeRun;
  /**
   * Injectable so tests never open a socket. A provider's `health()` is a REAL
   * probe by design — that is the whole point of not calling it `available()` —
   * which means the only way to test the commands around it is to hand them a
   * probe.
   */
  probe?: TcpProbe;
  /**
   * Injectable so `evidence prune` is covered against a fixture tree and can
   * never be pointed at the repo's real `evidence/`. Same reason `probe` exists.
   */
  pruneFs?: PruneFs;
  /**
   * Command caps for the agent-browser engine, from `geoqa.config.json`.
   *
   * Typed as the config's own field so the two cannot drift. Absent keys mean
   * "let `browser/exec.ts` apply its own default" — the numbers are private to
   * that file and writing them out here would be a second source of truth for a
   * value nobody would notice going stale.
   */
  browserTimeouts?: GeoQaConfig["browser"];
}

/**
 * Config timeouts as agent-browser runtime options.
 *
 * Spread conditionally because `exactOptionalPropertyTypes` will not pass
 * `undefined` through — which is the point: `exec.ts` reads a `timeoutMs` of 0
 * as "no cap", so an "unset" that arrived as a number would produce a run that
 * does not fail but hangs, and a hung run reports nothing at all.
 */
export function runtimeOptions(timeouts: GeoQaConfig["browser"] = {}): RuntimeOptions {
  return {
    ...(timeouts.commandTimeoutMs !== undefined ? { timeoutMs: timeouts.commandTimeoutMs } : {}),
    ...(timeouts.idleTimeoutMs !== undefined ? { idleMs: timeouts.idleTimeoutMs } : {}),
  };
}

/**
 * Where a verification session's own artifacts land.
 *
 * A Playwright context always records a HAR into `<evidenceRoot>/<runId>/`, and
 * a verify session is not a run: left at the top level, every `browser verify`
 * would leave a manifest-less directory that `evidence prune` can only report as
 * "we cannot tell what this was" and refuse to delete. One nested directory
 * keeps that to a single entry instead of one per invocation.
 */
export const VERIFY_SESSION_DIR = "verify-sessions";

/**
 * A verification runtime expressed as a `RunSpec`.
 *
 * `buildRuntime` is the only sanctioned way to reach an engine from here:
 * `cli/` may not import `playwright-launch.ts` (dependency-cruiser's
 * `engine-internals-are-private`), and a second copy of the profile-to-context
 * mapping is precisely how a session starts claiming Oslo while rendering
 * Frankfurt. `buildRuntime` speaks `RunSpec`, so a verification session is
 * described as one.
 *
 * `buildRuntime` reads engine, runId, proxy, headed, initScriptPath and
 * evidenceRoot, and nothing else. The remaining fields are inert here and are
 * spelled out rather than left for a reader to discover: a verify session has no
 * journey, navigates on its caller's instruction, and has no seeded pacing.
 */
export function verificationSpec(
  config: BrowserSessionConfig,
  request: RuntimeRequest,
  evidenceRoot: string,
): RunSpec {
  return {
    runId: config.sessionId,
    engine: request.engine,
    evidenceRoot,
    // Derived from the session config rather than passed twice: two channels for
    // the same proxy is how one of them ends up stale.
    proxyUrl: config.proxy ?? null,
    proxyBypass: config.proxyBypass ?? null,
    initScriptPath: config.initScripts?.[0] ?? null,
    headed: config.headed ?? false,
    // Inert: read by no branch of buildRuntime.
    corroborateGeo: false,
    profilePath: "",
    journeyPath: "",
    target: "",
    vars: {},
    seed: 0,
    verifyEndpoint: "",
  };
}

export function defaultDeps(repoRoot: string, overrides: Partial<CommandDeps> = {}): CommandDeps {
  // Resolved before `makeRuntime` closes over it, so a caller's `--evidence-root`
  // also moves where a Playwright verify session writes its HAR.
  const evidenceRoot = overrides.evidenceRoot ?? path.join(repoRoot, DEFAULT_EVIDENCE_DIRNAME);
  return {
    repoRoot,
    evidenceRoot,
    env: process.env,
    now: Date.now,
    log: (line) => console.error(line),
    makeRuntime: (config, request) =>
      request?.engine === "playwright"
        ? buildRuntime(verificationSpec(config, request, path.join(evidenceRoot, VERIFY_SESSION_DIR)), request.profile)
        : new AgentBrowserRuntime(config, runtimeOptions(overrides.browserTimeouts)),
    runOnce: executeRun,
    ...overrides,
  };
}

/**
 * Where evidence is written, with the precedence the whole CLI uses:
 * **flag > config file > built-in default.**
 *
 * The config's value arrives already defaulted by the loader, so the only
 * judgement left here is the relative one: a relative root is resolved against
 * the repo root, never against the process's working directory, because
 * `geoqa` run from a subdirectory would otherwise write its evidence somewhere
 * nobody later looks for it.
 */
export function resolveEvidenceRoot(repoRoot: string, configuredRoot: string, flagValue?: string): string {
  if (flagValue !== undefined && flagValue !== "") return path.resolve(flagValue);
  return path.isAbsolute(configuredRoot) ? configuredRoot : path.resolve(repoRoot, configuredRoot);
}

export const profilesDir = (deps: CommandDeps): string => path.join(deps.repoRoot, "profiles");
export const journeysDir = (deps: CommandDeps): string => path.join(deps.repoRoot, "journeys");

const yamlFiles = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();

export function profilePath(deps: CommandDeps, id: string): string {
  return path.join(profilesDir(deps), id.endsWith(".yaml") ? id : `${id}.yaml`);
}

export function journeyPath(deps: CommandDeps, id: string): string {
  return path.join(journeysDir(deps), id.endsWith(".yaml") ? id : `${id}.yaml`);
}

export function loadProfileOrThrow(deps: CommandDeps, id: string): GeoProfile {
  const loaded = loadGeoProfile(profilePath(deps, id));
  if (!loaded.ok) throw new Error(`profile "${id}": ${loaded.errors.join("; ")}`);
  return loaded.value;
}

// ── list ─────────────────────────────────────────────────────────────────

export function profileList(deps: CommandDeps): {
  profiles: { id: string; label: string; country: string; city: string; device: string; visitorType: string }[];
} {
  const profiles = yamlFiles(profilesDir(deps)).map((file) => {
    const loaded = loadGeoProfile(path.join(profilesDir(deps), file));
    if (!loaded.ok) {
      // An unreadable profile is listed rather than skipped — a profile that
      // vanished from a listing is how a market silently stops being covered — and
      // its visitorType is "?" rather than a guess, because a default here would
      // make it selectable by place.
      return { id: file.replace(/\.yaml$/, ""), label: `INVALID: ${loaded.errors[0]}`, country: "?", city: "?", device: "?", visitorType: "?" };
    }
    const p = loaded.value;
    return { id: p.id, label: p.label, country: p.market.country, city: p.market.city, device: p.device.id, visitorType: p.visitorType };
  });
  return { profiles };
}

/** The device a place-based selection assumes. Same reasoning as `DEFAULT_PROFILE_ID`. */
export const DEFAULT_DEVICE = "desktop";

export interface PlaceSelection {
  /** A profile id, the direct way. */
  geo?: string;
  country?: string;
  city?: string;
  device?: string;
  /**
   * Which kind of visitor the place should resolve to. Defaults to `anonymous`.
   *
   * A first-time visitor is the neutral subject: it carries nothing in, keeps
   * nothing out, and is what a place name means when nobody says otherwise. Without
   * this the moment a second profile existed for one place — the returning-visitor
   * one — every `--country NO --city Oslo` became ambiguous and refused, which is
   * the refusal working correctly and the feature becoming useless.
   */
  visitor?: GeoProfile["visitorType"];
}

/**
 * A profile id from `--country` / `--city`, or from `--geo` directly.
 *
 * The place form exists because a profile id is an implementation detail of this
 * repo's `profiles/` directory, and the question anybody actually has is "what
 * does a visitor in Oslo see". It RESOLVES rather than constructs: `oslo-desktop`
 * is looked up among the profiles that exist, so `--city Osló` refuses instead of
 * building a path to a file that is not there and failing per scenario.
 *
 * Giving both forms is refused rather than ranked. A `--geo bergen-desktop
 * --city Oslo` has two answers and no correct one, and picking either silently
 * means a run reporting a city it was not asked about — the single worst failure
 * this engine can have.
 */
export function resolveProfileId(
  deps: CommandDeps,
  selection: PlaceSelection,
): { ok: true; id: string } | { ok: false; errors: string[] } {
  const place = selection.country !== undefined || selection.city !== undefined;
  if (selection.geo !== undefined && place) {
    return {
      ok: false,
      errors: [`--geo ${selection.geo} and --country/--city both name an identity — give one`],
    };
  }
  if (!place) return { ok: true, id: selection.geo ?? DEFAULT_PROFILE_ID };

  const device = selection.device ?? DEFAULT_DEVICE;
  const visitor = selection.visitor ?? "anonymous";
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const matches = profileList(deps).profiles.filter(
    (p) =>
      p.device === device &&
      p.visitorType === visitor &&
      (selection.country === undefined || same(p.country, selection.country)) &&
      (selection.city === undefined || same(p.city, selection.city)),
  );
  const asked = [selection.country, selection.city].filter((v) => v !== undefined).join("/");
  if (matches.length === 0) {
    // The available places, because "no profile for NO/Ålesund" without them
    // sends someone to read the directory, and the answer is a flag away.
    const places = [
      ...new Set(
        profileList(deps)
          .profiles.filter((p) => p.device === device && p.visitorType === visitor)
          .map((p) => `${p.country}/${p.city}`),
      ),
    ];
    return { ok: false, errors: [`no ${visitor} ${device} profile for ${asked} — available: ${places.sort().join(", ")}`] };
  }
  // Ambiguity refuses too: two profiles for one place would be a run whose
  // identity depends on directory order.
  if (matches.length > 1) {
    return { ok: false, errors: [`${asked} on ${device} as a ${visitor} visitor matches ${matches.length} profiles (${matches.map((p) => p.id).join(", ")}) — name one with --geo`] };
  }
  return { ok: true, id: (matches[0] as { id: string }).id };
}

export function journeyList(deps: CommandDeps): { journeys: { id: string; title: string; steps: number }[] } {
  const journeys = yamlFiles(journeysDir(deps)).map((file) => {
    const loaded = loadJourney(path.join(journeysDir(deps), file));
    if (!loaded.ok) return { id: file.replace(/\.yaml$/, ""), title: `INVALID: ${loaded.errors[0]}`, steps: 0 };
    return { id: loaded.value.id, title: loaded.value.title, steps: loaded.value.steps.length };
  });
  return { journeys };
}

// ── browser verify (EXP-000) ─────────────────────────────────────────────

export interface PrimitiveResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface BrowserVerifyResult {
  primitives: PrimitiveResult[];
  passed: number;
  total: number;
  launchHash: string | null;
  /** Which adapter was actually proven. The whole point of honouring --engine. */
  engine: RunEngine;
}

export interface BrowserVerifyOptions {
  /** Which adapter to prove. Defaults to the engine Phase 0 shipped. */
  engine?: RunEngine;
  /**
   * The identity a Playwright context is built from. Loaded on both engines so a
   * bad `--geo` is refused here rather than on the one engine that reads it.
   */
  profileId?: string;
}

/**
 * Prove each primitive by USING it against a real page, not by checking that
 * the CLI advertises it. `--help` listing a command says nothing about whether
 * it answers.
 *
 * The agent-browser session config is deliberately unchanged by `--geo`: on that
 * engine geography is a `TZ` variable and an injected script written by the run
 * path, and quietly altering the launch identity of the command that PROVES the
 * primitives would change what EXP-000 measured. The profile reaches the
 * Playwright branch only, which cannot build a context without one.
 */
export async function browserVerify(
  deps: CommandDeps,
  url = "https://example.com",
  options: BrowserVerifyOptions = {},
): Promise<BrowserVerifyResult> {
  const engine = options.engine ?? DEFAULT_ENGINE;
  const profile = loadProfileOrThrow(deps, options.profileId ?? DEFAULT_PROFILE_ID);
  const runtime = deps.makeRuntime({ sessionId: `verify-${deps.now()}`, namespace: "verify" }, { engine, profile });
  const primitives: PrimitiveResult[] = [];
  let launchHash: string | null = null;

  const record = async (name: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<void> => {
    try {
      const { ok, detail } = await fn();
      primitives.push({ name, ok, detail });
    } catch (e) {
      primitives.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  };

  try {
    await record("open", async () => {
      const out = await runtime.open(url);
      if (out.ok) launchHash = out.data.launchHash;
      return { ok: out.ok, detail: out.ok ? `${out.data.title} @ ${out.data.url}` : out.failure.detail };
    });
    await record("get-title", async () => {
      const out = await runtime.getTitle();
      return { ok: out.ok && out.data.length > 0, detail: out.ok ? out.data : out.failure.detail };
    });
    await record("snapshot", async () => {
      const out = await runtime.snapshot({ interactiveOnly: true });
      return { ok: out.ok && out.data.length > 0, detail: out.ok ? `${out.data.split("\n").length} nodes` : out.failure.detail };
    });
    await record("evaluate", async () => {
      const out = await runtime.evaluate<unknown>("JSON.stringify({ok:1})");
      return { ok: out.ok, detail: out.ok ? JSON.stringify(out.data) : out.failure.detail };
    });
    await record("console", async () => {
      const out = await runtime.console();
      return { ok: out.ok, detail: out.ok ? `${out.data.length} messages` : out.failure.detail };
    });
    await record("errors", async () => {
      const out = await runtime.errors();
      return { ok: out.ok, detail: out.ok ? `${out.data.length} errors` : out.failure.detail };
    });
    await record("network-requests", async () => {
      const out = await runtime.networkRequests();
      return { ok: out.ok, detail: out.ok ? `${out.data.length} requests` : out.failure.detail };
    });
    await record("vitals", async () => {
      const out = await runtime.vitals();
      return { ok: out.ok, detail: out.ok ? `lcp=${out.data.lcp ?? "?"} ttfb=${out.data.ttfb ?? "?"}` : out.failure.detail };
    });
    await record("a11y", async () => {
      const out = await runtime.a11y();
      return { ok: out.ok, detail: out.ok ? `${out.data.length} violations` : out.failure.detail };
    });
    await record("screenshot", async () => {
      const out = await runtime.screenshot(path.join(deps.evidenceRoot, "verify.png"));
      return { ok: out.ok, detail: out.ok ? "captured" : out.failure.detail };
    });
  } finally {
    await runtime.close();
  }

  return { primitives, passed: primitives.filter((p) => p.ok).length, total: primitives.length, launchHash, engine };
}

// ── proxy / geo verify ───────────────────────────────────────────────────

export interface GeoVerifyResult {
  profileId: string;
  provider: string;
  proxy: string | null;
  /** Which adapter took the readings — the two reach geography differently. */
  engine: RunEngine;
  verification: ReturnType<typeof verifyGeo>;
  warnings: string[];
}

export interface GeoVerifyOptions {
  profileId: string;
  providerName?: string;
  verifyEndpoint?: string;
  engine?: RunEngine;
  /**
   * Read a SECOND, independent IP-geo database and report whether the two agree.
   *
   * Default ON for this command, because "where is this session" is the entire
   * question it answers, it runs once, and one extra page load is nothing against
   * a wrong answer. `journey run` and `matrix run` default it OFF for the opposite
   * reason: they are where volume lives, a 430-page sweep would be 430 extra
   * probes against a free endpoint's monthly allowance, and an engine that
   * exhausts its own corroborating source starts reporting `unverified` for every
   * run — the failure Decodo's 407 already taught once.
   */
  corroborate?: boolean;
}

export async function proxyVerify(deps: CommandDeps, options: GeoVerifyOptions): Promise<GeoVerifyResult> {
  const profile = loadProfileOrThrow(deps, options.profileId);
  const engine = options.engine ?? DEFAULT_ENGINE;
  const { provider, warning } = selectProvider(options.providerName ?? DEFAULT_PROVIDER, {
    env: deps.env,
    ...(deps.probe ? { probe: deps.probe } : {}),
  });
  const warnings = warning ? [warning] : [];

  const health = await provider.health(deps.now());
  if (health.state === "unusable") throw new Error(`provider "${provider.name}" is unusable: ${health.detail}`);

  const session = await provider.createSession(profile.market, deps.now());
  if (!session.ok) throw new Error(`could not open a network session: ${session.reason}`);
  if (session.session.proxyUrl === null && provider.name === "direct") {
    warnings.push(`egress is DIRECT — not ${profile.market.city}. Geographic claims are unproven.`);
  }

  const runtime = deps.makeRuntime(
    toSessionConfig(profile, {
      sessionId: `geoverify-${deps.now()}`,
      proxyUrl: session.session.proxyUrl,
      proxyBypass: session.session.proxyBypass,
      baseEnv: deps.env,
    }),
    { engine, profile },
  );

  try {
    // Apply the profile before observing it. Without this the viewport axis
    // reports whatever the browser defaulted to, which is a reading about
    // agent-browser rather than about the profile.
    warnings.push(...(await applyDeviceProfile(runtime, profile)));
    const network = await observeNetwork(runtime, options.verifyEndpoint ?? DEFAULT_VERIFY_ENDPOINT);
    const browser = await observeBrowser(runtime);
    const verified = verifyGeo(profile, network, browser);
    // The corroborating read comes AFTER the browser observation, not between the
    // two network reads: a second navigation resets nothing here, but it does add
    // wall clock, and the browser axes should be read as close to the primary
    // identity as the sequence allows.
    const verification =
      options.corroborate === false ? verified : withCorroboration(verified, await observeNetworkVia(runtime, GEOJS_SOURCE));
    return {
      profileId: profile.id,
      provider: provider.name,
      proxy: redactProxyUrl(session.session.proxyUrl),
      engine,
      verification,
      warnings,
    };
  } finally {
    await runtime.close();
  }
}

// ── journey run ──────────────────────────────────────────────────────────

export interface JourneyRunOptions {
  url: string;
  profileId: string;
  /** Read a second IP-geo database and report whether the two agree. */
  corroborate?: boolean;
  journeyId: string;
  providerName?: string;
  vars?: Record<string, string>;
  headed?: boolean;
  /** Which browser drives the run. Defaults to the engine Phase 0 shipped. */
  engine?: RunEngine;
  /** Seeds pacing and optional steps. Defaults to a hash of the run id. */
  seed?: number;
  /**
   * How many times to run the journey in this one session. Defaults to 1.
   *
   * The journey never retries, so this is the only way flakiness gets measured:
   * N attempts on purpose, the worst reading of each step reported, and each
   * finding carrying how many attempts it appeared in.
   */
  repeat?: number;
  /**
   * Where egress identity is read from, inside the page.
   *
   * Configurable so `geoqa.config.json` can point it at a self-hosted endpoint
   * or a fixture route; absent means the built-in default. It is on the spec
   * rather than read from a constant at the point of use because a Temporal
   * Activity rebuilds everything from serialisable arguments.
   */
  verifyEndpoint?: string;
}

export async function journeyRun(deps: CommandDeps, options: JourneyRunOptions): Promise<GeoQaRunResult & { warnings: string[] }> {
  const profile = loadProfileOrThrow(deps, options.profileId);
  const { provider, warning } = selectProvider(options.providerName ?? DEFAULT_PROVIDER, {
    env: deps.env,
    ...(deps.probe ? { probe: deps.probe } : {}),
  });
  const runId = newRunId(profile.id, deps.now());

  const prepared = await prepareRun(
    {
      runId,
      engine: options.engine ?? DEFAULT_ENGINE,
      // Default derived from the run id: each run paces differently, and any one
      // run replays exactly. `--seed` from a failing run's run.json repeats it.
      seed: options.seed ?? seedFrom(runId),
      corroborateGeo: options.corroborate === true,
      target: options.url,
      profilePath: profilePath(deps, options.profileId),
      journeyPath: journeyPath(deps, options.journeyId),
      evidenceRoot: deps.evidenceRoot,
      vars: options.vars ?? {},
      headed: options.headed ?? false,
      verifyEndpoint: options.verifyEndpoint ?? DEFAULT_VERIFY_ENDPOINT,
    },
    provider,
    deps.now(),
  );

  const warnings = warning ? [warning, ...prepared.warnings] : prepared.warnings;
  for (const w of warnings) deps.log(`warning: ${w}`);

  const result = await deps.runOnce({
    spec: prepared.spec,
    provider,
    log: deps.log,
    repeat: options.repeat ?? 1,
  });
  return { ...result, warnings };
}

// ── matrix run ───────────────────────────────────────────────────────────

/**
 * Devices covered when `--device` says nothing.
 *
 * Both, deliberately: a market covered on one device cannot catch a
 * device-specific defect, which is the class the first live run hit.
 */
export const DEFAULT_MATRIX_DEVICES = ["mobile", "desktop"];

/**
 * Read a `--urls-file` into the matrix's target axis.
 *
 * Unreadable is an ERROR, never an empty list: a missing or unreadable file
 * that degraded to "no targets" would run the matrix against the single `--url`
 * and report a clean pass over one page while the operator believed they had
 * swept a sitemap.
 */
export function loadUrlList(file: string): { ok: true; urls: string[] } | { ok: false; errors: string[] } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e: unknown) {
    return { ok: false, errors: [`--urls-file ${file}: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const parsed = parseUrlList(text);
  return parsed.ok ? parsed : { ok: false, errors: parsed.errors.map((line) => `--urls-file ${file}: ${line}`) };
}

export interface MatrixRunOptions {
  /**
   * The target when the matrix carries no URL axis, and the fallback for a
   * scenario whose own target is null.
   */
  url: string;
  markets: string[];
  journeys: string[];
  devices?: string[];
  /**
   * Pages to visit, one scenario each per market/device/journey. Empty or absent
   * keeps the single-`--url` shape.
   */
  targets?: string[];
  /**
   * Read a second IP-geo database per scenario and report whether the two agree.
   *
   * Off by default, and the default matters more here than anywhere else: this is
   * one extra probe PER SCENARIO, so a 430-page sweep is 430 of them against a
   * free endpoint's monthly allowance. An engine that exhausts its own
   * corroborating source reports `unverified` for every later run — the shape of
   * failure an exhausted proxy already produced once.
   */
  corroborate?: boolean;
  providerName?: string;
  engine?: RunEngine;
  vars?: Record<string, string>;
  headed?: boolean;
  /** Base seed for the whole matrix; each scenario derives its own from it. */
  seed?: number;
  repeat?: number;
  concurrency?: number;
  /** Expand and validate, launch nothing. */
  dryRun?: boolean;
  /** Required before a matrix containing a state-changing journey will run. */
  allowWrites?: boolean;
  verifyEndpoint?: string;
}

export interface MatrixRunResult {
  dryRun: boolean;
  /** The full expansion, available before anything launches. */
  scenarios: MatrixScenario[];
  /** Journeys in this matrix that CHANGE STATE, and how many runs that is. */
  writes: { journeys: string[]; runs: number };
  /** Recorded so the whole matrix replays from one number. */
  baseSeed: number;
  provider: string;
  engine: RunEngine;
  /**
   * Null on a dry run.
   *
   * Null rather than an empty result, because an empty result has counts of zero
   * and a verdict — and "nothing was executed" must not be readable as "nothing
   * failed".
   */
  result: MatrixResult | null;
  warnings: string[];
}

/**
 * One scenario's seed: the matrix's base plus a hash of the scenario's own key.
 *
 * Not `seedFrom(runId)` — a run id contains a timestamp, so scenarios would pace
 * differently on every invocation and a failing matrix could not be replayed.
 * Not the base seed alone either: every scenario would then make the identical
 * pacing and optional-step choices, which measures one pacing across 96
 * scenarios rather than 96 scenarios. Wrapped to 32 bits because that is the
 * generator's state width and an overflowing sum would not be stable.
 */
export function scenarioSeed(baseSeed: number, key: string): number {
  return (baseSeed + seedFrom(key)) >>> 0;
}

/**
 * The whole matrix.
 *
 * Everything the expansion needs is validated BEFORE a browser starts, and one
 * bad name refuses all of it. Discovering a mistyped market ninety launches in is
 * not a report, and a matrix that quietly skipped a market would be reported as a
 * matrix that passed.
 */
export async function matrixRun(deps: CommandDeps, options: MatrixRunOptions): Promise<MatrixRunResult> {
  const devices = options.devices?.length ? options.devices : DEFAULT_MATRIX_DEVICES;
  const engine = options.engine ?? DEFAULT_ENGINE;
  const errors: string[] = [];
  if (options.markets.length === 0) errors.push("matrix run needs at least one --market");
  if (options.journeys.length === 0) errors.push("matrix run needs at least one --journey");
  const targets = options.targets ?? [];
  // Checked here rather than left to `prepareRun`: an empty target reaches the
  // browser as a navigation to nothing, once per scenario, and the matrix reports
  // N unmeasured scenarios instead of one refused argument.
  if (targets.length === 0 && options.url === "") {
    errors.push("matrix run needs --url, or --urls-file to sweep a list of pages");
  }

  // Expanded through the same function the runner uses, so what is validated and
  // printed here is exactly what will be executed — including its dedupe and its
  // ordering.
  const axes = { markets: options.markets, devices, journeys: options.journeys, targets };
  const scenarios = expandMatrix(axes);

  for (const profileId of [...new Set(scenarios.map((s) => `${s.market}-${s.device}`))]) {
    const loaded = loadGeoProfile(profilePath(deps, profileId));
    if (!loaded.ok) errors.push(`profile "${profileId}": ${loaded.errors.join("; ")}`);
  }
  const writeJourneys: string[] = [];
  for (const journeyId of [...new Set(scenarios.map((s) => s.journey))]) {
    const loaded = loadJourney(journeyPath(deps, journeyId));
    if (!loaded.ok) errors.push(`journey "${journeyId}": ${loaded.errors.join("; ")}`);
    else if (loaded.value.writes) writeJourneys.push(journeyId);
  }
  // Every problem at once. Fixing one typo per run of a 96-scenario matrix is how
  // a tool stops being used.
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const writeRuns = scenarios.filter((s) => writeJourneys.includes(s.journey)).length;
  const { provider, warning } = selectProvider(options.providerName ?? DEFAULT_PROVIDER, {
    env: deps.env,
    ...(deps.probe ? { probe: deps.probe } : {}),
  });
  const warnings = warning ? [warning] : [];
  const baseSeed = options.seed ?? seedFrom(newRunId("matrix", deps.now()));

  const common = {
    dryRun: options.dryRun === true,
    scenarios,
    writes: { journeys: writeJourneys, runs: writeRuns },
    baseSeed,
    provider: provider.name,
    engine,
    warnings,
  };

  // The dry run answers the question you have BEFORE an overnight job — how many
  // scenarios, which keys, how many of them write — and it answers it for free.
  // It is therefore also the thing that must not demand --allow-writes.
  if (common.dryRun) return { ...common, result: null };

  if (writeRuns > 0 && options.allowWrites !== true) {
    throw new Error(
      `this matrix would run ${writeRuns} state-changing scenario(s): ${writeJourneys.join(", ")} declare writes:true, so it submits that many real forms, registrations or bookings against ${options.url}. Invariant 14 says a write is announced; at matrix scale an announcement is too late. Re-run with --allow-writes, or --dry-run to see the expansion.`,
    );
  }

  const result = await runMatrix({
    axes,
    plan: async (scenario) => {
      const profileId = `${scenario.market}-${scenario.device}`;
      // The journey is part of the run id, not just the profile: two journeys on
      // one profile prepared in the same millisecond would otherwise share an
      // evidence directory, and the second would overwrite the first's manifest
      // — a matrix losing runs while reporting a full count.
      // The scenario's index disambiguates a URL axis, and only a URL axis: two
      // pages share a profile, a journey and a millisecond under concurrency, and
      // a run id is `run_<ms>_<slug>`, so they would share an evidence directory
      // and the second would overwrite the first's manifest. The index rather
      // than the URL itself — a URL contains `/` and `:`, and the run id becomes a
      // directory name. Appended only when the axis is present, so a plain
      // market × device × journey matrix keeps the run ids it had.
      const slug = scenario.target === null ? `${profileId}-${scenario.journey}` : `${profileId}-${scenario.journey}-${scenario.index}`;
      const runId = newRunId(slug, deps.now());
      const prepared = await prepareRun(
        {
          runId,
          engine,
          seed: scenarioSeed(baseSeed, scenario.key),
          corroborateGeo: options.corroborate === true,
          // The scenario's own page when the matrix carries a URL axis. Without
          // this the axis expanded, every scenario got its own key and seed, and
          // all of them visited `--url` — a sweep reporting 430 clean pages
          // having loaded one of them 430 times.
          target: scenario.target ?? options.url,
          profilePath: profilePath(deps, profileId),
          journeyPath: journeyPath(deps, scenario.journey),
          evidenceRoot: deps.evidenceRoot,
          vars: options.vars ?? {},
          headed: options.headed ?? false,
          verifyEndpoint: options.verifyEndpoint ?? DEFAULT_VERIFY_ENDPOINT,
        },
        provider,
        deps.now(),
      );
      // Prefixed with the scenario, because under concurrency a bare warning
      // cannot be attributed to the market it is about.
      for (const w of prepared.warnings) deps.log(`warning: ${scenario.key}: ${w}`);
      return { spec: prepared.spec, provider, log: deps.log, repeat: options.repeat ?? 1 };
    },
    run: deps.runOnce,
    now: deps.now,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    onScenario: (outcome) =>
      deps.log(`matrix: ${outcome.scenario.key} → ${outcome.outcome}${outcome.error === null ? "" : ` (${outcome.error})`}`),
  });

  return { ...common, result };
}

/** One line per scenario a human has to act on. */
function renderScenario(outcome: MatrixScenarioResult): string {
  const detail = outcome.error ?? outcome.result?.runId ?? "no run id";
  return `  ${outcome.outcome.padEnd(11)} ${outcome.scenario.key.padEnd(40)} ${detail}`;
}

export function renderMatrixResult(matrix: MatrixRunResult): string {
  const lines: string[] = [];
  // Said out loud, because the difference between one page and 430 is the
  // difference between a smoke test and half a gigabyte of proxy traffic, and the
  // scenario count alone does not distinguish "43 markets" from "43 pages".
  const pages = new Set(matrix.scenarios.map((s) => s.target).filter((t) => t !== null)).size;
  const pagesNote = pages === 0 ? [] : [`  ${pages} page(s) from the URL axis`];
  // Tense matters here and is not cosmetic: after the fact the sentence is a
  // record of real forms submitted against a live product, and reading it as a
  // warning about something still to come would be the wrong action entirely.
  const writesNote =
    matrix.writes.runs === 0
      ? []
      : [
          matrix.result === null
            ? `  ! ${matrix.writes.runs} of these CHANGE STATE (journeys: ${matrix.writes.journeys.join(", ")}) — --allow-writes is required to run them`
            : `  ! ${matrix.writes.runs} of these CHANGED STATE on the target (journeys: ${matrix.writes.journeys.join(", ")})`,
        ];

  if (matrix.result === null) {
    lines.push(
      `matrix dry run — ${matrix.scenarios.length} scenario(s), nothing launched`,
      `  provider ${matrix.provider}, engine ${matrix.engine}, base seed ${matrix.baseSeed}`,
      ...pagesNote,
      ...matrix.scenarios.map((s) => `  ${s.key}`),
      ...writesNote,
    );
  } else {
    const c = matrix.result.counts;
    lines.push(
      `${matrix.result.verdict} — ${c.total} scenario(s): ${c.passed} passed, ${c.warned} warned, ${c.siteFailed} site-failed, ${c.unmeasured} unmeasured`,
      `  concurrency limit ${matrix.result.concurrency.limit}, peak in flight ${matrix.result.concurrency.peakInFlight}, ${matrix.result.durationMs}ms`,
      `  provider ${matrix.provider}, engine ${matrix.engine}, base seed ${matrix.baseSeed} (replays the whole matrix)`,
      ...pagesNote,
      // Only the scenarios a human acts on are listed; the passing ones are a
      // count, because 96 lines of "passed" is how the four that matter get
      // missed. --json carries every scenario either way.
      ...matrix.result.scenarios.filter((s) => s.outcome !== "passed").map(renderScenario),
      ...writesNote,
    );
  }
  for (const warning of matrix.warnings) lines.push(`  ! ${warning}`);
  return lines.join("\n");
}

// ── evidence inspect ─────────────────────────────────────────────────────

export function evidenceInspect(deps: CommandDeps, runId: string): { runId: string; manifest: ReturnType<typeof readManifest> } {
  const manifest = readManifest(path.join(deps.evidenceRoot, runId));
  if (!manifest) throw new Error(`no evidence manifest for run "${runId}" under ${deps.evidenceRoot}`);
  return { runId, manifest };
}

// ── evidence prune ───────────────────────────────────────────────────────

/**
 * The tiers a policy may name. Spelled out rather than derived from `RETENTION`'s
 * keys so a tier the CLI accepts is a compile-time fact, not a runtime one.
 */
const POLICY_TIERS = ["pass", "warning", "fail", "investigation"] as const satisfies readonly RetentionTier[];

const isPolicyTier = (value: string): value is RetentionTier =>
  (POLICY_TIERS as readonly string[]).includes(value);

/** The words that mean "this rule does not select anything". */
const NEVER_WORDS = ["null", "off", "never"];

/**
 * Days, or `null` for "age never selects this".
 *
 * A non-numeric value is REFUSED rather than read as the default: `--max-age
 * pass=sevendays` silently keeping the 7-day default is indistinguishable from
 * the flag working, and the person who typed it believes they changed the
 * policy. Negative is refused for the same reason it is meaningless — a ceiling
 * below zero selects everything, which is a delete-the-tree instruction nobody
 * would write on purpose.
 */
function parseDays(text: string, label: string): ParseResult<number | null> {
  if (NEVER_WORDS.includes(text.toLowerCase())) return { ok: true, value: null };
  const days = Number(text);
  if (!Number.isFinite(days) || days < 0) {
    return { ok: false, errors: [`${label}: expected a number of days or one of ${NEVER_WORDS.join("/")}, got "${text}"`] };
  }
  return { ok: true, value: days };
}

const BYTE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

/**
 * A byte cap, with an optional KB/MB/GB suffix.
 *
 * Suffixes are supported because a size cap typed in raw bytes is the one flag
 * here where an off-by-one-thousand is both easy and expensive: a cap three
 * orders of magnitude too small sweeps every regenerable run in the tree.
 */
function parseBytes(text: string, label: string): ParseResult<number> {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(text.trim());
  const unit = BYTE_UNITS[(match?.[2] ?? "b").toLowerCase()];
  if (!match || unit === undefined) {
    return { ok: false, errors: [`${label}: expected bytes, optionally suffixed B/KB/MB/GB, got "${text}"`] };
  }
  return { ok: true, value: Math.floor(Number(match[1]) * unit) };
}

/** The raw flag values `evidence prune` accepts, before any of them is trusted. */
export interface PrunePolicyFlags {
  /** `--max-age <tier>=<days|null>`, already split into pairs. */
  maxAge?: Record<string, string>;
  maxTotal?: string;
  privacyDays?: string;
  sweepTiers?: string[];
  deleteUnreadable?: boolean;
}

/**
 * Flags as a retention policy, or every reason it is not one.
 *
 * Parsing lives here rather than in `index.ts` because it is judgement, and
 * `index.ts` is coverage-excluded: an unknown tier silently ignored would mean
 * `--max-age pas=1` reporting a prune that used the defaults, which is the same
 * shape of lie as an unread config key.
 */
export function parsePrunePolicy(flags: PrunePolicyFlags = {}): ParseResult<RetentionPolicy> {
  const errors: string[] = [];
  const maxAgeDays = { ...DEFAULT_POLICY.maxAgeDays };

  for (const [tier, value] of Object.entries(flags.maxAge ?? {})) {
    if (!isPolicyTier(tier)) {
      errors.push(`--max-age ${tier}=...: unknown retention tier. Valid tiers: ${POLICY_TIERS.join(", ")}`);
      continue;
    }
    const days = parseDays(value, `--max-age ${tier}`);
    if (days.ok) maxAgeDays[tier] = days.value;
    else errors.push(...days.errors);
  }

  let privacyMaxAgeDays = DEFAULT_POLICY.privacyMaxAgeDays;
  if (flags.privacyDays !== undefined) {
    const days = parseDays(flags.privacyDays, "--privacy-days");
    if (days.ok) privacyMaxAgeDays = days.value;
    else errors.push(...days.errors);
  }

  let maxTotalBytes: number | undefined;
  if (flags.maxTotal !== undefined) {
    const bytes = parseBytes(flags.maxTotal, "--max-total");
    if (bytes.ok) maxTotalBytes = bytes.value;
    else errors.push(...bytes.errors);
  }

  let sizeSweepTiers = DEFAULT_POLICY.sizeSweepTiers;
  if (flags.sweepTiers !== undefined && flags.sweepTiers.length > 0) {
    const unknown = flags.sweepTiers.filter((tier) => !isPolicyTier(tier));
    if (unknown.length > 0) {
      errors.push(`--sweep-tiers: unknown tier(s) ${unknown.join(", ")}. Valid tiers: ${POLICY_TIERS.join(", ")}`);
    } else {
      sizeSweepTiers = flags.sweepTiers.filter(isPolicyTier);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      maxAgeDays,
      privacyMaxAgeDays,
      sizeSweepTiers,
      deleteUnreadable: flags.deleteUnreadable === true,
      ...(maxTotalBytes !== undefined ? { maxTotalBytes } : {}),
    },
  };
}

export interface EvidencePruneResult {
  plan: PrunePlan;
  execution: PruneExecution;
}

/**
 * Plan a prune, and carry it out only when explicitly told to.
 *
 * `apply` defaults to false and there is deliberately no `--dry-run` flag to
 * forget: the shape of the API is what makes the safe thing the default.
 */
export function evidencePrune(
  deps: CommandDeps,
  options: { policy?: RetentionPolicy; apply?: boolean } = {},
): EvidencePruneResult {
  const fs = deps.pruneFs ?? nodePruneFs();
  const plan = planPrune({
    root: deps.evidenceRoot,
    policy: options.policy ?? DEFAULT_POLICY,
    nowMs: deps.now(),
    fs,
  });
  return { plan, execution: executePrune(plan, fs, { apply: options.apply === true }) };
}

/**
 * The plan a human reads, then what actually happened.
 *
 * The plan's own description carries the sizes and the privacy notes; this adds
 * only the execution, and it says "nothing was deleted" out loud rather than
 * leaving a silent dry run to be mistaken for a completed one.
 */
export function renderPruneResult(result: EvidencePruneResult): string {
  const lines = describePrunePlan(result.plan);
  const { execution } = result;
  lines.push(
    execution.dryRun
      ? `  DRY RUN — nothing was deleted. Re-run with --apply to remove the ${result.plan.doomed.length} run(s) above.`
      : `  applied: deleted ${execution.deletedRunIds.length} run(s), reclaimed ${formatBytes(execution.reclaimedBytes)}`,
  );
  for (const failure of execution.failed) lines.push(`  FAILED ${failure.runId}: ${failure.error}`);
  return lines.join("\n");
}

// ── experiment run ───────────────────────────────────────────────────────

export interface ExperimentOptions {
  id: string;
  samples: number;
  profileId: string;
  url: string;
  providerName?: string;
  /**
   * Which browser adapter the samples are taken through.
   *
   * Absent means `DEFAULT_ENGINE`, which is what every experiment measured before
   * this field existed — so an experiment re-run without `--engine` still measures
   * what its recorded results measured. The field matters because it is the
   * difference between a feasibility number about the daemon engine and one about
   * Playwright, and EXP-001's own hypothesis is about the proxy rather than the
   * adapter: measuring it through an engine nobody uses answers a question nobody
   * asked.
   */
  engine?: RunEngine;
  /**
   * The egress-identity endpoint. Absent means `DEFAULT_VERIFY_ENDPOINT`.
   *
   * Here because the samplers reached for the constant directly, so a configured
   * `network.verifyEndpoint` did not reach an experiment at all — the exact shape of
   * defect B-1 closed for the config file, reappearing one layer down.
   */
  verifyEndpoint?: string;
}

export type Sampler = (deps: CommandDeps, options: ExperimentOptions, index: number) => Promise<Record<string, unknown>>;
export type Summariser = (samples: ExperimentSample[], options: ExperimentOptions) => { metrics: MetricResult[]; notes: string[] };

export interface ExperimentRunResult {
  summary: ExperimentSummary;
  rendered: string;
  paths: { results: string; summary: string };
}

/**
 * Run one experiment: take samples, write every one as it happens, then
 * summarise.
 *
 * Samples are appended to `results.jsonl` immediately rather than at the end,
 * so a run killed at sample 60 of 100 still leaves 60 real observations. An
 * experiment that only writes on success loses everything to the first crash —
 * and crashes are exactly what a feasibility experiment is trying to count.
 */
export async function experimentRun(
  deps: CommandDeps,
  options: ExperimentOptions,
  sampler: Sampler,
  summariser: Summariser,
): Promise<ExperimentRunResult> {
  const spec = findExperiment(options.id);
  if (!spec) throw new Error(`unknown experiment "${options.id}"`);

  const paths = experimentPaths(path.join(deps.repoRoot, "experiments"), spec.id);
  ensureExperimentDir(paths);
  const startedAt = new Date(deps.now()).toISOString();

  const samples = await runSamples((index) => sampler(deps, options, index), {
    samples: options.samples,
    now: deps.now,
    onSample: (sample) => {
      appendSample(paths, sample);
      deps.log(`  sample ${sample.index + 1}/${options.samples}: ${sample.ok ? "ok" : `failed — ${sample.error}`}`);
    },
  });

  const { metrics, notes } = summariser(samples, options);
  const summary = summarize(spec, samples, metrics, { startedAt, finishedAt: new Date(deps.now()).toISOString() }, notes);
  writeSummary(paths, summary);
  return { summary, rendered: renderSummary(summary), paths: { results: paths.results, summary: paths.summary } };
}

/** Shared helpers the per-experiment summarisers use. */
export const metricHelpers = { rate, meanOf, evaluateMetric };

/** One-line human summary of a run result. */
export function renderRunResult(result: GeoQaRunResult): string {
  const lines = [
    `${result.verdict} — ${result.target} via ${result.profileId}`,
    `  ${describeConfidence(result.confidence)}`,
  ];
  for (const note of result.confidence.notes) lines.push(`  · ${note}`);
  for (const finding of result.findings.slice(0, 10)) {
    lines.push(`  [${finding.severity}] ${finding.title} — expected ${finding.expected}, observed ${finding.observed}`);
  }
  if (result.findings.length > 10) lines.push(`  … and ${result.findings.length - 10} more`);
  if (result.evidenceId) lines.push(`  evidence: ${result.evidenceId}`);
  return lines.join("\n");
}

export type { RunSpec };
