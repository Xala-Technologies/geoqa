import { describe, expect, it } from "vitest";
import {
  SESSION_STALL_MS,
  assessWatch,
  findingKey,
  lastActivityMs,
  unreportedFindings,
  type WatchHealthInput,
  type WatchSessionView,
} from "../health.js";

const T0 = Date.parse("2026-08-18T21:00:00.000Z");

const session = (over: Partial<WatchSessionView> = {}): WatchSessionView => ({
  id: "run_1",
  status: "preparing",
  startedAt: new Date(T0).toISOString(),
  frameUpdatedAt: null,
  steps: [],
  target: "https://digilist.no",
  market: "oslo",
  journey: "landing-page",
  ...over,
});

const input = (over: Partial<WatchHealthInput> = {}): WatchHealthInput => ({
  enabled: true,
  nowMs: T0 + 10_000,
  lastStartedMs: T0,
  lastFinishedMs: null,
  inFlight: 1,
  sessions: [session()],
  lastSweepError: null,
  ...over,
});

describe("lastActivityMs", () => {
  it("is null for a finished session — done is not stalled", () => {
    expect(lastActivityMs(session({ status: "done" }))).toBeNull();
  });

  it("takes the latest of start, frame and step, and treats unreadable times as never", () => {
    expect(lastActivityMs(session())).toBe(T0);
    expect(
      lastActivityMs(
        session({
          frameUpdatedAt: new Date(T0 + 5_000).toISOString(),
          steps: [{ at: new Date(T0 + 2_000).toISOString() }],
        }),
      ),
    ).toBe(T0 + 5_000);
    expect(
      lastActivityMs(
        session({
          startedAt: "not-a-date",
          frameUpdatedAt: "also-bad",
          steps: [{ at: "nope" }],
        }),
      ),
    ).toBe(0);
  });
});

describe("assessWatch", () => {
  it("is paused when the watch is off and nothing is in flight", () => {
    const out = assessWatch(
      input({
        enabled: false,
        inFlight: 0,
        lastStartedMs: null,
        lastFinishedMs: null,
        sessions: [],
      }),
    );
    expect(out.status).toBe("paused");
    expect(out.findings).toEqual([]);
  });

  it("is ok while a session is still moving, even if it started a while ago", () => {
    const out = assessWatch(
      input({
        nowMs: T0 + SESSION_STALL_MS + 5_000,
        sessions: [
          session({
            status: "running",
            startedAt: new Date(T0).toISOString(),
            steps: [{ at: new Date(T0 + SESSION_STALL_MS + 1_000).toISOString() }],
          }),
        ],
      }),
    );
    expect(out.status).toBe("ok");
    expect(out.findings).toEqual([]);
  });

  it("names a session that has had no progress past the stall window", () => {
    const out = assessWatch(
      input({
        nowMs: T0 + SESSION_STALL_MS,
        sessions: [session({ status: "preparing", startedAt: new Date(T0).toISOString() })],
      }),
    );
    expect(out.status).toBe("stalled");
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.kind).toBe("session-stalled");
    expect(out.findings[0]?.sessionId).toBe("run_1");
    expect(out.findings[0]?.message).toContain("oslo");
    expect(out.findings[0]?.message).toContain("landing-page");
    expect(out.findings[0]?.sinceMs).toBe(SESSION_STALL_MS);
  });

  it("does not call a just-started session stalled — the window has not elapsed", () => {
    const out = assessWatch(input({ nowMs: T0 + SESSION_STALL_MS - 1 }));
    expect(out.status).toBe("ok");
    expect(out.findings).toEqual([]);
  });

  it("never files a finished session as stalled", () => {
    const out = assessWatch(
      input({
        nowMs: T0 + SESSION_STALL_MS * 2,
        inFlight: 0,
        lastFinishedMs: T0 + 1_000,
        sessions: [session({ status: "done", startedAt: new Date(T0).toISOString() })],
      }),
    );
    expect(out.findings.some((f) => f.kind === "session-stalled")).toBe(false);
  });

  it("calls the sweep hung when it is in flight and nothing has moved", () => {
    const out = assessWatch(
      input({
        nowMs: T0 + SESSION_STALL_MS,
        inFlight: 1,
        lastStartedMs: T0,
        sessions: [],
      }),
    );
    expect(out.status).toBe("stalled");
    expect(out.findings.map((f) => f.kind)).toContain("sweep-hung");
    expect(out.findings.find((f) => f.kind === "sweep-hung")?.sinceMs).toBe(SESSION_STALL_MS);
  });

  it("does not call a sweep hung in its first window — browsers have not opened yet", () => {
    const out = assessWatch(
      input({
        nowMs: T0 + SESSION_STALL_MS - 1,
        inFlight: 1,
        lastStartedMs: T0,
        sessions: [],
      }),
    );
    expect(out.status).toBe("ok");
    expect(out.findings).toEqual([]);
  });

  it("reports a thrown sweep as failed once it is no longer in flight", () => {
    const out = assessWatch(
      input({
        inFlight: 0,
        lastFinishedMs: T0 + 1_000,
        sessions: [],
        lastSweepError: "matrixRun blew up",
      }),
    );
    expect(out.status).toBe("failed");
    expect(out.findings[0]?.kind).toBe("sweep-failed");
    expect(out.findings[0]?.message).toContain("matrixRun blew up");
    expect(out.findings[0]?.sinceMs).toBe(9_000);
    const unfinished = assessWatch(
      input({
        inFlight: 0,
        lastStartedMs: T0,
        lastFinishedMs: null,
        sessions: [],
        lastSweepError: "threw before finish",
      }),
    );
    expect(unfinished.findings[0]?.sinceMs).toBe(0);
  });

  it("a live stall outranks a previous failed sweep — the current problem is the one that matters", () => {
    const out = assessWatch(
      input({
        nowMs: T0 + SESSION_STALL_MS,
        lastSweepError: "earlier throw",
        sessions: [session()],
      }),
    );
    expect(out.status).toBe("stalled");
  });

  it("a paused watch with a hung session is still stalled — pausing does not hide a stuck browser", () => {
    const out = assessWatch(
      input({
        enabled: false,
        nowMs: T0 + SESSION_STALL_MS,
        sessions: [session()],
      }),
    );
    expect(out.status).toBe("stalled");
  });
});

describe("unreportedFindings", () => {
  it("a stall with no market still names the session, and a stall without an id keys by kind", () => {
    const out = assessWatch(
      input({
        nowMs: T0 + SESSION_STALL_MS,
        sessions: [
          {
            id: "run_1",
            status: "preparing",
            startedAt: new Date(T0).toISOString(),
            frameUpdatedAt: null,
            steps: [],
          },
        ],
      }),
    );
    expect(out.findings[0]?.message).toContain("run_1");
    expect(findingKey({ kind: "session-stalled", severity: "high", message: "x", sinceMs: 1 })).toBe("session-stalled");
    expect(findingKey({ kind: "sweep-failed", severity: "high", message: "x", sinceMs: 1 })).toBe("sweep-failed");
  });

  it("keys a session stall by id so a second session is a new report, and drops recovered ones", () => {
    const stalled = assessWatch(
      input({
        nowMs: T0 + SESSION_STALL_MS,
        sessions: [session({ id: "a" }), session({ id: "b" })],
      }),
    ).findings;
    expect(stalled.map(findingKey).sort()).toEqual(["session-stalled:a", "session-stalled:b"]);
    const first = unreportedFindings(stalled, new Set());
    expect(first).toHaveLength(2);
    const again = unreportedFindings(stalled, new Set(stalled.map(findingKey)));
    expect(again).toEqual([]);
    const onlyB = unreportedFindings(
      stalled.filter((f) => f.sessionId === "b"),
      new Set(["session-stalled:a"]),
    );
    expect(onlyB.map((f) => f.sessionId)).toEqual(["b"]);
  });
});
