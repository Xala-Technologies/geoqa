/**
 * Screening feed: what the visitor is looking at, right now.
 *
 * This is a watch, not a remote control. The journey is deterministic; you see
 * the frame and the step, you do not drive the browser. Interactive control
 * would put an operator in the middle of a seeded run and make the evidence
 * unreproducible.
 *
 * The page title lives in the header bar.
 */
import { useEffect, useState, type JSX } from "react";
import { getJson } from "../api.ts";
import { LiveVisit } from "./LiveVisit.tsx";

export interface LiveStep {
  index: number;
  label: string;
  phase: string;
  at: string;
}

export interface LiveSession {
  id: string;
  target: string;
  market: string;
  device: string;
  journey: string;
  startedAt: string;
  phase: string;
  stepLabel: string | null;
  stepIndex: number | null;
  stepsTotal: number | null;
  status: string;
  verdict: string | null;
  writes: boolean;
  frameUpdatedAt: string | null;
  runId?: string;
  observedIp?: string;
  confidence?: number;
  steps?: LiveStep[];
}

interface LiveEvent {
  at: string;
  level: string;
  message: string;
  observedIp?: string;
  confidence?: number;
  verdict?: string;
  runId?: string;
}

interface LiveBoard {
  sessions: LiveSession[];
  inFlight: number;
  events: LiveEvent[];
}

interface Frame {
  mime: string;
  data: string;
}

const verdictTone = (verdict: string): string =>
  verdict === "PASS" ? "good" : verdict === "ERROR" ? "bad" : "warn";

export function Live({ selectedId }: { selectedId: string | undefined }): JSX.Element {
  const [board, setBoard] = useState<LiveBoard | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [frames, setFrames] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const poll = (): void => {
      void getJson<LiveBoard>("/api/run").then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setBoard({
            sessions: result.value.sessions,
            inFlight: result.value.inFlight,
            events: result.value.events ?? [],
          });
          setProblem(null);
          for (const session of result.value.sessions) {
            if (session.frameUpdatedAt === null) continue;
            void getJson<Frame>(`/api/live/${session.id}/frame`).then((frame) => {
              if (cancelled || !frame.ok) return;
              setFrames((prev) => ({ ...prev, [session.id]: `data:${frame.value.mime};base64,${frame.value.data}` }));
            });
          }
          return;
        }
        setProblem(result.signedOut ? "this console is not signed in" : result.error);
      });
    };
    poll();
    const timer = window.setInterval(poll, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (problem !== null && board === null) {
    return (
      <>
        <div className="head">
          <p className="hint">Sessions in flight, with the latest frame. Screening, not driving.</p>
        </div>
        <div className="empty">
          <strong>No live board.</strong>
          {problem}
        </div>
      </>
    );
  }
  if (board === null) return <div className="load">listening for sessions…</div>;

  const active = board.sessions.filter((s) => s.status !== "done");
  const recent = board.sessions.filter((s) => s.status === "done");
  const log = [...board.events].reverse().slice(0, 16);

  return (
    <>
      <div className="head">
        <p className="hint">
          {board.inFlight === 0
            ? `${recent.length} recent session(s). Arm a watch or POST /api/run — this feed does not drive the browser.`
            : `${board.inFlight} session(s) on screen. Screening only; the journey stays seeded.`}
        </p>
      </div>

      {selectedId !== undefined ? <LiveVisit runId={selectedId} /> : null}

      {active.length === 0 && recent.length === 0 && selectedId === undefined ? (
        <div className="empty">
          <strong>No session on the board.</strong>
          Open Watch, add the brand URLs, and start a sweep.
        </div>
      ) : (
        <div className="live-grid">
          {active.map((s) => (
            <SessionCard key={s.id} session={s} frame={frames[s.id]} selected={selectedId === s.id || selectedId === s.runId} />
          ))}
          {recent.map((s) => (
            <SessionCard key={s.id} session={s} frame={frames[s.id]} selected={selectedId === s.id || selectedId === s.runId} />
          ))}
        </div>
      )}

      {log.length > 0 ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Control events</h3>
            <p className="hint">Newest first. The same stream GET /api/run returns.</p>
          </div>
          <ol className="live-log">
            {log.map((e, i) => (
              <li key={`${e.at}-${e.message}-${i}`} data-level={e.level}>
                <span className="mono dim">{e.at.slice(11, 19)}</span>
                <span>{e.message}</span>
                {e.observedIp !== undefined ? <span className="mono">{e.observedIp}</span> : null}
                {e.verdict !== undefined ? <span className={`pill ${verdictTone(e.verdict)}`}>{e.verdict}</span> : null}
                {e.confidence !== undefined ? <span className="dim">conf {e.confidence}</span> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </>
  );
}

function SessionCard({
  session,
  frame,
  selected,
}: {
  session: LiveSession;
  frame: string | undefined;
  selected: boolean;
}): JSX.Element {
  const step =
    session.stepLabel === null
      ? session.phase
      : session.stepsTotal === null
        ? session.stepLabel
        : `${(session.stepIndex ?? 0) + 1}/${session.stepsTotal} ${session.stepLabel}`;
  return (
    <article
      className={`live-card link${selected ? " on" : ""}`}
      data-status={session.status}
      onClick={() => {
        window.location.hash = `#/live/${session.id}`;
      }}
      title={`watch ${session.id}`}
    >
      <div className="live-frame">
        {frame !== undefined ? <img src={frame} alt={`${session.market} ${session.target}`} /> : <div className="live-wait">awaiting frame</div>}
        {session.status !== "done" ? <span className="live-pulse" aria-hidden="true" /> : null}
      </div>
      <div className="live-meta">
        <div className="live-k">
          {session.market} · {session.device}
          {session.verdict !== null ? <span className={`pill ${verdictTone(session.verdict)}`}>{session.verdict}</span> : <span className="pill unknown">{session.status}</span>}
        </div>
        <div className="mono">{session.target.replace(/^https?:\/\//, "")}</div>
        <div className="dim">
          {session.journey} · {step}
        </div>
        <div className="row-sub">
          {session.startedAt.slice(11, 19)}
          {session.observedIp !== undefined ? ` · ${session.observedIp}` : ""}
          {session.confidence !== undefined ? ` · conf ${session.confidence}` : ""}
          {session.writes ? " · writes" : ""}
        </div>
      </div>
    </article>
  );
}
