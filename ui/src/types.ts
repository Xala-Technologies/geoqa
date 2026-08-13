/**
 * The shape `geoqa dashboard build` writes.
 *
 * Mirrored rather than imported: this app is built by a different tsconfig and ships as
 * static files, so it must not reach into `src/`. The pairing is checked by
 * `src/report/__tests__/view.test.ts`, which asserts the field names this file expects —
 * a drift there fails the engine's own suite rather than silently producing a blank panel.
 */
export type Measured<T> =
  | { measured: true; value: T; text: string }
  | { measured: false; reason: string; text: "not measured" };

export interface RunView {
  runId: string;
  target: string;
  profileId: string;
  marketId: string;
  journeyId: string;
  verdict: string;
  startedAt: string;
  evidenceId: string | null;
  seed: number;
  findings: { total: number; bySeverity: Record<string, number> };
  confidence: {
    overall: Measured<number>;
    geo: Measured<number>;
    browser: Measured<number>;
    journey: Measured<number>;
    evidence: Measured<number>;
    search: Measured<number>;
  };
  vitals: { lcp: Measured<number>; cls: Measured<number>; ttfb: Measured<number>; inp: Measured<number> };
  geo: { requested: string; observed: string; country: string; city: string; egressHeld: string; agreement: string };
  latency: Measured<number>;
}

export interface Regression {
  label: string;
  profileId: string;
  journeyId: string;
  target: string;
  lastGood: { runId: string; startedAt: string };
  firstBad: { runId: string; startedAt: string };
}

export interface PageAcrossMarkets {
  target: string;
  markets: Record<string, { verdict: string; ttfbMs: number | null; lcpMs: number | null; confidence: number }>;
  ttfbSpreadMs: number | null;
  divergentMarkets: string[];
}

export type TrendDirection = "improving" | "worsening" | "stable" | "insufficient-data";

export interface TrendSeries {
  target: string;
  marketId: string;
  metric: "lcp" | "cls" | "ttfb" | "inp" | "confidence";
  /** Gaps included. A null value is a GAP and must render as one, never interpolated. */
  points: { at: string; runId: string; value: number | null }[];
  measuredPoints: number;
  earlier: Measured<number>;
  later: Measured<number>;
  direction: TrendDirection;
  reason: string;
}

export interface DashboardView {
  generatedAt: string;
  runs: RunView[];
  /** Only the series with a real direction. `allTrends` has the rest. */
  trends: TrendSeries[];
  allTrends: TrendSeries[];
  summary: {
    total: number;
    byVerdict: Record<string, number>;
    meanConfidence: Measured<number>;
    first: string | null;
    last: string | null;
  };
  regressions: Regression[];
  site: {
    pages: number;
    markets: string[];
    perPage: PageAcrossMarkets[];
    coverageGaps: { target: string; missing: string[] }[];
    geographicallyDivergent: PageAcrossMarkets[];
    widestLatencyGaps: PageAcrossMarkets[];
    warnings: string[];
  };
  warnings: string[];
}
