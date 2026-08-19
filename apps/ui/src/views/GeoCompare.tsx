/**
 * Two cities, every page. A delta is absent unless both sides produced a TTFB.
 */
import type { JSX } from "react";
import type { PageAcrossMarkets } from "../types.ts";
import { Verdict } from "../Measured.tsx";
import { compareRows, geographyHref, pageLabel } from "./geography.ts";

export function GeoCompare({
  pages,
  left,
  right,
}: {
  pages: PageAcrossMarkets[];
  left: string;
  right: string;
}): JSX.Element {
  const rows = compareRows(pages, left, right);
  if (rows.length === 0) {
    return (
      <div className="empty">
        <strong>Pick two different cities.</strong>
        Comparing a market to itself is not a comparison.
      </div>
    );
  }
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>{left}</th>
            <th>{right}</th>
            <th className="num">TTFB Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.target} className={row.sameVerdict ? undefined : "geo-split"}>
              <td>
                <a className="geo-page-link" href={geographyHref(row.target)}>
                  {pageLabel(row.target)}
                </a>
              </td>
              <td>
                <Side reading={row.left} />
              </td>
              <td>
                <Side reading={row.right} />
              </td>
              <td className="num">
                {row.ttfbDeltaMs === null ? <span className="unmeasured">not measured</span> : `${row.ttfbDeltaMs}ms`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Side({ reading }: { reading: PageAcrossMarkets["markets"][string] | null }): JSX.Element {
  if (reading === null) return <span className="unmeasured">never measured</span>;
  return (
    <span className="geo-side">
      <Verdict value={reading.verdict} />
      <span className="dim">{reading.ttfbMs === null ? "TTFB not measured" : `${reading.ttfbMs}ms`}</span>
    </span>
  );
}
