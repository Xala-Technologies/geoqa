/**
 * The finding schema.
 *
 * Adapted from agent-fleet's `tools/adversarial-agent/src/types.ts`, which is
 * the best one in that repo: severity AND a separate 0..1 confidence, evidence
 * by reference, and — the parts most finding schemas omit — `validationMethod`
 * (how a human confirms this themselves) and `reproducibility` (how many times
 * we tried and how many times it happened).
 *
 * Severity and confidence are deliberately independent. `critical` at
 * confidence 42 means "drop everything and look", `medium` at confidence 99
 * means "definitely real, fix it next sprint". Collapsing them into one number
 * loses the distinction that decides what a human does next.
 */
import type { GeoVerification } from "../geo/types.js";

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export type FindingCategory =
  | "functional"
  | "content"
  | "localization"
  | "performance"
  | "network"
  | "navigation"
  | "conversion"
  | "accessibility"
  | "javascript"
  | "http"
  | "redirect"
  | "instrumentation"
  | "unknown";

/**
 * `instrumentation` is a first-class category, not a catch-all. It means the
 * defect is OURS — a reading never arrived — and it must never be filed as a
 * site defect. Keeping it in the same schema is what makes "how much of what we
 * reported was actually about the site?" an answerable question.
 */
export interface EvidenceRef {
  label: string;
  /** Relative to the run's evidence directory. */
  path: string;
  mime?: string;
}

export type FindingStatus = "observed" | "reproduced" | "dismissed";

export interface Reproducibility {
  attempts: number;
  occurrences: number;
}

export interface Finding {
  id: string;
  runId: string;
  category: FindingCategory;
  severity: FindingSeverity;
  status: FindingStatus;
  title: string;
  expected: string;
  observed: string;
  /** 0..100 that the finding is genuine. Independent of severity. */
  confidence: number;
  reproducibility: Reproducibility;
  affectedUrl: string;
  market: string;
  device: string;
  /** Which journey step produced it, so a human can re-run exactly that. */
  journeyId: string;
  stepLabel: string | null;
  evidence: EvidenceRef[];
  /** How a human confirms this without trusting us. */
  validationMethod: string;
  /** ISO-8601. */
  detectedAt: string;
}

/**
 * The full result of one geoqa run — what the CLI prints and an agent consumes.
 *
 * This shape IS the integration contract (`--json`), so it carries a version.
 * The constant and the rule for bumping it live next to the other consumed
 * artifact, in `evidence/manifest.ts` (`GEOQA_SCHEMA_VERSION`) — one number
 * covers both, because a consumer reading a run result and the evidence package
 * it points at is reading one contract. It is stamped by `assembleResult`, not
 * defaulted anywhere, so a result that reached a consumer without going through
 * the assembler is visibly not a run result.
 */
export interface GeoQaRunResult {
  /** `GEOQA_SCHEMA_VERSION` at the time of the run. */
  schemaVersion: number;
  runId: string;
  target: string;
  profileId: string;
  journeyId: string;
  verdict: "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "ERROR";
  geo: GeoVerification;
  confidence: ConfidenceReport;
  findings: Finding[];
  evidenceId: string | null;
  startedAt: string;
  durationMs: number;
}

/**
 * Confidence, kept as separate axes.
 *
 * `searchObservation` is `null` in Phase 0 and that is recorded rather than
 * defaulted. It would combine our observations with DataForSEO/SerpApi
 * agreement, and this project has no SERP source wired — a fabricated number
 * there would be exactly the "perfect score is the most suspicious number on
 * the board" failure.
 */
export interface ConfidenceReport {
  /** Network identity: is the egress where we asked for? */
  geo: number;
  /** Browser environment: does the page believe what we told it? */
  browser: number;
  /** Did the journey execute cleanly enough to trust its verdict? */
  journey: number;
  /** Is the evidence package complete enough to reproduce from? */
  evidence: number;
  /** Not measured in Phase 0. */
  searchObservation: number | null;
  overall: number;
  /** Why the overall number is what it is. */
  notes: string[];
}
