/**
 * Confidence, as separate axes that stay separate.
 *
 * The PRD is explicit and it is right: do not create one vague AI-generated
 * score. Five things can each be independently wrong, and a single number hides
 * which. So each axis is computed from its own evidence, `overall` is a
 * weighted combination CAPPED by the weakest axis, and `notes` says in words
 * why the number is what it is.
 *
 * `searchObservation` is `null` here and stays `null` until a SERP source is
 * wired. Reporting a number for a thing we do not measure is the exact failure
 * agent-fleet recorded as "a perfect score is the most suspicious number on the
 * board".
 */
import type { EvidenceManifest } from "../evidence/manifest.js";
import type { GeoVerification } from "../geo/types.js";
import type { JourneyResult } from "../journeys/engine.js";
import type { ConfidenceReport } from "../findings/types.js";

const VERDICT_SCORE = { match: 1, unverified: 0.4, mismatch: 0 } as const;

const scoreAxes = (verdicts: readonly ("match" | "unverified" | "mismatch")[], weights: readonly number[]): number => {
  let total = 0;
  for (const [i, v] of verdicts.entries()) total += (weights[i] ?? 0) * VERDICT_SCORE[v];
  return total;
};

/** Network identity only: country carries three times the weight of city. */
export function networkConfidence(geo: GeoVerification): number {
  const raw = scoreAxes([geo.network.country.verdict, geo.network.city.verdict], [0.75, 0.25]);
  const cap = geo.network.country.verdict === "mismatch" ? 0.4 : 1;
  return Math.round(raw * cap * 100);
}

/** Browser environment only: language and clock weigh the same. */
export function browserConfidence(geo: GeoVerification): number {
  const raw = scoreAxes([geo.browser.language.verdict, geo.browser.timezone.verdict], [0.5, 0.5]);
  return Math.round(raw * 100);
}

/**
 * How much the journey's own verdict can be trusted.
 *
 * Errored steps are punished far harder than failed ones. A failed step is the
 * journey working — it looked, and the page was wrong. An errored step is the
 * journey NOT working, and a run full of them has a verdict that means nothing.
 * Skipped steps count as unknowns, because they were never executed.
 */
export function journeyConfidence(result: JourneyResult): number {
  const { passed, failed, errored, skipped } = result.counts;
  const total = passed + failed + errored + skipped;
  if (total === 0) return 0;
  const executed = passed + failed;
  const score = (executed - errored * 2 - skipped * 0.5) / total;
  return Math.max(0, Math.min(100, Math.round(score * 100)));
}

/** Straight from the manifest — the share of required artifacts present. */
export function evidenceConfidence(manifest: EvidenceManifest | null): number {
  return manifest === null ? 0 : manifest.completeness;
}

const WEIGHTS = { geo: 0.3, browser: 0.15, journey: 0.35, evidence: 0.2 } as const;

export interface ScoreInput {
  geo: GeoVerification;
  journey: JourneyResult;
  manifest: EvidenceManifest | null;
}

export function scoreRun(input: ScoreInput): ConfidenceReport {
  const geo = networkConfidence(input.geo);
  const browser = browserConfidence(input.geo);
  const journey = journeyConfidence(input.journey);
  const evidence = evidenceConfidence(input.manifest);

  const weighted =
    geo * WEIGHTS.geo + browser * WEIGHTS.browser + journey * WEIGHTS.journey + evidence * WEIGHTS.evidence;

  // The cap is the whole point of keeping the axes apart. A run that executed
  // perfectly from the wrong country is not an 80% confident run.
  const weakest = Math.min(geo, browser, journey, evidence);
  const overall = Math.round(Math.min(weighted, weakest * 0.4 + weighted * 0.6));

  const notes: string[] = [];
  if (geo < 100) notes.push(`network identity ${geo}: ${input.geo.network.country.reasons.join("; ")}`);
  if (browser < 100) notes.push(`browser environment ${browser}: ${input.geo.browser.language.reasons.join("; ")}`);
  if (input.journey.counts.errored > 0)
    notes.push(
      `${input.journey.counts.errored} step(s) could not be read — this is a GeoQA defect and caps what the run can claim`,
    );
  if (input.journey.counts.skipped > 0)
    notes.push(`${input.journey.counts.skipped} step(s) never ran`);
  if (input.manifest === null) notes.push("no evidence was captured");
  else if (input.manifest.missing.length > 0)
    notes.push(`evidence missing: ${input.manifest.missing.join(", ")}`);
  if (notes.length === 0) notes.push("every axis verified; evidence complete");

  return { geo, browser, journey, evidence, searchObservation: null, overall, notes };
}

/** One-line rendering for a terminal summary. */
export function describeConfidence(report: ConfidenceReport): string {
  const search = report.searchObservation === null ? "search n/a" : `search ${report.searchObservation}`;
  return `overall ${report.overall} · geo ${report.geo} · browser ${report.browser} · journey ${report.journey} · evidence ${report.evidence} · ${search}`;
}
