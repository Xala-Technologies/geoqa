/**
 * Workflows. Runs inside Temporal's deterministic V8 sandbox: no I/O here, only
 * orchestration of Activities.
 *
 * **One run = one workflow execution, start to finish.** This is the direct
 * answer to the architecture that failed in agent-fleet, where a run was split
 * across two independently-scheduled processes with persisted state between
 * them — and any crash in the middle orphaned that state with no record it had
 * ever existed (90 of 106 live worktrees, one incident). Here there is no
 * intermediate state a separate timer must later pick up. If this process dies,
 * Temporal resumes the same execution from its history.
 *
 * That history is also the audit trail, which answers a second failure this
 * repo has recorded: a run that silently dropped all its work used to look
 * identical to an idle one. It cannot here — every Activity, every retry and
 * every failure is in the execution history whether or not anything reported it.
 */
import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities.js";
import type { GeoQaRunResult } from "../findings/types.js";
import type { EvidenceManifest } from "../evidence/manifest.js";
import type { RunSpec } from "../run/context.js";
// A VALUE import, and the only one this file makes outside the Temporal SDK. `run/pool.ts` has
// no imports of its own, so it carries nothing into the workflow sandbox — which is exactly why
// the pool lives there rather than in `run/matrix.ts`.
import { boundedPool, resolveConcurrency } from "../run/pool.js";

/**
 * Network setup retries readily: a proxy vendor refusing one connection is the
 * textbook transient failure, and re-asking costs a second.
 */
const { prepare } = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3, initialInterval: "2 seconds" },
});

/**
 * Geo verification retries too — it is two page loads — but fewer times. A
 * verification that keeps failing is usually telling the truth about the
 * network, and burning six attempts to hear it again wastes the run's budget.
 */
const { verifyGeoActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "3 minutes",
  retry: { maximumAttempts: 2, initialInterval: "5 seconds" },
});

/**
 * The journey does NOT retry. It is the measurement, and a silent second
 * attempt would quietly convert a real intermittent site failure into a pass —
 * destroying the one signal the run exists to produce. Flakiness is measured by
 * running the journey N times ON PURPOSE and reporting the rate, never by
 * retrying until it is green.
 */
const { runJourneyActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 1 },
});

/**
 * The closing egress check and the run's bookkeeping.
 *
 * Retried twice like the other reads: an unreadable closing probe is our defect and worth one
 * more attempt, and `recordOutcome` writes a cooldown and a history line, both of which are
 * derived caches — `geoqa runs rebuild` reconstructs the second from the evidence on disk.
 */
const { verifyEgressHeldActivity, recordOutcome } = proxyActivities<typeof activities>({
  startToCloseTimeout: "3 minutes",
  retry: { maximumAttempts: 2, initialInterval: "2 seconds" },
});

const { collectEvidenceActivity, assemble } = proxyActivities<typeof activities>({
  startToCloseTimeout: "3 minutes",
  retry: { maximumAttempts: 2, initialInterval: "2 seconds" },
});

/**
 * Cleanup must still run when the run has already failed, so it gets its own
 * short timeout and no retries — a browser that will not close will not close.
 */
const { closeSession } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

export interface GeoQaRunInput {
  base: Omit<RunSpec, "proxyUrl" | "proxyBypass" | "initScriptPath">;
  providerName: string;
  cooldownPath?: string;
  startedAt: string;
  /** How many times to run the journey inside one session. Default 1. */
  repeat?: number;
  cooldownMs?: number;
  tenantId?: string | null;
}

export interface GeoQaWorkflowResult {
  result: GeoQaRunResult;
  warnings: string[];
}

export async function geoQaRunWorkflow(input: GeoQaRunInput): Promise<GeoQaWorkflowResult> {
  const { spec, warnings } = await prepare({
    base: input.base,
    providerName: input.providerName,
    ...(input.cooldownPath ? { cooldownPath: input.cooldownPath } : {}),
  });

  let manifest: EvidenceManifest | null = null;
  try {
    const geo = await verifyGeoActivity(spec);
    const ran = await runJourneyActivity({ spec, ...(input.repeat !== undefined ? { repeat: input.repeat } : {}) });

    /**
     * Did the egress hold for the whole run?
     *
     * This step did not exist here, which meant a durable run never verified the invariant its
     * whole geographic claim rests on: one journey is one network session. A rotating exit
     * mid-run was invisible, and the run reported a clean verdict for observations it could not
     * attribute to the site.
     *
     * The activity returns the MERGED geo and journey rather than an axis this workflow would
     * then fold in — `withExtraStep` reaches `spec.ts` and therefore zod and the filesystem, and
     * workflow code is bundled into a deterministic sandbox. Same constraint that put the
     * concurrency pool in its own import-free module.
     */
    const held = await verifyEgressHeldActivity({ spec, geo, ran });
    const verifiedGeo = held.geo;
    const journey = held.journey;
    const reproducibility = held.reproducibility;

    manifest = await collectEvidenceActivity({
      spec,
      geo: verifiedGeo,
      journey,
      createdAt: input.startedAt,
      ...(reproducibility.attempts > 1 ? { reproducibility } : {}),
    });
    const result = await assemble({
      spec,
      geo: verifiedGeo,
      journey,
      manifest,
      createdAt: input.startedAt,
      // Workflow code may not read the clock; the duration a human cares about
      // is the one Temporal already records on the execution itself.
      durationMs: 0,
      attempts: reproducibility.attempts,
      occurrences: reproducibility.occurrences,
    });

    // The cooldown write and the history append — neither of which a durable run did, so a
    // vendor that failed was never frozen and the run never entered `runs.jsonl` at all.
    await recordOutcome({
      spec,
      result,
      providerName: input.providerName,
      egressWasRight: verifiedGeo.network.country.verdict !== "mismatch",
      // A workflow may not read the clock, so the time comes from the input the run was started
      // with. A cooldown window measured from a replayed `Date.now()` would differ between the
      // original execution and its replay, which is the determinism rule this sandbox enforces.
      nowMs: Date.parse(input.startedAt),
      ...(input.cooldownPath ? { cooldownPath: input.cooldownPath } : {}),
      ...(input.cooldownMs !== undefined ? { cooldownMs: input.cooldownMs } : {}),
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      seed: spec.seed,
    });
    return { result, warnings };
  } finally {
    // The manifest goes with it so an unretained HAR is deleted — armed on every run, flushed at
    // close regardless, and listed by no manifest on a passing tier.
    await closeSession({ spec, manifest });
  }
}

export interface MatrixInput {
  runs: GeoQaRunInput[];
  /**
   * How many child workflows run at once. Defaults to `DEFAULT_MATRIX_CONCURRENCY`.
   *
   * On the input rather than read from a config file, for the reason every other run-shaping
   * value is: a workflow rebuilds itself from serialisable arguments, and one that read a file
   * would replay differently from how it ran.
   */
  concurrency?: number;
}

/**
 * The market × device × journey matrix, as child workflows.
 *
 * Children rather than a loop of activities, so one market failing does not
 * take the matrix with it, and each run keeps its own retry budget and its own
 * separately-inspectable history.
 *
 * **This ran sequentially, and the reason it gave had expired.** The comment here said
 * concurrency was unmeasured (EXP-007) and that picking a parallelism number before measuring
 * is how the first OOM happens. Both were true when written. EXP-007 has since run — 100%
 * completion, verdict agreement and egress-held at 2, 4, 8, 12 and 16 — and the in-process
 * runner adopted `DEFAULT_MATRIX_CONCURRENCY = 4` on the strength of it, while this path kept
 * obeying a caution whose reason no longer existed.
 *
 * Invariant 12 is the point: two execution modes, one implementation. A durable sweep that took
 * four times as long as the local one, for no stated reason, is a divergence that would be
 * discovered as a mystery rather than read as a decision. The bound and the pool now come from
 * `run/pool.ts` — a module with NO imports, because workflow code runs in a deterministic
 * sandbox and cannot pull in the graph `run/matrix.ts` reaches.
 *
 * Order is preserved explicitly: the pool returns results in COMPLETION order, and a matrix
 * whose results shuffled by timing would make two identical sweeps produce different-looking
 * output and neither of them wrong.
 */
export async function geoQaMatrixWorkflow(input: MatrixInput): Promise<GeoQaWorkflowResult[]> {
  const limit = resolveConcurrency(input.concurrency);
  const indexed = input.runs.map((run, index) => ({ run, index }));
  const pooled = await boundedPool(indexed, limit, async ({ run, index }) => ({
    index,
    result: await geoQaRunWorkflow(run),
  }));
  return pooled.results.sort((a, b) => a.index - b.index).map((r) => r.result);
}
