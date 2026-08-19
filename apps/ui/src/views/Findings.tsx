/**
 * What is wrong, aggregated the same way GitHub issues are.
 *
 * A check that failed on three hosts is three rows. Click a row for the
 * brief. Fixed rows stay on the page, struck out, so the count of what
 * Claude already opened is visible next to what is still open. The Fix
 * button starts that work from here — it does not wait for the next sweep.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { getJson, sendJson } from "../api.ts";
import { findingHref } from "../route.ts";
import type { DashboardView, FindingTicket, RunView } from "../types.ts";
import { FindingDetail } from "./FindingDetail.tsx";

const SEVERITY_RANK = ["critical", "high", "medium", "low", "info"];

const worstSeverity = (ticket: FindingTicket, runs: RunView[]): string => {
  const named = new Set(ticket.runIds);
  const severities = runs.filter((run) => named.has(run.runId)).flatMap((run) => Object.keys(run.findings.bySeverity));
  return SEVERITY_RANK.find((s) => severities.includes(s)) ?? (ticket.urgent ? "high" : "unknown");
};

const TONE: Record<string, string> = { critical: "bad", high: "bad", medium: "warn", low: "unknown", info: "unknown" };

interface RepairStatus {
  running: boolean;
  queued: number;
  done: number;
  failed: number;
  last: string | null;
  started?: boolean;
  reason?: string;
}

export function Findings({
  view,
  onReload,
  ticketKey,
}: {
  view: DashboardView;
  onReload: () => void;
  ticketKey?: string;
}): JSX.Element {
  const [market, setMarket] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<RepairStatus | null>(null);
  const [action, setAction] = useState<string | null>(null);

  const runs = view.runs.filter((r) => market === "" || r.marketId === market);
  const visible = new Set(runs.map((r) => r.runId));
  const rows = useMemo(
    () =>
      view.tickets.filter((ticket) => {
        if (!ticket.runIds.some((id) => visible.has(id))) return false;
        if (q === "") return true;
        const hay = `${ticket.title} ${ticket.site} ${ticket.hosts.join(" ")}`.toLowerCase();
        return hay.includes(q.toLowerCase());
      }),
    [view.tickets, visible, q],
  );
  const markets = [...new Set(view.runs.map((r) => r.marketId))].sort();
  const filed = rows.filter((r) => r.issue.measured).length;
  const fixed = rows.filter((r) => r.fixed).length;
  const open = rows.length - fixed;
  const urgent = rows.filter((r) => r.urgent && !r.fixed).length;
  const running = status?.running === true;

  useEffect(() => {
    let cancelled = false;
    const poll = (): void => {
      void getJson<RepairStatus>("/api/findings/repair").then((result) => {
        if (cancelled || !result.ok) return;
        setStatus(result.value);
        if (result.value.running) onReload();
      });
    };
    poll();
    const timer = window.setInterval(poll, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [onReload]);

  const fix = (keys?: string[]): void => {
    setAction("Starting…");
    void sendJson<RepairStatus>("/api/findings/repair", "POST", keys === undefined ? {} : { keys }).then((result) => {
      if (!result.ok) {
        setAction(result.signedOut ? "sign in to fix" : result.error);
        return;
      }
      setStatus(result.value);
      setAction(result.value.started ? null : (result.value.last ?? result.value.reason ?? "already running"));
      onReload();
    });
  };

  if (ticketKey !== undefined) {
    return (
      <>
        {action !== null ? <p className="hint">{action}</p> : null}
        <FindingDetail view={view} ticketKey={ticketKey} onFix={fix} running={running} />
      </>
    );
  }

  return (
    <>
      <div className="head">
        <p className="hint">
          One row per site and check. Click a row for the brief — problem, cause,
          breaking changes, evidence. A ticket Claude already opened a PR for is struck out.
        </p>
      </div>

      <div className="gauges">
        <Gauge k="To fix" v={String(open)} sub={`${rows.length} tickets in this data`} />
        <Gauge k="Fixed" v={String(fixed)} sub="PR opened — struck out below" />
        <Gauge k="Urgent" v={String(urgent)} sub="Decodo or a run that could not be measured" tone={urgent > 0 ? "var(--fail)" : undefined} />
        <Gauge k="Filed" v={String(filed)} sub="open on GitHub" />
      </div>

      <div className="filters">
        <input type="search" placeholder="filter by check or site…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter findings" />
        <select value={market} onChange={(e) => setMarket(e.target.value)} aria-label="all markets">
          <option value="">all markets</option>
          {markets.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" type="button" disabled={running || open === 0} onClick={() => fix()}>
          {running ? "Fixing…" : open === 0 ? "All fixed" : `Fix ${open}`}
        </button>
        <span className="spacer">{action ?? status?.last ?? `${rows.length} tickets`}</span>
      </div>

      <div className="panel">
        {rows.length === 0 ? (
          <div className="empty">
            <strong>Nothing is failing.</strong>
            No check in {runs.length} run(s) produced a finding.
          </div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Site</th>
                  <th>Check</th>
                  <th>Issue</th>
                  <th>PR</th>
                  <th className="num">Runs</th>
                  <th>Last seen</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((ticket) => {
                  const latest = ticket.runIds[0];
                  const seen = view.runs.find((r) => r.runId === latest);
                  const severity = worstSeverity(ticket, view.runs);
                  return (
                    <tr
                      key={ticket.key}
                      className={ticket.fixed ? "link struck" : "link"}
                      onClick={() => {
                        window.location.hash = findingHref(ticket.key);
                      }}
                      title={`open ${ticket.title}`}
                    >
                      <td>
                        <span className={`pill ${ticket.urgent ? "bad" : (TONE[severity] ?? "unknown")}`}>
                          {ticket.urgent ? "geoqa" : ticket.site}
                        </span>
                      </td>
                      <td>
                        {ticket.title}
                        {ticket.hosts.length > 1 ? <div className="dim">{ticket.hosts.join(", ")}</div> : null}
                      </td>
                      <td>
                        <LinkOrAbsence measured={ticket.issue} label={(v) => `#${v.number}`} href={(v) => v.url} />
                      </td>
                      <td>
                        <LinkOrAbsence measured={ticket.pr} label={() => "PR"} href={(v) => v.url} />
                      </td>
                      <td className="num">{ticket.runIds.length}</td>
                      <td className="dim">
                        <a className="tag" href={`#/run/${latest ?? ""}`} onClick={(e) => e.stopPropagation()}>
                          {(seen?.startedAt ?? "").slice(0, 10)} &rarr;
                        </a>
                      </td>
                      <td>
                        {ticket.fixed ? null : (
                          <button
                            className="btn btn-quiet"
                            type="button"
                            disabled={running}
                            onClick={(e) => {
                              e.stopPropagation();
                              fix([ticket.key]);
                            }}
                          >
                            Fix
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function LinkOrAbsence<T>({
  measured,
  label,
  href,
}: {
  measured: { measured: true; value: T; text: string } | { measured: false; reason: string; text: "not measured" };
  label: (value: T) => string;
  href: (value: T) => string;
}): JSX.Element {
  if (!measured.measured) {
    return (
      <span className="unmeasured" title={measured.reason}>
        {measured.text}
      </span>
    );
  }
  return (
    <a className="tag" href={href(measured.value)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
      {label(measured.value)}
    </a>
  );
}

function Gauge({ k, v, sub, tone }: { k: string; v: string; sub: string; tone?: string | undefined }): JSX.Element {
  return (
    <div className="gauge">
      <div className="gauge-k">{k}</div>
      <div className="gauge-v" style={tone !== undefined ? { color: tone } : undefined}>
        {v}
      </div>
      <div className="gauge-sub">{sub}</div>
    </div>
  );
}
