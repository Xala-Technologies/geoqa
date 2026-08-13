/**
 * A run, reduced to the fields a question spans runs to answer.
 *
 * **The evidence tree is the source of truth and this is a derived cache.** That
 * single decision is what makes the whole file safe: an index that disagrees with the
 * runs on disk is rebuilt from them, never reconciled and never trusted over them. A
 * store that owned the truth would introduce the failure this project exists to
 * prevent — a confident answer about runs that did not happen the way it says.
 *
 * Why not SQLite, which Node now ships. `node:sqlite` is EXPERIMENTAL: it prints a
 * warning on every invocation and its own documentation says it may change at any
 * time. A CLI that emits an experimental-feature warning before every line of output
 * is a worse tool, and "may change at any time" is a poor foundation for the store
 * that trends and a UI are supposed to depend on. Against that, JSONL costs one line
 * per run, is greppable, diffs in a review, and cannot corrupt in a way that loses a
 * run — because the run is still on disk.
 *
 * When SQLite becomes right: when a query needs an INDEX rather than a scan. A tenant
 * with 10,000 runs is a 10 MB file and a linear scan measured in milliseconds; a
 * hosted UI serving many tenants concurrently is a different problem, and the shape
 * here — one record per run, append-only — imports into a table without a rewrite.
 *
 * Only what a cross-run question needs is kept. Findings are counted and grouped
 * rather than copied: the full text of every finding is already in the run's own
 * evidence, and duplicating it here would make the index the biggest thing in the
 * tree while adding nothing a reader could not get by opening the run.
 */
import type { GeoQaRunResult } from "../findings/types.js";

/** The index format. Bumped when a field changes meaning, never when one is added. */
export const HISTORY_SCHEMA_VERSION = 1;

export interface RunRecord {
  schemaVersion: number;
  runId: string;
  /** Null for a run that named no tenant — single-target use, still the common case. */
  tenantId: string | null;
  target: string;
  profileId: string;
  journeyId: string;
  verdict: GeoQaRunResult["verdict"];
  startedAt: string;
  durationMs: number;
  /**
   * The seed, so a run in this index can be REPLAYED from it.
   *
   * The point of keeping it: a regression found by comparing two runs is only
   * actionable if the older one can be re-run, and the seed is what makes a run with
   * human pacing and optional steps repeat exactly.
   */
  seed: number;
  engine: string;
  evidenceId: string | null;
  /** Counts and groupings, not the findings themselves. See the file comment. */
  findings: {
    total: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
    /**
     * The step labels that produced a finding.
     *
     * The one piece of per-finding detail worth keeping, because it is what makes
     * regression detection possible: "this check passed on Monday and fails today" is
     * a question about labels, and answering it by opening every run's evidence would
     * make the index pointless.
     */
     labels: string[];
  };
  confidence: {
    overall: number;
    geo: number;
    browser: number;
    journey: number;
    evidence: number;
  };
  /** Per-axis geographic verdicts, which is what a geographic trend is made of. */
  geo: {
    requestedCountry: string;
    requestedCity: string;
    observedCountry: string | null;
    observedCity: string | null;
    country: string;
    city: string;
    egressHeld: string;
    /** Null when nothing corroborated. Distinct from a source disagreement. */
    agreement: string;
  };
  /** Round-trip latency to the identity endpoint, in ms, or null if unread. */
  latencyMs: number | null;
  /** Core Web Vitals worth trending. Null is UNMEASURED, never zero. */
  vitals: { lcp: number | null; cls: number | null; ttfb: number | null; inp: number | null };
}

/**
 * Reduce a run result to its record.
 *
 * `vitals` are not on `GeoQaRunResult`, so they are passed in by the caller that has
 * them. Nulls are preserved all the way through: a metric that was not measured must
 * not become a zero in a trend, which would show a page getting faster the moment it
 * stopped being measurable.
 */
export function toRunRecord(
  result: GeoQaRunResult,
  extra: {
    tenantId: string | null;
    seed: number;
    engine: string;
    vitals?: { lcp: number | null; cls: number | null; ttfb: number | null; inp: number | null } | undefined;
  },
): RunRecord {
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const labels: string[] = [];
  for (const finding of result.findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
    if (finding.stepLabel && !labels.includes(finding.stepLabel)) labels.push(finding.stepLabel);
  }
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    runId: result.runId,
    tenantId: extra.tenantId,
    target: result.target,
    profileId: result.profileId,
    journeyId: result.journeyId,
    verdict: result.verdict,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    seed: extra.seed,
    engine: extra.engine,
    evidenceId: result.evidenceId,
    findings: { total: result.findings.length, bySeverity, byCategory, labels },
    confidence: {
      overall: result.confidence.overall,
      geo: result.confidence.geo,
      browser: result.confidence.browser,
      journey: result.confidence.journey,
      evidence: result.confidence.evidence,
    },
    geo: {
      requestedCountry: result.geo.network.requested.country,
      requestedCity: result.geo.network.requested.city,
      observedCountry: result.geo.network.observed.country,
      observedCity: result.geo.network.observed.city,
      country: result.geo.network.country.verdict,
      city: result.geo.network.city.verdict,
      egressHeld: result.geo.network.egressHeld.verdict,
      agreement: result.geo.network.agreement.verdict,
    },
    latencyMs: result.geo.network.observed.latencyMs,
    vitals: extra.vitals ?? { lcp: null, cls: null, ttfb: null, inp: null },
  };
}

/**
 * Parse one index line.
 *
 * `null` for anything unreadable, and the caller reports how many lines it skipped.
 * A half-written final line is a NORMAL state for an append-only file — a process
 * killed mid-write leaves one — and throwing on it would make one interrupted run
 * destroy the readability of every run before it. The evidence for that run is still
 * on disk, so the honest response is to skip the line, say so, and offer a rebuild.
 */
export function parseRunRecord(line: string): RunRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Partial<RunRecord>;
  // The three fields every query depends on. A record missing any of them cannot
  // answer a question, and guessing at them would put a fabricated run in a trend.
  if (typeof record.runId !== "string" || typeof record.startedAt !== "string" || typeof record.verdict !== "string") return null;
  return record as RunRecord;
}
