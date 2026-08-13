import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { startFixtureServer } from "./src/fixtures/server.js";
import * as activities from "./src/temporal/activities.js";
import { durableMatrix, type TemporalConnector } from "./src/temporal/client.js";
import { TASK_QUEUE } from "./src/temporal/constants.js";

async function main(): Promise<void> {
  const env = await TestWorkflowEnvironment.createLocal();
  const fixtures = await startFixtureServer();
  const evidenceRoot = mkdtempSync(path.join(tmpdir(), "geoqa-probe-"));
  const connector: TemporalConnector = {
    connect: () => Promise.resolve({ client: env.client as never, close: () => Promise.resolve() }),
  };
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: path.join(process.cwd(), "src", "temporal", "workflows.ts"),
    activities,
  });
  await worker.runUntil(
    durableMatrix(
      [{
        base: {
          runId: "probe1", engine: "playwright", seed: 7, corroborateGeo: false,
          target: `${fixtures.origin}/healthy`,
          profilePath: path.join(process.cwd(), "profiles", "oslo-mobile.yaml"),
          journeyPath: path.join(process.cwd(), "journeys", "landing-page.yaml"),
          evidenceRoot, vars: {}, headed: false, verifyEndpoint: `${fixtures.origin}/ipinfo`,
        },
        providerName: "direct", startedAt: "2026-08-13T00:00:00.000Z",
      }],
      { connector, workflowId: "wf-probe-1" },
    ),
  );
  const read = (f: string): string => {
    try { return readFileSync(path.join(evidenceRoot, "probe1", f), "utf8").slice(0, 220); }
    catch { return "(absent)"; }
  };
  console.log("VITALS:", read("vitals.json"));
  console.log("MANIFEST completeness:", JSON.parse(readFileSync(path.join(evidenceRoot, "probe1", "manifest.json"), "utf8")).completeness);
  await fixtures.close();
  await env.teardown();
  rmSync(evidenceRoot, { recursive: true, force: true });
}
void main();
