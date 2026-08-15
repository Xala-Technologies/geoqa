/**
 * What to file when a visit warned or failed.
 *
 * A label in a table is not a ticket. This is the description, the reason,
 * and the page console — the three things a human needs to open an issue
 * without re-opening the run.
 */
import { useState, type JSX } from "react";

export interface IssueRow {
  label: string;
  outcome: string;
  severity: string;
  reason: string;
  expected: string;
  observed: string;
  detail: string;
}

export interface ConsoleRow {
  type: string;
  text: string;
}

export function RunIssues({
  issues,
  console,
  brief,
}: {
  issues: IssueRow[];
  console: ConsoleRow[];
  brief: string;
}): JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const noisy = console.filter((line) => line.type === "error" || line.type === "warning" || line.type === "assert");
  if (issues.length === 0 && noisy.length === 0) return null;

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>File this</h3>
          <p className="hint">Description, why it failed, and what the page logged. Copy into an issue.</p>
        </div>
        {brief !== "" && (
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(brief).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {issues.length > 0 ? (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>Why</th>
                <th>Expected</th>
                <th>Observed</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue) => (
                <tr key={`${issue.outcome}:${issue.label}`}>
                  <td>
                    <span className={`outcome outcome-${issue.outcome}`}>{issue.outcome}</span> {issue.label}
                    <span className="row-sub">{issue.severity}</span>
                  </td>
                  <td className="step-did">{issue.reason}</td>
                  <td className="dim">{issue.expected}</td>
                  <td className="dim">{issue.observed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="issue-console">
        <h4>Console</h4>
        {console.length === 0 ? (
          <p className="hint">Console was not recorded, or the page logged nothing we kept.</p>
        ) : (
          <ol>
            {console.map((line, i) => (
              <li key={`${line.type}:${i}`} data-level={line.type}>
                <span className="mono">{line.type}</span>
                <span>{line.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
