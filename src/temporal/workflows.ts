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


/**
 * The whole run, and it does NOT retry.
 *
 * A silent second attempt would quietly convert a real intermittent site failure into a pass,
 * destroying the one signal the run exists to produce. Flakiness is measured by running the
 * journey N times ON PURPOSE and reporting the rate — `repeat` — never by retrying until green.
 *
 * The timeout covers a browser launch, a geo verification, N journey attempts, the closing
 * egress read and the evidence write, so it is generous: this is one activity because a browser
 * session cannot cross an activity boundary (gaps D-6), not because the work is small.
 */
const { executeRunActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 minutes",
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

  /**
   * TWO activities, and the second is the entire run.
   *
   * This used to be six steps, each building its own runtime — and `playwrightOpener` launches a
   * new browser on every use, so each step got a DIFFERENT one. The closing egress read ran in a
   * context that never visited the site, and evidence was collected from a blank one: measured
   * against a real Chromium, `vitals.json` recorded a null LCP for a page that had demonstrably
   * rendered (gaps D-6).
   *
   * A browser session cannot cross an activity boundary — an activity may be retried on another
   * worker — so there is no arrangement of per-step activities that fixes it. The run has to be
   * one activity, and it is literally `executeRun`: the same function the CLI calls, not a
   * re-sequencing of it. That makes the D-5 class of drift structurally impossible, because
   * there is no second copy left to diverge.
   *
   * `prepare` stays separate because it touches no browser: it resolves the exit and writes the
   * init script, and keeping it its own activity is what puts the proxy selection in the durable
   * history rather than inside the run it configures.
   */
  const result = await executeRunActivity({
    spec,
    providerName: input.providerName,
    startedAt: input.startedAt,
    ...(input.repeat !== undefined ? { repeat: input.repeat } : {}),
    ...(input.cooldownPath ? { cooldownPath: input.cooldownPath } : {}),
    ...(input.cooldownMs !== undefined ? { cooldownMs: input.cooldownMs } : {}),
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
  });
  return { result, warnings };
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
