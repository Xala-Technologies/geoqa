/**
 * Turning a SERP into the fifth confidence axis — or into an honest `null`.
 *
 * The three states, and why the middle one is the whole design:
 *
 * | What happened                          | `searchObservation` |
 * |---|---|
 * | The provider could not answer          | `null`, with a reason |
 * | Results came back, we are NOT in them  | a real LOW score |
 * | Results came back, we rank             | a real score by position |
 *
 * **"No results at all" is `null`, not zero.** That is the rule everything else here
 * serves. An exhausted SERP account returns an empty list, and so does a query nobody
 * has ever searched, and so does a parse we got wrong — while "your site is invisible"
 * is one of the most alarming things this system could tell a tenant. Reporting it on
 * the strength of an empty list would be the DataForSEO failure exactly: a
 * credentials-present check let a zero-balance account pass for weeks, and empty results
 * read as "we rank nowhere".
 *
 * **"Results, but not us" IS a real reading and scores low.** This is the case worth
 * having a SERP source for at all. The engine looked, the SERP was populated, the
 * tenant was not on it — that is a finding, and hedging it into `null` would waste the
 * one honest signal the axis can produce.
 */
import type { SearchOutcome } from "./types.js";

export interface SearchObservation {
  /** 0..100, or null when nothing could be measured. Never a fabricated 0. */
  score: number | null;
  /** Always populated, including on a good score — the same rule as `AxisResult`. */
  reason: string;
  /** Where the tenant's own URL was found, or null when it was not. */
  position: number | null;
  /** How many organic results were examined. Null when none were. */
  examined: number | null;
}

/**
 * Score by position, steeply.
 *
 * Position 1 is 100 and position 10 is 55, which is deliberately not linear: the gap
 * between first and third matters enormously and the gap between eleventh and
 * thirteenth does not, so a linear scale would flatter a page nobody clicks. Beyond the
 * examined window the score floors rather than going negative — being 40th and being
 * 400th are the same fact to a visitor.
 */
export function scoreForPosition(position: number): number {
  if (position <= 1) return 100;
  // -5 per position, so 10th ≈ 55, 20th ≈ 5, and everything past that is 5.
  return Math.max(5, Math.round(100 - (position - 1) * 5));
}

/**
 * The score a populated SERP that does not contain us deserves.
 *
 * Not zero, and the distinction is not pedantry. Zero is the score for "we know nothing"
 * in most systems, and this axis reserves `null` for that — so a real, measured absence
 * has to be a small NUMBER to be distinguishable from an unmeasured one at a glance.
 * Two is that number: unmistakably bad, unmistakably measured.
 */
export const ABSENT_FROM_SERP_SCORE = 2;

/**
 * Was this tenant's page in the results, and how does that score?
 *
 * Matching is by ORIGIN plus path prefix, not by string containment, for the reason
 * recorded in `tenant/registry.ts`: `https://acme.no.evil.test` contains
 * `https://acme.no`, and a containment test would credit a tenant for a competitor's
 * page — or worse, for a typosquatter's.
 */
export function observeSearch(outcome: SearchOutcome, ownUrl: string): SearchObservation {
  if (!outcome.ok) {
    // Could not look. Never a number.
    return { score: null, reason: `search observation unmeasured — ${outcome.reason}`, position: null, examined: null };
  }
  let own: URL;
  try {
    own = new URL(ownUrl);
  } catch {
    return { score: null, reason: `search observation unmeasured — "${ownUrl}" is not a URL to look for`, position: null, examined: outcome.results.length };
  }
  const found = outcome.results.find((result) => {
    try {
      const candidate = new URL(result.url);
      // Origin must match exactly; the path is a prefix so a deep link to the tenant's
      // own page still counts as the tenant ranking.
      return candidate.origin === own.origin;
    } catch {
      return false;
    }
  });
  if (found === undefined) {
    return {
      score: ABSENT_FROM_SERP_SCORE,
      reason: `${own.origin} is absent from ${outcome.results.length} organic result(s) — this is a MEASURED absence, not an unmeasured one`,
      position: null,
      examined: outcome.results.length,
    };
  }
  return {
    score: scoreForPosition(found.position),
    reason: `${own.origin} ranks at position ${found.position} of ${outcome.results.length} examined`,
    position: found.position,
    examined: outcome.results.length,
  };
}
