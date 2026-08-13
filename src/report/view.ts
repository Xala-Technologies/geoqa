/**
 * The view model a UI renders, and the one rule it exists to enforce.
 *
 * **An axis with no reading must render as "not measured", visually distinct from zero.**
 * That is a requirement rather than a preference: the entire engine refuses to conflate
 * "we could not look" with "it is fine", and a UI that printed `0` for a null LCP would
 * undo all of it at the last step — a dashboard is where a number gets believed.
 *
 * So the view model does not carry raw nullables and hope the renderer is careful. Every
 * value a UI displays arrives as a `Measured<T>`: either a reading with its formatted text,
 * or an explicit absence with the REASON it is absent. A renderer cannot accidentally show
 * a missing metric as a value, because a missing metric is not the same TYPE as a present
 * one.
 *
 * Built here rather than in the UI so it is covered like everything else in `src/`. The
 * React app is a renderer; every judgement about what a number means happens on this side.
 */
import type { RunRecord } from "../history/records.js";
import { analyseSite, marketOf, type SiteReport } from "../analysis/site.js";
import { findRegressions, summariseHistory, type Regression } from "../history/store.js";

/**
 * A value that may not exist, carrying WHY when it does not.
 *
 * The shape is the safeguard. A renderer writing `{value.text}` gets "not measured" for an
 * absence rather than "0" or "null" or "NaN", and a renderer wanting to style the two
 * differently switches on `measured`.
 */
export type Measured<T> = { measured: true; value: T; text: string } | { measured: false; reason: string; text: "not measured" };

export const measured = <T,>(value: T, text: string): Measured<T> => ({ measured: true, value, text });
export const unmeasured = <T,>(reason: string): Measured<T> => ({ measured: false, reason, text: "not measured" });

/** Milliseconds, or an explicit absence. Never 0 standing in for "unread". */
export const ms = (value: number | null, reason = "the browser reported no value"): Measured<number> =>
  value === null ? unmeasured(reason) : measured(value, `${Math.round(value)}ms`);

/** A unitless metric such as CLS, where 0 is a REAL and good reading. */
export const ratio = (value: number | null, reason = "the browser reported no value"): Measured<number> =>
  value === null ? unmeasured(reason) : measured(value, String(Math.round(value * 1000) / 1000));

/** A 0..100 score. */
export const score = (value: number | null, reason = "not computed"): Measured<number> =>
  value === null ? unmeasured(reason) : measured(value, String(Math.round(value)));

export interface RunView {
  runId: string;
  target: string;
  profileId: string;
  marketId: string;
  journeyId: string;
  verdict: RunRecord["verdict"];
  startedAt: string;
  /** For a link to the evidence directory. Null when none was written. */
  evidenceId: string | null;
  seed: number;
  findings: { total: number; bySeverity: Record<string, number> };
  confidence: {
    overall: Measured<number>;
    geo: Measured<number>;
    browser: Measured<number>;
    journey: Measured<number>;
    evidence: Measured<number>;
    /** Null for almost every run, and that must LOOK different from a bad score. */
    search: Measured<number>;
  };
  vitals: { lcp: Measured<number>; cls: Measured<number>; ttfb: Measured<number>; inp: Measured<number> };
  geo: {
    requested: string;
    observed: string;
    country: string;
    city: string;
    egressHeld: string;
    agreement: string;
  };
  latency: Measured<number>;
}

/**
 * One run, as a UI needs it.
 *
 * `searchObservation` is the case that proves the point: it is `null` for almost every run
 * in this system, and a dashboard showing `0` there would tell a reader their site is
 * invisible in search when the truth is that nobody looked.
 */
export function toRunView(record: RunRecord): RunView {
  return {
    runId: record.runId,
    target: record.target,
    profileId: record.profileId,
    marketId: marketOf(record.profileId),
    journeyId: record.journeyId,
    verdict: record.verdict,
    startedAt: record.startedAt,
    evidenceId: record.evidenceId,
    seed: record.seed,
    findings: { total: record.findings.total, bySeverity: record.findings.bySeverity },
    confidence: {
      overall: score(record.confidence.overall),
      geo: score(record.confidence.geo),
      browser: score(record.confidence.browser),
      journey: score(record.confidence.journey),
      evidence: score(record.confidence.evidence),
      // Not on the record at all for a run that took no SERP observation, which is most of
      // them. Explicitly unmeasured rather than defaulted.
      search: unmeasured("no SERP observation was taken for this run"),
    },
    vitals: {
      lcp: ms(record.vitals.lcp, "no largest-contentful-paint entry was emitted"),
      // CLS uses `ratio`, not `ms`, and a CLS of 0 is a REAL reading meaning nothing moved
      // — the one metric here where zero is good news rather than a missing value.
      cls: ratio(record.vitals.cls, "no layout-shift entries were observed"),
      ttfb: ms(record.vitals.ttfb),
      inp: ms(record.vitals.inp, "no interaction was timed — INP does not exist until something is clicked, and a page that responds faster than the browser reports produces no entry"),
    },
    geo: {
      requested: `${record.geo.requestedCountry}/${record.geo.requestedCity}`,
      observed: `${record.geo.observedCountry ?? "?"}/${record.geo.observedCity ?? "?"}`,
      country: record.geo.country,
      city: record.geo.city,
      egressHeld: record.geo.egressHeld,
      agreement: record.geo.agreement,
    },
    latency: ms(record.latencyMs, "the identity endpoint was not reached"),
  };
}

export interface DashboardView {
  generatedAt: string;
  runs: RunView[];
  summary: {
    total: number;
    byVerdict: Record<string, number>;
    meanConfidence: Measured<number>;
    first: string | null;
    last: string | null;
  };
  regressions: Regression[];
  site: SiteReport;
  /** Said out loud in the UI, not swallowed. */
  warnings: string[];
}

/**
 * Everything a dashboard needs, from the run history.
 *
 * One function so the UI makes exactly one request and cannot assemble a half-loaded
 * picture. `generatedAt` is passed in rather than read from the clock, because a view model
 * that stamps itself is not reproducible and its tests would depend on the time of day.
 */
export function toDashboardView(records: RunRecord[], generatedAt: string, warnings: string[] = []): DashboardView {
  const summary = summariseHistory(records);
  return {
    generatedAt,
    // Newest first: a dashboard is read from the top, and the most recent run is what
    // somebody opened it to see.
    runs: [...records].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(toRunView),
    summary: {
      total: summary.runs,
      byVerdict: summary.byVerdict,
      // Null for an empty history, and it must not render as 0 — "no runs" and "runs that
      // scored zero" are different facts and only one of them is bad news.
      meanConfidence: score(summary.meanConfidence, "no runs have been recorded yet"),
      first: summary.first,
      last: summary.last,
    },
    regressions: findRegressions(records),
    site: analyseSite(records),
    warnings: [...warnings, ...analyseSite(records).warnings],
  };
}

/** Verdict → a semantic class name, so the UI does not re-derive severity. */
export function verdictTone(verdict: string): "good" | "warn" | "bad" | "unknown" {
  switch (verdict) {
    case "PASS":
      return "good";
    case "PASS_WITH_WARNINGS":
      return "warn";
    case "FAIL":
      return "bad";
    default:
      // ERROR and anything unrecognised. `unknown` rather than `bad` on purpose: an ERROR
      // is our defect, and colouring it like a site failure in a dashboard is the same
      // conflation the verdict model spent so much effort avoiding.
      return "unknown";
  }
}

/** An axis verdict → a tone. `unverified` is its own state, never styled as a failure. */
export function axisTone(verdict: string): "good" | "warn" | "bad" | "unknown" {
  switch (verdict) {
    case "match":
      return "good";
    case "mismatch":
      return "bad";
    case "unverified":
      return "unknown";
    default:
      return "unknown";
  }
}
