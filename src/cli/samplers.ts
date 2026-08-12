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
import { EXP_000, EXP_001, EXP_003, EXP_004, EXP_005 } from "../experiments/definitions.js";
import { browserVerify, journeyRun, loadProfileOrThrow, type CommandDeps, type ExperimentOptions } from "./commands.js";

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

export async function sampleEgress(deps: CommandDeps, options: ExperimentOptions, index: number): Promise<Record<string, unknown>> {
  const profile = loadProfileOrThrow(deps, options.profileId);
  const runtime = deps.makeRuntime(
    toSessionConfig(profile, { sessionId: `exp001-${deps.now()}-${index}`, baseEnv: deps.env }),
  );
  try {
    const network = await observeNetwork(runtime, DEFAULT_VERIFY_ENDPOINT);
    const country = compareCountry(profile.market.country, network.country);
    const city = compareCity(profile.market.city, network.city);
    return {
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
  }
}

export function summariseEgress(samples: ExperimentSample[]): { metrics: MetricResult[]; notes: string[] } {
  const connected = (s: ExperimentSample): boolean => s.data.connected === true;
  const connectedSamples = samples.filter(connected);
  const ips = new Set(connectedSamples.map((s) => String(s.data.ip)));

  return {
    metrics: [
      evaluateMetric(metric(EXP_001.metrics, "connection-success"), rate(samples, connected), "no samples ran"),
      evaluateMetric(
        metric(EXP_001.metrics, "country-match"),
        connectedSamples.length === 0 ? null : rate(samples, truthy("countryMatched"), connected),
        "no session produced an egress reading",
      ),
      evaluateMetric(
        metric(EXP_001.metrics, "city-match"),
        connectedSamples.length === 0 ? null : rate(samples, truthy("cityMatched"), connected),
        "no session produced an egress reading",
      ),
      evaluateMetric(metric(EXP_001.metrics, "latency"), meanOf(samples, (s) => num(s, "latencyMs")), "no latency was measured"),
    ],
    notes: [
      `${ips.size} distinct egress IP(s) across ${connectedSamples.length} connected sample(s): ${[...ips].join(", ")}`,
    ],
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

// ── registry ─────────────────────────────────────────────────────────────

export interface SamplerPair {
  sample: (deps: CommandDeps, options: ExperimentOptions, index: number) => Promise<Record<string, unknown>>;
  summarise: (samples: ExperimentSample[], options: ExperimentOptions) => { metrics: MetricResult[]; notes: string[] };
}

export const SAMPLERS: Record<string, SamplerPair> = {
  [EXP_000.id]: { sample: sampleBrowserPrimitives, summarise: summariseBrowserPrimitives },
  [EXP_001.id]: { sample: sampleEgress, summarise: summariseEgress },
  [EXP_003.id]: { sample: sampleIsolation, summarise: summariseIsolation },
  [EXP_004.id]: { sample: sampleProfileConsistency, summarise: summariseProfileConsistency },
  [EXP_005.id]: { sample: sampleJourney, summarise: summariseJourney },
};
