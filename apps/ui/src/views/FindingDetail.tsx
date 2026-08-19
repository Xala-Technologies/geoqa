/**
 * One ticket, in the same words that were filed on GitHub.
 *
 * The list is a queue. This is the brief: problem, cause, what it is not,
 * breaking changes, and the runs that produced it.
 */
import type { JSX } from "react";
import type { DashboardView, Measured } from "../types.ts";
import { parseBrief, parseMarkdownTable, tokenizeInline } from "./finding-brief.ts";

export function FindingDetail({
  view,
  ticketKey,
  onFix,
  running,
}: {
  view: DashboardView;
  ticketKey: string;
  onFix: (keys: string[]) => void;
  running: boolean;
}): JSX.Element {
  const ticket = view.tickets.find((row) => row.key === ticketKey);
  if (ticket === undefined) {
    return (
      <div className="empty">
        <strong>This ticket is not in the current dashboard.</strong>
        Rebuild after the next sweep, or go back to{" "}
        <a className="tag" href="#/findings">
          To fix
        </a>
        .
      </div>
    );
  }

  const body = ticket.body;
  const sections = parseBrief(body);
  const shown =
    sections.length > 0
      ? sections
      : [
          { heading: "Problem", text: ticket.title },
          {
            heading: "Evidence",
            text: "This dashboard was built before briefs were stored. Rebuild to load Problem, root cause, and breaking changes.",
          },
        ];
  const latest = ticket.runIds[0];
  const seen = view.runs.find((run) => run.runId === latest);

  return (
    <>
      <div className="head">
        <p className="hint">
          <a className="tag" href="#/findings">
            ← To fix
          </a>{" "}
          {ticket.urgent ? "geoqa / vendor" : ticket.site}
          {ticket.fixed ? " · PR opened" : ""}
        </p>
      </div>

      <div className="gauges">
        <Gauge k="Check" v={ticket.title} sub={ticket.hosts.join(", ") || ticket.site} />
        <Gauge k="Runs" v={String(ticket.runIds.length)} sub={seen === undefined ? "no run in this view" : `${seen.marketId} · ${seen.journeyId}`} />
        <Gauge k="Issue" v={<LinkOrDash measured={ticket.issue} label={(v) => `#${v.number}`} href={(v) => v.url} />} sub="on GitHub" />
        <Gauge k="PR" v={<LinkOrDash measured={ticket.pr} label={() => "open"} href={(v) => v.url} />} sub={ticket.fixed ? "struck out on the list" : "none yet"} />
      </div>

      {shown.map((section) => (
        <div className="panel" key={section.heading}>
          <div className="panel-head">
            <h3>{section.heading}</h3>
          </div>
          <SectionBody text={section.text} />
        </div>
      ))}

      {ticket.fixed ? null : (
        <div className="filters">
          <button className="btn btn-primary" type="button" disabled={running} onClick={() => onFix([ticket.key])}>
            {running ? "Fixing…" : "Fix this"}
          </button>
          {latest === undefined ? null : (
            <a className="tag" href={`#/run/${latest}`}>
              Open latest run
            </a>
          )}
        </div>
      )}
    </>
  );
}

function SectionBody({ text }: { text: string }): JSX.Element {
  const table = parseMarkdownTable(text);
  if (table !== null) {
    return (
      <div className="scroll">
        <table>
          <thead>
            <tr>
              {table.headers.map((header) => (
                <th key={header}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className="brief-cell">
                    <Inline text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="brief-prose">
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i}>
          {para.split("\n").map((line, j) => (
            <span key={j}>
              {j > 0 ? <br /> : null}
              <Inline text={line} />
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

function Inline({ text }: { text: string }): JSX.Element {
  return (
    <>
      {tokenizeInline(text).map((token, i) => {
        if (token.kind === "strong") return <strong key={i}>{token.text}</strong>;
        if (token.kind === "code") return <code key={i}>{token.text}</code>;
        if (token.kind === "link") {
          const local = token.href.startsWith("#") || token.href.includes("/#/");
          return (
            <a key={i} className="tag" href={token.href} {...(local ? {} : { target: "_blank", rel: "noreferrer" })}>
              {token.text}
            </a>
          );
        }
        return <span key={i}>{token.text}</span>;
      })}
    </>
  );
}

function LinkOrDash<T>({
  measured,
  label,
  href,
}: {
  measured: Measured<T>;
  label: (value: T) => string;
  href: (value: T) => string;
}): JSX.Element {
  if (!measured.measured) return <span className="unmeasured">{measured.text}</span>;
  return (
    <a className="tag" href={href(measured.value)} target="_blank" rel="noreferrer">
      {label(measured.value)}
    </a>
  );
}

function Gauge({ k, v, sub }: { k: string; v: JSX.Element | string; sub: string }): JSX.Element {
  return (
    <div className="gauge">
      <div className="gauge-k">{k}</div>
      <div className="gauge-v brief-gauge">{typeof v === "string" ? v : v}</div>
      <div className="gauge-sub">{sub}</div>
    </div>
  );
}
