/**
 * Operator health for the watch itself — not for a page.
 *
 * A sweep can look busy on Live while every session has been stuck on
 * "preparing" for minutes. This panel is the reading that names that.
 */
import type { JSX } from "react";

export interface WatchFinding {
  kind: string;
  severity: string;
  message: string;
  sinceMs: number;
  sessionId?: string;
}

export interface WatchHealthView {
  status: "ok" | "paused" | "stalled" | "failed" | string;
  findings: WatchFinding[];
}

export interface WatchLogLine {
  at: string;
  level: string;
  kind: string;
  message: string;
  sessionId?: string;
}

const statusTone = (status: string): string =>
  status === "ok" || status === "paused" ? "good" : status === "stalled" || status === "failed" ? "bad" : "warn";

export function WatchHealth({ health, log }: { health: WatchHealthView; log: WatchLogLine[] }): JSX.Element {
  const tone = statusTone(health.status);
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Health</h3>
        <p className="hint">
          The watch's own process — hung browsers, a sweep that threw, a clock we could not read.
        </p>
      </div>
      <div className="watch-row" style={{ padding: "0 1.25rem 0.75rem" }}>
        <span className={`pill ${tone}`}>{health.status}</span>
        {health.findings.length === 0 ? <span className="dim">nothing to report</span> : null}
      </div>
      {health.findings.length > 0 ? (
        <div className={`note${tone === "bad" ? " bad" : ""}`}>
          <div>
            {health.findings.map((finding) => (
              <div key={`${finding.kind}-${finding.sessionId ?? ""}`}>{finding.message}</div>
            ))}
          </div>
        </div>
      ) : null}
      {log.length === 0 ? (
        <div className="dim" style={{ padding: "0 1.25rem 1rem" }}>
          No watch log yet. Stalls and sweep failures land here and survive a restart.
        </div>
      ) : (
        <ol className="live-log">
          {log.map((line, index) => (
            <li key={`${line.at}-${line.kind}-${index}`} data-level={line.level}>
              <span className="mono dim">{line.at.slice(11, 19)}</span>
              <span className="mono dim">{line.kind}</span>
              <span>{line.message}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
