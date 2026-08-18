/**
 * A visit that is on the live board, or just finished and not yet in the index.
 *
 * Shown on `#/live/<id>` so watching a session never leaves Now.
 * `#/run/<id>` still falls back here when the dashboard has not caught up.
 */
import { useEffect, useState, type JSX } from "react";
import { getJson } from "../api.ts";
import type { RunView } from "../types.ts";
import { RunJourney } from "./RunJourney.tsx";
import type { LiveSession } from "./Live.tsx";

interface EvidencePack {
  runId: string;
  verdict: string;
  steps: RunView["steps"];
  screenshots: RunView["screenshots"];
}

const tone = (verdict: string): string =>
  verdict === "PASS" ? "good" : verdict === "ERROR" ? "bad" : "warn";

export function LiveVisit({ runId }: { runId: string }): JSX.Element {
  const [session, setSession] = useState<LiveSession | null | undefined>(undefined);
  const [frame, setFrame] = useState<string>("");
  const [pack, setPack] = useState<EvidencePack | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const loadEvidence = (id: string): void => {
      if (!id.startsWith("run_")) return;
      void getJson<EvidencePack>(`/api/evidence/${id}`).then((evidence) => {
        if (cancelled) return;
        setPack(evidence.ok ? evidence.value : null);
      });
    };
    const poll = (): void => {
      void getJson<LiveSession>(`/api/live/${runId}`).then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setSession(null);
          loadEvidence(runId);
          return;
        }
        setSession(result.value);
        const id = result.value.id;
        void getJson<{ mime: string; data: string }>(`/api/live/${id}/frame`).then((shot) => {
          if (cancelled || !shot.ok) return;
          setFrame(`data:${shot.value.mime};base64,${shot.value.data}`);
        });
        loadEvidence(result.value.runId ?? runId);
      });
    };
    poll();
    const timer = window.setInterval(poll, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runId]);

  if (session === undefined || (session === null && pack === undefined)) {
    return <div className="load">looking for this visit…</div>;
  }

  if (session === null && pack === null) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>No such run.</strong>
          <code>{runId}</code> is not on the live board and not in this dashboard. Rebuild
          after the sweep finishes, or open it from Now while it is still on screen.
        </div>
      </div>
    );
  }

  const steps = session?.steps ?? [];
  const current = session?.stepIndex;
  const evidenceId = pack?.runId ?? session?.runId ?? (runId.startsWith("run_") ? runId : "");
  const live = session !== null && session.status !== "done";

  return (
    <>
      <div className="head">
        <p className="hint">
          {session !== null ? (
            <>
              {session.verdict !== null ? (
                <span className={`pill ${tone(session.verdict)}`}>{session.verdict}</span>
              ) : (
                <span className="pill unknown">{session.status}</span>
              )}{" "}
              {session.target} · {session.market} {session.device} · {session.journey}
              {session.stepLabel !== null
                ? ` · ${session.stepsTotal === null ? session.stepLabel : `${(session.stepIndex ?? 0) + 1}/${session.stepsTotal} ${session.stepLabel}`}`
                : ` · ${session.phase}`}
            </>
          ) : (
            <>Finished visit — evidence is on disk, not yet in the dashboard index.</>
          )}
        </p>
      </div>

      {session !== null ? (
        <div className="panel">
          <div className="panel-head">
            <h3>{live ? "On screen" : "Last frame"}</h3>
            <p className="hint">
              {live
                ? "The visitor's current view. You watch. You do not drive."
                : "The last frame this session kept. The evidence package below is the record."}
            </p>
          </div>
          <div className="live-stage">
            {frame !== "" ? <img src={frame} alt={session.target} /> : <div className="live-wait">awaiting frame</div>}
            {live ? (
              <>
                <span className="wake-layer" aria-hidden>
                  <span className="wake-ring wake-ring-a" />
                  <span className="wake-ring wake-ring-b" />
                  <span className="wake-ring wake-ring-c" />
                </span>
                <span className="live-pulse" aria-hidden="true" />
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {steps.length > 0 ? (
        <div className="panel">
          <div className="panel-head">
            <h3>What it is doing</h3>
            <p className="hint">Steps as they happen. A finished package, when it lands, has the outcomes.</p>
          </div>
          <ol className="live-steps">
            {steps.map((step) => (
              <li key={`${step.index}:${step.label}`} data-current={step.index === current ? "true" : undefined}>
                <span className="num dim">{step.index + 1}</span>
                <span>{step.label}</span>
                <span className="dim">{step.phase}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {pack != null && evidenceId !== "" ? (
        <RunJourney runId={evidenceId} steps={pack.steps} screenshots={pack.screenshots} />
      ) : null}
    </>
  );
}
