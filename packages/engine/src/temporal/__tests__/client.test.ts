import { describe, expect, it, vi } from "vitest";
import { durableMatrix, unreachable, type TemporalConnector } from "../client.js";
import { TASK_QUEUE } from "../constants.js";
import type { GeoQaRunInput } from "../workflows.js";

const RUN = { base: {}, providerName: "direct", startedAt: "t" } as unknown as GeoQaRunInput;

/** A connector over plain objects — the whole point of the structural interface. */
const connector = (over: {
  start?: (type: string, opts: { taskQueue: string; workflowId: string; args: unknown[] }) => Promise<unknown>;
  connect?: () => Promise<never>;
  onClose?: () => void;
} = {}): TemporalConnector => ({
  connect: over.connect
    ? over.connect
    : () =>
        Promise.resolve({
          client: {
            workflow: {
              start: async (type, opts) => {
                await over.start?.(type, opts);
                return { workflowId: opts.workflowId, result: () => Promise.resolve([{ result: { verdict: "PASS" }, warnings: [] }]) };
              },
            },
          },
          close: () => {
            over.onClose?.();
            return Promise.resolve();
          },
        }),
});

describe("durableMatrix", () => {
  it("starts the matrix workflow on the shared task queue and returns its results", async () => {
    const seen: { type: string; queue: string; args: unknown[] }[] = [];
    const out = await durableMatrix([RUN], {
      connector: connector({
        start: (type, opts) => {
          seen.push({ type, queue: opts.taskQueue, args: opts.args });
          return Promise.resolve();
        },
      }),
      workflowId: "wf_1",
    });
    // The queue name is shared with the worker through `constants.ts` rather than written twice
    // — a client polling a queue nobody serves waits forever and says nothing.
    expect(seen[0]).toMatchObject({ type: "geoQaMatrixWorkflow", queue: TASK_QUEUE });
    expect(out.workflowId).toBe("wf_1");
    expect(out.results).toHaveLength(1);
  });

  it("FAILS when Temporal is unreachable, and never falls back to running here", async () => {
    // The rule this module exists for. A --durable sweep that quietly ran in-process would
    // produce exactly what a durable sweep produces, with none of the durability — a lie that
    // looks like success, which is the hardest kind to notice.
    const out = durableMatrix([RUN], {
      connector: connector({ connect: () => Promise.reject(new Error("ECONNREFUSED")) }),
      workflowId: "wf_1",
      address: "127.0.0.1:7233",
    });
    await expect(out).rejects.toThrow(/does NOT fall back/);
    await expect(out).rejects.toThrow(/ECONNREFUSED/);
  });

  it("names the ADDRESS in the failure, because the fix is one command away", async () => {
    expect(unreachable("10.0.0.5:7233", "timeout")).toContain("10.0.0.5:7233");
    expect(unreachable("10.0.0.5:7233", "timeout")).toContain("temporal server start-dev");
    expect(unreachable("10.0.0.5:7233", "timeout")).toContain("pnpm worker");
  });

  it("handles a rejection that is not an Error at all", async () => {
    await expect(
      durableMatrix([RUN], { connector: connector({ connect: () => Promise.reject("just a string" as unknown as Error) }), workflowId: "wf_1" }),
    ).rejects.toThrow(/just a string/);
  });

  it("REFUSES a sweep over zero runs rather than reporting an empty success", async () => {
    // It would start, succeed and return nothing — which reads as a clean sweep. Zero scenarios
    // is zero evidence, the same refusal `matrix run` already makes in-process.
    const connect = vi.fn();
    await expect(durableMatrix([], { connector: { connect }, workflowId: "wf_1" })).rejects.toThrow(/zero runs/);
    // And refused BEFORE connecting, so a mistake costs nothing.
    expect(connect).not.toHaveBeenCalled();
  });

  it("closes the connection even when the workflow itself fails", async () => {
    // A leaked connection outlives the process's usefulness and the next run inherits a
    // confusing error.
    let closed = 0;
    const failing: TemporalConnector = {
      connect: () =>
        Promise.resolve({
          client: { workflow: { start: () => Promise.reject(new Error("workflow rejected")) } },
          close: () => {
            closed++;
            return Promise.resolve();
          },
        }),
    };
    await expect(durableMatrix([RUN], { connector: failing, workflowId: "wf_1" })).rejects.toThrow("workflow rejected");
    expect(closed).toBe(1);
  });

  it("passes the concurrency bound through, and omits it when unset", async () => {
    const args: unknown[][] = [];
    const capture = connector({
      start: (_t, opts) => {
        args.push(opts.args);
        return Promise.resolve();
      },
    });
    await durableMatrix([RUN], { connector: capture, workflowId: "a", concurrency: 2 });
    await durableMatrix([RUN], { connector: capture, workflowId: "b" });
    expect(args[0]?.[0]).toMatchObject({ concurrency: 2 });
    // Absent rather than a number this process invented: `resolveConcurrency` owns the default,
    // and it runs inside the workflow where the sweep actually happens.
    expect(args[1]?.[0]).not.toHaveProperty("concurrency");
  });
});
