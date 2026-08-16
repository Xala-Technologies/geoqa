/**
 * Worker entrypoint. Connects to a local `temporal server start-dev` and polls
 * the `geoqa` task queue.
 *
 * One hard-won detail, inherited from agent-fleet's temporal pilot: do NOT run
 * this under `tsx --import <some-preload>`. That flag applies process-wide, and
 * Node's `worker_threads` inherit `execArgv` by default. Temporal runs the
 * workflow sandbox in exactly such a thread, so a global preload hook leaks its
 * imports into a context that must stay pure and deterministic — which showed
 * up live as the sandbox thread dying with `Cannot find module`. If this
 * project ever grows a preload step, import it directly here instead of as a
 * process-wide flag.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";
import { DEFAULT_ADDRESS, DEFAULT_NAMESPACE, TASK_QUEUE } from "./constants.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS ?? DEFAULT_ADDRESS;
  const connection = await NativeConnection.connect({ address });
  try {
    const worker = await Worker.create({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? DEFAULT_NAMESPACE,
      taskQueue: TASK_QUEUE,
      workflowsPath: path.join(here, "workflows.ts"),
      activities,
    });
    console.log(`[geoqa] worker started — queue "${TASK_QUEUE}" @ ${address}`);
    await worker.run();
  } finally {
    await connection.close();
  }
}

main().catch((e: unknown) => {
  console.error("[geoqa] worker failed:", e);
  process.exit(1);
});
