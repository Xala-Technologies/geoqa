/**
 * The publish gate: may this page go live?
 *
 * **A deliberate narrowing, stated rather than done quietly.** The loop's slice said
 * "copy the content agent". Generation does NOT come here, and that is the point rather
 * than a shortcut. The division the whole loop rests on is *agents produce, geoqa
 * verifies* — so putting a content generator inside the verifier would collapse exactly
 * the separation it exists to enforce, and the first time an LLM in this repo wrote a page
 * that this repo then approved, the approval would be worth nothing.
 *
 * Publishing stays in `agent-fleet` too, and for a plainer reason: it is OAuth tokens,
 * LinkedIn and X API calls and blog markdown writes. None of that is geographic QA.
 *
 * What geoqa owes that pipeline is a verdict it cannot argue with. This file is that
 * verdict, and its whole design is one rule:
 *
 * **Default deny.** No reading is a BLOCK, never an allow. A gate that opens when it
 * cannot see is not a gate, and every other component in this system already refuses to
 * turn "we could not measure" into "it is fine" — this is that rule at the point where it
 * costs something.
 */
import type { Finding, GeoQaRunResult } from "../findings/types.js";

export type GateDecision = "allow" | "block" | "unknown";

export interface GateThresholds {
  /**
   * Findings at or above this severity block. Default `high`.
   *
   * `high` rather than `critical`, because the severities are declared per step by the
   * journey author: a step marked `high` was marked that way on purpose by whoever knew
   * what the page is for.
   */
  blockAtOrAbove?: "critical" | "high" | "medium" | "low";
  /** Minimum overall confidence. Default 70. */
  minConfidence?: number;
  /** Minimum geographic confidence, for a page whose point is a market. Default 0 (off). */
  minGeoConfidence?: number;
}

export interface GateResult {
  decision: GateDecision;
  /** Why, in one sentence a publisher can log. Always populated. */
  reason: string;
  /** Every rule that failed, so a fix list is available without re-running. */
  blockers: string[];
  /** Real problems that did not block. Never silently dropped. */
  warnings: string[];
  /** The run this decision was taken from, so it is auditable. */
  runId: string | null;
  evidenceId: string | null;
}

const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"] as const;
type Severity = (typeof SEVERITY_ORDER)[number];

const atOrAbove = (severity: string, floor: Severity): boolean => {
  const s = SEVERITY_ORDER.indexOf(severity as Severity);
  return s >= 0 && s >= SEVERITY_ORDER.indexOf(floor);
};

/**
 * Decide from a completed run.
 *
 * The three-state result is not decoration, and the middle state is where most gates go
 * wrong:
 *
 * - `block` — the page has a problem we MEASURED. Actionable: fix the page.
 * - `unknown` — we could not measure. Actionable: fix the instrumentation, then re-run.
 *   Reported separately from `block` because it is OUR defect, and telling an author their
 *   page is broken when the truth is that our browser could not read it wastes their time
 *   and costs the gate its credibility.
 * - `allow` — measured, and clean enough by the declared thresholds.
 *
 * `unknown` still prevents publishing. It is a different SENTENCE from `block`, not a
 * different outcome for the page.
 */
export function gateFromRun(result: GeoQaRunResult, thresholds: GateThresholds = {}): GateResult {
  const floor = thresholds.blockAtOrAbove ?? "high";
  const minConfidence = thresholds.minConfidence ?? 70;
  const minGeo = thresholds.minGeoConfidence ?? 0;

  const blockers: string[] = [];
  const warnings: string[] = [];

  // An instrumentation failure is OUR defect and is never reported as the page's.
  const instrumentation = result.findings.filter((f) => f.category === "instrumentation");
  if (result.verdict === "ERROR" || instrumentation.length > 0) {
    return {
      decision: "unknown",
      reason: `cannot decide: ${instrumentation.length > 0 ? `${instrumentation.length} step(s) could not be read` : "the run errored"} — this is a geoqa defect, not a problem with the page. Fix the instrumentation and re-run; publishing stays blocked meanwhile because a gate that opens when it cannot see is not a gate.`,
      blockers: instrumentation.map((f) => `could not verify: ${f.title}`),
      warnings,
      runId: result.runId,
      evidenceId: result.evidenceId,
    };
  }

  const blocking = result.findings.filter((f) => atOrAbove(f.severity, floor));
  for (const finding of blocking) blockers.push(`[${finding.severity}] ${finding.title} — expected ${finding.expected}, observed ${finding.observed}`);
  for (const finding of result.findings.filter((f) => !atOrAbove(f.severity, floor))) {
    warnings.push(`[${finding.severity}] ${finding.title}`);
  }

  if (result.confidence.overall < minConfidence) {
    blockers.push(
      `overall confidence ${result.confidence.overall} is below the ${minConfidence} this gate requires — the run's own readings are not trustworthy enough to approve a page on`,
    );
  }
  if (minGeo > 0 && result.confidence.geo < minGeo) {
    blockers.push(`geographic confidence ${result.confidence.geo} is below the ${minGeo} required for a page whose point is a market`);
  }

  if (blockers.length > 0) {
    return {
      decision: "block",
      reason: `blocked by ${blockers.length} measured problem(s) at severity ${floor} or above`,
      blockers,
      warnings,
      runId: result.runId,
      evidenceId: result.evidenceId,
    };
  }
  return {
    decision: "allow",
    reason: `measured clean: verdict ${result.verdict}, overall confidence ${result.confidence.overall}, no finding at severity ${floor} or above${warnings.length > 0 ? `, ${warnings.length} lower-severity finding(s) recorded` : ""}`,
    blockers,
    warnings,
    runId: result.runId,
    evidenceId: result.evidenceId,
  };
}

/**
 * The gate with NO run at all.
 *
 * Exists so a caller cannot express "publish without checking" by omission. If the pipeline
 * failed to produce a run — the URL was unreachable, the tenant was wrong, geoqa was not
 * installed — the answer is still not `allow`.
 */
export function gateWithoutRun(why: string): GateResult {
  return {
    decision: "unknown",
    reason: `cannot decide: no geoqa run was produced (${why}). Publishing stays blocked: the absence of a verdict is not a verdict.`,
    blockers: [why],
    warnings: [],
    runId: null,
    evidenceId: null,
  };
}

/**
 * Findings a producer can act on, ordered so the first one is worth reading.
 *
 * Deliberately separate from `blockers`: those are strings for a log, these are the
 * structured findings, and an agent regenerating a page needs the second. Sorted by
 * severity so a truncated list keeps the worst.
 */
export function actionableFindings(result: GeoQaRunResult): Finding[] {
  return [...result.findings]
    .filter((f) => f.category !== "instrumentation")
    .sort((a, b) => SEVERITY_ORDER.indexOf(b.severity as Severity) - SEVERITY_ORDER.indexOf(a.severity as Severity));
}

/** The exit code a publisher should condition on: 0 allows, anything else does not. */
export function gateExitCode(gate: GateResult): number {
  return gate.decision === "allow" ? 0 : 1;
}
