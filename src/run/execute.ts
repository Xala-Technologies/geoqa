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
import { withEgressHeld } from "../geo/verify.js";
import { mergeAttempts, withExtraStep, type JourneyResult } from "../journeys/engine.js";
import type { GeoQaRunResult } from "../findings/types.js";
import { buildRuntime, newRunId, writeInitScript, type RunSpec } from "./context.js";
import {
  applyDeviceProfile,
  assembleResult,
  collectEvidence,
  executeJourney,
  loadInputs,
  StageError,
  verifyEgressHeld,
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
  /**
   * How many times to run the journey. Default 1, clamped to at least 1.
   *
   * This is the mechanism the design uses INSTEAD of retrying. The journey never
   * silently runs a second time to get a green result; a repeat is asked for
   * explicitly, every attempt is kept, and the merge reports the worst reading of
   * each step together with how often it happened.
   */
  repeat?: number;
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

    // Record a trace from the start and keep it only if the verdict earns one.
    //
    // Tracing has to be armed BEFORE the first navigation, but the retention
    // tier is not known until the journey has finished — so the choice is
    // "record always, keep on failure" or "never have a trace when it matters".
    // `collectEvidence` calls `traceStop` for the fail and investigation tiers
    // only, so a passing run's trace is simply never written. Previously nothing
    // started tracing at all, and every fail-tier `trace.json` landed at zero
    // bytes: the manifest correctly reported 88% completeness for the one tier
    // whose whole purpose is making a non-reproducing bug diagnosable.
    const tracing = await runtime.traceStart();
    if (!tracing.ok) log(`warning: tracing unavailable — ${tracing.failure.detail}`);

    log(`geo: verifying both axes for ${profile.id}`);
    const geo = await verifyEnvironment(runtime, profile, options.spec.verifyEndpoint);
    log(`geo: confidence ${geo.confidence}${geo.trustworthy ? "" : " (not fully verified)"}`);

    // A verified-wrong egress records a provider failure. A verified-right one
    // CLEARS the cooldown — the rule that stops a recovered vendor staying
    // frozen forever.
    noteProviderOutcome(options.provider.name, geo.network.country.verdict !== "mismatch", now(), {
      ...(options.cooldownPath ? { cooldownPath: options.cooldownPath } : {}),
    });

    /**
     * Repeats happen INSIDE one browser and one network session, which is why
     * this does not violate "one journey is one network session": all N attempts
     * are the same visitor, and `verifyEgressHeld` still spans the whole set. A
     * repeat that opened a fresh session per attempt would take LCP from one
     * visitor and CLS from another, and nothing measured could be attributed.
     *
     * Each attempt gets `spec.seed + attemptIndex`, so the attempts pace and
     * choose their optional steps DIFFERENTLY — running the identical sequence N
     * times measures the site's flakiness under one pacing, not its flakiness —
     * while the whole set stays reproducible from the one base seed.
     */
    const repeat = Math.max(1, Math.floor(options.repeat ?? 1));

    // A journey that registers an account, sends a contact form or completes a
    // booking creates real records on a live product. That must be stated before
    // it happens, not discovered in the evidence afterwards — and with --repeat
    // it happens once PER ATTEMPT, which is the number a human needs before
    // sending three contact forms to measure whether one of them flakes.
    if (journey.value.writes) {
      const times = repeat > 1 ? ` ${repeat} TIMES` : "";
      log(`journey: ${journey.value.id} DECLARES WRITES — this run will change state on ${options.spec.target}${times}`);
    }
    log(`journey: ${journey.value.id} (seed ${options.spec.seed})`);
    if (repeat > 1) log(`journey: ${repeat} attempts in ONE session — repeats MEASURE flakiness, they never mask it`);

    const attempt = async (index: number): Promise<JourneyResult> => {
      const seed = options.spec.seed + index;
      const outcome = await executeJourney(runtime, { ...options.spec, seed }, journey.value, log);
      if (repeat > 1) log(`journey: attempt ${index + 1}/${repeat} (seed ${seed}) → ${outcome.verdict}`);
      return outcome;
    };

    const attempts: [JourneyResult, ...JourneyResult[]] = [await attempt(0)];
    for (let index = 1; index < repeat; index++) attempts.push(await attempt(index));
    const merged = mergeAttempts(attempts);

    // One journey must be one network session. Confirm that it was, before the
    // verdict is used to pick a retention tier.
    const held = await verifyEgressHeld(
      runtime,
      options.spec.verifyEndpoint,
      geo.network.observed.ip,
      merged.result.steps.length,
      now,
    );
    const verifiedGeo = withEgressHeld(geo, held.axis);
    const result = held.step === null ? merged.result : withExtraStep(merged.result, held.step);
    if (held.step !== null) log(`egress: ${held.axis.reasons.join("; ")}`);

    log(`evidence: collecting for verdict ${result.verdict}`);
    const manifest = await collectEvidence(runtime, {
      spec: options.spec,
      profile,
      geo: verifiedGeo,
      journey: result,
      createdAt: startedAt,
    });

    return assembleResult({
      spec: options.spec,
      profile,
      geo: verifiedGeo,
      journey: result,
      manifest,
      startedAt,
      durationMs: now() - startedMs,
      // Reproducibility, finally fed. Until this was plumbed every finding in
      // every real run was `observed` at a flat confidence, and `reproduced` was
      // unreachable from the CLI — the mechanism the design uses instead of
      // retrying existed and nothing ever called it.
      attempts: attempts.length,
      occurrences: {
        ...merged.occurrences,
        // A whole-run check is measured ONCE for the whole set, not once per
        // attempt, so it must not be discounted as "seen in 1 of 3": it was seen
        // in the only measurement there was.
        ...(held.step ? { [held.step.label]: attempts.length } : {}),
      },
    });
  } finally {
    if (!options.keepOpen) await runtime.close();
  }
}

export { newRunId };
