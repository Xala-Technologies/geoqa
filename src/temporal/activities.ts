/**
 * Activities — every piece of real I/O in a run.
 *
 * Each one is a thin wrapper that rebuilds its browser handle from the
 * serialised `RunSpec` and delegates to a stage in `src/run/stages.ts`. The
 * judgement lives there, at 100% coverage; this file is deliberately dumb, and
 * is coverage-excluded for that reason.
 *
 * Rebuilding the runtime per activity is not a workaround — it is the correct
 * model here. agent-browser is a daemon, so the browser survives between
 * activities and is addressed by its launch flags rather than held as a handle.
 * An activity that tried to carry a live object across a Temporal boundary
 * could not be retried, which is the entire reason for using Temporal.
 */
import { loadGeoProfile } from "../geo/profile.js";
import type { GeoVerification } from "../geo/types.js";
import { loadJourney } from "../journeys/spec.js";
import type { JourneyResult } from "../journeys/engine.js";
import type { EvidenceManifest } from "../evidence/manifest.js";
import type { GeoQaRunResult } from "../findings/types.js";
import { selectProvider } from "../network/provider.js";
import { buildRuntime, writeInitScript, type RunSpec } from "../run/context.js";
import { prepareRun } from "../run/execute.js";
import { assembleResult, collectEvidence, executeJourney, StageError, verifyEnvironment } from "../run/stages.js";

const profileOf = (spec: RunSpec) => {
  const loaded = loadGeoProfile(spec.profilePath);
  if (!loaded.ok) throw new StageError(`invalid profile: ${loaded.errors.join("; ")}`, "load");
  return loaded.value;
};

export interface PrepareArgs {
  base: Omit<RunSpec, "proxyUrl" | "proxyBypass" | "initScriptPath">;
  providerName: string;
  cooldownPath?: string;
}

export async function prepare(args: PrepareArgs): Promise<{ spec: RunSpec; warnings: string[] }> {
  const { provider, warning } = selectProvider(args.providerName, {
    ...(args.cooldownPath ? { cooldownPath: args.cooldownPath } : {}),
  });
  const prepared = await prepareRun(args.base, provider, Date.now());
  return { spec: prepared.spec, warnings: warning ? [warning, ...prepared.warnings] : prepared.warnings };
}

export async function verifyGeoActivity(spec: RunSpec): Promise<GeoVerification> {
  const profile = profileOf(spec);
  // The init script may not exist if `prepare` ran on another worker; writing
  // it is idempotent and cheap, and its absence would silently change the
  // browser's launch identity.
  if (spec.initScriptPath) writeInitScript(spec, profile);
  return verifyEnvironment(buildRuntime(spec, profile), profile, spec.verifyEndpoint);
}

export async function runJourneyActivity(spec: RunSpec): Promise<JourneyResult> {
  const profile = profileOf(spec);
  const journey = loadJourney(spec.journeyPath);
  if (!journey.ok) throw new StageError(`invalid journey: ${journey.errors.join("; ")}`, "load");
  return executeJourney(buildRuntime(spec, profile), spec, journey.value);
}

export interface CollectArgs {
  spec: RunSpec;
  geo: GeoVerification;
  journey: JourneyResult;
  createdAt: string;
}

export async function collectEvidenceActivity(args: CollectArgs): Promise<EvidenceManifest> {
  const profile = profileOf(args.spec);
  return collectEvidence(buildRuntime(args.spec, profile), {
    spec: args.spec,
    profile,
    geo: args.geo,
    journey: args.journey,
    createdAt: args.createdAt,
  });
}

export interface AssembleArgs extends CollectArgs {
  manifest: EvidenceManifest | null;
  durationMs: number;
}

/**
 * Async despite doing no I/O: Temporal's `proxyActivities` type only accepts
 * members that return a Promise, and a sync member makes the whole namespace
 * unproxyable rather than just that one function.
 */
export async function assemble(args: AssembleArgs): Promise<GeoQaRunResult> {
  return assembleResult({
    spec: args.spec,
    profile: profileOf(args.spec),
    geo: args.geo,
    journey: args.journey,
    manifest: args.manifest,
    startedAt: args.createdAt,
    durationMs: args.durationMs,
  });
}

/** Always runs, even when the run failed — a leaked browser outlives the run. */
export async function closeSession(spec: RunSpec): Promise<void> {
  await buildRuntime(spec, profileOf(spec)).close();
}
