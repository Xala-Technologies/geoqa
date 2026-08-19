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
  /** `labels` names the checks that failed — the difference between counting problems and naming one. */
  findings: { total: number; bySeverity: Record<string, number>; byCategory: Record<string, number>; labels: string[] };
  durationMs: number;
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
  steps: {
    index: number;
    action: string;
    label: string;
    outcome: string;
    detail: string;
    expected: string | null;
    observed: string | null;
    durationMs: number;
  }[];
  screenshots: { label: string; file: string; present: boolean }[];
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
  /** Same grouping as the GitHub tickets: one row per check × host. */
  tickets: FindingTicket[];
  warnings: string[];
}

export interface FindingTicket {
  key: string;
  title: string;
  site: string;
  hosts: string[];
  urgent: boolean;
  runIds: string[];
  issue: Measured<{ number: number; url: string }>;
  pr: Measured<{ url: string }>;
  /** A PR exists. The row is struck out. */
  fixed: boolean;
  /** The same brief that was filed (or would be filed) on GitHub. */
  body: string;
}
