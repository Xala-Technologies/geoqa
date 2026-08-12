/**
 * The commands. Each returns a JSON-able result; `index.ts` only parses
 * arguments, calls one, and prints.
 *
 * Every dependency that touches the world — the clock, the filesystem root,
 * the browser factory, the network provider — arrives through `CommandDeps`.
 * That is what lets these be covered without launching Chrome, while keeping
 * `index.ts` thin enough to be honestly coverage-excluded.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { AgentBrowserRuntime } from "../browser/agent-browser.js";
import type { BrowserRuntime, BrowserSessionConfig } from "../browser/types.js";
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
import { observeBrowser, observeNetwork, DEFAULT_VERIFY_ENDPOINT } from "../geo/observe.js";
import { loadGeoProfile, toSessionConfig } from "../geo/profile.js";
import type { GeoProfile } from "../geo/types.js";
import { verifyGeo } from "../geo/verify.js";
import { loadJourney } from "../journeys/spec.js";
import { redactProxyUrl, selectProvider, type TcpProbe } from "../network/provider.js";
import { newRunId, type RunSpec } from "../run/context.js";
import { executeRun, prepareRun } from "../run/execute.js";
import { applyDeviceProfile } from "../run/stages.js";
import type { GeoQaRunResult } from "../findings/types.js";
import { describeConfidence } from "../confidence/score.js";

export interface CommandDeps {
  repoRoot: string;
  evidenceRoot: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  log: (line: string) => void;
  /** Injectable so tests never launch a browser. */
  makeRuntime: (config: BrowserSessionConfig) => BrowserRuntime;
  /** Injectable so tests never execute a full run. */
  runOnce: typeof executeRun;
  /**
   * Injectable so tests never open a socket. A provider's `health()` is a REAL
   * probe by design — that is the whole point of not calling it `available()` —
   * which means the only way to test the commands around it is to hand them a
   * probe.
   */
  probe?: TcpProbe;
}

export function defaultDeps(repoRoot: string, overrides: Partial<CommandDeps> = {}): CommandDeps {
  return {
    repoRoot,
    evidenceRoot: path.join(repoRoot, "evidence"),
    env: process.env,
    now: Date.now,
    log: (line) => console.error(line),
    makeRuntime: (config) => new AgentBrowserRuntime(config),
    runOnce: executeRun,
    ...overrides,
  };
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

export function profileList(deps: CommandDeps): { profiles: { id: string; label: string; country: string; city: string; device: string }[] } {
  const profiles = yamlFiles(profilesDir(deps)).map((file) => {
    const loaded = loadGeoProfile(path.join(profilesDir(deps), file));
    if (!loaded.ok) return { id: file.replace(/\.yaml$/, ""), label: `INVALID: ${loaded.errors[0]}`, country: "?", city: "?", device: "?" };
    const p = loaded.value;
    return { id: p.id, label: p.label, country: p.market.country, city: p.market.city, device: p.device.id };
  });
  return { profiles };
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
}

/**
 * Prove each primitive by USING it against a real page, not by checking that
 * the CLI advertises it. `--help` listing a command says nothing about whether
 * it answers.
 */
export async function browserVerify(deps: CommandDeps, url = "https://example.com"): Promise<BrowserVerifyResult> {
  const runtime = deps.makeRuntime({ sessionId: `verify-${deps.now()}`, namespace: "verify" });
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

  return { primitives, passed: primitives.filter((p) => p.ok).length, total: primitives.length, launchHash };
}

// ── proxy / geo verify ───────────────────────────────────────────────────

export interface GeoVerifyResult {
  profileId: string;
  provider: string;
  proxy: string | null;
  verification: ReturnType<typeof verifyGeo>;
  warnings: string[];
}

export async function proxyVerify(
  deps: CommandDeps,
  options: { profileId: string; providerName?: string; verifyEndpoint?: string },
): Promise<GeoVerifyResult> {
  const profile = loadProfileOrThrow(deps, options.profileId);
  const { provider, warning } = selectProvider(options.providerName ?? "direct", {
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
  );

  try {
    // Apply the profile before observing it. Without this the viewport axis
    // reports whatever the browser defaulted to, which is a reading about
    // agent-browser rather than about the profile.
    warnings.push(...(await applyDeviceProfile(runtime, profile)));
    const network = await observeNetwork(runtime, options.verifyEndpoint ?? DEFAULT_VERIFY_ENDPOINT);
    const browser = await observeBrowser(runtime);
    return {
      profileId: profile.id,
      provider: provider.name,
      proxy: redactProxyUrl(session.session.proxyUrl),
      verification: verifyGeo(profile, network, browser),
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
  journeyId: string;
  providerName?: string;
  vars?: Record<string, string>;
  headed?: boolean;
}

export async function journeyRun(deps: CommandDeps, options: JourneyRunOptions): Promise<GeoQaRunResult & { warnings: string[] }> {
  const profile = loadProfileOrThrow(deps, options.profileId);
  const { provider, warning } = selectProvider(options.providerName ?? "direct", {
    env: deps.env,
    ...(deps.probe ? { probe: deps.probe } : {}),
  });
  const runId = newRunId(profile.id, deps.now());

  const prepared = await prepareRun(
    {
      runId,
      target: options.url,
      profilePath: profilePath(deps, options.profileId),
      journeyPath: journeyPath(deps, options.journeyId),
      evidenceRoot: deps.evidenceRoot,
      vars: options.vars ?? {},
      headed: options.headed ?? false,
      verifyEndpoint: DEFAULT_VERIFY_ENDPOINT,
    },
    provider,
    deps.now(),
  );

  const warnings = warning ? [warning, ...prepared.warnings] : prepared.warnings;
  for (const w of warnings) deps.log(`warning: ${w}`);

  const result = await deps.runOnce({ spec: prepared.spec, provider, log: deps.log });
  return { ...result, warnings };
}

// ── evidence inspect ─────────────────────────────────────────────────────

export function evidenceInspect(deps: CommandDeps, runId: string): { runId: string; manifest: ReturnType<typeof readManifest> } {
  const manifest = readManifest(path.join(deps.evidenceRoot, runId));
  if (!manifest) throw new Error(`no evidence manifest for run "${runId}" under ${deps.evidenceRoot}`);
  return { runId, manifest };
}

// ── experiment run ───────────────────────────────────────────────────────

export interface ExperimentOptions {
  id: string;
  samples: number;
  profileId: string;
  url: string;
  providerName?: string;
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
