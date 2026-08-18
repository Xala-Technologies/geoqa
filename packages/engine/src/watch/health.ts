/**
 * Whether the watch itself is healthy — not whether a page is.
 *
 * A session that sits on "preparing" with no new step, no new frame and no
 * phase change is the hung-proxy class: Chromium reached the vendor and
 * never authenticated, Live looked alive, and the only signal was the
 * journal three minutes later. This file is the judgement that names that
 * before the command timeout does.
 *
 * Pure. The loop holds the clock and the live board; this file only reads
 * them. A finding here is about *our* process, never about the site.
 */

export const SESSION_STALL_MS = 90_000;

export type WatchHealthStatus = "ok" | "paused" | "stalled" | "failed";

export type WatchFindingKind = "session-stalled" | "sweep-hung" | "sweep-failed";

export interface WatchFinding {
  kind: WatchFindingKind;
  severity: "high";
  message: string;
  sinceMs: number;
  sessionId?: string;
}

export interface WatchSessionView {
  id: string;
  status: string;
  startedAt: string;
  frameUpdatedAt: string | null;
  steps: { at: string }[];
  target?: string;
  market?: string;
  journey?: string;
}

export interface WatchHealthInput {
  enabled: boolean;
  nowMs: number;
  lastStartedMs: number | null;
  lastFinishedMs: number | null;
  inFlight: number;
  sessions: WatchSessionView[];
  lastSweepError: string | null;
}

export interface WatchHealth {
  status: WatchHealthStatus;
  findings: WatchFinding[];
}

const parseMs = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * When this session last did anything a human could see.
 *
 * `null` means it is finished — done is not a stall. `0` means every
 * timestamp was unreadable: absence of a clock is not proof of progress.
 */
export function lastActivityMs(session: WatchSessionView): number | null {
  if (session.status === "done") return null;
  const times = [parseMs(session.startedAt), parseMs(session.frameUpdatedAt), ...session.steps.map((s) => parseMs(s.at))].filter(
    (ms): ms is number => ms !== null,
  );
  if (times.length === 0) return 0;
  return Math.max(...times);
}

const describeSession = (session: WatchSessionView): string => {
  const bits = [session.market, session.journey, session.target].filter((part): part is string => typeof part === "string" && part !== "");
  return bits.length > 0 ? bits.join(" · ") : session.id;
};

export function findingKey(finding: WatchFinding): string {
  return finding.kind === "session-stalled" && finding.sessionId !== undefined
    ? `session-stalled:${finding.sessionId}`
    : finding.kind;
}

export function unreportedFindings(findings: WatchFinding[], reported: ReadonlySet<string>): WatchFinding[] {
  return findings.filter((finding) => !reported.has(findingKey(finding)));
}

export function assessWatch(input: WatchHealthInput): WatchHealth {
  const findings: WatchFinding[] = [];

  for (const session of input.sessions) {
    const last = lastActivityMs(session);
    if (last === null) continue;
    const sinceMs = input.nowMs - last;
    if (sinceMs < SESSION_STALL_MS) continue;
    findings.push({
      kind: "session-stalled",
      severity: "high",
      message: `${describeSession(session)} has had no progress for ${Math.floor(sinceMs / 1000)}s`,
      sinceMs,
      sessionId: session.id,
    });
  }

  if (input.inFlight > 0 && input.lastStartedMs !== null) {
    const sinceMs = input.nowMs - input.lastStartedMs;
    const live = input.sessions.filter((session) => session.status !== "done");
    // Session stalls already name a stuck browser. This finding is the
    // empty-board case: inFlight is 1 and nothing ever appeared.
    if (sinceMs >= SESSION_STALL_MS && live.length === 0) {
      findings.push({
        kind: "sweep-hung",
        severity: "high",
        message: `sweep has been in flight for ${Math.floor(sinceMs / 1000)}s with no session progress`,
        sinceMs,
      });
    }
  }

  if (input.lastSweepError !== null && input.inFlight === 0) {
    findings.push({
      kind: "sweep-failed",
      severity: "high",
      message: input.lastSweepError,
      sinceMs: input.lastFinishedMs === null ? 0 : input.nowMs - input.lastFinishedMs,
    });
  }

  const stalled = findings.some((f) => f.kind === "session-stalled" || f.kind === "sweep-hung");
  const status: WatchHealthStatus = stalled
    ? "stalled"
    : findings.length > 0
      ? "failed"
      : !input.enabled && input.inFlight === 0
        ? "paused"
        : "ok";

  return { status, findings };
}
