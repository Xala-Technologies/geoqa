/**
 * One page, every city. Click a card to open the visit that produced it.
 */
import type { JSX } from "react";
import type { PageAcrossMarkets, RunView } from "../types.ts";
import { Verdict } from "../Measured.tsx";
import {
  buildCells,
  filterCells,
  sortCells,
  type GeoCell,
  type GeoMetric,
  type GeoSort,
} from "./geography.ts";

export function GeoExplore({
  page,
  markets,
  runs,
  metric,
  sort,
  desc,
  q,
}: {
  page: PageAcrossMarkets;
  markets: string[];
  runs: RunView[];
  metric: GeoMetric;
  sort: GeoSort;
  desc: boolean;
  q: string;
}): JSX.Element {
  const cells = filterCells(sortCells(buildCells(page, markets, runs, metric), sort, desc), q);
  if (cells.length === 0) {
    return (
      <div className="empty">
        <strong>No city matches.</strong>
        Clear the filter to see every market on this page.
      </div>
    );
  }
  return (
    <div className="geo-grid">
      {cells.map((cell) => (
        <CityCard key={cell.marketId} cell={cell} />
      ))}
    </div>
  );
}

function CityCard({ cell }: { cell: GeoCell }): JSX.Element {
  const href = cell.runId === null ? undefined : `#/run/${cell.runId}`;
  const heat = cell.heat;
  const tone = cell.errored ? "unknown" : cell.verdict === null ? "void" : cell.divergent ? "bad" : "ok";
  const inner = (
    <>
      <div className="geo-city-k">{cell.marketId}</div>
      <div className="geo-city-v">
        {cell.errored ? (
          <Verdict value="ERROR" />
        ) : cell.verdict === null ? (
          <span className="unmeasured">never measured</span>
        ) : (
          <Verdict value={cell.verdict} />
        )}
      </div>
      <dl className="geo-city-meta">
        <div>
          <dt>TTFB</dt>
          <dd>{cell.ttfbMs === null ? "—" : `${cell.ttfbMs}ms`}</dd>
        </div>
        <div>
          <dt>LCP</dt>
          <dd>{cell.lcpMs === null ? "—" : `${cell.lcpMs}ms`}</dd>
        </div>
        <div>
          <dt>Conf</dt>
          <dd>{cell.confidence === null ? "—" : String(cell.confidence)}</dd>
        </div>
      </dl>
      {cell.requested === null ? null : (
        <div className="geo-city-geo">
          asked {cell.requested}
          {cell.observed === null ? "" : ` · saw ${cell.observed}`}
          {cell.cityAxis === null || cell.cityAxis === "match" ? "" : ` · city ${cell.cityAxis}`}
        </div>
      )}
    </>
  );
  const style =
    heat === null
      ? undefined
      : { ["--geo-heat" as string]: String(heat), background: `color-mix(in srgb, var(--fg-accent) ${Math.round(heat * 28)}%, var(--bg-elevated))` };
  if (href === undefined) {
    return (
      <article className={`geo-city geo-city-${tone}`} style={style}>
        {inner}
      </article>
    );
  }
  return (
    <a className={`geo-city geo-city-${tone} pressable`} style={style} href={href} title={`open ${cell.marketId}`}>
      {inner}
    </a>
  );
}
