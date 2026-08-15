/**
 * What the journey actually did: stills first, then the step log, then
 * the ticket text if anything failed.
 *
 * Frames do not play. A rotating GIF hides the still you need to file an
 * issue against. Click a thumbnail to enlarge it.
 */
import { useEffect, useState, type JSX } from "react";
import { getJson } from "../api.ts";
import type { RunView } from "../types.ts";
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
  const present = (pack?.screenshots ?? screenshots).filter((s) => s.present);

  return (
    <>
      <Frames runId={runId} shots={present} />
      <RunIssues issues={pack?.issues ?? []} console={pack?.console ?? []} brief={pack?.brief ?? ""} />
      <div className="panel">
        <div className="panel-head">
          <h3>What it did</h3>
          <p className="hint">Every step, in order. A click names the selector and the URL it landed on.</p>
        </div>
        {log.length === 0 ? (
          <div className="empty">
            <strong>No step log on this visit.</strong>
            Rebuild the dashboard so it reads this run&rsquo;s <code>run.json</code>.
          </div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Step</th>
                  <th>Did</th>
                  <th>Landed</th>
                  <th>Ms</th>
                </tr>
              </thead>
              <tbody>
                {log.map((step) => (
                  <tr key={`${step.index}:${step.label}`}>
                    <td className="num dim">{step.index + 1}</td>
                    <td>
                      <span className={`outcome outcome-${step.outcome}`}>{step.outcome}</span> {step.label}
                    </td>
                    <td className="step-did">{step.detail || step.action}</td>
                    <td className="dim">{step.observed ?? step.expected ?? "—"}</td>
                    <td className="num dim">{step.durationMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Frames({ runId, shots }: { runId: string; shots: RunView["screenshots"] }): JSX.Element {
  const [cursor, setCursor] = useState(0);
  const [urls, setUrls] = useState<Record<string, string>>({});

  const shotKey = shots.map((s) => s.label).join(",");
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

  const current = shots[cursor];
  const src = current === undefined ? "" : (urls[current.label] ?? "");

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>Screenshots</h3>
          <p className="hint">Stills this visit kept. Click one. They do not play.</p>
        </div>
      </div>
      {shots.length === 0 ? (
        <div className="empty">
          <strong>No frames kept.</strong>
          This journey did not take a screenshot, or the file is gone.
        </div>
      ) : (
        <div className="film">
          <figure className="film-hero">
            {src !== "" ? <img src={src} alt={current?.label ?? ""} /> : <div className="film-wait">loading frame…</div>}
            <figcaption>
              {current?.label} · {cursor + 1}/{shots.length}
            </figcaption>
          </figure>
          <div className="film-strip">
            {shots.map((shot, i) => (
              <button
                key={shot.label}
                type="button"
                className={i === cursor ? "film-thumb on" : "film-thumb"}
                onClick={() => setCursor(i)}
              >
                {urls[shot.label] !== undefined ? <img src={urls[shot.label]} alt={shot.label} /> : <span className="film-wait">…</span>}
                <span>{shot.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
