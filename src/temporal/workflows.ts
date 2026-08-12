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
import type { RunSpec } from "../run/context.js";

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

  try {
    const geo = await verifyGeoActivity(spec);
    const journey = await runJourneyActivity(spec);
    const manifest = await collectEvidenceActivity({ spec, geo, journey, createdAt: input.startedAt });
    const result = await assemble({
      spec,
      geo,
      journey,
      manifest,
      createdAt: input.startedAt,
      // Workflow code may not read the clock; the duration a human cares about
      // is the one Temporal already records on the execution itself.
      durationMs: 0,
    });
    return { result, warnings };
  } finally {
    await closeSession(spec);
  }
}

export interface MatrixInput {
  runs: GeoQaRunInput[];
}

/**
 * The market × device × journey matrix, as child workflows.
 *
 * Children rather than a loop of activities, so one market failing does not
 * take the matrix with it, and each run keeps its own retry budget and its own
 * separately-inspectable history.
 *
 * They run SEQUENTIALLY in Phase 0 and that is deliberate: concurrency is
 * unmeasured (EXP-007), each profile costs its own Chrome process, and picking
 * a parallelism number before measuring is how the first OOM happens.
 */
export async function geoQaMatrixWorkflow(input: MatrixInput): Promise<GeoQaWorkflowResult[]> {
  const results: GeoQaWorkflowResult[] = [];
  for (const run of input.runs) {
    results.push(await geoQaRunWorkflow(run));
  }
  return results;
}
