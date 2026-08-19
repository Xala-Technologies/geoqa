/**
 * The half of the picture no crawler running from one datacentre can produce.
 *
 * One URL, one set of HTML, different results by market. Explore a page
 * city by city, or compare two cities across every page.
 */
import { useMemo, useState, type JSX } from "react";
import type { DashboardView, PageAcrossMarkets } from "../types.ts";
import { GeoCompare } from "./GeoCompare.tsx";
import { GeoExplore } from "./GeoExplore.tsx";
import {
  geographyHref,
  marketsInView,
  pageLabel,
  spreadText,
  verdictMix,
  worstSpread,
  type GeoMetric,
  type GeoSort,
} from "./geography.ts";

export function Geography({ view, pageTarget }: { view: DashboardView; pageTarget?: string }): JSX.Element {
  const { site, runs } = view;
  const pages = site.perPage;
  const markets = useMemo(() => marketsInView(site.markets, runs), [site.markets, runs]);
  const [mode, setMode] = useState<"explore" | "compare">("explore");
  const [metric, setMetric] = useState<GeoMetric>("verdict");
  const [sort, setSort] = useState<GeoSort>("name");
  const [desc, setDesc] = useState(false);
  const [q, setQ] = useState("");
  const [left, setLeft] = useState(markets[0] ?? "");
  const [right, setRight] = useState(markets[1] ?? markets[0] ?? "");

  const selected =
    pages.find((page) => page.target === pageTarget) ??
    site.geographicallyDivergent[0] ??
    pages[0];
  const spread = worstSpread(pages);
  const divergent = site.geographicallyDivergent.length;

  return (
    <>
      <div className="head">
        <p className="hint">
          The same page, measured from inside each market. A latency spread is not a slow site — it
          is a site that is slow <em>somewhere</em>. Click a city to open the visit.
        </p>
      </div>

      <div className="gauges">
        <Gauge k="Pages" v={String(site.pages)} sub={`${markets.length} market(s) in this data`} />
        <Gauge k="Divergent" v={String(divergent)} sub="verdict is not the same everywhere" tone={divergent > 0 ? "var(--fail)" : undefined} />
        <Gauge
          k="Widest TTFB spread"
          v={spread === null ? "not measured" : `${spread}ms`}
          sub={site.widestLatencyGaps[0] === undefined ? "needs two markets with a TTFB" : pageLabel(site.widestLatencyGaps[0].target)}
        />
        <Gauge k="Could not verify" v={String(view.summary.byVerdict.ERROR ?? 0)} sub="ERROR runs — excluded from the comparison" />
      </div>

      {pages.length === 0 ? (
        <div className="empty">
          <strong>No page has been measured yet.</strong>
          Run a journey from more than one market to compare.
        </div>
      ) : (
        <>
          <div className="geo-pages">
            {pages.map((page) => (
              <PageCard key={page.target} page={page} selected={page.target === selected?.target} />
            ))}
          </div>

          <div className="filters">
            <div className="toolbar" role="tablist" aria-label="Geography mode">
              <button className={`tool-text${mode === "explore" ? " tool-accent" : ""}`} type="button" onClick={() => setMode("explore")}>
                Explore
              </button>
              <button className={`tool-text${mode === "compare" ? " tool-accent" : ""}`} type="button" onClick={() => setMode("compare")}>
                Compare
              </button>
            </div>
            {mode === "explore" ? (
              <>
                <select value={metric} onChange={(e) => setMetric(e.target.value as GeoMetric)} aria-label="colour cities by">
                  <option value="verdict">colour by verdict</option>
                  <option value="ttfb">colour by TTFB</option>
                  <option value="lcp">colour by LCP</option>
                  <option value="confidence">colour by confidence</option>
                </select>
                <select
                  value={sort}
                  onChange={(e) => {
                    const next = e.target.value as GeoSort;
                    setDesc(next !== "name" && next !== sort ? true : desc);
                    setSort(next);
                  }}
                  aria-label="sort cities"
                >
                  <option value="name">sort A–Z</option>
                  <option value="ttfb">sort TTFB</option>
                  <option value="lcp">sort LCP</option>
                  <option value="confidence">sort confidence</option>
                  <option value="verdict">sort verdict</option>
                </select>
                <button className="btn btn-quiet" type="button" onClick={() => setDesc(!desc)}>
                  {desc ? "High first" : "Low first"}
                </button>
                <input type="search" placeholder="filter cities…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter cities" />
              </>
            ) : (
              <>
                <select value={left} onChange={(e) => setLeft(e.target.value)} aria-label="left city">
                  {markets.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <span className="dim">vs</span>
                <select value={right} onChange={(e) => setRight(e.target.value)} aria-label="right city">
                  {markets.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </>
            )}
            <span className="spacer">
              {selected === undefined ? `${pages.length} page(s)` : spreadText(selected)}
            </span>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>{mode === "explore" ? (selected === undefined ? "Markets" : pageLabel(selected.target)) : `${left} vs ${right}`}</h3>
              <p className="hint">
                {mode === "explore"
                  ? "A hotter card is slower or less confident on the metric you picked. ERROR is ours, not a site fail."
                  : "A row that disagrees is where geography changed the outcome."}
              </p>
            </div>
            {mode === "explore" && selected !== undefined ? (
              <div className="panel-body geo-explore">
                <GeoExplore page={selected} markets={markets} runs={runs} metric={metric} sort={sort} desc={desc} q={q} />
              </div>
            ) : mode === "compare" ? (
              <GeoCompare pages={pages} left={left} right={right} />
            ) : null}
          </div>
        </>
      )}
    </>
  );
}

function PageCard({ page, selected }: { page: PageAcrossMarkets; selected: boolean }): JSX.Element {
  const mix = verdictMix(page);
  return (
    <a className={`geo-page pressable${selected ? " on" : ""}`} href={geographyHref(page.target)}>
      <div className="geo-page-k">{pageLabel(page.target)}</div>
      <div className="geo-page-v">
        {mix.fail > 0 ? <span className="bad-num">{mix.fail} fail</span> : <span className="measured">{mix.pass} pass</span>}
        <span className="dim"> · {mix.total} market(s)</span>
      </div>
      <div className="geo-page-sub">
        {page.divergentMarkets.length > 0
          ? `${page.divergentMarkets.length} diverged`
          : page.ttfbSpreadMs === null
            ? "spread not measured"
            : `${page.ttfbSpreadMs}ms spread`}
      </div>
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
