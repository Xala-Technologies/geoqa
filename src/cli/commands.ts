/**
 * The commands. Each returns a JSON-able result; `index.ts` only parses
 * arguments, calls one, and prints.
 *
 * Every dependency that touches the world — the clock, the filesystem root,
 * the browser factory, the network provider — arrives through `CommandDeps`.
 * That is what lets these be covered without launching Chrome, while keeping
 * `index.ts` thin enough to be honestly coverage-excluded.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
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
import type { DurableMatrixResult } from "../temporal/client.js";
import type { GeoQaRunInput } from "../temporal/workflows.js";
import { buildRuntime, newRunId, type RunEngine, type RunSpec } from "../run/context.js";
import { containedPath, loadTenant, tenantEvidenceRoot, tenantOwnsTarget } from "../tenant/registry.js";
import {
  checkQuota,
  estimateTrafficMb,
  runsStartedToday,
  usageFor,
  type QuotaDecision,
} from "../tenant/quota.js";
import { decodoUsageProbe, type UsageProbe } from "../tenant/usage-probe.js";
import { serpApiProvider } from "../search/serpapi.js";
import type { SearchProvider } from "../search/types.js";
import { loadKeywordSeeds } from "../keywords/seeds.js";
import { opportunities, researchKeywords } from "../keywords/research.js";
import type { KeywordReport } from "../keywords/types.js";
import type { Market } from "../geo/types.js";
import { actionableFindings, gateFromRun, gateWithoutRun, type GateResult, type GateThresholds } from "../gate/publish.js";
import { analyseSite, describeLatencySpread, type SiteReport } from "../analysis/site.js";
import {
  analyseContent,
  parsePageContent,
  DUPLICATE_SIMILARITY,
  THIN_PAGE_WORDS,
  type ContentFindings,
  type ContentRecord,
} from "../analysis/content.js";
import { toDashboardView, type DashboardView } from "../report/view.js";
import {
  filterHistory,
  findRegressions,
  nodeHistoryFs,
  readHistory,
  rebuildHistory,
  summariseHistory,
  type HistoryFilter,
  type HistoryFs,
  type HistorySummary,
  type Regression,
} from "../history/store.js";
import { HISTORY_SCHEMA_VERSION, type RunRecord } from "../history/records.js";
import type { Tenant } from "../tenant/types.js";
import { executeRun, prepareRun } from "../run/execute.js";
import {
  countScenarios,
  expandMatrix,
  matrixVerdict,
  OUTCOME_BY_VERDICT,
  resolveConcurrency,
  runMatrix,
  type MatrixResult,
  type MatrixScenario,
  type MatrixScenarioResult,
} from "../run/matrix.js";
import { applyDeviceProfile } from "../run/stages.js";
import type { Finding, GeoQaRunResult } from "../findings/types.js";
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
  /**
   * The retention policy from `geoqa.config.json`, put onto every `RunSpec`.
   *
   * Typed as the config's own field so the two cannot drift, and carried here rather than read
   * inside a stage: a stage that read the file itself would give a local run and a durable one
   * different completeness numbers for the same spec. Absent means the built-in table.
   */
  retention?: GeoQaConfig["evidence"]["retention"];
  /**
   * Where provider cooldowns are persisted, and how long one lasts.
   *
   * Nothing in the CLI passed either, so the whole store was unreachable from the only place
   * that runs anything: `httpProxyProvider` skipped its cooldown read (`if (!cooldownPath)
   * return null`) and `noteProviderOutcome` returned immediately. A vendor that failed
   * mid-sweep was retried on every scenario, which is exactly the behaviour the store was
   * ported from agent-fleet to prevent — it earned its shape on a provider that ran out of
   * credit.
   *
   * Under the evidence root, beside `runs.jsonl`: both are derived state about this
   * installation, and `--tenant` replaces the evidence root, so a tenant with its own proxy
   * account gets its own cooldowns rather than inheriting another tenant's frozen vendor.
   */
  cooldownPath?: string;
  cooldownMs?: number;
  /**
   * Starts a durable sweep. Injected so the unit suite never opens a socket, for the same
   * reason `probe`, `pruneFs` and `usageProbe` are.
   *
   * The connector is already bound by whoever supplies this, so the CLI layer never names a
   * Temporal type it would then have to construct. Absent means `--durable` is REFUSED rather
   * than silently running in this process: a caller that asked for durability and got a local
   * run would be told nothing, because the output of the two is identical.
   */
  startDurable?: (runs: GeoQaRunInput[], options: { workflowId: string; address?: string; concurrency?: number }) => Promise<DurableMatrixResult>;
  /**
   * Injectable so the unit suite never reads the vendor's usage API. Same reason
   * `probe` and `pruneFs` exist: a quota check that could only be tested by spending
   * real traffic would not be tested.
   */
  usageProbe?: UsageProbe;
  /**
   * The tenant whose own profiles and journeys take precedence, when one is scoped.
   *
   * Just the id: the tenant's data directory is derived from it, so there is one place
   * that knows the layout. Absent means the shared set only, which is what
   * single-target use has always done.
   */
  tenantId?: string;
  /** Injectable so history tests never touch a real tree. Same reason `pruneFs` exists. */
  historyFs?: HistoryFs;
  /**
   * Injectable so the unit suite never calls a SERP API. Same reason `probe` and
   * `usageProbe` exist, with an extra edge: a search costs real money, so a test that
   * spent one would be a test nobody runs twice.
   */
  searchProvider?: SearchProvider;
}

/**
 * Config timeouts as agent-browser runtime options.
 *
 * Spread conditionally because `exactOptionalPropertyTypes` will not pass
 * `undefined` through — which is the point: `exec.ts` reads a `timeoutMs` of 0
 * as "no cap", so an "unset" that arrived as a number would produce a run that
 * does not fail but hangs, and a hung run reports nothing at all.
 */
/**
 * The config's agent-browser caps, shaped for a `RunSpec`.
 *
 * Spread rather than assigned, because `exactOptionalPropertyTypes` will not let `undefined`
 * through — which is what stops "unset" being carried on as "0", and `exec.ts` reads 0 as
 * "no cap". A run with no wall-clock cap does not fail, it hangs, and a hung run reports
 * nothing at all.
 */
export function browserCaps(deps: Pick<CommandDeps, "browserTimeouts">): { commandTimeoutMs?: number; idleTimeoutMs?: number } {
  const t = deps.browserTimeouts ?? {};
  return {
    ...(t.commandTimeoutMs !== undefined ? { commandTimeoutMs: t.commandTimeoutMs } : {}),
    ...(t.idleTimeoutMs !== undefined ? { idleTimeoutMs: t.idleTimeoutMs } : {}),
  };
}

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

export const tenantsDir = (deps: CommandDeps): string => path.join(deps.repoRoot, "tenants");

export function tenantPath(deps: CommandDeps, id: string): string {
  return path.join(tenantsDir(deps), id.endsWith(".yaml") ? id : `${id}.yaml`);
}

export function tenantList(deps: CommandDeps): { tenants: { id: string; name: string; markets: number; targets: number; trafficMb: number }[] } {
  const tenants = yamlFiles(tenantsDir(deps)).map((file) => {
    const loaded = loadTenant(path.join(tenantsDir(deps), file));
    if (!loaded.ok) return { id: file.replace(/\.yaml$/, ""), name: `INVALID: ${loaded.errors[0]}`, markets: 0, targets: 0, trafficMb: 0 };
    const t = loaded.value;
    return { id: t.id, name: t.name, markets: t.markets.length, targets: t.targets.length, trafficMb: t.quota.trafficMb };
  });
  return { tenants };
}

/**
 * Resolve `--tenant` into the tenant and the evidence root its runs must use.
 *
 * Two things happen here and neither is optional. The tenant is LOADED, so a
 * mistyped id refuses instead of creating a directory for a tenant that does not
 * exist — a run whose evidence lands under `evidence/digilst/` is lost, and lost
 * quietly. And the evidence root is REPLACED rather than appended to by a caller,
 * because every path below this point derives from it: a caller that forgot to nest
 * would write one tenant's run into the shared tree.
 *
 * No `--tenant` is not an error. Single-target use is still the common case and the
 * shared root is still correct for it — but then no tenant rule applies either, which
 * is why the tenant is returned as null rather than a default one.
 */
export function resolveTenant(
  deps: CommandDeps,
  tenantId: string | undefined,
): { ok: true; tenant: Tenant | null; evidenceRoot: string } | { ok: false; errors: string[] } {
  if (tenantId === undefined || tenantId === "") return { ok: true, tenant: null, evidenceRoot: deps.evidenceRoot };
  const loaded = loadTenant(tenantPath(deps, tenantId));
  if (!loaded.ok) return { ok: false, errors: loaded.errors };
  const root = tenantEvidenceRoot(deps.evidenceRoot, loaded.value.id);
  if (!root.ok) return { ok: false, errors: root.errors };
  return { ok: true, tenant: loaded.value, evidenceRoot: root.value };
}

/**
 * Is this run allowed, for this tenant?
 *
 * Target ownership and market scope, checked BEFORE anything launches. Both are
 * refusals rather than warnings: a run against a site the tenant does not own is
 * either a mistake or this engine being aimed at somebody else's product from
 * residential IPs, and a market nobody asked about is a bill.
 *
 * Returns every problem at once, like the matrix's validation, because fixing one
 * refusal per invocation is how a tool stops being used.
 */
export function checkTenantScope(tenant: Tenant, options: { url?: string; markets?: string[] }): string[] {
  const errors: string[] = [];
  if (options.url !== undefined && options.url !== "" && !tenantOwnsTarget(tenant, options.url)) {
    errors.push(
      `tenant "${tenant.id}" does not own ${options.url} — declared targets are ${tenant.targets.join(", ")}. Add it to tenants/${tenant.id}.yaml if it is theirs.`,
    );
  }
  for (const market of options.markets ?? []) {
    if (!tenant.markets.includes(market)) {
      errors.push(`tenant "${tenant.id}" has not asked for market "${market}" — declared markets are ${tenant.markets.join(", ")}`);
    }
  }
  return errors;
}

/**
 * Enforce a tenant's proxy budget before anything launches.
 *
 * The three-state result is the whole design, and it mirrors every other honest
 * reading in this codebase. `refused` stops the run. `within` proceeds. `unknown`
 * proceeds and SAYS SO — because with a vendor-enforced cap per sub-account,
 * exhaustion is isolated to the tenant that caused it, so blocking every tenant's
 * work because a usage API is down would cause more harm than it prevents. What it
 * must never do is read an unmeasured figure as nothing spent.
 *
 * `pageLoads` is how many page loads the caller is about to perform — scenarios for a
 * matrix, one for a journey. The estimate is deliberately coarse and named as an
 * estimate wherever it surfaces; its job is to catch the 430-page sweep against a
 * tenant with 100 MB left, not to bill anybody.
 */
export async function enforceQuota(
  deps: CommandDeps,
  tenant: Tenant,
  pageLoads: number,
): Promise<QuotaDecision> {
  const estimate = estimateTrafficMb(pageLoads);
  // The sub-account username comes from the environment, via the NAME the tenant
  // declares. A tenant naming a variable that is not set is unmeasurable, which is
  // the same state as naming no variable at all — and both are distinct from
  // measuring zero.
  const subUser = tenant.proxySubUser === null ? null : (deps.env[tenant.proxySubUser] ?? null);
  const apiKey = deps.env.DECODO_API_KEY ?? null;
  const probe = deps.usageProbe ?? decodoUsageProbe;
  const subUsers = apiKey === null || subUser === null ? null : await probe(apiKey);
  const runs = runsStartedToday(existingRunIds(deps.evidenceRoot), deps.now());
  return checkQuota(tenant, usageFor(tenant, subUsers, subUser, runs), estimate);
}

/**
 * The run ids already in a tenant's evidence tree.
 *
 * A missing directory is an empty list, not an error: a tenant's first run has
 * nowhere to have written yet, and refusing it would make the quota check the thing
 * that prevents a tenant from ever starting.
 */
function existingRunIds(root: string): string[] {
  try {
    return readdirSync(root).filter((entry) => entry.startsWith("run_"));
  } catch {
    return [];
  }
}

export const profilesDir = (deps: CommandDeps): string => path.join(deps.repoRoot, "profiles");
export const journeysDir = (deps: CommandDeps): string => path.join(deps.repoRoot, "journeys");

/** A tenant's own data lives beside its registry entry: `tenants/<id>/…`. */
export const tenantDataDir = (deps: CommandDeps, tenantId: string, kind: "profiles" | "journeys"): string =>
  path.join(tenantsDir(deps), tenantId, kind);

const yamlFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  } catch {
    // A tenant with no profiles of its own is normal, not an error: it uses the
    // shared set. Only a missing SHARED directory would be a broken install, and
    // that surfaces as "no profile named X" a moment later.
    return [];
  }
};

/**
 * A profile or journey id, constrained so it cannot be a path.
 *
 * This closes a real traversal that predates multi-tenancy. `profilePath` used to
 * `path.join` the id straight onto the directory, so `--geo ../../../../etc/hosts`
 * resolved to `/Volumes/etc/hosts.yaml` and tried to read it — verified before the
 * fix. Only `.yaml` files were reachable and a parse failure was the usual outcome,
 * but the id came from the command line, the resolved path was echoed back in the
 * error, and a YAML parse error can quote the line it failed on. That is an
 * attacker-controlled read attempt with a disclosure channel, which is enough.
 *
 * Same shape as `TenantIdSchema` and for the same reason: these ids become
 * filenames. A `.yaml` suffix is tolerated because callers and tests pass both
 * spellings, but nothing else containing a dot is.
 */
export const DataIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9](\.yaml)?$/,
    "a profile or journey id is lowercase letters, digits and inner hyphens — it becomes a filename, so dots, slashes and traversal are refused",
  );

/**
 * Where a named profile or journey is read from, tenant first.
 *
 * A tenant's own file WINS over the repo's, which is the point of the feature: a
 * tenant customises a journey without forking the engine, and the repo's set stays
 * the shared baseline. Falling back rather than requiring a full set means a tenant
 * declaring one custom journey still gets the other seven.
 *
 * Every candidate goes through `containedPath` against the directory it is supposed
 * to be in — the id pattern already refuses traversal, and this refuses anything that
 * got past it, for the reason recorded on `tenantEvidenceRoot`. Belt and braces is
 * warranted when the consequence is reading a file the caller chose.
 *
 * A name that matches nothing anywhere is a refusal naming both places it looked. The
 * previous behaviour was to return a path that did not exist and let the loader report
 * ENOENT, which tells a reader about the filesystem rather than about their typo.
 */
export function resolveDataPath(
  deps: CommandDeps,
  kind: "profiles" | "journeys",
  id: string,
): { ok: true; value: string } | { ok: false; errors: string[] } {
  const valid = DataIdSchema.safeParse(id);
  if (!valid.success) {
    return { ok: false, errors: [`${kind === "profiles" ? "profile" : "journey"} "${id}": ${valid.error.issues[0]?.message ?? "invalid id"}`] };
  }
  const file = id.endsWith(".yaml") ? id : `${id}.yaml`;
  const roots = deps.tenantId === undefined ? [] : [tenantDataDir(deps, deps.tenantId, kind)];
  roots.push(kind === "profiles" ? profilesDir(deps) : journeysDir(deps));

  const looked: string[] = [];
  for (const root of roots) {
    const contained = containedPath(root, file);
    // A refusal here is not "try the next root": it means the id got past the pattern
    // and is trying to leave. Stop.
    if (!contained.ok) return contained;
    looked.push(contained.value);
    if (existsSync(contained.value)) return { ok: true, value: contained.value };
  }
  return {
    ok: false,
    errors: [`no ${kind === "profiles" ? "profile" : "journey"} named "${id}" — looked in ${looked.join(" and ")}`],
  };
}

export function profilePath(deps: CommandDeps, id: string): string {
  const resolved = resolveDataPath(deps, "profiles", id);
  if (!resolved.ok) throw new Error(resolved.errors.join("; "));
  return resolved.value;
}

export function journeyPath(deps: CommandDeps, id: string): string {
  const resolved = resolveDataPath(deps, "journeys", id);
  if (!resolved.ok) throw new Error(resolved.errors.join("; "));
  return resolved.value;
}

export function loadProfileOrThrow(deps: CommandDeps, id: string): GeoProfile {
  const resolved = resolveDataPath(deps, "profiles", id);
  if (!resolved.ok) throw new Error(resolved.errors.join("; "));
  const loaded = loadGeoProfile(resolved.value);
  if (!loaded.ok) throw new Error(`profile "${id}": ${loaded.errors.join("; ")}`);
  return loaded.value;
}

// ── list ─────────────────────────────────────────────────────────────────

/**
 * Every name available for a kind, tenant's own first and the shared set after.
 *
 * De-duplicated by filename, so a tenant's `oslo-desktop.yaml` REPLACES the repo's in
 * the listing rather than appearing twice — which is what `resolveDataPath` does when
 * a run asks for it, and a listing that disagreed with the resolver would be worse
 * than no listing.
 */
function availableData(deps: CommandDeps, kind: "profiles" | "journeys"): { file: string; dir: string }[] {
  const dirs = deps.tenantId === undefined ? [] : [tenantDataDir(deps, deps.tenantId, kind)];
  dirs.push(kind === "profiles" ? profilesDir(deps) : journeysDir(deps));
  const seen = new Set<string>();
  const found: { file: string; dir: string }[] = [];
  for (const dir of dirs) {
    for (const file of yamlFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      found.push({ file, dir });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

export function profileList(deps: CommandDeps): {
  profiles: { id: string; label: string; country: string; city: string; device: string; visitorType: string }[];
} {
  const profiles = availableData(deps, "profiles").map(({ file, dir }) => {
    const loaded = loadGeoProfile(path.join(dir, file));
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
  const journeys = availableData(deps, "journeys").map(({ file, dir }) => {
    const loaded = loadJourney(path.join(dir, file));
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
    // The READ half of the cooldown. Without it `httpProxyProvider` returns null from
    // `cooldownUntil` and a vendor that failed a minute ago is tried again immediately.
    ...(deps.cooldownPath ? { cooldownPath: deps.cooldownPath } : {}),
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
  /** Recorded on the run's history entry, so a tenant's trend is its own. */
  tenantId?: string;
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
    // The READ half of the cooldown. Without it `httpProxyProvider` returns null from
    // `cooldownUntil` and a vendor that failed a minute ago is tried again immediately.
    ...(deps.cooldownPath ? { cooldownPath: deps.cooldownPath } : {}),
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
      // From `geoqa.config.json`. On the spec rather than read in a stage, so a durable run and
      // a local one collect — and score completeness — identically for the same spec.
      ...(deps.retention ? { retention: deps.retention } : {}),
      // Reached `browser verify` and `proxy verify` and NOT this command — so a cap on a hung
      // command applied to the two commands least likely to hang, and not to the one that runs
      // a whole journey.
      ...browserCaps(deps),
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
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    // The WRITE half: a verified-wrong egress records the failure, a verified-right one clears
    // it. Both are required — a store that only ever adds freezes a vendor that recovered.
    ...(deps.cooldownPath ? { cooldownPath: deps.cooldownPath } : {}),
    ...(deps.cooldownMs !== undefined ? { cooldownMs: deps.cooldownMs } : {}),
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
  /**
   * Run the sweep as a Temporal workflow instead of in this process.
   *
   * The two modes are the same matrix and the same scenarios; what differs is who survives a
   * crash halfway through. A durable run that cannot reach Temporal FAILS rather than falling
   * back — see `temporal/client.ts`.
   */
  durable?: boolean;
  temporalAddress?: string;
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

  // Resolved through `resolveDataPath` rather than `profilePath`, because a matrix
  // reports EVERY problem at once and a throwing path builder would abort on the
  // first — turning "these four names are wrong" into "this one is", once per run.
  for (const profileId of [...new Set(scenarios.map((s) => `${s.market}-${s.device}`))]) {
    const file = resolveDataPath(deps, "profiles", profileId);
    if (!file.ok) {
      errors.push(...file.errors);
      continue;
    }
    const loaded = loadGeoProfile(file.value);
    if (!loaded.ok) errors.push(`profile "${profileId}": ${loaded.errors.join("; ")}`);
  }
  const writeJourneys: string[] = [];
  for (const journeyId of [...new Set(scenarios.map((s) => s.journey))]) {
    const file = resolveDataPath(deps, "journeys", journeyId);
    if (!file.ok) {
      errors.push(...file.errors);
      continue;
    }
    const loaded = loadJourney(file.value);
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
    // The READ half of the cooldown. Without it `httpProxyProvider` returns null from
    // `cooldownUntil` and a vendor that failed a minute ago is tried again immediately.
    ...(deps.cooldownPath ? { cooldownPath: deps.cooldownPath } : {}),
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

  /**
   * The durable path, and the refusal that keeps it honest.
   *
   * `--durable` without an injected starter is an ERROR, never a quiet local run. The two modes
   * produce identical output, so a caller who asked for durability and silently got a process
   * that dies with the terminal would have no way to notice — which is the same class of lie as
   * an unmeasured metric reported as fine, and worse, because it looks like success.
   *
   * The scenarios, the seeds, the provider selection and the write guard above are all shared:
   * only who executes them changes. That is invariant 12 as a code path rather than as a rule.
   */
  /**
   * The spec a scenario runs under, WITHOUT the network resolution.
   *
   * `prepareRun` picks the exit and writes the init script, and on the durable path that happens
   * inside the `prepare` activity — so the proxy selection is part of the workflow's own history
   * and survives a crash, rather than being a decision this process made and forgot. Everything
   * else is identical to the in-process `plan` below, deliberately: the two modes differ in who
   * executes them, not in what they were asked to do.
   */
  const baseSpecFor = (scenario: MatrixScenario): GeoQaRunInput["base"] => {
    const profileId = `${scenario.market}-${scenario.device}`;
    const slug = scenario.target === null ? `${profileId}-${scenario.journey}` : `${profileId}-${scenario.journey}-${scenario.index}`;
    return {
      runId: newRunId(slug, deps.now()),
      engine,
      seed: scenarioSeed(baseSeed, scenario.key),
      corroborateGeo: options.corroborate === true,
      ...(deps.retention ? { retention: deps.retention } : {}),
      ...browserCaps(deps),
      target: scenario.target ?? options.url,
      profilePath: profilePath(deps, profileId),
      journeyPath: journeyPath(deps, scenario.journey),
      evidenceRoot: deps.evidenceRoot,
      vars: options.vars ?? {},
      headed: options.headed ?? false,
      verifyEndpoint: options.verifyEndpoint ?? DEFAULT_VERIFY_ENDPOINT,
    };
  };

  if (options.durable === true) {
    if (deps.startDurable === undefined) {
      throw new Error(
        "--durable needs a Temporal client, and this process has none wired. It will NOT fall back to running in-process: a durable sweep and a local one produce the same output, so a silent fallback would be undetectable.",
      );
    }
    const startedAt = new Date(deps.now()).toISOString();
    // The base spec only — `prepareRun` runs inside the workflow's `prepare` activity, which is
    // what makes the proxy selection part of the durable history rather than of this process.
    const runs: GeoQaRunInput[] = scenarios.map((scenario) => ({
      base: baseSpecFor(scenario),
      providerName: provider.name,
      ...(deps.cooldownPath ? { cooldownPath: deps.cooldownPath } : {}),
      startedAt,
    }));
    const durable = await deps.startDurable(runs, {
      workflowId: newRunId("matrix", deps.now()),
      ...(options.temporalAddress ? { address: options.temporalAddress } : {}),
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    });
    deps.log(`durable: workflow ${durable.workflowId} @ ${durable.address}`);
    return { ...common, result: durableMatrixResult(durable, scenarios, startedAt) };
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
          ...(deps.retention ? { retention: deps.retention } : {}),
          ...browserCaps(deps),
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
      return {
        spec: prepared.spec,
        provider,
        log: deps.log,
        repeat: options.repeat ?? 1,
        ...(deps.tenantId !== undefined ? { tenantId: deps.tenantId } : {}),
        ...(deps.cooldownPath ? { cooldownPath: deps.cooldownPath } : {}),
        ...(deps.cooldownMs !== undefined ? { cooldownMs: deps.cooldownMs } : {}),
      };
    },
    run: deps.runOnce,
    now: deps.now,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    onScenario: (outcome) =>
      deps.log(`matrix: ${outcome.scenario.key} → ${outcome.outcome}${outcome.error === null ? "" : ` (${outcome.error})`}`),
  });

  return { ...common, result };
}

/**
 * A durable sweep's results, in the shape `matrix run` already renders.
 *
 * The two execution modes must be indistinguishable to a reader — that is the whole point of
 * offering both — so the durable path maps into `MatrixResult` rather than growing a second
 * renderer. `OUTCOME_BY_VERDICT` is imported rather than re-derived: two tables would drift, and
 * a matrix that counted a FAIL as a pass on one mode and not the other is exactly the divergence
 * invariant 12 exists to prevent.
 *
 * Zipped by INDEX, which is sound because `geoQaMatrixWorkflow` sorts its results back into
 * input order for this reason. A workflow returning fewer results than there were scenarios
 * would silently shift every later row onto the wrong scenario, so the length is checked rather
 * than trusted.
 *
 * `durationMs` is 0 and `peakInFlight` is the bound rather than a measurement: workflow code may
 * not read the clock, and this process did not run the scenarios so it cannot say how many were
 * ever in flight. Reporting a plausible number we did not measure is the one thing this codebase
 * refuses everywhere else — Temporal's own history has the real timings.
 */
function durableMatrixResult(durable: DurableMatrixResult, scenarios: MatrixScenario[], startedAt: string): MatrixResult {
  /**
   * One guard, checking BOTH the count and every entry, so the map below needs no arm for a
   * missing result.
   *
   * The types say a `GeoQaWorkflowResult` always carries one, and across a workflow boundary a
   * type is a claim about what should arrive rather than about what did. But the answer to that
   * is a guard here, not a branch in the map: an arm with no reachable failure is dead code the
   * coverage gate can only be silenced about, and — worse — it would turn a malformed response
   * into a single `unmeasured` row buried among real ones, when the honest reading is that the
   * whole sweep cannot be trusted to line up.
   */
  const runs = durable.results.map((r) => r?.result);
  if (runs.length !== scenarios.length || runs.some((r) => r === undefined)) {
    throw new Error(
      `the durable sweep returned ${runs.filter((r) => r !== undefined).length} usable result(s) for ${scenarios.length} scenario(s) — they are matched by position, so a mismatch would attribute every later result to the wrong market. Inspect workflow ${durable.workflowId}.`,
    );
  }
  const mapped: MatrixScenarioResult[] = scenarios.map((scenario, index) => {
    const run = runs[index] as GeoQaRunResult;
    return { scenario, outcome: OUTCOME_BY_VERDICT[run.verdict], result: run, error: null, startedAt, durationMs: 0 };
  });
  return {
    startedAt,
    durationMs: 0,
    concurrency: { limit: resolveConcurrency(undefined), peakInFlight: 0 },
    scenarios: mapped,
    counts: countScenarios(mapped),
    verdict: matrixVerdict(countScenarios(mapped)),
  };
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

// ── dashboard data ───────────────────────────────────────────────────────

/**
 * The view model the UI consumes, written next to the evidence it describes.
 *
 * Written to a FILE rather than served by a process, because a static file is the whole
 * infrastructure story: the UI is a directory anybody can open, host behind a CDN, or serve
 * from the evidence root. No server means no auth surface, no port, and nothing to keep
 * running — which is also why the React app can be read-only without that being a
 * limitation.
 */
export function dashboardBuild(deps: CommandDeps, filter: HistoryFilter = {}): { path: string; view: DashboardView } {
  const { records, skipped } = readHistory(deps.evidenceRoot, deps.historyFs ?? nodeHistoryFs);
  const warnings = skipped > 0 ? [`${skipped} unparseable index line(s) skipped — "geoqa runs rebuild" reconstructs the index`] : [];
  const view = toDashboardView(filterHistory(records, filter), new Date(deps.now()).toISOString(), warnings);
  const file = path.join(deps.evidenceRoot, DASHBOARD_FILE);
  const fs = deps.historyFs ?? nodeHistoryFs;
  fs.mkdir(deps.evidenceRoot);
  fs.write(file, JSON.stringify(view, null, 2));
  return { path: file, view };
}

export const DASHBOARD_FILE = "dashboard.json";

export function renderDashboardBuild(result: { path: string; view: DashboardView }): string {
  const v = result.view;
  const lines = [
    `wrote ${result.path}`,
    `  ${v.summary.total} run(s), mean confidence ${v.summary.meanConfidence.text}`,
    `  ${v.regressions.length} regression(s), ${v.site.geographicallyDivergent.length} geographically divergent page(s)`,
  ];
  for (const w of v.warnings) lines.push(`  ! ${w}`);
  // The count that matters for a UI's honesty: how many displayed values are absences.
  const absences = v.runs.flatMap((r) => [...Object.values(r.vitals), ...Object.values(r.confidence)]).filter((m) => !m.measured).length;
  lines.push(`  ${absences} value(s) marked "not measured" — these MUST render distinctly from zero`);
  return lines.join("\n");
}

// ── site analysis ────────────────────────────────────────────────────────

export interface SiteAnalysisResult {
  report: SiteReport;
  /** Index lines that could not be parsed. */
  skipped: number;
  warnings: string[];
}

/**
 * Analyse a site across markets, from the run history.
 *
 * Reads the same index `runs list` does — so this needs no crawl of its own and cannot
 * disagree with the run records. A sweep produces the data; this interprets it.
 */
export function siteAnalyse(deps: CommandDeps, filter: HistoryFilter = {}): SiteAnalysisResult {
  const { records, skipped } = readHistory(deps.evidenceRoot, deps.historyFs ?? nodeHistoryFs);
  const report = analyseSite(filterHistory(records, filter));
  const warnings = [...report.warnings];
  if (skipped > 0) warnings.push(`${skipped} unparseable index line(s) skipped — "geoqa runs rebuild" reconstructs the index from the evidence`);
  if (report.markets.length < 2) {
    warnings.push(
      `only ${report.markets.length} market(s) in the history, so there is nothing to compare ACROSS markets — which is the half of this analysis no other tool can do. Run a matrix over two or more markets first.`,
    );
  }
  return { report, skipped, warnings };
}

/**
 * Read every run's `content.json` back off disk.
 *
 * From the evidence rather than the index, because the content is deliberately NOT in
 * `runs.jsonl`: shingles for hundreds of pages would make the index the largest thing in the
 * tree, and the index exists to be scanned quickly. A run with no `content.json` is skipped
 * silently — it is a bonus artifact, and a sweep from before this existed should still analyse.
 */
export function readContentRecords(deps: CommandDeps): { records: ContentRecord[]; runsWithout: number } {
  const records: ContentRecord[] = [];
  let runsWithout = 0;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(deps.evidenceRoot).filter((d) => d.startsWith("run_"));
  } catch {
    return { records: [], runsWithout: 0 };
  }
  // Newest run per target wins: a sweep repeated over days should describe the site as it is
  // now, not average a page against its own history.
  const byTarget = new Map<string, { runId: string; record: ContentRecord }>();
  for (const dir of dirs.sort()) {
    try {
      const contentFile = path.join(deps.evidenceRoot, dir, "content.json");
      if (!existsSync(contentFile)) {
        runsWithout += 1;
        continue;
      }
      const run = JSON.parse(readFileSync(path.join(deps.evidenceRoot, dir, "run.json"), "utf8")) as { target?: string };
      const content = parsePageContent(JSON.parse(readFileSync(contentFile, "utf8")));
      if (typeof run.target !== "string" || content === null) {
        runsWithout += 1;
        continue;
      }
      byTarget.set(run.target, { runId: dir, record: { target: run.target, content } });
    } catch {
      runsWithout += 1;
    }
  }
  for (const { record } of byTarget.values()) records.push(record);
  return { records, runsWithout };
}

export interface ContentAnalysisResult {
  findings: ContentFindings;
  pages: number;
  runsWithoutContent: number;
}

export function contentAnalyse(deps: CommandDeps): ContentAnalysisResult {
  const { records, runsWithout } = readContentRecords(deps);
  return { findings: analyseContent(records), pages: records.length, runsWithoutContent: runsWithout };
}

export function renderContentAnalysis(result: ContentAnalysisResult): string {
  const f = result.findings;
  const lines = [`${result.pages} page(s) with captured content` + (result.runsWithoutContent > 0 ? `, ${result.runsWithoutContent} run(s) had none` : "")];
  for (const w of f.warnings) lines.push(`  ! ${w}`);
  if (f.thin.length > 0) {
    lines.push(`  ${f.thin.length} page(s) under ${THIN_PAGE_WORDS} words — a list to look at, not a verdict:`);
    for (const t of f.thin.slice(0, 10)) lines.push(`    ${String(t.wordCount).padStart(5)} words  ${t.target}`);
  }
  if (f.duplicates.length > 0) {
    lines.push(`  ${f.duplicates.length} near-duplicate pair(s) at or above ${DUPLICATE_SIMILARITY} similarity:`);
    for (const d of f.duplicates.slice(0, 10)) lines.push(`    ${d.similarity}  ${d.a}\n         ${d.b}`);
  }
  if (f.orphans.length > 0) {
    lines.push(`  ${f.orphans.length} page(s) nothing else in this sweep links to:`);
    for (const o of f.orphans.slice(0, 10)) lines.push(`    ${o}`);
  }
  if (f.headingProblems.length > 0) {
    lines.push(`  ${f.headingProblems.length} page(s) without exactly one h1:`);
    for (const h of f.headingProblems.slice(0, 10)) lines.push(`    h1 x${h.h1Count}  ${h.target}`);
  }
  return lines.join("\n");
}

export function renderSiteAnalysis(result: SiteAnalysisResult): string {
  const { report } = result;
  const lines = [`${report.pages} page(s) across ${report.markets.length} market(s): ${report.markets.join(", ") || "none"}`];
  for (const w of result.warnings) lines.push(`  ! ${w}`);

  if (report.geographicallyDivergent.length > 0) {
    lines.push(`  ${report.geographicallyDivergent.length} page(s) where GEOGRAPHY CHANGED THE OUTCOME:`);
    for (const page of report.geographicallyDivergent.slice(0, 10)) {
      const verdicts = Object.entries(page.markets).map(([id, m]) => `${id}=${m.verdict}`).join(" ");
      lines.push(`    ${page.target}`);
      lines.push(`      ${verdicts}`);
    }
  }
  if (report.widestLatencyGaps.length > 0) {
    lines.push("  widest latency gaps between markets — a crawler from one datacentre sees none of this:");
    for (const page of report.widestLatencyGaps.slice(0, 8)) lines.push(`    ${describeLatencySpread(page)}`);
  }
  if (report.coverageGaps.length > 0) {
    lines.push(`  ${report.coverageGaps.length} page(s) NOT measured in every market — a page nobody measured in a market is not a page that works there:`);
    for (const gap of report.coverageGaps.slice(0, 8)) lines.push(`    ${gap.target} — missing ${gap.missing.join(", ")}`);
  }
  return lines.join("\n");
}

// ── publish gate ─────────────────────────────────────────────────────────

export interface GateCheckOptions extends GateThresholds {
  url: string;
  profileId: string;
  journeyId: string;
  providerName?: string;
  engine?: RunEngine;
  verifyEndpoint?: string;
  seed?: number;
  tenantId?: string;
}

export interface GateCheckResult {
  gate: GateResult;
  /** The findings a producer can act on, worst first. Empty on an allow. */
  actionable: Finding[];
  warnings: string[];
}

/**
 * Run a journey against a candidate page and decide whether it may be published.
 *
 * The run is a NORMAL run — same journey, same profile, same evidence — because a gate
 * that measured something special would be answering a different question from the one the
 * rest of the system answers. What is different is only the interpretation.
 *
 * A run that THROWS becomes `unknown`, not an exception a caller might catch and treat as a
 * pass. The absence of a verdict is not a verdict, and the one place that could go wrong is
 * a publisher wrapping this in a try/catch.
 */
export async function gateCheck(deps: CommandDeps, options: GateCheckOptions): Promise<GateCheckResult> {
  let result: GeoQaRunResult;
  try {
    result = await journeyRun(deps, {
      url: options.url,
      profileId: options.profileId,
      journeyId: options.journeyId,
      ...(options.providerName ? { providerName: options.providerName } : {}),
      ...(options.engine ? { engine: options.engine } : {}),
      ...(options.verifyEndpoint ? { verifyEndpoint: options.verifyEndpoint } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    });
  } catch (e) {
    return {
      gate: gateWithoutRun(e instanceof Error ? e.message : String(e)),
      actionable: [],
      warnings: [],
    };
  }
  const gate = gateFromRun(result, {
    ...(options.blockAtOrAbove !== undefined ? { blockAtOrAbove: options.blockAtOrAbove } : {}),
    ...(options.minConfidence !== undefined ? { minConfidence: options.minConfidence } : {}),
    ...(options.minGeoConfidence !== undefined ? { minGeoConfidence: options.minGeoConfidence } : {}),
  });
  return { gate, actionable: gate.decision === "allow" ? [] : actionableFindings(result), warnings: [] };
}

export function renderGateResult(result: GateCheckResult): string {
  const lines = [`${result.gate.decision.toUpperCase()} — ${result.gate.reason}`];
  for (const b of result.gate.blockers) lines.push(`  ✗ ${b}`);
  for (const w of result.gate.warnings) lines.push(`  ! ${w}`);
  if (result.gate.runId !== null) lines.push(`  run ${result.gate.runId}${result.gate.evidenceId ? ` · evidence ${result.gate.evidenceId}` : ""}`);
  return lines.join("\n");
}

// ── keywords ─────────────────────────────────────────────────────────────

export interface KeywordsResearchOptions {
  /** Cap this run's spend. Absent means the provider's remaining quota is the ceiling. */
  budget?: number;
  limit?: number;
  /** Restrict to these market ids. Absent means every market the tenant declared. */
  markets?: string[];
}

/**
 * Research a tenant's keywords, per market, through the SERP provider.
 *
 * Requires a tenant, and that is not ceremony: the seeds, the markets and the site to
 * look for all come from the tenant, and there is no sensible default for any of them.
 * The alternative would be a command that researched *something* against *somewhere*.
 *
 * The markets come from the tenant's own list, resolved to real `Market` objects through
 * the profiles — so a tenant declaring a market with no profile is refused here rather
 * than producing a query with no geography.
 */
// `async`, so every failure arrives as a REJECTION. Declared as returning a promise
// while throwing synchronously would hand a caller using `.catch()` an uncaught
// exception instead — the refusals here are the whole value of the function, so they
// must arrive the way a caller is waiting for them.
export async function keywordsResearch(
  deps: CommandDeps,
  tenant: Tenant,
  options: KeywordsResearchOptions,
): Promise<KeywordReport> {
  const seeds = loadKeywordSeeds(path.join(tenantsDir(deps), tenant.id, "keywords.yaml"));
  if (!seeds.ok) throw new Error(seeds.errors.join("\n"));

  const wanted = options.markets?.length ? options.markets : tenant.markets;
  const markets: Market[] = [];
  const missing: string[] = [];
  for (const id of wanted) {
    // A market is a property of a PROFILE, so the profile is the source of truth for its
    // country, city and language. A tenant naming a market with no profile has a config
    // error, and querying it with invented geography would be worse than refusing.
    const resolved = resolveDataPath(deps, "profiles", `${id}-${DEFAULT_DEVICE}`);
    if (!resolved.ok) {
      missing.push(id);
      continue;
    }
    const loaded = loadGeoProfile(resolved.value);
    if (!loaded.ok) missing.push(id);
    else markets.push(loaded.value.market);
  }
  if (missing.length > 0) {
    throw new Error(
      `tenant "${tenant.id}" declares market(s) ${missing.join(", ")} with no ${DEFAULT_DEVICE} profile — a market's country, city and language come from its profile, and querying with invented geography would be worse than refusing`,
    );
  }

  return researchKeywords({
    tenantId: tenant.id,
    // The tenant's FIRST declared target. Ownership is already enforced, so this is the
    // site whose rankings the report is about.
    ownUrl: tenant.targets[0] as string,
    seeds: seeds.value,
    markets,
    provider: deps.searchProvider ?? serpApiProvider({ apiKey: deps.env.SERPAPI_KEY }),
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    log: deps.log,
  });
}

export function renderKeywordReport(report: KeywordReport): string {
  const lines: string[] = [];
  lines.push(
    report.queried === 0
      ? `no keyword queries ran for tenant "${report.tenantId}"`
      : `${report.measured} of ${report.queried} query(ies) measured for tenant "${report.tenantId}"`,
  );
  // Null, not 0, when nothing was measured — "no readings" and "readings that scored
  // zero" are different facts and only one of them is about the site.
  if (report.meanScore !== null) lines.push(`  mean visibility ${report.meanScore} over the measured queries`);
  for (const w of report.warnings) lines.push(`  ! ${w}`);
  for (const o of report.observations) {
    const where = o.score === null ? "unmeasured" : o.position === null ? "absent" : `#${o.position}`;
    lines.push(`  ${where.padEnd(11)} ${o.marketId.padEnd(12)} ${o.term.padEnd(34)} ${o.topCompetitor ?? ""}`);
  }
  const gaps = opportunities(report);
  if (gaps.length > 0) {
    lines.push(`  ${gaps.length} measured gap(s) — the term was searched, the SERP was populated, this tenant was not on it:`);
    for (const o of gaps.slice(0, 10)) lines.push(`    ${o.marketId.padEnd(12)} ${o.term.padEnd(34)} top: ${o.topCompetitor ?? "?"}`);
  }
  return lines.join("\n");
}

// ── runs (history) ───────────────────────────────────────────────────────

export interface RunsListResult {
  summary: HistorySummary;
  runs: RunRecord[];
  regressions: Regression[];
  /** Index lines that could not be parsed. A half-written last line is normal. */
  skipped: number;
  /** Said out loud when the index has gaps a rebuild would close. */
  warnings: string[];
}

/**
 * The history, filtered, with regressions.
 *
 * `limit` applies to the RUN LIST only and never to the summary or the regressions:
 * "the last 20 runs" is a display preference, while "how many runs have there been"
 * and "what broke" are questions about all of them. Truncating the answer to match the
 * display would be a quieter version of the same lie as an unmeasured metric reported
 * as fine.
 */
export function runsList(
  deps: CommandDeps,
  options: HistoryFilter & { limit?: number } = {},
): RunsListResult {
  const { records, skipped } = readHistory(deps.evidenceRoot, deps.historyFs ?? nodeHistoryFs);
  const matching = filterHistory(records, options);
  const warnings: string[] = [];
  if (skipped > 0) {
    warnings.push(
      `${skipped} line(s) of the run index could not be parsed and were skipped — a half-written final line is normal after an interrupted run. The evidence is still on disk: "geoqa runs rebuild" reconstructs the index from it.`,
    );
  }
  const limit = options.limit ?? 20;
  return {
    // Over EVERY matching run, not the truncated list.
    summary: summariseHistory(matching),
    runs: matching.slice(-limit).reverse(),
    regressions: findRegressions(matching),
    skipped,
    warnings,
  };
}

/**
 * Rebuild the index from the runs on disk.
 *
 * The operation that makes the index safe to treat as a cache. `run.json` is the
 * authority on its own run, so a corrupt, truncated, hand-edited or deleted index costs
 * nothing permanent — which is the whole reason this is JSONL over the evidence tree
 * rather than a database that owns the truth.
 */
export function runsRebuild(deps: CommandDeps): { written: number; unreadable: string[] } {
  return rebuildHistory(
    deps.evidenceRoot,
    (runJson, runId) => {
      // `run.json` holds the run, the profile and the journey; a record needs the
      // result shape, so the fields are read defensively rather than cast. A file that
      // does not describe a run is reported by the caller, not guessed at.
      const doc = runJson as { runId?: string; target?: string; profile?: { id?: string }; journey?: { id?: string; verdict?: string; seed?: number } };
      if (typeof doc.runId !== "string") return null;
      return {
        schemaVersion: HISTORY_SCHEMA_VERSION,
        runId: doc.runId,
        tenantId: null,
        target: typeof doc.target === "string" ? doc.target : "",
        profileId: doc.profile?.id ?? "",
        journeyId: doc.journey?.id ?? "",
        // The JOURNEY's verdict, which is what run.json records. A rebuilt record is
        // therefore slightly poorer than an appended one — run.json does not carry the
        // assembled run verdict or the confidence report — and that is stated rather
        // than papered over with defaults that would read as real readings.
        verdict: (doc.journey?.verdict as RunRecord["verdict"] | undefined) ?? "ERROR",
        startedAt: new Date(Number(/^run_(\d+)_/.exec(runId)?.[1] ?? 0)).toISOString(),
        durationMs: 0,
        seed: doc.journey?.seed ?? 0,
        engine: "unknown",
        evidenceId: null,
        findings: { total: 0, bySeverity: {}, byCategory: {}, labels: [] },
        confidence: { overall: 0, geo: 0, browser: 0, journey: 0, evidence: 0 },
        geo: {
          requestedCountry: "",
          requestedCity: "",
          observedCountry: null,
          observedCity: null,
          country: "unverified",
          city: "unverified",
          egressHeld: "unverified",
          agreement: "unverified",
        },
        latencyMs: null,
        vitals: { lcp: null, cls: null, ttfb: null, inp: null },
      };
    },
    deps.historyFs ?? nodeHistoryFs,
  );
}

export function renderRunsList(result: RunsListResult): string {
  const lines: string[] = [];
  const s = result.summary;
  lines.push(
    s.runs === 0
      ? "no runs recorded yet"
      : `${s.runs} run(s) from ${s.first} to ${s.last} — ${Object.entries(s.byVerdict).map(([v, n]) => `${n} ${v}`).join(", ")}`,
  );
  // Null, not 0, on an empty history: "no runs" and "runs that scored zero" are
  // different facts and only one of them is bad news.
  if (s.meanConfidence !== null) lines.push(`  mean overall confidence ${s.meanConfidence}`);
  for (const w of result.warnings) lines.push(`  ! ${w}`);
  if (result.regressions.length > 0) {
    lines.push(`  ${result.regressions.length} regression(s) — a check that used to pass and now does not:`);
    for (const r of result.regressions.slice(0, 10)) {
      lines.push(`    ${r.label} · ${r.profileId}/${r.journeyId} · last good ${r.lastGood.startedAt} → first bad ${r.firstBad.startedAt}`);
    }
  }
  for (const run of result.runs) {
    lines.push(
      `  ${run.verdict.padEnd(18)} ${run.startedAt} ${run.profileId.padEnd(18)} ${run.journeyId.padEnd(18)} conf ${String(run.confidence.overall).padStart(3)} ${run.target}`,
    );
  }
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
