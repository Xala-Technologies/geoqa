/**
 * These tests EXECUTE the workflow inside a real Temporal test environment —
 * a real worker, a real task queue, real activity dispatch and real replay.
 * They do not import the workflow and call it as a function, which would prove
 * nothing about determinism, retry policy or ordering.
 *
 * That distinction is the whole reason this file exists. agent-fleet's rule,
 * paid for by an agent that merged with 1362 green tests and did nothing:
 * **verify by execution, not inspection.** A workflow that typechecks and is
 * never run is a hypothesis.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GeoQaRunResult } from "../../findings/types.js";
import type { RunSpec } from "../../run/context.js";
import { TASK_QUEUE } from "../constants.js";
import { durableMatrix, type TemporalConnector } from "../client.js";
import type { GeoQaRunInput } from "../workflows.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsPath = path.join(here, "..", "workflows.ts");

let env: TestWorkflowEnvironment;
/** Workflow ids must be unique across the whole test file. */
let workflowSeq = 0;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const SPEC: RunSpec = {
  runId: "run_1",
  engine: "agent-browser",
  seed: 7,
  corroborateGeo: false,
  target: "https://digilist.no",
  profilePath: "/p.yaml",
  journeyPath: "/j.yaml",
  evidenceRoot: "/e",
  proxyUrl: null,
  proxyBypass: null,
  initScriptPath: "/e/run_1/init-locale.js",
  vars: {},
  headed: false,
  verifyEndpoint: "https://ipinfo.io/json",
};

const INPUT: GeoQaRunInput = {
  base: {
    runId: "run_1",
    engine: "agent-browser",
    seed: 7,
    corroborateGeo: false,
    target: "https://digilist.no",
    profilePath: "/p.yaml",
    journeyPath: "/j.yaml",
    evidenceRoot: "/e",
    vars: {},
    headed: false,
    verifyEndpoint: "https://ipinfo.io/json",
  },
  providerName: "direct",
  startedAt: "2026-08-12T00:00:00.000Z",
};

const RESULT = { runId: "run_1", verdict: "PASS" } as GeoQaRunResult;

/** Run one workflow against a set of stub activities, recording the call order. */
async function runWorkflow(
  activities: Record<string, (...args: never[]) => unknown>,
  order: string[],
  workflowType = "geoQaRunWorkflow",
  input: unknown = INPUT,
): Promise<unknown> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities,
  });
  return worker.runUntil(
    env.client.workflow.execute(workflowType, {
      taskQueue: TASK_QUEUE,
      workflowId: `wf-${++workflowSeq}-${workflowType}`,
      args: [input],
    }),
  );
}

const stubs = (order: string[], over: Record<string, (...args: never[]) => unknown> = {}) => ({
  prepare: async () => {
    order.push("prepare");
    return { spec: SPEC, warnings: ["egress is DIRECT"] };
  },
  /**
   * The whole run, in one activity.
   *
   * This used to be five stubs — geo, journey, egress, evidence, assemble, close — because the
   * workflow re-sequenced `executeRun` by hand. It no longer does: each of those steps built its
   * OWN browser, so the run was split across four of them and its evidence described a context
   * that had never visited the site (gaps D-6). The ordering those stubs pinned now lives in
   * `execute.test.ts`, where it always belonged.
   */
  executeRunActivity: async () => {
    order.push("executeRunActivity");
    return RESULT;
  },
  ...over,
});

describe("geoQaRunWorkflow", () => {
  it("prepares, then runs — two activities, and the run is one of them", async () => {
    // One activity for the run because a browser session cannot cross an activity boundary: an
    // activity may be retried on a different worker, and a retried step in a fresh browser is
    // exactly the defect D-6 records. `prepare` stays separate because it touches no browser,
    // which is what puts the proxy selection in the durable history rather than inside the run
    // it configures.
    const order: string[] = [];
    const out = (await runWorkflow(stubs(order), order)) as { result: GeoQaRunResult; warnings: string[] };
    expect(order).toEqual(["prepare", "executeRunActivity"]);
    expect(out.result.runId).toBe("run_1");
    // `prepare`'s warnings survive to the caller — a direct-egress run must say so, and a
    // warning swallowed by the orchestration is a run claiming more than it proved.
    expect(out.warnings).toEqual(["egress is DIRECT"]);
  });

  it("does NOT retry the run — a silent second attempt would hide an intermittent failure", async () => {
    // The rule that survives the collapse unchanged, and the one that matters most: flakiness is
    // measured by running the journey N times ON PURPOSE and reporting the rate, never by
    // retrying until green.
    const order: string[] = [];
    let attempts = 0;
    await expect(
      runWorkflow(
        stubs(order, {
          executeRunActivity: async () => {
            attempts++;
            order.push("executeRunActivity");
            throw new Error("the page never loaded");
          },
        }),
        order,
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  }, 60_000);

  it("DOES retry prepare, because a refused proxy connection is transient", async () => {
    // Unchanged: `prepare` opens no browser, so retrying it repeats a decision rather than a
    // measurement.
    const order: string[] = [];
    let attempts = 0;
    const out = (await runWorkflow(
      stubs(order, {
        prepare: async () => {
          attempts++;
          order.push("prepare");
          if (attempts < 3) throw new Error("proxy refused the connection");
          return { spec: SPEC, warnings: [] };
        },
      }),
      order,
    )) as { result: GeoQaRunResult };
    expect(attempts).toBe(3);
    expect(out.result.runId).toBe("run_1");
  }, 60_000);

  it("stops retrying prepare after its maximum attempts", async () => {
    const order: string[] = [];
    let attempts = 0;
    await expect(
      runWorkflow(
        stubs(order, {
          prepare: async () => {
            attempts++;
            order.push("prepare");
            throw new Error("proxy always refuses");
          },
        }),
        order,
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(3);
  }, 60_000);
});

describe("geoQaMatrixWorkflow", () => {
  const SEQUENTIAL_FIRST_RUN = ["prepare", "executeRunActivity"];

  it("returns one result per run, in INPUT order", async () => {
    // The pool hands results back in COMPLETION order, so the workflow sorts them. A matrix
    // whose output shuffled by timing would make two identical sweeps look different and
    // neither of them wrong.
    const order: string[] = [];
    const out = (await runWorkflow(stubs(order), order, "geoQaMatrixWorkflow", {
      runs: [INPUT, INPUT],
    })) as { result: GeoQaRunResult }[];
    expect(out).toHaveLength(2);
    expect(order.filter((s) => s === "executeRunActivity")).toHaveLength(2);
  }, 90_000);

  it("runs children CONCURRENTLY by default, converging on the in-process runner", async () => {
    // This ran sequentially, and the reason it gave had expired: EXP-007 was unmeasured when
    // the comment was written and has since reported 100% completion and verdict agreement at
    // 2, 4, 8, 12 and 16. The in-process runner adopted 4 on that evidence while this path kept
    // obeying a caution whose reason no longer existed — invariant 12 says two execution modes,
    // one implementation.
    //
    // Asserted by INTERLEAVING rather than by wall clock: with a bound above 1, the second
    // child starts before the first has finished, so the activity log is not two clean blocks.
    const order: string[] = [];
    await runWorkflow(stubs(order), order, "geoQaMatrixWorkflow", { runs: [INPUT, INPUT] });
    expect(order.slice(0, SEQUENTIAL_FIRST_RUN.length)).not.toEqual(SEQUENTIAL_FIRST_RUN);
  }, 90_000);

  it("HONOURS a bound of 1, which restores the old sequential shape exactly", async () => {
    // The bound is real rather than decorative, and this is the assertion that proves it: at 1
    // the interleaving disappears and the first child completes before the second begins.
    const order: string[] = [];
    const out = (await runWorkflow(stubs(order), order, "geoQaMatrixWorkflow", {
      runs: [INPUT, INPUT],
      concurrency: 1,
    })) as { result: GeoQaRunResult }[];
    expect(out).toHaveLength(2);
    expect(order.slice(0, SEQUENTIAL_FIRST_RUN.length)).toEqual(SEQUENTIAL_FIRST_RUN);
  }, 90_000);
});

describe("durableMatrix, against a REAL Temporal server", () => {
  /**
   * The half of the durable path that had never been exercised: a client that starts a workflow.
   *
   * Everything else in this file drives the workflow through `env.client` directly. This drives
   * it through `durableMatrix` — the same function the CLI calls — over a connector wired to the
   * test environment's real client. So the queue name, the workflow type string, the argument
   * shape and the result unwrapping are all proven rather than assumed, and any of them being
   * wrong would previously have surfaced only against a live server.
   *
   * The queue name is the one that would have bitten: a client polling a queue nobody serves
   * does not fail, it waits forever and says nothing.
   */
  const envConnector = (): TemporalConnector => ({
    // The test environment's real client, satisfying the structural interface — which is the
    // point of declaring that interface structurally rather than importing the SDK's type.
    // `close` is a no-op because the environment owns this connection's lifetime.
    connect: () => Promise.resolve({ client: env.client as never, close: () => Promise.resolve() }),
  });

  it("starts the matrix workflow and returns one result per run", async () => {
    const order: string[] = [];
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: stubs(order),
    });
    const out = await worker.runUntil(
      durableMatrix([INPUT, INPUT], {
        connector: envConnector(),
        workflowId: `wf-${++workflowSeq}-durable-matrix`,
        concurrency: 2,
      }),
    );
    expect(out.results).toHaveLength(2);
    expect(order.filter((s) => s === "executeRunActivity")).toHaveLength(2);
    // The id comes back off the handle, so a caller can find the sweep again after the terminal
    // has gone — `temporal workflow show -w <id>`.
    expect(out.workflowId).toContain("durable-matrix");
  }, 120_000);
});
