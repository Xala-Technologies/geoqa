/**
 * One run, start to finish, in a single process.
 *
 * This is the shape the user asked for and the one agent-fleet's delivery loop
 * failed to have: **the agent starts one thing and finishes it end to end.**
 * There is no persisted intermediate state between stages that a separate
 * scheduled process has to pick up later, so there is nothing to orphan when
 * this process dies. The Temporal workflow adds durability and retries ON TOP
 * of exactly these stages; it does not replace them, and Phase 0 experiments
 * run without it.
 */
import { loadGeoProfile } from "../geo/profile.js";
import type { GeoProfile } from "../geo/types.js";
import type { GeoNetworkProvider } from "../network/types.js";
import { noteProviderOutcome } from "../network/provider.js";
import type { GeoQaRunResult } from "../findings/types.js";
import { buildRuntime, newRunId, writeInitScript, type RunSpec } from "./context.js";
import {
  applyDeviceProfile,
  assembleResult,
  collectEvidence,
  executeJourney,
  loadInputs,
  StageError,
  verifyEnvironment,
} from "./stages.js";

export interface ExecuteOptions {
  spec: RunSpec;
  provider: GeoNetworkProvider;
  now?: () => number;
  log?: (line: string) => void;
  cooldownPath?: string;
  /** Skip closing the browser — used when a caller reuses the session. */
  keepOpen?: boolean;
}

export interface PrepareResult {
  spec: RunSpec;
  profile: GeoProfile;
  warnings: string[];
}

/**
 * Resolve the network session and write the init script, producing the final
 * `RunSpec` the stages will use.
 *
 * A provider that cannot serve the market is a HARD failure, not a silent
 * downgrade to direct egress. Falling back would produce a run that looks like
 * a Berlin run, carries a full evidence package, and was actually executed from
 * Norway — the single most dangerous output this system could produce.
 */
export async function prepareRun(
  base: Omit<RunSpec, "proxyUrl" | "proxyBypass" | "initScriptPath">,
  provider: GeoNetworkProvider,
  nowMs: number,
): Promise<PrepareResult> {
  const loaded = loadGeoProfile(base.profilePath);
  if (!loaded.ok) throw new StageError(`invalid profile: ${loaded.errors.join("; ")}`, "prepare");
  const profile = loaded.value;
  const warnings: string[] = [];

  const health = await provider.health(nowMs);
  if (health.state === "unusable") {
    throw new StageError(`network provider "${provider.name}" is unusable: ${health.detail}`, "network");
  }
  if (health.state === "unconfigured" && provider.name !== "direct") {
    throw new StageError(`network provider "${provider.name}" is not configured: ${health.detail}`, "network");
  }

  const session = await provider.createSession(profile.market, nowMs);
  if (!session.ok) throw new StageError(`could not open a network session: ${session.reason}`, "network");
  if (session.session.proxyUrl === null && provider.name === "direct") {
    warnings.push(
      `egress is DIRECT — this run leaves from this machine's own network, not from ${profile.market.city}. Geographic claims are unproven.`,
    );
  }

  const initScriptPath = writeInitScript(base, profile);
  return {
    spec: {
      ...base,
      proxyUrl: session.session.proxyUrl,
      proxyBypass: session.session.proxyBypass,
      initScriptPath,
    },
    profile,
    warnings,
  };
}

/** The whole run. */
export async function executeRun(options: ExecuteOptions): Promise<GeoQaRunResult> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => {});
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();

  const { profile, journey } = loadInputs(options.spec);
  if (!journey.ok) throw new StageError(journey.errors.join("; "), "load");
  const runtime = buildRuntime(options.spec, profile);

  try {
    // Before anything is observed: a profile that never applied its device
    // measures a different layout than the one it claims to.
    for (const warning of await applyDeviceProfile(runtime, profile)) log(`warning: ${warning}`);

    log(`geo: verifying both axes for ${profile.id}`);
    const geo = await verifyEnvironment(runtime, profile, options.spec.verifyEndpoint);
    log(`geo: confidence ${geo.confidence}${geo.trustworthy ? "" : " (not fully verified)"}`);

    // A verified-wrong egress records a provider failure. A verified-right one
    // CLEARS the cooldown — the rule that stops a recovered vendor staying
    // frozen forever.
    noteProviderOutcome(options.provider.name, geo.network.country.verdict !== "mismatch", now(), {
      ...(options.cooldownPath ? { cooldownPath: options.cooldownPath } : {}),
    });

    log(`journey: ${journey.value.id}`);
    const result = await executeJourney(runtime, options.spec, journey.value, log);

    log(`evidence: collecting for verdict ${result.verdict}`);
    const manifest = await collectEvidence(runtime, {
      spec: options.spec,
      profile,
      geo,
      journey: result,
      createdAt: startedAt,
    });

    return assembleResult({
      spec: options.spec,
      profile,
      geo,
      journey: result,
      manifest,
      startedAt,
      durationMs: now() - startedMs,
    });
  } finally {
    if (!options.keepOpen) await runtime.close();
  }
}

export { newRunId };
