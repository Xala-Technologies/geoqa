/**
 * What is wrong, aggregated across every run — the page a QA product exists to have.
 *
 * The Runs view answers "what happened"; this answers "what should I fix first", which is a
 * different question and the one somebody actually opens a console to ask. A check that failed
 * once in twelve runs and a check that failed twelve times out of twelve are the same row in a
 * run list and completely different pieces of news.
 *
 * **Aggregated by check LABEL**, because that is the unit a person fixes. "has a search box"
 * failing in two markets across nine runs is one job. Nine rows saying the same thing is a list
 * somebody scrolls past.
 *
 * Severity comes from the runs the label appears in rather than being stored per label: the run
 * index keeps counts by severity and the labels that produced a finding, not a mapping between
 * them. So a label's severity here is the WORST severity present in the runs it failed in, which
 * is stated in the column header rather than implied — an inference presented as a fact is the
 * thing this whole codebase refuses.
 */
import { useMemo, useState, type JSX } from "react";
import type { DashboardView, RunView } from "../types.ts";

const SEVERITY_RANK = ["critical", "high", "medium", "low", "info"];

interface Aggregate {
  label: string;
  runs: number;
  markets: string[];
  journeys: string[];
  pages: string[];
  worstSeverity: string;
  lastSeen: string;
  /** Runs where this label appeared, newest first — the drill-down target. */
  runIds: string[];
  /** How many of the runs that COULD have produced it did. */
  rate: number;
}

function aggregate(runs: RunView[]): Aggregate[] {
  const byLabel = new Map<string, RunView[]>();
  for (const run of runs) {
    for (const label of run.findings.labels) {
      byLabel.set(label, [...(byLabel.get(label) ?? []), run]);
    }
  }
  // The denominator is runs of the same JOURNEY, not all runs. A check that only exists in the
  // search journey has not "failed 4 of 32 times" — it failed 4 of the 4 times it ran, which is
  // a completely different claim and the one a reader would act on.
  const byJourney = new Map<string, number>();
  for (const run of runs) byJourney.set(run.journeyId, (byJourney.get(run.journeyId) ?? 0) + 1);

  return [...byLabel.entries()]
    .map(([label, where]) => {
      const journeys = [...new Set(where.map((r) => r.journeyId))];
      const possible = journeys.reduce((sum, j) => sum + (byJourney.get(j) ?? 0), 0);
      const severities = where.flatMap((r) => Object.keys(r.findings.bySeverity));
      const worst = SEVERITY_RANK.find((s) => severities.includes(s)) ?? "unknown";
      const sorted = [...where].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return {
        label,
        runs: where.length,
        markets: [...new Set(where.map((r) => r.marketId))].sort(),
        journeys,
        pages: [...new Set(where.map((r) => r.target))],
        worstSeverity: worst,
        lastSeen: sorted[0]?.startedAt ?? "",
        runIds: sorted.map((r) => r.runId),
        rate: possible === 0 ? 0 : where.length / possible,
      };
    })
    .sort((a, b) => SEVERITY_RANK.indexOf(a.worstSeverity) - SEVERITY_RANK.indexOf(b.worstSeverity) || b.runs - a.runs);
}

const TONE: Record<string, string> = { critical: "bad", high: "bad", medium: "warn", low: "unknown", info: "unknown" };

export function Findings({ view }: { view: DashboardView }): JSX.Element {
  const [market, setMarket] = useState("");
  const [q, setQ] = useState("");

  const runs = view.runs.filter((r) => market === "" || r.marketId === market);
  const rows = useMemo(() => aggregate(runs), [runs]).filter(
    (a) => q === "" || `${a.label} ${a.pages.join(" ")}`.toLowerCase().includes(q.toLowerCase()),
  );
  const markets = [...new Set(view.runs.map((r) => r.marketId))].sort();

  const total = rows.reduce((n, r) => n + r.runs, 0);
  const persistent = rows.filter((r) => r.rate >= 0.99).length;
  const intermittent = rows.filter((r) => r.rate < 0.99 && r.rate > 0).length;

  return (
    <>
      <div className="head">
        <p className="hint">
          Grouped by the check that produced them, because that is the unit somebody fixes. A
          check failing every time it runs and a check failing once are the same row in a run list
          and completely different news.
        </p>
      </div>

      <div className="gauges">
        <Gauge k="Distinct problems" v={String(rows.length)} sub="checks with at least one finding" />
        <Gauge k="Always fails" v={String(persistent)} sub="fails every run of its journey" tone={persistent > 0 ? "var(--fail)" : undefined} />
        <Gauge k="Intermittent" v={String(intermittent)} sub="fails some runs — flakiness, or a real intermittent defect" tone={intermittent > 0 ? "var(--warn)" : undefined} />
        <Gauge k="Total occurrences" v={String(total)} sub="across every run in this data" />
      </div>

      <div className="filters">
        <input type="search" placeholder="filter by check or page…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter findings" />
        <select value={market} onChange={(e) => setMarket(e.target.value)} aria-label="all markets">
          <option value="">all markets</option>
          {markets.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="spacer">{rows.length} checks</span>
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
                  <th>Worst severity</th>
                  <th>Check</th>
                  <th className="num">Fails</th>
                  <th>Rate</th>
                  <th>Markets</th>
                  <th>Journey</th>
                  <th>Page</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.label}>
                    <td>
                      <span className={`pill ${TONE[a.worstSeverity] ?? "unknown"}`}>{a.worstSeverity}</span>
                    </td>
                    <td>{a.label}</td>
                    <td className="num">{a.runs}</td>
                    <td>
                      {/* Rate as form and number: "always" reads before the percentage does. */}
                      <span className="mkt">
                        <span className="mkt-bar">
                          <span style={{ width: `${Math.round(a.rate * 100)}%`, background: a.rate >= 0.99 ? "var(--fail)" : "var(--warn)" }} />
                        </span>
                        <span className="measured">{Math.round(a.rate * 100)}%</span>
                      </span>
                    </td>
                    <td className="dim">{a.markets.join(", ")}</td>
                    <td className="dim">{a.journeys.join(", ")}</td>
                    <td className="dim" title={a.pages.join("\n")}>
                      {a.pages.length === 1 ? (a.pages[0] ?? "").replace(/^https?:\/\//, "") : `${a.pages.length} pages`}
                    </td>
                    <td className="dim">
                      <a className="tag" href={`#/run/${a.runIds[0] ?? ""}`}>
                        {a.lastSeen.slice(0, 10)} &rarr;
                      </a>
                    </td>
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
