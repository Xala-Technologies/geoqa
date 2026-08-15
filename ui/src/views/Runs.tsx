/**
 * Every visit, filterable, sortable, paged.
 *
 * The filters are the whole reason this is its own view: at 32 runs a table is readable, and at
 * 3,200 it is a wall. Filtering happens in memory over the loaded document — there is no server
 * to ask, by design ([R-147]). Latest first is the opening order; a header click is the rest.
 *
 * The page title lives in the header bar. Repeating it here is the same word twice.
 */
import { useMemo, useState, type JSX } from "react";
import type { DashboardView, RunView } from "../types.ts";
import { MeasuredValue, Verdict } from "../Measured.tsx";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  deviceOf,
  filterRuns,
  nextSort,
  pageRuns,
  sortRuns,
  type RunSortKey,
} from "./run-list.ts";

export function Runs({ view }: { view: DashboardView }): JSX.Element {
  const [q, setQ] = useState("");
  const [market, setMarket] = useState("");
  const [verdict, setVerdict] = useState("");
  const [journey, setJourney] = useState("");
  const [device, setDevice] = useState("");
  const [sort, setSort] = useState<RunSortKey>("startedAt");
  const [desc, setDesc] = useState(true);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const markets = useMemo(() => [...new Set(view.runs.map((r) => r.marketId))].sort(), [view.runs]);
  const journeys = useMemo(() => [...new Set(view.runs.map((r) => r.journeyId))].sort(), [view.runs]);
  const verdicts = useMemo(() => [...new Set(view.runs.map((r) => r.verdict))].sort(), [view.runs]);
  const devices = useMemo(() => [...new Set(view.runs.map((r) => deviceOf(r.profileId)))].sort(), [view.runs]);

  const filtered = filterRuns(view.runs, { q, market, verdict, journey, device });
  const sorted = sortRuns(filtered, sort, desc);
  const shown = pageRuns(sorted, page, pageSize);

  const tally = filtered.reduce(
    (acc, r) => {
      acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const reset = (fn: () => void): void => {
    fn();
    setPage(0);
  };

  const onSort = (key: RunSortKey): void => {
    const next = nextSort(sort, desc, key);
    setSort(next.sort);
    setDesc(next.desc);
    setPage(0);
  };

  return (
    <>
      <div className="head">
        <p className="hint">
          {tally.PASS ?? 0} pass · {tally.FAIL ?? 0} fail · {tally.ERROR ?? 0} error
          {tally.PASS_WITH_WARNINGS ? ` · ${tally.PASS_WITH_WARNINGS} warned` : ""}.{" "}
          <strong>ERROR</strong> is our instrumentation, not the page — excluded from every
          cross-market comparison. Observed city is the one that matters: a pass from the wrong
          town is a geographic claim we could not keep.
        </p>
      </div>

      <div className="filters">
        <input
          type="search"
          placeholder="filter by URL, run id, profile or observed city…"
          value={q}
          onChange={(e) => reset(() => setQ(e.target.value))}
          aria-label="Filter runs"
        />
        <Select value={market} onChange={(v) => reset(() => setMarket(v))} options={markets} all="all markets" />
        <Select value={device} onChange={(v) => reset(() => setDevice(v))} options={devices} all="all devices" />
        <Select value={journey} onChange={(v) => reset(() => setJourney(v))} options={journeys} all="all journeys" />
        <Select value={verdict} onChange={(v) => reset(() => setVerdict(v))} options={verdicts} all="all verdicts" />
        <span className="spacer">
          {shown.total === 0 ? "0" : `${shown.from}–${shown.to}`} / {view.runs.length}
        </span>
      </div>

      <div className="panel">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <Th sort={sort} desc={desc} onSort={onSort} k="verdict" label="Verdict" />
                <Th sort={sort} desc={desc} onSort={onSort} k="startedAt" label="When" />
                <Th sort={sort} desc={desc} onSort={onSort} k="marketId" label="From" />
                <Th sort={sort} desc={desc} onSort={onSort} k="journeyId" label="Journey" />
                <Th sort={sort} desc={desc} onSort={onSort} k="target" label="Page" />
                <Th sort={sort} desc={desc} onSort={onSort} k="observed" label="Observed" />
                <Th sort={sort} desc={desc} onSort={onSort} k="findings" label="Issues" num />
                <Th sort={sort} desc={desc} onSort={onSort} k="lcp" label="LCP" num />
                <Th sort={sort} desc={desc} onSort={onSort} k="cls" label="CLS" num />
                <Th sort={sort} desc={desc} onSort={onSort} k="confidence" label="Conf" num />
                <Th sort={sort} desc={desc} onSort={onSort} k="durationMs" label="Dur" num />
              </tr>
            </thead>
            <tbody>
              {shown.rows.map((r) => (
                <Row key={r.runId} r={r} />
              ))}
            </tbody>
          </table>
        </div>
        {shown.total === 0 ? (
          <div className="empty">
            <strong>No run matches.</strong>
            Widen the filters — the data is loaded, nothing is being fetched.
          </div>
        ) : (
          <Pager
            shown={shown}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={(n) => {
              setPageSize(n);
              setPage(0);
            }}
          />
        )}
      </div>
    </>
  );
}

function Pager({
  shown,
  pageSize,
  onPage,
  onPageSize,
}: {
  shown: { page: number; pages: number; from: number; to: number; total: number };
  pageSize: number;
  onPage: (n: number) => void;
  onPageSize: (n: number) => void;
}): JSX.Element {
  return (
    <div className="pager">
      <span className="pager-pos">
        {shown.from}–{shown.to} of {shown.total}
      </span>
      <div className="pager-nav">
        <select
          value={pageSize}
          aria-label="Rows per page"
          onChange={(e) => onPageSize(Number(e.target.value))}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
        <button className="btn btn-quiet" type="button" disabled={shown.page === 0} onClick={() => onPage(shown.page - 1)}>
          Prev
        </button>
        <span className="pager-pos">
          {shown.page + 1} / {shown.pages}
        </span>
        <button
          className="btn btn-quiet"
          type="button"
          disabled={shown.page + 1 >= shown.pages}
          onClick={() => onPage(shown.page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function Row({ r }: { r: RunView }): JSX.Element {
  const firstLabel = r.findings.labels[0];
  const cityOff = r.geo.city !== "match";
  return (
    <tr className="link" onClick={() => (window.location.hash = `#/run/${r.runId}`)} title={`open ${r.runId}`}>
      <td>
        <Verdict value={r.verdict} />
      </td>
      <td className="mono dim">{r.startedAt.slice(0, 19).replace("T", " ")}</td>
      <td>
        <span className="mono">{r.marketId}</span>
        <span className="row-sub">{deviceOf(r.profileId)}</span>
      </td>
      <td className="dim">{r.journeyId}</td>
      <td>
        <Page url={r.target} />
      </td>
      <td>
        <span className={cityOff ? "bad-num" : "measured"}>{r.geo.observed}</span>
        <span className="row-sub">
          asked {r.geo.requested}
          {r.geo.egressHeld !== "match" ? ` · held ${r.geo.egressHeld}` : ""}
        </span>
      </td>
      <td className="num">
        <span className={r.findings.total > 0 ? "bad-num" : "measured"}>{r.findings.total}</span>
        {firstLabel !== undefined ? <span className="row-sub">{firstLabel}</span> : null}
      </td>
      <td className="num">
        <MeasuredValue value={r.vitals.lcp} />
      </td>
      <td className="num">
        <MeasuredValue value={r.vitals.cls} />
      </td>
      <td className="num">
        <MeasuredValue value={r.confidence.overall} />
      </td>
      <td className="num mono dim">{(Math.round(r.durationMs / 100) / 10).toFixed(1)}s</td>
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
  k: RunSortKey;
  label: string;
  num?: boolean;
  sort: RunSortKey;
  desc: boolean;
  onSort: (k: RunSortKey) => void;
}): JSX.Element {
  const active = sort === k;
  return (
    <th className={num === true ? "num sortable" : "sortable"} aria-sort={active ? (desc ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => onSort(k)}>
        {label}
        <span className="sort-mark">{active ? (desc ? "\u25BE" : "\u25B4") : "\u2195"}</span>
      </button>
    </th>
  );
}

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
