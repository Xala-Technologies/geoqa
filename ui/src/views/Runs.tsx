/**
 * Every run, filterable.
 *
 * The filters are the whole reason this is its own view: at 32 runs a table is readable, and at
 * 3,200 it is a wall. Filtering happens in memory over the loaded document — there is no server
 * to ask, by design ([R-147]).
 */
import { useMemo, useState, type JSX } from "react";
import type { DashboardView, RunView } from "../types.ts";
import { MeasuredValue, Verdict } from "../Measured.tsx";

export function Runs({ view }: { view: DashboardView }): JSX.Element {
  const [q, setQ] = useState("");
  const [market, setMarket] = useState("");
  const [verdict, setVerdict] = useState("");
  const [journey, setJourney] = useState("");

  const markets = useMemo(() => [...new Set(view.runs.map((r) => r.marketId))].sort(), [view.runs]);
  const journeys = useMemo(() => [...new Set(view.runs.map((r) => r.journeyId))].sort(), [view.runs]);
  const verdicts = useMemo(() => [...new Set(view.runs.map((r) => r.verdict))].sort(), [view.runs]);

  const rows = view.runs.filter(
    (r) =>
      (market === "" || r.marketId === market) &&
      (verdict === "" || r.verdict === verdict) &&
      (journey === "" || r.journeyId === journey) &&
      (q === "" || `${r.target} ${r.runId} ${r.profileId}`.toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <>
      <div className="head">
        <h2>Runs</h2>
        <p className="hint">
          One row per run. <strong>ERROR</strong> is our instrumentation failing, not the page —
          it carries its own tone and is excluded from every cross-market comparison.
        </p>
      </div>

      <div className="filters">
        <input
          type="search"
          placeholder="filter by URL, run id or profile…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Filter runs"
        />
        <Select value={market} onChange={setMarket} options={markets} all="all markets" />
        <Select value={journey} onChange={setJourney} options={journeys} all="all journeys" />
        <Select value={verdict} onChange={setVerdict} options={verdicts} all="all verdicts" />
        <span className="spacer">
          {rows.length} / {view.runs.length}
        </span>
      </div>

      <div className="panel">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Verdict</th>
                <th>Started</th>
                <th>Market</th>
                <th>Journey</th>
                <th>Page</th>
                <th className="num">LCP</th>
                <th className="num">CLS</th>
                <th className="num">TTFB</th>
                <th className="num">INP</th>
                <th className="num">Conf</th>
                <th>Country</th>
                <th>City</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.runId} r={r} />
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <div className="empty">
            <strong>No run matches.</strong>
            Widen the filters — the data is loaded, nothing is being fetched.
          </div>
        )}
      </div>
    </>
  );
}

function Row({ r }: { r: RunView }): JSX.Element {
  return (
    <tr>
      <td>
        <Verdict value={r.verdict} />
      </td>
      <td className="mono dim">{r.startedAt.slice(0, 19).replace("T", " ")}</td>
      <td className="mono">{r.marketId}</td>
      <td className="dim">{r.journeyId}</td>
      <td>
        <Page url={r.target} />
      </td>
      <td className="num">
        <MeasuredValue value={r.vitals.lcp} />
      </td>
      <td className="num">
        <MeasuredValue value={r.vitals.cls} />
      </td>
      <td className="num">
        <MeasuredValue value={r.vitals.ttfb} />
      </td>
      <td className="num">
        <MeasuredValue value={r.vitals.inp} />
      </td>
      <td className="num">
        <MeasuredValue value={r.confidence.overall} />
      </td>
      <td>
        <Verdict value={r.geo.country} />
      </td>
      <td>
        <Verdict value={r.geo.city} />
      </td>
    </tr>
  );
}

/**
 * A URL shown without its scheme.
 *
 * Every target in this table is http(s), so the prefix is eight characters of noise repeated on
 * every row — and it pushes the one column that identifies a row off the side of a wide table.
 * The full URL stays in the title, because a shortened identifier a reader cannot recover is a
 * different problem from a long one.
 */
function Page({ url }: { url: string }): JSX.Element {
  return (
    <span className="dim" title={url}>
      {url.replace(/^https?:\/\//, "")}
    </span>
  );
}

function Select({
  value,
  onChange,
  options,
  all,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  all: string;
}): JSX.Element {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={all}>
      <option value="">{all}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
