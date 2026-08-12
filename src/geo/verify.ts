/**
 * Comparing what we asked for against what we got — per axis, never merged.
 *
 * The three-valued verdict is the whole design. "unverified" is NOT a soft
 * mismatch and it is NOT a pass: it means the probe never produced a reading,
 * and a run built on it can make no geographic claim at all. Collapsing it into
 * either neighbour is how a QA system reports 100% confidence about a market it
 * never actually reached.
 */
import type { AxisResult, BrowserObservation, GeoProfile, GeoVerification, NetworkObservation } from "./types.js";

const matched = (why: string): AxisResult => ({ verdict: "match", reasons: [why] });
const mismatched = (why: string): AxisResult => ({ verdict: "mismatch", reasons: [why] });
const unverified = (why: string): AxisResult => ({ verdict: "unverified", reasons: [why] });

/** ISO-3166 alpha-2, case-insensitive. */
export function compareCountry(requested: string, observed: string | null): AxisResult {
  if (observed === null) return unverified("egress country was never read");
  return observed.toUpperCase() === requested.toUpperCase()
    ? matched(`egress country ${observed}`)
    : mismatched(`requested ${requested.toUpperCase()}, egressed from ${observed.toUpperCase()}`);
}

/**
 * City comparison is deliberately loose. Egress-identity databases name the
 * suburb that hosts the exchange, not the city a human would say — the real
 * Norway baseline reads "Lysaker", which is Bærum, not Oslo, for an
 * unmistakably Oslo-area connection. Requiring string equality would report a
 * mismatch for a perfectly good session, so a city that cannot be confirmed is
 * `unverified` and never `mismatch`: we can prove a city right, not wrong.
 */
export function compareCity(requested: string, observed: string | null): AxisResult {
  if (observed === null) return unverified("egress city was never read");
  const a = observed.trim().toLowerCase();
  const b = requested.trim().toLowerCase();
  if (a === b) return matched(`egress city ${observed}`);
  if (a.includes(b) || b.includes(a)) return matched(`egress city ${observed} contains ${requested}`);
  return unverified(
    `egress city ${observed} is not ${requested} — metro areas are named by exchange, so this is unproven, not wrong`,
  );
}

/** BCP-47, compared on the primary subtag: "nb-NO" and "nb" agree. */
export function compareLanguage(requested: string, observed: string | null): AxisResult {
  if (observed === null) return unverified("navigator.language was never read");
  const primary = (tag: string): string => tag.toLowerCase().split("-")[0] ?? "";
  if (observed.toLowerCase() === requested.toLowerCase()) return matched(`navigator.language ${observed}`);
  return primary(observed) === primary(requested)
    ? matched(`navigator.language ${observed} shares a primary subtag with ${requested}`)
    : mismatched(`requested ${requested}, browser reports ${observed}`);
}

/** IANA zone, exact. A wrong clock changes rendered dates and opening hours. */
export function compareTimezone(requested: string, observed: string | null): AxisResult {
  if (observed === null) return unverified("Intl timezone was never read");
  return observed === requested
    ? matched(`Intl timezone ${observed}`)
    : mismatched(`requested ${requested}, browser reports ${observed}`);
}

/**
 * The rendered viewport, compared on WIDTH only.
 *
 * Height varies with the browser's own chrome and with `--hide-scrollbars`,
 * and no layout decision in a responsive site keys off it. Width is what
 * selects a breakpoint, so width is what we can meaningfully verify.
 */
export function compareViewport(
  requested: { width: number; height: number },
  observed: { width: number; height: number } | null,
): AxisResult {
  if (observed === null) return unverified("viewport was never read");
  return observed.width === requested.width
    ? matched(`viewport width ${observed.width}px`)
    : mismatched(`requested ${requested.width}px wide, browser rendered ${observed.width}px`);
}

const WEIGHT = { country: 0.45, city: 0.15, language: 0.2, timezone: 0.2 } as const;
const SCORE: Record<AxisResult["verdict"], number> = { match: 1, unverified: 0.4, mismatch: 0 };

/**
 * One 0..100 number, but only as a summary of four verdicts that remain
 * individually visible.
 *
 * Country carries the most weight because it is the axis that actually changes
 * what a server sends. `unverified` scores 0.4 rather than 0 — it is genuinely
 * worse than a match and genuinely better than a proven mismatch — and the
 * result is then CAPPED by the weakest axis, so a single proven mismatch can
 * never be averaged away by three good readings.
 */
export function geoConfidence(axes: AxisResult[]): number {
  const weights = [WEIGHT.country, WEIGHT.city, WEIGHT.language, WEIGHT.timezone];
  let score = 0;
  for (const [i, axis] of axes.entries()) score += (weights[i] ?? 0) * (SCORE[axis.verdict] ?? 0);
  const worst = axes.some((a) => a.verdict === "mismatch")
    ? 0.5
    : axes.some((a) => a.verdict === "unverified")
      ? 0.85
      : 1;
  return Math.round(score * worst * 100);
}

export function verifyGeo(
  profile: GeoProfile,
  network: NetworkObservation,
  browser: BrowserObservation,
): GeoVerification {
  const country = compareCountry(profile.market.country, network.country);
  const city = compareCity(profile.market.city, network.city);
  const language = compareLanguage(profile.market.language, browser.language);
  const timezone = compareTimezone(profile.market.timezone, browser.timezone);
  const viewport = compareViewport(profile.device.viewport, browser.viewport);
  const axes = [country, city, language, timezone];
  return {
    profileId: profile.id,
    network: {
      requested: { country: profile.market.country, city: profile.market.city },
      observed: network,
      country,
      city,
    },
    browser: {
      requested: {
        language: profile.market.language,
        timezone: profile.market.timezone,
        viewport: profile.device.viewport,
      },
      observed: browser,
      language,
      timezone,
      viewport,
    },
    confidence: geoConfidence(axes),
    // The viewport counts toward trustworthiness even though it is not in the
    // weighted geo score: a desktop render under a mobile profile is not a
    // trustworthy observation of that profile, whatever the geography said.
    trustworthy: [...axes, viewport].every((a) => a.verdict === "match"),
  };
}

/** Every reason across both axes, for a human-readable run summary. */
export function verificationReasons(v: GeoVerification): string[] {
  return [
    ...v.network.country.reasons,
    ...v.network.city.reasons,
    ...v.browser.language.reasons,
    ...v.browser.timezone.reasons,
    ...v.browser.viewport.reasons,
  ];
}
