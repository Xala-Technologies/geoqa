/**
 * The in-memory board of sessions that are on screen right now.
 *
 * A watch sweep fans out into many browser sessions. The console needs to
 * show them while they run — market, URL, current step, latest frame — and
 * it needs to stop showing them once they are stale. This is that board:
 * no filesystem, no browser, no clock of its own. The server writes; the
 * `/api/live` route reads.
 *
 * Frames live on disk (`<evidenceRoot>/live/<id>.png`) because a base64
 * payload in every session object would make the list endpoint a screenshot
 * dump. The board only records *whether* a frame has been written, and when.
 */

export type LiveStatus = "queued" | "preparing" | "running" | "closing" | "done";

/** One line of the control-plane stream, kept on the board so GET /api/run can read it. */
export interface LiveEvent {
  at: string;
  level: string;
  message: string;
  observedIp?: string;
  liveUrl?: string;
  confidence?: number;
  verdict?: string;
  runId?: string;
  evidenceId?: string | null;
}

export interface LiveSession {
  id: string;
  tenantId: string;
  target: string;
  market: string;
  device: string;
  journey: string;
  startedAt: string;
  phase: string;
  stepLabel: string | null;
  stepIndex: number | null;
  stepsTotal: number | null;
  status: LiveStatus;
  verdict: string | null;
  writes: boolean;
  frameUpdatedAt: string | null;
  /** Present once the engine names the run — API sessions start as `api_<ms>`. */
  runId?: string;
  observedIp?: string;
  confidence?: number;
  /** Every step that has been on screen, in order. The current one is also stepLabel. */
  steps: LiveStep[];
}

export interface LiveStep {
  index: number;
  label: string;
  phase: string;
  at: string;
}

/** An id that can be a filename. Anything else is a path-escape attempt. */
const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

const KEEP_EVENTS = 200;

export class LiveRegistry {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly log: LiveEvent[] = [];

  safeId(id: string): boolean {
    return SAFE_ID.test(id);
  }

  upsert(session: Omit<LiveSession, "steps"> & { steps?: LiveStep[] }): LiveSession {
    const next = { ...session, steps: session.steps ?? [] };
    this.sessions.set(session.id, next);
    return next;
  }

  get(id: string): LiveSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * By session id, or by the run id the engine names later.
   *
   * A live card links to `#/run/<id>`. API sessions start as `api_<ms>` and
   * only learn the evidence id mid-flight — looking up only the map key is
   * how opening a live visit said "No such run".
   */
  find(id: string): LiveSession | undefined {
    const direct = this.sessions.get(id);
    if (direct !== undefined) return direct;
    for (const session of this.sessions.values()) {
      if (session.runId === id) return session;
    }
    return undefined;
  }

  /**
   * Patch the session and append a step when the label is new.
   *
   * The board used to keep only the current step. Opening the visit then had
   * nothing to show but a phase name — the log the finished page has, arriving
   * too late because the dashboard rebuilds after the sweep.
   */
  progress(id: string, update: Partial<Omit<LiveSession, "id" | "steps">>, at: string): LiveSession | null {
    const current = this.sessions.get(id);
    if (current === undefined) return null;
    let steps = current.steps;
    if (typeof update.stepLabel === "string") {
      const index = update.stepIndex ?? steps.length;
      const last = steps[steps.length - 1];
      if (last === undefined || last.index !== index || last.label !== update.stepLabel) {
        steps = [...steps, { index, label: update.stepLabel, phase: update.phase ?? current.phase, at }];
      }
    }
    return this.patch(id, { ...update, steps });
  }

  list(): LiveSession[] {
    return [...this.sessions.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }

  patch(id: string, update: Partial<LiveSession>): LiveSession | null {
    const current = this.sessions.get(id);
    if (current === undefined) return null;
    const next = { ...current, ...update, id: current.id };
    this.sessions.set(id, next);
    return next;
  }

  appendEvent(event: LiveEvent): void {
    this.log.push(event);
    if (this.log.length > KEEP_EVENTS) this.log.splice(0, this.log.length - KEEP_EVENTS);
  }

  events(): LiveEvent[] {
    return [...this.log];
  }

  finish(id: string, verdict: string | null): LiveSession | null {
    return this.patch(id, { status: "done", phase: "done", verdict });
  }

  /**
   * Drop finished sessions whose start is older than `keepMs`.
   *
   * A running session is never dropped, even if it started before the window:
   * the whole point of the board is to show what is on screen now, and a long
   * journey is still on screen.
   */
  prune(nowMs: number, keepMs: number): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.status !== "done") continue;
      if (nowMs - Date.parse(session.startedAt) <= keepMs) continue;
      this.sessions.delete(id);
      removed += 1;
    }
    return removed;
  }
}
