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

type SortKey = "startedAt" | "verdict" | "marketId" | "journeyId" | "lcp" | "ttfb" | "confidence" | "findings";

export function Runs({ view }: { view: DashboardView }): JSX.Element {
  const [q, setQ] = useState("");
  const [market, setMarket] = useState("");
  const [verdict, setVerdict] = useState("");
  const [journey, setJourney] = useState("");
  const [sort, setSort] = useState<SortKey>("startedAt");
  const [desc, setDesc] = useState(true);

  /**
   * Sorting on a `Measured<number>` puts absences LAST in both directions.
   *
   * An unmeasured LCP is not a fast page and not a slow one. Sorting it as 0 would put every run
   * the engine could not read at the top of "fastest", which is the conflation this entire
   * application exists to refuse — at the exact moment somebody is looking for the fastest page.
   */
  const value = (r: RunView, key: SortKey): number | string | null => {
    switch (key) {
      case "lcp":
        return r.vitals.lcp.measured ? r.vitals.lcp.value : null;
      case "ttfb":
        return r.vitals.ttfb.measured ? r.vitals.ttfb.value : null;
      case "confidence":
        return r.confidence.overall.measured ? r.confidence.overall.value : null;
      case "findings":
        return r.findings.total;
      default:
        return r[key];
    }
  };

  const markets = useMemo(() => [...new Set(view.runs.map((r) => r.marketId))].sort(), [view.runs]);
  const journeys = useMemo(() => [...new Set(view.runs.map((r) => r.journeyId))].sort(), [view.runs]);
  const verdicts = useMemo(() => [...new Set(view.runs.map((r) => r.verdict))].sort(), [view.runs]);

  const rows = view.runs
    .filter(
      (r) =>
        (market === "" || r.marketId === market) &&
        (verdict === "" || r.verdict === verdict) &&
        (journey === "" || r.journeyId === journey) &&
        (q === "" || `${r.target} ${r.runId} ${r.profileId}`.toLowerCase().includes(q.toLowerCase())),
    )
    .sort((a, b) => {
      const av = value(a, sort);
      const bv = value(b, sort);
      // Absences last, whichever way the column is pointing.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return desc ? -cmp : cmp;
    });

  /**
   * Defined OUTSIDE the component, and that is not a style preference.
   *
   * `Th` was declared inside `Runs`, so React saw a new component type on every render and
   * remounted the whole header. Clicking a column to sort descending and clicking it again to
   * sort ascending did nothing the second time, because the node the click landed on had already
   * been replaced. A component defined during render is a component that cannot hold state or
   * receive a second event.
   */
  const onSort = (key: SortKey): void => {
    if (key === sort) setDesc(!desc);
    else {
      setSort(key);
      setDesc(true);
    }
  };

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
                <Th sort={sort} desc={desc} onSort={onSort} k="verdict" label="Verdict" />
                <Th sort={sort} desc={desc} onSort={onSort} k="startedAt" label="Started" />
                <Th sort={sort} desc={desc} onSort={onSort} k="marketId" label="Market" />
                <Th sort={sort} desc={desc} onSort={onSort} k="journeyId" label="Journey" />
                <th>Page</th>
                <Th sort={sort} desc={desc} onSort={onSort} k="findings" label="Issues" num />
                <Th sort={sort} desc={desc} onSort={onSort} k="lcp" label="LCP" num />
                <th className="num">CLS</th>
                <Th sort={sort} desc={desc} onSort={onSort} k="ttfb" label="TTFB" num />
                <th className="num">INP</th>
                <Th sort={sort} desc={desc} onSort={onSort} k="confidence" label="Conf" num />
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

/**
 * A row is a link to the run, not a dead cell.
 *
 * The whole row rather than an id column, because the question a reader has while scanning is
 * always "what happened in THAT one" — and a drill-down reachable only from a narrow link is a
 * drill-down most people never find.
 */
function Row({ r }: { r: RunView }): JSX.Element {
  return (
    <tr className="link" onClick={() => (window.location.hash = `#/run/${r.runId}`)} title={`open ${r.runId}`}>
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
        {/* Zero is not dimmed: "nothing wrong" is a real answer and deserves to read as one. */}
        <span className={r.findings.total > 0 ? "bad-num" : "measured"}>{r.findings.total}</span>
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

function Th({
  k,
  label,
  num,
  sort,
  desc,
  onSort,
}: {
  k: SortKey;
  label: string;
  num?: boolean;
  sort: SortKey;
  desc: boolean;
  onSort: (k: SortKey) => void;
}): JSX.Element {
  const active = sort === k;
  return (
    <th
      className={num === true ? "num sortable" : "sortable"}
      onClick={() => onSort(k)}
      aria-sort={active ? (desc ? "descending" : "ascending") : "none"}
    >
      {label}
      <span className="sort-mark">{active ? (desc ? "\u25BE" : "\u25B4") : ""}</span>
    </th>
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
