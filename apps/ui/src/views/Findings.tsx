/**
 * What is wrong, aggregated the same way GitHub issues are.
 *
 * A check that failed on three hosts is three rows. Collapsing them hid
 * that xala.no and digilist.no are different repos. Severity still comes
 * from the runs a ticket names; the issue and PR are Measured — not filed
 * is an absence, not a blank.
 */
import { useMemo, useState, type JSX } from "react";
import type { DashboardView, FindingTicket, RunView } from "../types.ts";

const SEVERITY_RANK = ["critical", "high", "medium", "low", "info"];

const worstSeverity = (ticket: FindingTicket, runs: RunView[]): string => {
  const named = new Set(ticket.runIds);
  const severities = runs.filter((run) => named.has(run.runId)).flatMap((run) => Object.keys(run.findings.bySeverity));
  return SEVERITY_RANK.find((s) => severities.includes(s)) ?? (ticket.urgent ? "high" : "unknown");
};

const TONE: Record<string, string> = { critical: "bad", high: "bad", medium: "warn", low: "unknown", info: "unknown" };

export function Findings({ view }: { view: DashboardView }): JSX.Element {
  const [market, setMarket] = useState("");
  const [q, setQ] = useState("");

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
  const prs = rows.filter((r) => r.pr.measured).length;
  const urgent = rows.filter((r) => r.urgent).length;

  return (
    <>
      <div className="head">
        <p className="hint">
          One row per site and check — the same grouping as the GitHub issue.
          An issue or PR that has not been opened renders as not measured.
        </p>
      </div>

      <div className="gauges">
        <Gauge k="To fix" v={String(rows.length)} sub="distinct tickets in this data" />
        <Gauge k="Urgent" v={String(urgent)} sub="Decodo or a run that could not be measured" tone={urgent > 0 ? "var(--fail)" : undefined} />
        <Gauge k="Filed" v={String(filed)} sub="open on GitHub" />
        <Gauge k="Pull requests" v={String(prs)} sub="Claude opened a PR" />
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
        <span className="spacer">{rows.length} tickets</span>
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
                </tr>
              </thead>
              <tbody>
                {rows.map((ticket) => {
                  const latest = ticket.runIds[0];
                  const seen = view.runs.find((r) => r.runId === latest);
                  const severity = worstSeverity(ticket, view.runs);
                  return (
                    <tr key={ticket.key}>
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
                        <a className="tag" href={`#/run/${latest ?? ""}`}>
                          {(seen?.startedAt ?? "").slice(0, 10)} &rarr;
                        </a>
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
    <a className="tag" href={href(measured.value)} target="_blank" rel="noreferrer">
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
