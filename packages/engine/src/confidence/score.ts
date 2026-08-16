/**
 * Confidence, as separate axes that stay separate.
 *
 * The PRD is explicit and it is right: do not create one vague AI-generated
 * score. Five things can each be independently wrong, and a single number hides
 * which. So each axis is computed from its own evidence, `overall` is a
 * weighted combination CAPPED by the weakest axis, and `notes` says in words
 * why the number is what it is.
 *
 * `searchObservation` is a REAL number when a SERP source produced one, and `null`
 * when nothing could be measured — never a fabricated 0. `search/observation.ts` owns
 * that decision; this file records the result.
 *
 * It is deliberately excluded from `overall`. The other four axes answer "can this
 * run's readings be believed"; this one answers "is this page visible in search". They
 * are different questions about different subjects, and averaging them would let good
 * search visibility disguise a run that could not read the page.
 */
import type { EvidenceManifest } from "../evidence/manifest.js";
import type { GeoVerification } from "../geo/types.js";
import type { JourneyResult } from "../journeys/engine.js";
import type { ConfidenceReport } from "../findings/types.js";

const VERDICT_SCORE = { match: 1, unverified: 0.4, mismatch: 0 } as const;

/**
 * Weighted axes, taken as PAIRS rather than as two parallel arrays.
 *
 * Two arrays let the caller pass three verdicts and two weights, and the `weights[i] ?? 0` that
 * covered for it silently scored the third axis at zero — a confidence figure quietly computed
 * from part of its evidence. Pairs make the mismatch unspellable, which is better than a
 * fallback that makes it survivable, and it removes a branch nothing could reach.
 */
const scoreAxes = (axes: readonly (readonly [("match" | "unverified" | "mismatch"), number])[]): number => {
  let total = 0;
  for (const [verdict, weight] of axes) total += weight * VERDICT_SCORE[verdict];
  return total;
};

/**
 * Network identity only: country carries three times the weight of city.
 *
 * Two conditions cap it, and they cap it equally, because they are the same
 * failure of this axis's purpose. A proven country mismatch means we know we are
 * in the wrong place. Two IP-geo databases disagreeing about the same IP means we
 * do not know where we are at all — measured live, one Decodo ISP exit read as São
 * Paulo by one source and New York by another. A run reporting `geo: 100` while
 * its two sources contradict each other is exactly the confident, coherent lie
 * this score exists to prevent.
 *
 * Source agreement is deliberately NOT a weighted term. It carries no location of
 * its own; it decides whether the terms that do can be believed.
 */
export function networkConfidence(geo: GeoVerification): number {
  const raw = scoreAxes([
    [geo.network.country.verdict, 0.75],
    [geo.network.city.verdict, 0.25],
  ]);
  const unreliable = geo.network.country.verdict === "mismatch" || geo.network.agreement.verdict === "mismatch";
  return Math.round(raw * (unreliable ? 0.4 : 1) * 100);
}

/**
 * Browser environment: locale, clock and device.
 *
 * The viewport is weighted lowest of the three but is NOT free — a mobile
 * profile that rendered at desktop width produced a run whose every other
 * check passed, which is exactly the kind of silent wrongness a confidence
 * score exists to surface.
 */
export function browserConfidence(geo: GeoVerification): number {
  const raw = scoreAxes([
    [geo.browser.language.verdict, 0.4],
    [geo.browser.timezone.verdict, 0.35],
    [geo.browser.viewport.verdict, 0.25],
  ]);
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
  /**
   * The search-visibility axis, when a SERP source produced one.
   *
   * Absent or null means UNMEASURED and is reported as such. It is deliberately NOT
   * folded into `overall`: the other four axes answer "can this run's readings be
   * believed", which is a question about the measurement, while this one answers "is
   * this page visible in search", which is a question about the site. Averaging them
   * would let a site with excellent search visibility disguise a run that could not
   * read the page — and that is the exact conflation the whole score exists to prevent.
   */
  searchObservation?: number | null;
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
  if (geo < 100) {
    // The agreement reason is included ONLY when it fired. It is the note a reader
    // acts on differently from every other one here — every other note says fix
    // the site or fix the profile; this one says do not trust the number above it.
    const why = [
      ...input.geo.network.country.reasons,
      ...(input.geo.network.agreement.verdict === "mismatch" ? input.geo.network.agreement.reasons : []),
    ];
    notes.push(`network identity ${geo}: ${why.join("; ")}`);
  }
  if (browser < 100) {
    const why = [
      ...input.geo.browser.language.reasons,
      ...input.geo.browser.timezone.reasons,
      ...input.geo.browser.viewport.reasons,
    ];
    notes.push(`browser environment ${browser}: ${why.join("; ")}`);
  }
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

  // A REAL observation when one was taken, `null` when it could not be. Never a
  // fabricated 0: an exhausted SERP account returns no results, and "your site is
  // invisible" is far too alarming a claim to make on the strength of an empty list.
  // `search/observation.ts` decides which of the three states applies; this only
  // records it, and deliberately does not fold it into `overall` — see below.
  return { geo, browser, journey, evidence, searchObservation: input.searchObservation ?? null, overall, notes };
}

/** One-line rendering for a terminal summary. */
export function describeConfidence(report: ConfidenceReport): string {
  const search = report.searchObservation === null ? "search n/a" : `search ${report.searchObservation}`;
  return `overall ${report.overall} · geo ${report.geo} · browser ${report.browser} · journey ${report.journey} · evidence ${report.evidence} · ${search}`;
}
