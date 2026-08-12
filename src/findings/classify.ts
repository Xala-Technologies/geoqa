/**
 * Journey steps → findings.
 *
 * The rule that matters: **a step we could not read never becomes a site
 * finding.** It becomes an `instrumentation` finding instead, which is filed
 * against us. Without that split, a run where the browser died reports a pile
 * of site defects, someone investigates the site, and the actual defect — ours
 * — stays invisible. Same failure mode as agent-fleet's "the monitor has failed
 * more often than the monitored".
 */
import type { StepResult } from "../journeys/engine.js";
import type { EvidenceRef, Finding, FindingCategory, FindingSeverity } from "./types.js";

/** Default category per check kind; a step's own `category` overrides it. */
const CATEGORY_BY_CHECK: Record<string, FindingCategory> = {
  "title-exists": "content",
  "title-contains": "content",
  "url-matches": "redirect",
  "selector-visible": "functional",
  "selector-absent": "functional",
  "selector-count-min": "navigation",
  "text-contains": "content",
  "text-absent": "content",
  "no-console-errors": "javascript",
  "no-page-errors": "javascript",
  "no-http-5xx": "http",
  "no-http-4xx": "http",
  "lcp-below": "performance",
  "cls-below": "performance",
  "no-a11y-critical": "accessibility",
};

export function categoryFor(step: StepResult): FindingCategory {
  if (step.category) return step.category;
  if (step.outcome === "errored") return "instrumentation";
  return (step.check && CATEGORY_BY_CHECK[step.check]) || "unknown";
}

const SEVERITIES = new Set<FindingSeverity>(["critical", "high", "medium", "low", "info"]);

export function severityFor(step: StepResult): FindingSeverity {
  // An instrumentation failure is always high: we cannot say anything about
  // the site until it is fixed, whatever the step's own severity claimed.
  if (step.outcome === "errored") return "high";
  return SEVERITIES.has(step.severity as FindingSeverity) ? (step.severity as FindingSeverity) : "medium";
}

/**
 * How confident we are that a finding is real.
 *
 * A failed check that genuinely read the page is near-certain — the page said
 * what it said. An instrumentation failure is a real event too, but "the
 * browser could not read the console" is a weaker claim about the world than "the
 * console contained an error", so it scores lower and says why.
 */
export function confidenceFor(step: StepResult, reproducibility: { attempts: number; occurrences: number }): number {
  const base = step.outcome === "errored" ? 60 : 92;
  if (reproducibility.attempts <= 1) return base;
  const rate = reproducibility.occurrences / reproducibility.attempts;
  // Repeating it is the strongest evidence available: 3/3 pushes toward 99,
  // 1/3 pulls hard toward "we saw it once and could not repeat it".
  return Math.round(Math.min(99, Math.max(20, base * (0.55 + 0.45 * rate) + (rate === 1 ? 7 : 0))));
}

export function validationMethodFor(step: StepResult, target: string, profileId: string): string {
  if (step.outcome === "errored") {
    return `Re-run \`geoqa journey run --url ${target} --geo ${profileId}\` and inspect the run log; this is a GeoQA defect, not a site defect, until it reproduces with a working browser.`;
  }
  return `Open ${target} with the ${profileId} profile and check "${step.label}" by hand: expected ${step.expected ?? "—"}.`;
}

export interface ClassifyContext {
  runId: string;
  target: string;
  profileId: string;
  journeyId: string;
  market: string;
  device: string;
  detectedAt: string;
  evidence: EvidenceRef[];
  /** How many times the whole journey ran, for reproducibility. */
  attempts?: number;
  /** Per-step-label occurrence counts across those attempts. */
  occurrences?: Record<string, number>;
}

/**
 * Turn one journey's steps into findings.
 *
 * Passing and skipped steps produce nothing. A skipped step is NOT a finding:
 * it was never executed, and filing it would double-count the failure that
 * halted the run.
 */
export function findingsFromSteps(steps: StepResult[], ctx: ClassifyContext): Finding[] {
  const attempts = ctx.attempts ?? 1;
  const findings: Finding[] = [];

  for (const step of steps) {
    if (step.outcome === "passed" || step.outcome === "skipped") continue;
    const occurrences = ctx.occurrences?.[step.label] ?? 1;
    const reproducibility = { attempts, occurrences };
    findings.push({
      id: `${ctx.runId}-${String(step.index).padStart(2, "0")}`,
      runId: ctx.runId,
      category: categoryFor(step),
      severity: severityFor(step),
      status: attempts > 1 && occurrences === attempts ? "reproduced" : "observed",
      title: step.outcome === "errored" ? `Could not verify: ${step.label}` : step.label,
      expected: step.expected ?? "—",
      observed: step.observed ?? step.detail,
      confidence: confidenceFor(step, reproducibility),
      reproducibility,
      affectedUrl: ctx.target,
      market: ctx.market,
      device: ctx.device,
      journeyId: ctx.journeyId,
      stepLabel: step.label,
      evidence: ctx.evidence,
      validationMethod: validationMethodFor(step, ctx.target, ctx.profileId),
      detectedAt: ctx.detectedAt,
    });
  }
  return findings;
}

const SEVERITY_ORDER: FindingSeverity[] = ["critical", "high", "medium", "low", "info"];

/** Most severe first, then most confident. */
export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    return bySeverity !== 0 ? bySeverity : b.confidence - a.confidence;
  });
}

/** How much of what we reported was about the SITE rather than about us. */
export function siteFindingShare(findings: Finding[]): { site: number; instrumentation: number; ratio: number } {
  const instrumentation = findings.filter((f) => f.category === "instrumentation").length;
  const site = findings.length - instrumentation;
  return { site, instrumentation, ratio: findings.length === 0 ? 1 : site / findings.length };
}
