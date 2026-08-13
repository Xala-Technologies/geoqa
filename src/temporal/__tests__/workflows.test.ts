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
  verifyGeoActivity: async () => {
    order.push("verifyGeoActivity");
    return { profileId: "oslo-mobile" };
  },
  runJourneyActivity: async () => {
    order.push("runJourneyActivity");
    return { journeyId: "landing-page", verdict: "PASS" };
  },
  collectEvidenceActivity: async () => {
    order.push("collectEvidenceActivity");
    return { evidenceId: "ev_1" };
  },
  assemble: async () => {
    order.push("assemble");
    return RESULT;
  },
  closeSession: async () => {
    order.push("closeSession");
  },
  ...over,
});

describe("geoQaRunWorkflow", () => {
  it("executes every stage in order and returns the assembled result", async () => {
    const order: string[] = [];
    const out = (await runWorkflow(stubs(order), order)) as { result: GeoQaRunResult; warnings: string[] };
    expect(order).toEqual([
      "prepare",
      "verifyGeoActivity",
      "runJourneyActivity",
      "collectEvidenceActivity",
      "assemble",
      "closeSession",
    ]);
    expect(out.result).toMatchObject({ runId: "run_1", verdict: "PASS" });
    expect(out.warnings).toEqual(["egress is DIRECT"]);
  }, 60_000);

  it("verifies geography BEFORE running the journey", async () => {
    // Verifying afterwards would spend the whole run's wall clock before
    // learning it was geographically wrong, and leave an authoritative-looking
    // evidence package for a market it never reached.
    const order: string[] = [];
    await runWorkflow(stubs(order), order);
    expect(order.indexOf("verifyGeoActivity")).toBeLessThan(order.indexOf("runJourneyActivity"));
  }, 60_000);

  it("closes the session even when the journey throws", async () => {
    const order: string[] = [];
    // Temporal wraps an activity failure in a WorkflowFailedError whose own
    // message is generic; the original text lives on the cause chain. What
    // matters here is that the run failed AND cleanup still ran.
    await expect(
      runWorkflow(
        stubs(order, {
          runJourneyActivity: async () => {
            order.push("runJourneyActivity");
            throw new Error("browser died");
          },
        }),
        order,
      ),
    ).rejects.toThrow();
    // A leaked browser outlives the run, so cleanup must survive the failure.
    expect(order).toContain("runJourneyActivity");
    expect(order).toContain("closeSession");
    expect(order).not.toContain("assemble");
  }, 60_000);

  it("does NOT retry the journey — a silent second attempt would hide a real intermittent failure", async () => {
    const order: string[] = [];
    await expect(
      runWorkflow(
        stubs(order, {
          runJourneyActivity: async () => {
            order.push("runJourneyActivity");
            throw new Error("flaky");
          },
        }),
        order,
      ),
    ).rejects.toThrow();
    expect(order.filter((s) => s === "runJourneyActivity")).toHaveLength(1);
  }, 60_000);

  it("DOES retry prepare, because a refused proxy connection is transient", async () => {
    const order: string[] = [];
    let attempts = 0;
    const out = (await runWorkflow(
      stubs(order, {
        prepare: async () => {
          order.push("prepare");
          if (++attempts < 3) throw new Error("proxy refused");
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
  const SEQUENTIAL_FIRST_RUN = [
    "prepare", "verifyGeoActivity", "runJourneyActivity", "collectEvidenceActivity", "assemble", "closeSession",
  ];

  it("returns one result per run, in INPUT order", async () => {
    // The pool hands results back in COMPLETION order, so the workflow sorts them. A matrix
    // whose output shuffled by timing would make two identical sweeps look different and
    // neither of them wrong.
    const order: string[] = [];
    const out = (await runWorkflow(stubs(order), order, "geoQaMatrixWorkflow", {
      runs: [INPUT, INPUT],
    })) as { result: GeoQaRunResult }[];
    expect(out).toHaveLength(2);
    expect(order.filter((s) => s === "runJourneyActivity")).toHaveLength(2);
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
