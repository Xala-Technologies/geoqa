/**
 * The client that starts a workflow — the half of the durable path that never existed.
 *
 * `geoQaRunWorkflow` and `geoQaMatrixWorkflow` have been written and tested since Phase 0, and
 * `worker.ts` can poll for them, but nothing ever constructed a Temporal `Client`. So the
 * durable execution mode was reachable only by writing a client by hand, which meant it was
 * reachable by nobody (gaps D-2).
 *
 * **The rule this file exists to enforce: a durable run that cannot reach Temporal FAILS.** It
 * does not fall back to the in-process runner. A `--durable` sweep that quietly ran locally
 * would report exactly what a durable sweep reports, with none of the durability — the same
 * class of lie as an unmeasured metric reported as fine, and harder to notice, because the
 * output is indistinguishable from success.
 *
 * The connection is injected for the reason every other outside-the-process dependency in this
 * repo is (`TcpProbe`, `PruneFs`, `UsageProbe`, `ExecFn`): a path that could only be tested by
 * standing up a server would not be tested. The injection is also what keeps `@temporalio/client`
 * out of the unit suite's import graph.
 *
 * `worker.ts` is deliberately NOT imported for its constants — it has an unguarded top-level
 * `main()`, so importing it would start a real worker and block forever. That is why
 * `constants.ts` exists.
 */
import { DEFAULT_ADDRESS, DEFAULT_NAMESPACE, TASK_QUEUE } from "./constants.js";
import type { GeoQaRunInput, GeoQaWorkflowResult, MatrixInput } from "./workflows.js";
import { describeThrown } from "../errors.js";

/**
 * The slice of `@temporalio/client` this module uses.
 *
 * Declared structurally rather than imported, exactly as `browser/playwright.ts` declares the
 * slice of Playwright it needs — so the whole client is testable with plain objects and the
 * unit suite never opens a socket or loads the SDK.
 */
export interface TemporalWorkflowHandle<T> {
  workflowId: string;
  result(): Promise<T>;
}

export interface TemporalClientLike {
  workflow: {
    start(
      workflowType: string,
      options: { taskQueue: string; workflowId: string; args: unknown[] },
    ): Promise<TemporalWorkflowHandle<unknown>>;
  };
}

/** Opens a client, and closes whatever it opened. */
export interface TemporalConnector {
  connect(options: { address: string; namespace: string }): Promise<{ client: TemporalClientLike; close: () => Promise<void> }>;
}

export interface DurableMatrixOptions {
  address?: string;
  namespace?: string;
  /** Required. There is no default connector, on purpose — see `durableMatrix`. */
  connector: TemporalConnector;
  /**
   * The workflow id, which is also Temporal's DEDUPLICATION key.
   *
   * Passed in rather than generated here so it is derived from the same run-id clock as
   * everything else, and so a caller retrying a sweep can decide whether it is the same sweep.
   */
  workflowId: string;
  concurrency?: number;
}

/** What a durable sweep returns, plus where to find it again. */
export interface DurableMatrixResult {
  workflowId: string;
  address: string;
  namespace: string;
  results: GeoQaWorkflowResult[];
}

/**
 * The message a caller sees when Temporal is not there.
 *
 * Names the address, because the failure is almost always "no server on 7233" or "worker not
 * started", and those are one command apart. A generic "connection failed" sends somebody to
 * read this file.
 */
export const unreachable = (address: string, detail: string): string =>
  `could not reach Temporal at ${address}: ${detail}. A durable run does NOT fall back to the in-process runner — it would report a durable sweep that never was. Start a server with \`temporal server start-dev\` and a worker with \`pnpm worker\`, or drop --durable to run in this process.`;

/**
 * Start the matrix as a durable workflow and wait for it.
 *
 * Waits rather than returning a handle, and that is the honest shape for a CLI: a command that
 * exited immediately after starting a workflow would print a green summary for work that had not
 * happened. The workflow id is returned either way, so a sweep that outlives the terminal can be
 * found again with `temporal workflow show`.
 *
 * The connector is REQUIRED and has no default. A default would mean this module imports
 * `@temporalio/client` at the top level, which pulls the SDK into the unit suite's graph and —
 * more importantly — makes it possible to call this function without having decided how it
 * connects. The CLI supplies the real one; tests supply a fake.
 */
export async function durableMatrix(runs: GeoQaRunInput[], options: DurableMatrixOptions): Promise<DurableMatrixResult> {
  const address = options.address ?? DEFAULT_ADDRESS;
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;

  // Refused before connecting: a workflow over zero runs would start, succeed and return an
  // empty array, which reads as a clean sweep. Zero scenarios is zero evidence — the same
  // refusal `matrix run` already makes in-process.
  if (runs.length === 0) {
    throw new Error("a durable matrix over zero runs is not a sweep — it would start, succeed and return nothing, which reads as a clean result");
  }

  let opened: { client: TemporalClientLike; close: () => Promise<void> };
  try {
    opened = await options.connector.connect({ address, namespace });
  } catch (thrown) {
    throw new Error(unreachable(address, describeThrown(thrown)));
  }

  try {
    const input: MatrixInput = {
      runs,
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    };
    const handle = await opened.client.workflow.start("geoQaMatrixWorkflow", {
      taskQueue: TASK_QUEUE,
      workflowId: options.workflowId,
      args: [input],
    });
    const results = (await handle.result()) as GeoQaWorkflowResult[];
    return { workflowId: handle.workflowId, address, namespace, results };
  } finally {
    // Always, including when the workflow itself failed: a leaked connection outlives the
    // process's usefulness and the next run inherits a confusing error.
    await opened.close();
  }
}
