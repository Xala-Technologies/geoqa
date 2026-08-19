/**
 * The visit as a flow: each step, with the still taken at that moment.
 *
 * A film strip beside a table is two lists of the same events. The
 * operator is asking "what did the visitor see here?" — one card per
 * step answers that. Frames do not play.
 */
import { useEffect, useState, type JSX } from "react";
import { getJson } from "../api.ts";
import type { RunView } from "../types.ts";
import { attachShotsToSteps, leftoverShots, type FlowStep, type Shot } from "./run-flow.ts";
import { RunIssues, type ConsoleRow, type IssueRow } from "./RunIssues.tsx";

interface EvidencePack {
  steps: RunView["steps"];
  screenshots: RunView["screenshots"];
  issues: IssueRow[];
  console: ConsoleRow[];
  brief: string;
}

export function RunJourney({
  runId,
  steps,
  screenshots,
}: {
  runId: string;
  steps: RunView["steps"];
  screenshots: RunView["screenshots"];
}): JSX.Element {
  const [pack, setPack] = useState<EvidencePack | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void getJson<EvidencePack>(`/api/evidence/${runId}`).then((result) => {
      if (cancelled || !result.ok) return;
      setPack(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const log = pack?.steps ?? steps;
  const shots = pack?.screenshots ?? screenshots;
  const flow = attachShotsToSteps(log, shots);
  const extra = leftoverShots(log, shots);
  const labels = [...flow.map((s) => s.shot?.label), ...extra.map((s) => s.label)].filter(
    (label): label is string => label !== undefined,
  );
  const shotKey = labels.join(",");

  useEffect(() => {
    let cancelled = false;
    for (const label of shotKey === "" ? [] : shotKey.split(",")) {
      void getJson<{ mime: string; data: string }>(`/api/evidence/${runId}/shot/${label}`).then((result) => {
        if (cancelled || !result.ok) return;
        setUrls((prev) => ({ ...prev, [label]: `data:${result.value.mime};base64,${result.value.data}` }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [runId, shotKey]);

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <div>
            <h3>What the visitor did</h3>
            <p className="hint">Every step, with the still taken then. They do not play.</p>
          </div>
        </div>
        {log.length === 0 ? (
          <div className="empty">
            <strong>No step log on this visit.</strong>
            Rebuild the dashboard so it reads this run&rsquo;s <code>run.json</code>.
          </div>
        ) : (
          <ol className="flow">
            {flow.map((step) => (
              <FlowCard key={`${step.index}:${step.label}`} step={step} src={step.shot ? (urls[step.shot.label] ?? "") : ""} />
            ))}
          </ol>
        )}
        {extra.length > 0 ? <AlsoKept shots={extra} urls={urls} /> : null}
      </div>
      <RunIssues issues={pack?.issues ?? []} console={pack?.console ?? []} brief={pack?.brief ?? ""} />
    </>
  );
}

function FlowCard({ step, src }: { step: FlowStep; src: string }): JSX.Element {
  return (
    <li className="flow-card" data-outcome={step.outcome}>
      <div className="flow-meta">
        <span className="flow-n">{step.index + 1}</span>
        <div>
          <p className="flow-title">
            <span className={`outcome outcome-${step.outcome}`}>{step.outcome}</span> {step.label}
          </p>
          <p className="flow-did">{step.detail || step.action}</p>
          {step.observed !== null || step.expected !== null ? (
            <p className="flow-landed">{step.observed ?? step.expected}</p>
          ) : null}
        </div>
        <span className="flow-ms">{step.durationMs} ms</span>
      </div>
      {step.shot !== null ? (
        <figure className="flow-still">
          {src !== "" ? <img src={src} alt={step.shot.label} /> : <div className="film-wait">loading frame…</div>}
          <figcaption>{step.shot.label}</figcaption>
        </figure>
      ) : (
        <p className="flow-gap">No still — this step did not keep a frame.</p>
      )}
    </li>
  );
}

function AlsoKept({ shots, urls }: { shots: Shot[]; urls: Record<string, string> }): JSX.Element {
  return (
    <div className="flow-extra">
      <p className="hint">Also kept, not attached to a step</p>
      <div className="film-strip">
        {shots.map((shot) => (
          <figure key={shot.label} className="film-thumb">
            {urls[shot.label] !== undefined ? <img src={urls[shot.label]} alt={shot.label} /> : <span className="film-wait">…</span>}
            <span>{shot.label}</span>
          </figure>
        ))}
      </div>
    </div>
  );
}
