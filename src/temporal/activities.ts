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
import { mergeAttempts, occurrenceKey, withExtraStep, type JourneyResult } from "../journeys/engine.js";
import type { EvidenceManifest } from "../evidence/manifest.js";
import type { GeoQaRunResult } from "../findings/types.js";
import { selectProvider } from "../network/provider.js";
import { buildRuntime, resolveVisitorState, writeInitScript, type RunSpec } from "../run/context.js";
import { prepareRun } from "../run/execute.js";
import { noteProviderOutcome } from "../network/provider.js";
import { appendRun } from "../history/store.js";
import { withEgressHeld } from "../geo/verify.js";
import { toRunRecord } from "../history/records.js";
import {
  applyDeviceProfile,
  assembleResult,
  closeEgress,
  collectEvidence,
  pruneUnlistedHar,
  repeatJourney,
  type RepeatedJourney,
  StageError,
  verifyEnvironment,
} from "../run/stages.js";

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
  const runtime = buildRuntime(spec, profile);
  await applyDeviceProfile(runtime, profile);
  return verifyEnvironment(runtime, profile, spec.verifyEndpoint, spec.corroborateGeo);
}

/**
 * The journey, N times, merged — through the SHARED `repeatJourney`.
 *
 * The repeat logic is not written here. It lives in `run/stages.ts` and `executeRun` calls the
 * same function, because a hand-mirrored copy is exactly how this path came to run one attempt
 * per scenario while the local one ran N (gaps B-4). An activity stays a thin wrapper that news
 * up a runtime and delegates; the judgement it delegates to is covered.
 */
export async function runJourneyActivity(args: RunJourneyArgs | RunSpec): Promise<RepeatedJourney> {
  // A bare spec is the pre-repeat argument shape. Accepted so a workflow that was mid-flight
  // when this shipped replays against its own history instead of failing permanently.
  const spec = "spec" in args ? args.spec : args;
  const journey = loadJourney(spec.journeyPath);
  if (!journey.ok) throw new StageError(`invalid journey: ${journey.errors.join("; ")}`, "load");
  return repeatJourney(buildRuntime(spec, profileOf(spec)), spec, journey.value, "spec" in args ? args.repeat : 1);
}

export interface RunJourneyArgs {
  spec: RunSpec;
  repeat?: number;
}



/**
 * Did the egress hold for the whole run?
 *
 * A durable run never asked. `executeRun` has closed every run with this since Phase 0 — it is
 * how "one journey is one network session" is VERIFIED rather than assumed — and the durable
 * path simply did not have the step, so a rotating exit mid-run was invisible there. A run whose
 * network moved under it can attribute nothing it observed to the site, and reporting a clean
 * verdict for one is the exact failure the whole engine is built to refuse.
 *
 * Its own activity, after the journey and before evidence, mirroring `executeRun`'s order. The
 * opening IP comes from the geo verification the workflow already holds, so this does not
 * re-observe it — two readings of the opening IP could disagree, and then neither is the one
 * the run started with.
 */
export interface EgressHeldArgs {
  spec: RunSpec;
  geo: GeoVerification;
  ran: RepeatedJourney;
}

/**
 * The closing egress check, through the SHARED `closeEgress`.
 *
 * The merging happens in `run/stages.ts`, not here — same reason as above, plus a sandbox one:
 * `withExtraStep` reaches `spec.ts` and therefore zod and the filesystem, and workflow code is
 * bundled into a deterministic V8 sandbox. An activity is ordinary Node and has no such limit,
 * which is why the fold belongs on this side of the boundary rather than in the workflow.
 */
export async function verifyEgressHeldActivity(args: EgressHeldArgs): Promise<Awaited<ReturnType<typeof closeEgress>>> {
  const runtime = buildRuntime(args.spec, profileOf(args.spec));
  return closeEgress(runtime, args.spec, args.geo, args.ran);
}

export interface CollectArgs {
  spec: RunSpec;
  geo: GeoVerification;
  journey: JourneyResult;
  createdAt: string;
  /** Present only for a repeated run, so a single one records nothing rather than a bare `1`. */
  reproducibility?: { attempts: number; occurrences: Record<string, number> };
}

export async function collectEvidenceActivity(args: CollectArgs): Promise<EvidenceManifest> {
  const profile = profileOf(args.spec);
  // What kind of visitor this run ACTUALLY tested — absent from durable evidence until now, so a
  // durable run recorded `visitorType: returning` off the profile whether or not a session was
  // restored. The declaration is an intention; `restored` is an observation, and only one of
  // them is evidence (gaps B-7).
  const visitor = resolveVisitorState(args.spec, profile);
  return collectEvidence(buildRuntime(args.spec, profile), {
    spec: args.spec,
    profile,
    geo: args.geo,
    journey: args.journey,
    createdAt: args.createdAt,
    visitor: { declared: profile.visitorType, restored: visitor.restored, unmet: visitor.unmet },
    ...(args.reproducibility ? { reproducibility: args.reproducibility } : {}),
  });
}

export interface AssembleArgs extends CollectArgs {
  manifest: EvidenceManifest | null;
  durationMs: number;
  /** Turns a finding from `observed` into `reproduced`. Absent means a single observation. */
  attempts?: number;
  occurrences?: Record<string, number>;
}

/**
 * The two things `executeRun` does AFTER a result exists, and the durable path did neither.
 *
 * **The cooldown write** (gaps B-1): the durable path READ cooldowns through `prepare` and never
 * wrote one, so a vendor that failed a durable sweep was never frozen and the next scenario
 * tried it again. A store that only reads is not a store. The success path clears, unchanged,
 * because one that only ever adds freezes a vendor that recovered.
 *
 * **The history append** (unrecorded until now): a durable run never entered `runs.jsonl`, so it
 * was invisible to `geoqa runs`, to the trends, and to regression detection — a sweep that
 * happened and left no trace in the one place a human looks across runs. Failure to append is
 * logged and never fails the run, exactly as in `executeRun`: the index is a derived cache, and
 * `geoqa runs rebuild` reconstructs it from the evidence on disk.
 */
export interface RecordArgs {
  spec: RunSpec;
  result: GeoQaRunResult;
  providerName: string;
  /** The country axis's verdict decides whether this counts as the provider succeeding. */
  egressWasRight: boolean;
  nowMs: number;
  cooldownPath?: string;
  cooldownMs?: number;
  tenantId?: string | null;
  seed: number;
  vitals?: { lcp: number | null; cls: number | null; ttfb: number | null; inp: number | null };
}

export async function recordOutcome(args: RecordArgs): Promise<string | null> {
  noteProviderOutcome(args.providerName, args.egressWasRight, args.nowMs, {
    ...(args.cooldownPath ? { cooldownPath: args.cooldownPath } : {}),
    ...(args.cooldownMs !== undefined ? { cooldownMs: args.cooldownMs } : {}),
  });
  return appendRun(
    args.spec.evidenceRoot,
    toRunRecord(args.result, {
      tenantId: args.tenantId ?? null,
      seed: args.seed,
      engine: args.spec.engine,
      ...(args.vitals ? { vitals: args.vitals } : {}),
    }),
  );
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
    ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
    ...(args.occurrences !== undefined ? { occurrences: args.occurrences } : {}),
  });
}

/** Always runs, even when the run failed — a leaked browser outlives the run. */
/**
 * Close the browser AND remove a HAR the manifest does not retain.
 *
 * The prune is not optional tidying. `harPath` is armed on every run — it cannot be started
 * retroactively for the run that turns out to need one — and Playwright flushes it at close
 * whether anything asked or not, so a PASSING run leaves a full network recording on disk that
 * no manifest lists. Unlisted is the worse half: pruning walks the manifest, so nothing would
 * ever remove it. See gaps B-3.
 *
 * **This divergence was introduced by the fix for B-3 itself**, which added the prune to
 * `executeRun`'s `finally` and not here — because nothing could start a durable run at the time,
 * so nothing exercised the omission. That is the shape of every entry in gaps D-5: an
 * improvement to one execution mode that the other silently did not receive.
 *
 * The manifest is passed in rather than re-read: `collectEvidence` already returned it to the
 * workflow, and re-reading it from disk would make this activity fail for a run whose evidence
 * directory was already pruned.
 */
export interface CloseArgs {
  spec: RunSpec;
  /** Null when the run never got as far as collecting — which `pruneUnlistedHar` reads as "keeps no HAR". */
  manifest: EvidenceManifest | null;
}

export async function closeSession(args: CloseArgs | RunSpec): Promise<string | null> {
  // Accepts a bare spec as well as the argument object, because a workflow that was mid-flight
  // when this shipped replays with the OLD argument shape — and a replay that threw on its own
  // history would turn a completed run into a permanent failure.
  const spec = "spec" in args ? args.spec : args;
  const manifest = "spec" in args ? args.manifest : null;
  await buildRuntime(spec, profileOf(spec)).close();
  return pruneUnlistedHar(spec, manifest);
}
