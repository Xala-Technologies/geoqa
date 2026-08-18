import { describe, expect, it } from "vitest";
import { LiveRegistry, type LiveSession } from "../live.js";

const session = (over: Partial<LiveSession> = {}): LiveSession => ({
  id: "run_1",
  tenantId: "digilist",
  target: "https://digilist.no",
  market: "oslo",
  device: "mobile",
  journey: "landing-page",
  startedAt: "2026-08-15T12:00:00.000Z",
  phase: "prepare",
  stepLabel: null,
  stepIndex: null,
  stepsTotal: null,
  status: "preparing",
  verdict: null,
  writes: false,
  frameUpdatedAt: null,
  steps: [],
  ...over,
});

describe("LiveRegistry", () => {
  it("lists sessions newest first, and get is by id", () => {
    const live = new LiveRegistry();
    live.upsert(session({ id: "a", startedAt: "2026-08-15T12:00:00.000Z" }));
    live.upsert(session({ id: "b", startedAt: "2026-08-15T12:01:00.000Z" }));
    expect(live.list().map((s) => s.id)).toEqual(["b", "a"]);
    live.upsert(session({ id: "c", startedAt: "2026-08-15T12:01:00.000Z" }));
    expect(live.list().map((s) => s.id)).toContain("c");
    expect(live.get("a")?.market).toBe("oslo");
    expect(live.get("missing")).toBeUndefined();
    const tied = new LiveRegistry();
    tied.upsert(session({ id: "x", startedAt: "2026-08-15T12:00:00.000Z" }));
    tied.upsert(session({ id: "y", startedAt: "2026-08-15T12:00:00.000Z" }));
    expect(tied.list().map((s) => s.id).sort()).toEqual(["x", "y"]);
  });

  it("patches an existing session and refuses a patch to one that is not there", () => {
    const live = new LiveRegistry();
    live.upsert(session());
    expect(live.patch("run_1", { phase: "journey", stepLabel: "open", stepIndex: 0 })?.phase).toBe("journey");
    expect(live.patch("nope", { phase: "journey" })).toBeNull();
  });

  it("finish records the verdict and marks the session done", () => {
    const live = new LiveRegistry();
    live.upsert(session());
    const done = live.finish("run_1", "PASS");
    expect(done?.status).toBe("done");
    expect(done?.verdict).toBe("PASS");
    expect(live.finish("nope", "FAIL")).toBeNull();
  });

  it("prunes finished sessions older than the keep window, and never a live one", () => {
    const live = new LiveRegistry();
    live.upsert(session({ id: "old", startedAt: "2026-08-15T11:00:00.000Z" }));
    live.finish("old", "PASS");
    live.upsert(session({ id: "running", startedAt: "2026-08-15T11:00:00.000Z", status: "running" }));
    live.upsert(session({ id: "fresh", startedAt: "2026-08-15T12:00:00.000Z" }));
    live.finish("fresh", "FAIL");
    const now = Date.parse("2026-08-15T12:05:00.000Z");
    expect(live.prune(now, 10 * 60_000)).toBe(1);
    expect(live.list().map((s) => s.id).sort()).toEqual(["fresh", "running"]);
  });

  it("keeps a ring of events, dropping the oldest once it is full", () => {
    const live = new LiveRegistry();
    live.appendEvent({ at: "t0", level: "info", message: "first" });
    live.appendEvent({ at: "t1", level: "info", message: "second", observedIp: "1.1.1.1" });
    expect(live.events().map((e) => e.message)).toEqual(["first", "second"]);
    for (let i = 0; i < 200; i++) live.appendEvent({ at: `t${i}`, level: "info", message: `n${i}` });
    expect(live.events()).toHaveLength(200);
    expect(live.events()[0]?.message).toBe("n0");
  });

  it("finds a session by id or by the run id the engine later names", () => {
    const live = new LiveRegistry();
    live.upsert(session({ id: "api_1", runId: "run_9_alesund-desktop-landing-page-0" }));
    expect(live.find("api_1")?.market).toBe("oslo");
    expect(live.find("run_9_alesund-desktop-landing-page-0")?.id).toBe("api_1");
    expect(live.find("missing")).toBeUndefined();
  });

  it("records each new step and does not duplicate the one already on screen", () => {
    const live = new LiveRegistry();
    live.upsert(session());
    live.progress("run_1", { phase: "journey", status: "running", stepLabel: "open target", stepIndex: 0, stepsTotal: 8 }, "t1");
    live.progress("run_1", { phase: "journey", status: "running", stepLabel: "open target", stepIndex: 0, stepsTotal: 8 }, "t2");
    live.progress("run_1", { phase: "journey", status: "running", stepLabel: "title-exists", stepIndex: 1, stepsTotal: 8 }, "t3");
    const steps = live.get("run_1")?.steps ?? [];
    expect(steps.map((s) => s.label)).toEqual(["open target", "title-exists"]);
    expect(steps[1]).toEqual({ index: 1, label: "title-exists", phase: "journey", at: "t3" });
    expect(live.progress("nope", { phase: "journey" }, "t")).toBeNull();
  });

  it("refuses an id that could escape a live-frame path", () => {
    const live = new LiveRegistry();
    expect(live.safeId("run_1")).toBe(true);
    expect(live.safeId("../etc")).toBe(false);
    expect(live.safeId("run/1")).toBe(false);
    expect(live.safeId("")).toBe(false);
  });
});

describe("the live board fills what a caller left out, and holds a stable order", () => {
  it("takes steps a caller supplies, and defaults a step index to the end of the log", () => {
    // `geoqa run --json` streams events that may name a step without numbering
    // it. Appending at the end is the honest reading of "the next thing that
    // happened", and inventing 0 would redraw the board from the top.
    const live = new LiveRegistry();
    live.upsert({ ...session(), steps: [{ index: 0, label: "open target", phase: "journey", at: "2026-08-15T12:00:01.000Z" }] });
    live.progress("run_1", { stepLabel: "click the first result", phase: "journey" }, "2026-08-15T12:00:02.000Z");
    const after = live.get("run_1");
    expect(after?.steps.map((s) => s.index)).toEqual([0, 1]);

    // The same label at the same index twice is one step being re-reported, not
    // two steps: a repeat must not grow the log.
    live.progress("run_1", { stepLabel: "click the first result", stepIndex: 1 }, "2026-08-15T12:00:03.000Z");
    expect(live.get("run_1")?.steps).toHaveLength(2);
  });

  it("keeps two sessions started in the same millisecond in a stable order", () => {
    // Sorting is newest first, and equal timestamps must compare equal rather
    // than swapping on every render — a board that reshuffles under a watching
    // operator looks like sessions appearing and vanishing.
    const live = new LiveRegistry();
    live.upsert(session({ id: "run_a", startedAt: "2026-08-15T12:00:00.000Z" }));
    live.upsert(session({ id: "run_b", startedAt: "2026-08-15T12:00:00.000Z" }));
    live.upsert(session({ id: "run_c", startedAt: "2026-08-15T12:00:05.000Z" }));
    const ids = live.list().map((s) => s.id);
    expect(ids[0]).toBe("run_c");
    expect(live.list().map((s) => s.id)).toEqual(ids);
  });
});
