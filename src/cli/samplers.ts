/**
 * Per-experiment samplers and summarisers.
 *
 * Each pair answers one hypothesis from `definitions.ts`. They are kept apart
 * from the harness so the harness stays about statistics and file layout, and
 * these stay about what a particular question actually requires observing.
 */
import path from "node:path";
import { observeBrowser, observeNetwork, DEFAULT_VERIFY_ENDPOINT } from "../geo/observe.js";
import { toSessionConfig } from "../geo/profile.js";
import { compareCity, compareCountry, compareLanguage, compareTimezone } from "../geo/verify.js";
import { evaluateMetric, meanOf, rate, type ExperimentSample, type MetricResult, type MetricSpec } from "../experiments/harness.js";
import { redactProxyUrl, selectProvider } from "../network/provider.js";
import { EXP_000, EXP_001, EXP_002, EXP_003, EXP_004, EXP_005, EXP_006, EXP_007 } from "../experiments/definitions.js";
import { DEFECTS, startFixtureServer } from "../fixtures/server.js";
import { browserVerify, journeyRun, loadProfileOrThrow, profileList, type CommandDeps, type ExperimentOptions } from "./commands.js";
import { parseDurationMs, type ParsedArgs } from "./args.js";

const metric = (specs: MetricSpec[], key: string): MetricSpec => {
  const found = specs.find((m) => m.key === key);
  if (!found) throw new Error(`no metric "${key}"`);
  return found;
};

const num = (sample: ExperimentSample, key: string): number | null => {
  const value = sample.data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const truthy = (key: string) => (s: ExperimentSample): boolean => s.data[key] === true;

/** The note every unmeasurable geographic metric carries in Phase 0. */
export const NO_VENDOR_NOTE =
  "No geo-proxy vendor is configured, so every session egressed from this machine. The target is declared but cannot be evaluated — this is `unmeasured`, not a pass.";

// ── EXP-000: agent-browser primitives ────────────────────────────────────

export async function sampleBrowserPrimitives(deps: CommandDeps, options: ExperimentOptions): Promise<Record<string, unknown>> {
  const result = await browserVerify(deps, options.url);
  return {
    passed: result.passed,
    total: result.total,
    allPassed: result.passed === result.total,
    launched: result.launchHash !== null,
    failures: result.primitives.filter((p) => !p.ok).map((p) => `${p.name}: ${p.detail}`),
  };
}

export function summariseBrowserPrimitives(samples: ExperimentSample[]): { metrics: MetricResult[]; notes: string[] } {
  const share = rate(samples, truthy("allPassed"));
  const launched = rate(samples, truthy("launched"));
  const failures = new Set(samples.flatMap((s) => (Array.isArray(s.data.failures) ? (s.data.failures as string[]) : [])));
  return {
    metrics: [
      evaluateMetric(metric(EXP_000.metrics, "primitive-success"), share, "no samples completed"),
      evaluateMetric(metric(EXP_000.metrics, "browser-launch"), launched, "no samples completed"),
    ],
    notes: failures.size > 0 ? [`primitives that failed at least once: ${[...failures].join(" | ")}`] : [],
  };
}

// ── EXP-001: geographic egress ───────────────────────────────────────────

/**
 * Take one egress reading THROUGH THE PROVIDER'S OWN SESSION.
 *
 * The provider round-trip is not ceremony, and leaving it out was a real defect:
 * this sampler used to derive `routed` from whether the `--provider` FLAG said
 * something other than "direct", while building the browser with no `proxyUrl`
 * at all. So `--provider http-proxy` launched a direct-egress browser, flipped
 * the honesty guard off, and let the observed country answer the hypothesis. Run
 * from a Norwegian office against the Oslo profile that reports
 * `country-match 100% ✓` — a green tick for a capability that had still never
 * been exercised, which is the exact lie the whole experiment exists to prevent.
 *
 * `routed` is therefore a fact about the SESSION (`proxyUrl !== null`), never
 * about an argument. A provider that cannot open a session throws, and the
 * harness records it as a failed sample rather than a quiet direct-egress
 * reading wearing a proxy's name.
 */
export async function sampleEgress(deps: CommandDeps, options: ExperimentOptions, index: number): Promise<Record<string, unknown>> {
  const profile = loadProfileOrThrow(deps, options.profileId);
  const { provider } = selectProvider(options.providerName ?? "direct", {
    env: deps.env,
    ...(deps.probe ? { probe: deps.probe } : {}),
  });
  const opened = await provider.createSession(profile.market, deps.now());
  if (!opened.ok) throw new Error(`could not open a network session: ${opened.reason}`);
  const session = opened.session;
  const routed = session.proxyUrl !== null;
  const runtime = deps.makeRuntime(
    toSessionConfig(profile, {
      sessionId: `exp001-${deps.now()}-${index}`,
      proxyUrl: session.proxyUrl,
      proxyBypass: session.proxyBypass,
      baseEnv: deps.env,
    }),
  );
  try {
    const network = await observeNetwork(runtime, DEFAULT_VERIFY_ENDPOINT);
    const country = compareCountry(profile.market.country, network.country);
    const city = compareCity(profile.market.city, network.city);
    return {
      routed,
      provider: provider.name,
      proxy: redactProxyUrl(session.proxyUrl),
      connected: network.ip !== null,
      ip: network.ip,
      observedCountry: network.country,
      observedCity: network.city,
      org: network.org,
      latencyMs: network.latencyMs,
      countryVerdict: country.verdict,
      cityVerdict: city.verdict,
      countryMatched: country.verdict === "match",
      cityMatched: city.verdict === "match",
    };
  } finally {
    await runtime.close();
    await provider.close(session);
  }
}

/**
 * The honesty rule this whole experiment turns on.
 *
 * With no proxy vendor, every session leaves from this machine. Running the
 * Oslo profile from a Norwegian office then reports `country-match 100% ✓` —
 * a green tick for a capability that does not exist. The country matched
 * because of where the laptop is, not because anything routed anywhere, and
 * the identical run against the Berlin profile would report 0% for the same
 * reason. Neither number measures the system under test.
 *
 * So a direct-egress run reports country and city as UNMEASURED regardless of
 * what was observed. The observations are still written to results.jsonl —
 * they are a real baseline — but they are not allowed to answer the
 * hypothesis. Connection success and latency are still genuinely measured,
 * because those are true of the path we actually used.
 */
export function summariseEgress(samples: ExperimentSample[]): { metrics: MetricResult[]; notes: string[] } {
  const connected = (s: ExperimentSample): boolean => s.data.connected === true;
  const connectedSamples = samples.filter(connected);
  const ips = new Set(connectedSamples.map((s) => String(s.data.ip)));
  const routed = samples.length > 0 && samples.every((s) => s.data.routed === true);

  const geoValue = (key: "countryMatched" | "cityMatched"): number | null => {
    if (!routed) return null;
    return connectedSamples.length === 0 ? null : rate(samples, truthy(key), connected);
  };
  const geoReason = routed ? "no session produced an egress reading" : NO_VENDOR_NOTE;

  const notes = [
    `${ips.size} distinct egress IP(s) across ${connectedSamples.length} connected sample(s): ${[...ips].join(", ")}`,
  ];
  if (!routed) {
    const observedCountries = new Set(connectedSamples.map((s) => String(s.data.observedCountry)));
    const observedCities = new Set(connectedSamples.map((s) => String(s.data.observedCity)));
    notes.push(NO_VENDOR_NOTE);
    notes.push(
      `Baseline only — observed country ${[...observedCountries].join("/")}, city ${[...observedCities].join("/")}. Recorded, but it answers "where is this machine", not "can we reach a requested market".`,
    );
  }

  return {
    metrics: [
      evaluateMetric(metric(EXP_001.metrics, "connection-success"), rate(samples, connected), "no samples ran"),
      evaluateMetric(metric(EXP_001.metrics, "country-match"), geoValue("countryMatched"), geoReason),
      evaluateMetric(metric(EXP_001.metrics, "city-match"), geoValue("cityMatched"), geoReason),
      evaluateMetric(metric(EXP_001.metrics, "latency"), meanOf(samples, (s) => num(s, "latencyMs")), "no latency was measured"),
    ],
    notes,
  };
}

// ── EXP-002: session stability ───────────────────────────────────────────

/** The window the external PRD asks about, and the yardstick for the note. */
export const PRD_STABILITY_WINDOW_MS = 600_000;

/**
 * The default window, and why it is NOT the PRD's ten minutes.
 *
 * Ten minutes per sample is 100 minutes for `--samples 10`, and a feasibility
 * check that takes an hour and a half gets killed halfway — which leaves
 * results.jsonl half-written and no summary at all, the worst of both outcomes.
 * So the cheap window stays the default and the note says loudly which window
 * it measured; the PRD window is a deliberate `--stability-window 10m`
 * when somebody is willing to pay for it. A long default would not be more
 * honest, it would just be unrun.
 */
export const DEFAULT_STABILITY_WINDOW_MS = 24_000;
export const DEFAULT_STABILITY_READS = 5;

/**
 * The EXP-002 knobs, layered onto the shared options.
 *
 * Declared here rather than in `ExperimentOptions` so the shared type does not
 * grow a field per experiment; the sampler states what it reads and any caller
 * that can supply it satisfies the type.
 */
export interface StabilityWindowOptions {
  /** Total wall clock one sample holds a single session open. */
  stabilityWindowMs?: number;
  /** How many egress readings are spread across that window. */
  stabilityReads?: number;
}

export type StabilityOptions = ExperimentOptions & StabilityWindowOptions;

export interface StabilityWindow {
  windowMs: number;
  reads: number;
  intervalMs: number;
}

/**
 * Resolve the window, DERIVING the interval instead of taking one.
 *
 * The window is the claim; the read count is what it costs. Ten minutes at the
 * old fixed 6s spacing would be 101 identity probes per sample, which trips
 * ipinfo's rate limit and quietly converts a stickiness measurement into a
 * throttling measurement. Holding the read count fixed and stretching the
 * spacing means raising the window costs wall clock only.
 *
 * An impossible window REFUSES: a single reading cannot disagree with itself,
 * so `reads < 2` is not a zero-length window, it is no measurement at all, and
 * a zero window would report perfect stability having waited for nothing.
 */
export function resolveStabilityWindow(options: StabilityOptions): StabilityWindow {
  const windowMs = options.stabilityWindowMs ?? DEFAULT_STABILITY_WINDOW_MS;
  const reads = options.stabilityReads ?? DEFAULT_STABILITY_READS;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`stability window must be a positive number of ms, got ${windowMs}`);
  }
  if (!Number.isInteger(reads) || reads < 2) {
    throw new Error(`stability needs at least 2 reads for one to disagree with another, got ${reads}`);
  }
  return { windowMs, reads, intervalMs: windowMs / (reads - 1) };
}

const duration = (ms: number): string => {
  const seconds = ms / 1000;
  return seconds >= 60 ? `${Number((seconds / 60).toFixed(1))}min` : `${Number(seconds.toFixed(1))}s`;
};

/**
 * The note every stability summary carries, stating the window ACTUALLY used.
 *
 * This used to be a constant sentence ending in "24s", which would have become
 * a lie the moment anyone raised the window — and a stale note is worse than no
 * note, because it is the line a reader quotes back as the finding. Both
 * branches name the real window and say plainly whether the PRD's window was
 * covered.
 */
export function stabilityWindowNote(window: StabilityWindow): string {
  const shape = `Each sample held ONE session for ${duration(window.windowMs)} across ${window.reads} reads (one every ${duration(window.intervalMs)}).`;
  if (window.windowMs >= PRD_STABILITY_WINDOW_MS) {
    return `${shape} That covers the ${duration(PRD_STABILITY_WINDOW_MS)} window the PRD asks for. The reads are spaced, not continuous, so a rotation that healed between two of them is still invisible.`;
  }
  return `${shape} The PRD asks for a ${duration(PRD_STABILITY_WINDOW_MS)} window; that is NOT what this measured — pass \`--stability-window 10m\` to measure it. A short window can prove instability but cannot prove stability over a long journey.`;
}

/**
 * One sample = one session, read repeatedly.
 *
 * The question is whether a single journey keeps ONE network identity, so the
 * session must stay open across reads — closing and reopening would measure
 * something else entirely (whether two sessions get the same IP), which is a
 * different and much weaker claim.
 */
export async function sampleStability(deps: CommandDeps, options: StabilityOptions, index: number): Promise<Record<string, unknown>> {
  const window = resolveStabilityWindow(options);
  const profile = loadProfileOrThrow(deps, options.profileId);
  const runtime = deps.makeRuntime(
    toSessionConfig(profile, { sessionId: `exp002-${deps.now()}-${index}`, baseEnv: deps.env }),
  );
  const seen: (string | null)[] = [];
  try {
    for (let read = 0; read < window.reads; read++) {
      if (read > 0) await new Promise((r) => setTimeout(r, window.intervalMs));
      const network = await observeNetwork(runtime, DEFAULT_VERIFY_ENDPOINT);
      seen.push(network.ip);
    }
  } finally {
    await runtime.close();
  }
  const first = seen[0] ?? null;
  const readable = seen.filter((ip): ip is string => ip !== null);
  return {
    // The window travels WITH the sample: a results.jsonl line that does not
    // say how long it watched cannot be interpreted a month later, and two
    // runs at different windows are not comparable observations.
    windowMs: window.windowMs,
    intervalMs: window.intervalMs,
    reads: seen.length,
    readable: readable.length,
    observed: seen,
    distinct: [...new Set(readable)].length,
    // Only meaningful when the FIRST read succeeded; otherwise there is no
    // baseline to be stable against.
    stable: first !== null && readable.length === seen.length && readable.every((ip) => ip === first),
    measurable: first !== null,
  };
}

export function summariseStability(samples: ExperimentSample[], options: StabilityOptions): { metrics: MetricResult[]; notes: string[] } {
  const measurable = (s: ExperimentSample): boolean => s.data.measurable === true;
  const measurableSamples = samples.filter(measurable);
  const notes = [stabilityWindowNote(resolveStabilityWindow(options))];
  const drifted = samples.filter((s) => typeof s.data.distinct === "number" && s.data.distinct > 1);
  if (drifted.length > 0) notes.push(`${drifted.length} sample(s) saw the IP change mid-session`);
  return {
    metrics: [
      evaluateMetric(
        metric(EXP_002.metrics, "ip-stability"),
        measurableSamples.length === 0 ? null : rate(samples, truthy("stable"), measurable),
        "no session produced a first reading to compare against",
      ),
    ],
    notes,
  };
}

// ── EXP-003: session isolation ───────────────────────────────────────────

export async function sampleIsolation(deps: CommandDeps, options: ExperimentOptions, index: number): Promise<Record<string, unknown>> {
  const profile = loadProfileOrThrow(deps, options.profileId);
  const stamp = `${deps.now()}-${index}`;
  const a = deps.makeRuntime(toSessionConfig(profile, { sessionId: `isoA-${stamp}`, baseEnv: deps.env }));
  const b = deps.makeRuntime(toSessionConfig(profile, { sessionId: `isoB-${stamp}`, baseEnv: deps.env }));
  try {
    await a.open(options.url);
    await b.open(options.url);
    await a.evaluate(`document.cookie="geoqa=${stamp};path=/"; localStorage.setItem("geoqa","${stamp}"); "set"`);
    const cookie = await b.evaluate<string>("document.cookie");
    const storage = await b.evaluate<string>('JSON.stringify(localStorage.getItem("geoqa"))');
    const cookieText = cookie.ok ? String(cookie.data) : "";
    const storageText = storage.ok ? String(storage.data) : "";
    return {
      cookieIsolated: !cookieText.includes(stamp),
      storageIsolated: !storageText.includes(stamp),
      observedCookie: cookieText,
      observedStorage: storageText,
    };
  } finally {
    await a.close();
    await b.close();
  }
}

export function summariseIsolation(samples: ExperimentSample[]): { metrics: MetricResult[]; notes: string[] } {
  return {
    metrics: [
      evaluateMetric(metric(EXP_003.metrics, "cookie-isolation"), rate(samples, truthy("cookieIsolated")), "no pairs ran"),
      evaluateMetric(metric(EXP_003.metrics, "storage-isolation"), rate(samples, truthy("storageIsolated")), "no pairs ran"),
    ],
    notes: [],
  };
}

// ── EXP-004: profile consistency ─────────────────────────────────────────

export async function sampleProfileConsistency(deps: CommandDeps, options: ExperimentOptions, index: number): Promise<Record<string, unknown>> {
  const profile = loadProfileOrThrow(deps, options.profileId);
  const initScript = path.join(deps.evidenceRoot, `exp004-${index}-init.js`);
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(path.dirname(initScript), { recursive: true });
  const { localeInitScript } = await import("../geo/profile.js");
  writeFileSync(initScript, localeInitScript(profile));

  const runtime = deps.makeRuntime(
    toSessionConfig(profile, { sessionId: `exp004-${deps.now()}-${index}`, initScriptPath: initScript, baseEnv: deps.env }),
  );
  try {
    await runtime.open(options.url);
    await runtime.setViewport(profile.device.viewport.width, profile.device.viewport.height);
    const observed = await observeBrowser(runtime);
    const language = compareLanguage(profile.market.language, observed.language);
    const timezone = compareTimezone(profile.market.timezone, observed.timezone);
    return {
      languageMatched: language.verdict === "match",
      timezoneMatched: timezone.verdict === "match",
      viewportMatched:
        observed.viewport?.width === profile.device.viewport.width,
      observedLanguage: observed.language,
      observedTimezone: observed.timezone,
      observedViewport: observed.viewport,
      geolocation: observed.geolocation,
    };
  } finally {
    await runtime.close();
  }
}

export function summariseProfileConsistency(samples: ExperimentSample[]): { metrics: MetricResult[]; notes: string[] } {
  const denied = samples.filter((s) => s.data.geolocation === "denied").length;
  const notes: string[] = [];
  if (denied > 0) {
    notes.push(
      `${denied}/${samples.length} sample(s) reported the Geolocation API as DENIED. agent-browser 0.34.0 sets coordinates via \`set geo\` but exposes no permission grant, so the init-script stub is the only way a page can read a position.`,
    );
  }
  return {
    metrics: [
      evaluateMetric(metric(EXP_004.metrics, "language-consistency"), rate(samples, truthy("languageMatched")), "no samples ran"),
      evaluateMetric(metric(EXP_004.metrics, "timezone-consistency"), rate(samples, truthy("timezoneMatched")), "no samples ran"),
      evaluateMetric(metric(EXP_004.metrics, "viewport-consistency"), rate(samples, truthy("viewportMatched")), "no samples ran"),
    ],
    notes,
  };
}

// ── EXP-005: journey stability ───────────────────────────────────────────

export async function sampleJourney(deps: CommandDeps, options: ExperimentOptions): Promise<Record<string, unknown>> {
  const result = await journeyRun(deps, {
    url: options.url,
    profileId: options.profileId,
    journeyId: "landing-page",
    ...(options.providerName ? { providerName: options.providerName } : {}),
  });
  return {
    verdict: result.verdict,
    completed: result.verdict !== "ERROR",
    findings: result.findings.length,
    instrumentationFindings: result.findings.filter((f) => f.category === "instrumentation").length,
    confidence: result.confidence.overall,
    evidenceId: result.evidenceId,
  };
}

export function summariseJourney(samples: ExperimentSample[]): { metrics: MetricResult[]; notes: string[] } {
  const verdicts = samples.map((s) => String(s.data.verdict ?? "THREW"));
  const counts = new Map<string, number>();
  for (const v of verdicts) counts.set(v, (counts.get(v) ?? 0) + 1);
  const commonest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const stability = samples.length === 0 ? null : ((commonest?.[1] ?? 0) / samples.length) * 100;

  return {
    metrics: [
      evaluateMetric(metric(EXP_005.metrics, "journey-completion"), rate(samples, truthy("completed")), "no runs completed"),
      evaluateMetric(metric(EXP_005.metrics, "verdict-stability"), stability, "no runs produced a verdict"),
    ],
    notes: [`verdicts: ${[...counts.entries()].map(([v, n]) => `${v}×${n}`).join(", ")}`],
  };
}

// ── EXP-006: evidence quality ────────────────────────────────────────────

/**
 * One sample = one deliberately broken page, run end to end.
 *
 * The control (`/healthy`) is part of the sample set on purpose. An engine that
 * reports a finding for every page would score 100% on detection while being
 * completely useless, and only a page with nothing wrong exposes that.
 */
export async function sampleEvidenceQuality(deps: CommandDeps, options: ExperimentOptions, index: number): Promise<Record<string, unknown>> {
  const defect = DEFECTS[index % DEFECTS.length] as (typeof DEFECTS)[number];
  const server = await startFixtureServer();
  try {
    const result = await journeyRun(deps, {
      url: `${server.origin}${defect.path}`,
      profileId: options.profileId,
      journeyId: "landing-page",
    });
    const siteFindings = result.findings.filter((f) => f.category !== "instrumentation");
    const categories = [...new Set(siteFindings.map((f) => f.category))];
    const isControl = defect.expects === "unknown";
    return {
      defect: defect.path,
      description: defect.description,
      isControl,
      verdict: result.verdict,
      findings: siteFindings.length,
      categories,
      expectedCategory: defect.expects,
      // The control must produce NOTHING; every other fixture must produce a
      // finding in the category it was built to trigger.
      detected: isControl ? siteFindings.length === 0 : categories.includes(defect.expects),
      evidenceCompleteness: result.confidence.evidence,
      instrumentationFindings: result.findings.length - siteFindings.length,
      evidenceId: result.evidenceId,
    };
  } finally {
    await server.close();
  }
}

export function summariseEvidenceQuality(samples: ExperimentSample[]): { metrics: MetricResult[]; notes: string[] } {
  const missed = samples
    .filter((s) => s.data.detected !== true)
    .map((s) => `${String(s.data.defect)} (expected ${String(s.data.expectedCategory)}, got ${JSON.stringify(s.data.categories)})`);
  const instrumentation = samples.reduce((n, s) => n + (num(s, "instrumentationFindings") ?? 0), 0);

  const notes: string[] = [];
  if (missed.length > 0) notes.push(`undetected: ${missed.join(" | ")}`);
  if (instrumentation > 0) notes.push(`${instrumentation} instrumentation finding(s) — OUR defects, excluded from detection`);
  return {
    metrics: [
      evaluateMetric(metric(EXP_006.metrics, "defect-detection"), rate(samples, truthy("detected")), "no fixtures ran"),
      evaluateMetric(
        metric(EXP_006.metrics, "evidence-completeness"),
        meanOf(samples, (s) => num(s, "evidenceCompleteness")),
        "no evidence was captured",
      ),
    ],
    notes,
  };
}

// ── EXP-007: concurrency ─────────────────────────────────────────────────

/**
 * How many journeys run at once in one sample.
 *
 * Three, not one: `concurrency: 1` is the sequential path the matrix already
 * takes, so a batch of one measures nothing about concurrency. Three is the
 * smallest number where two sessions can contend for the same shared thing
 * while a laptop still holds every browser plus the runner — and a default that
 * OOMs the machine it is meant to measure would answer the question by
 * destroying the evidence.
 */
export const DEFAULT_CONCURRENCY = 3;

export interface ConcurrencyOptions {
  /** How many full runs execute simultaneously in one sample. */
  concurrency?: number;
}

export type ConcurrencyExperimentOptions = ExperimentOptions & ConcurrencyOptions;

/** Why `peak-memory-per-session` is declared and still cannot be evaluated. */
export const NO_MEMORY_PROBE_NOTE =
  "Peak resident memory across the browser process tree is not observable from this process: agent-browser is a separate daemon and Playwright's Chrome is an unsampled child, so `process.memoryUsage()` measures the runner, not the browsers. The target is declared because OOM is the reason concurrency is 1 — it is `unmeasured`, not a pass.";

export function resolveConcurrency(options: ConcurrencyExperimentOptions): number {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 2) {
    throw new Error(`concurrency must be an integer of at least 2 — 1 is the sequential baseline this experiment compares against, got ${concurrency}`);
  }
  return concurrency;
}

/**
 * One profile per concurrent session, starting from the requested one.
 *
 * Each session gets a DIFFERENT profile, because a run id is
 * `run_<ms>_<profileId>` (`newRunId`): two sessions on one profile started in
 * the same millisecond collide on the run id, hence on the browser session name
 * — and agent-browser's daemon is keyed by session name plus launch flags, so
 * the second "session" is silently handed the FIRST browser and the batch
 * measures one browser twice while reporting two. Asking for more sessions than
 * there are profiles REFUSES instead of wrapping into that collision.
 */
export function concurrencyProfiles(deps: CommandDeps, requested: string, count: number): string[] {
  const ids = profileList(deps).profiles.map((p) => p.id);
  const start = Math.max(0, ids.indexOf(requested));
  const ordered = [...ids.slice(start), ...ids.slice(0, start)];
  if (count > ordered.length) {
    throw new Error(`concurrency ${count} exceeds the ${ordered.length} distinct profiles available — two sessions sharing a profile share a run id, and therefore a browser`);
  }
  return ordered.slice(0, count);
}

/** What this experiment can and cannot say about "concurrency". */
export function concurrencyShapeNote(concurrency: number): string {
  return `Measured ${concurrency} FULL RUNS at once — each with its own browser session, profile and evidence package, which is the shape a matrix scheduler would use. It does NOT measure N contexts inside one browser: the Playwright engine gives each context its own proxy, which is what makes concurrency newly possible, but nothing above browser/ opens more than one context per run.`;
}

interface ConcurrentSession {
  profileId: string;
  ok: boolean;
  verdict: string | null;
  durationMs: number | null;
  instrumentationFindings: number | null;
  egressHeld: string | null;
  egressIp: string | null;
  evidenceId: string | null;
  error: string | null;
}

/**
 * One run, and a thrown run recorded rather than rethrown.
 *
 * A session that dies is DATA — the whole question is what happens to N at
 * once, and the one that died is the interesting one. Letting it reject would
 * take its peers' readings with it through `Promise.all` and leave the batch
 * looking like it never happened.
 */
async function runConcurrentSession(
  deps: CommandDeps,
  options: ConcurrencyExperimentOptions,
  profileId: string,
): Promise<ConcurrentSession> {
  try {
    const result = await journeyRun(deps, {
      url: options.url,
      profileId,
      journeyId: "landing-page",
      ...(options.providerName ? { providerName: options.providerName } : {}),
    });
    return {
      profileId,
      ok: true,
      verdict: result.verdict,
      durationMs: result.durationMs,
      instrumentationFindings: result.findings.filter((f) => f.category === "instrumentation").length,
      // `unverified` here means the closing probe was unreadable, which is
      // neither a held identity nor a rotation — the summariser keeps it out of
      // the denominator rather than counting it either way.
      egressHeld: result.geo.network.egressHeld.verdict,
      egressIp: result.geo.network.observed.ip,
      evidenceId: result.evidenceId,
      error: null,
    };
  } catch (e) {
    return {
      profileId,
      ok: false,
      verdict: null,
      durationMs: null,
      instrumentationFindings: null,
      egressHeld: null,
      egressIp: null,
      evidenceId: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** A share inside ONE batch, or null when nothing qualified — `rate()`'s
 *  empty-denominator rule, applied within a sample. */
const shareWithin = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : (numerator / denominator) * 100;

/**
 * One sample = one solo control run, then a batch of N run at once.
 *
 * The control is inside the sample and runs FIRST, alone: a baseline taken
 * while the batch is running is not a baseline, and without one at all
 * "the batch agreed with itself" scores a meaningless 100% — the same reason
 * EXP-006 keeps `/healthy` in its sample set. A control that throws does not
 * void the sample; the batch readings are still real, and the metrics that need
 * a baseline report `unmeasured` for that sample instead.
 *
 * The control and the first batch session deliberately share the requested
 * profile — comparing a mobile solo run against a desktop concurrent one would
 * blame concurrency for a difference the device caused. They cannot collide on a
 * run id despite that, because the control has to finish before the batch
 * starts, and a journey takes seconds.
 */
export async function sampleConcurrency(deps: CommandDeps, options: ConcurrencyExperimentOptions): Promise<Record<string, unknown>> {
  const concurrency = resolveConcurrency(options);
  const profileIds = concurrencyProfiles(deps, options.profileId, concurrency);

  const solo = await runConcurrentSession(deps, options, options.profileId);
  const startedMs = deps.now();
  const sessions = await Promise.all(profileIds.map((id) => runConcurrentSession(deps, options, id)));
  const batchWallClockMs = deps.now() - startedMs;

  const answered = sessions.filter((s) => s.ok);
  const soloDurationMs = solo.ok ? solo.durationMs : null;
  const durations = answered.map((s) => s.durationMs).filter((ms): ms is number => ms !== null && Number.isFinite(ms));
  const meanSessionMs = durations.length === 0 ? null : durations.reduce((a, b) => a + b, 0) / durations.length;
  const decided = answered.filter((s) => s.egressHeld === "match" || s.egressHeld === "mismatch");
  const ips = [...new Set(answered.map((s) => s.egressIp).filter((ip): ip is string => ip !== null))];

  return {
    concurrency,
    profiles: profileIds,
    soloProfile: options.profileId,
    soloOk: solo.ok,
    soloVerdict: solo.verdict,
    soloDurationMs,
    sessions,
    // Recorded, not scored: the acceptance target is per-session cost, and this
    // is what a reader needs to compare the batch against N sequential runs.
    batchWallClockMs,
    completionRate: shareWithin(
      sessions.filter((s) => s.ok && s.verdict !== "ERROR" && s.instrumentationFindings === 0).length,
      sessions.length,
    ),
    // No baseline verdict means no agreement to measure — not agreement of 0%.
    verdictAgreementRate:
      solo.verdict === null ? null : shareWithin(answered.filter((s) => s.verdict === solo.verdict).length, answered.length),
    egressHeldRate: shareWithin(decided.filter((s) => s.egressHeld === "match").length, decided.length),
    meanSessionMs,
    wallClockFactor:
      soloDurationMs === null || soloDurationMs <= 0 || meanSessionMs === null ? null : meanSessionMs / soloDurationMs,
    // Recorded as an explicit null: unread is not zero, and a missing field
    // would read as "nothing to say about memory" a month from now.
    peakMemoryMbPerSession: null,
    distinctEgressIps: ips.length,
    egressIps: ips,
    errors: sessions.filter((s) => !s.ok).map((s) => `${s.profileId}: ${String(s.error)}`),
  };
}

export function summariseConcurrency(samples: ExperimentSample[], options: ConcurrencyExperimentOptions): { metrics: MetricResult[]; notes: string[] } {
  const notes = [concurrencyShapeNote(resolveConcurrency(options)), NO_MEMORY_PROBE_NOTE];
  const errors = samples.flatMap((s) => (Array.isArray(s.data.errors) ? (s.data.errors as string[]) : []));
  if (errors.length > 0) notes.push(`${errors.length} session(s) never returned a run: ${[...new Set(errors)].join(" | ")}`);

  // Sessions sharing one egress identity is the expected shape on direct
  // egress and says nothing about concurrency — so it is a note, never a score.
  const shared = samples.filter((s) => num(s, "distinctEgressIps") === 1 && (num(s, "concurrency") ?? 0) > 1);
  if (shared.length > 0) {
    notes.push(
      `${shared.length} batch(es) saw ONE egress IP across every concurrent session. Expected without a proxy vendor — it means per-session network identity was not exercised, not that it failed.`,
    );
  }

  return {
    metrics: [
      evaluateMetric(metric(EXP_007.metrics, "concurrent-completion"), meanOf(samples, (s) => num(s, "completionRate")), "no batch reported a session"),
      evaluateMetric(
        metric(EXP_007.metrics, "verdict-agreement"),
        meanOf(samples, (s) => num(s, "verdictAgreementRate")),
        "no batch had a solo baseline to agree with",
      ),
      evaluateMetric(
        metric(EXP_007.metrics, "egress-identity-held"),
        meanOf(samples, (s) => num(s, "egressHeldRate")),
        "no session's closing egress probe could be read — an unread probe is not a held identity",
      ),
      evaluateMetric(
        metric(EXP_007.metrics, "wall-clock-factor"),
        meanOf(samples, (s) => num(s, "wallClockFactor")),
        "no batch had a solo baseline to compare its wall clock against",
      ),
      evaluateMetric(metric(EXP_007.metrics, "peak-memory-per-session"), meanOf(samples, (s) => num(s, "peakMemoryMbPerSession")), NO_MEMORY_PROBE_NOTE),
    ],
    notes,
  };
}

// ── registry ─────────────────────────────────────────────────────────────

export interface SamplerPair {
  sample: (deps: CommandDeps, options: ExperimentOptions, index: number) => Promise<Record<string, unknown>>;
  summarise: (samples: ExperimentSample[], options: ExperimentOptions) => { metrics: MetricResult[]; notes: string[] };
}

/**
 * The per-experiment knobs, off the command line.
 *
 * Parsed here rather than in `args.ts` because the knob types live here: an
 * experiment states what it reads, and `ExperimentOptions` does not grow a field
 * per experiment. `args.ts` cannot import this file either way — `samplers` →
 * `commands` → `args` already, and dependency-cruiser refuses the cycle.
 *
 * Unreadable REFUSES. The alternative is what shipped: nothing reached
 * `stabilityWindowMs`, so EXP-002 measured 24 seconds while the PRD asked for
 * ten minutes, and a `--stability-window 10m` that fell back to the default
 * would have produced the same 24-second answer with a caller convinced they had
 * asked for ten minutes. `resolveStabilityWindow` and `resolveConcurrency`
 * already refuse impossible values; this refuses unparseable ones, which is the
 * same rule one layer out.
 */
export function experimentKnobs(args: ParsedArgs): {
  ok: true;
  knobs: StabilityWindowOptions & ConcurrencyOptions;
} | { ok: false; errors: string[] } {
  const knobs: StabilityWindowOptions & ConcurrencyOptions = {};
  const errors: string[] = [];

  const window = args.flags["stability-window"];
  if (typeof window === "string") {
    const ms = parseDurationMs(window);
    if (ms === null) errors.push(`--stability-window "${window}" is not a duration — try 600000, 600s or 10m`);
    else knobs.stabilityWindowMs = ms;
  } else if (window === true) {
    errors.push("--stability-window needs a duration, e.g. --stability-window 10m");
  }

  const reads = args.flags["stability-reads"];
  if (typeof reads === "string") {
    const n = Number(reads);
    if (!Number.isInteger(n)) errors.push(`--stability-reads "${reads}" is not a whole number`);
    else knobs.stabilityReads = n;
  } else if (reads === true) {
    errors.push("--stability-reads needs a number");
  }

  // Shared spelling with `matrix run --concurrency`, and deliberately so: both
  // mean "how many full runs at once". EXP-007 exists to tell the matrix what its
  // bound should be, and two names for one quantity is how the answer stops
  // being applied to the question.
  const concurrency = args.flags["concurrency"];
  if (typeof concurrency === "string") {
    const n = Number(concurrency);
    if (!Number.isInteger(n)) errors.push(`--concurrency "${concurrency}" is not a whole number`);
    else knobs.concurrency = n;
  } else if (concurrency === true) {
    errors.push("--concurrency needs a number");
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, knobs };
}

export const SAMPLERS: Record<string, SamplerPair> = {
  [EXP_000.id]: { sample: sampleBrowserPrimitives, summarise: summariseBrowserPrimitives },
  [EXP_001.id]: { sample: sampleEgress, summarise: summariseEgress },
  [EXP_002.id]: { sample: sampleStability, summarise: summariseStability },
  [EXP_003.id]: { sample: sampleIsolation, summarise: summariseIsolation },
  [EXP_004.id]: { sample: sampleProfileConsistency, summarise: summariseProfileConsistency },
  [EXP_005.id]: { sample: sampleJourney, summarise: summariseJourney },
  [EXP_006.id]: { sample: sampleEvidenceQuality, summarise: summariseEvidenceQuality },
  [EXP_007.id]: { sample: sampleConcurrency, summarise: summariseConcurrency },
};
