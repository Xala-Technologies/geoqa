/**
 * What the fix agent works on, and what it reports.
 *
 * Two sources file findings — the growth fleet into Postgres, geoqa into
 * `filed-issues.json` — and a human can opt a third in by labelling an issue
 * `agent: approved`. A `WorkItem` is the ONE shape all three become before
 * anything is cloned, so the ranking, the budget and the dedup are written
 * once instead of three times.
 *
 * Pure type declarations; coverage-excluded by the types.ts rule in vitest.config.ts.
 */
import type { VerifyReport } from "./verify.js";

export type WorkSource = "growth" | "geoqa" | "github";

/**
 * One underlying row or draft inside a `WorkItem`.
 *
 * Carried because the write-back needs the source's own identity, not ours:
 * growth is keyed `(agent, finding_key)` — the table's UNIQUE contract —
 * and geoqa is keyed by the ticket draft key. A `WorkItem.key` is a grouping
 * name and would be meaningless to either.
 */
export interface WorkMember {
  source: WorkSource;
  agent?: string;
  findingKey?: string;
  draftKey?: string;
  url?: string;
  severity?: string;
  firstSeen?: string;
  lastSeen?: string;
}

export interface WorkRoute {
  /** owner/name */
  codeRepo: string;
  base: string;
  /** Bare host, or "" for a route keyed by repo rather than by host. */
  site: string;
  reason: "target-repo" | "site-host" | "urgent";
}

export interface WorkItem {
  /** Namespaced and stable across nights. The ONLY dedup identity. */
  key: string;
  source: WorkSource;
  title: string;
  /** `formatBrief()` output — the eight sections `parseBrief` and `prBody` expect. */
  body: string;
  labels: string[];
  urgent: boolean;
  /** `v_agent_findings_open.severity_rank`, 0..5. */
  severityRank: number;
  /** How many underlying rows this item covers. 339, not 1. */
  reach: number;
  /** 0..1, from the FIXABILITY table. Invented — see `triage.ts`. */
  fixability: number;
  daysOpen: number;
  category: string;
  rule: string;
  /** null until an issue exists. */
  issue: { repo: string; number: number; url: string } | null;
  /** null means REFUSED — never fall back to GEOQA_GITHUB_REPO. */
  route: WorkRoute | null;
  members: WorkMember[];
}

export type IneligibleReason =
  | "unroutable"
  | "no-issue"
  | "below-severity"
  | "category-not-allowed"
  | "already-repaired"
  | "attempts-exhausted"
  | "pr-open"
  | "changes-requested";

export type FixStatus =
  /** A pull request exists. */
  | "opened"
  /** The model declined — CANNOT_FIX. */
  | "cannot-fix"
  /** The model changed nothing. */
  | "no-changes"
  /** The review said no. Nothing reached origin. */
  | "rejected"
  /** The target repo's own checks failed. Nothing reached origin. */
  | "verify-failed"
  /** An exec, claude or IO failure. */
  | "failed";

export interface FixOutcome {
  key: string;
  status: FixStatus;
  prUrl?: string;
  autoMerge?: boolean;
  reviewVerdict?: "approve" | "reject";
  verify?: VerifyReport;
  detail?: string;
  ms: number;
}

export interface SourceReport {
  state: "ok" | "off" | "unavailable";
  rows: number;
  detail?: string;
}

export interface FixRunResult {
  skipped: "none" | "unconfigured" | "store-unreadable" | "locked" | "dry-run" | "no-sources" | "nothing-eligible";
  sources: { growth: SourceReport; geoqa: SourceReport; github: SourceReport };
  /** WorkItems after grouping. */
  intake: number;
  eligible: number;
  attempted: number;
  outcomes: FixOutcome[];
  ineligible: { key: string; reason: IneligibleReason }[];
  /** Dry run only. */
  wouldFix: WorkItem[];
  budget: { maxItems: number; budgetMs: number; usedMs: number; stoppedOnBudget: boolean };
  /** `growth.agent_runs.id`, or null when the database was unreachable. */
  runId: number | null;
}
