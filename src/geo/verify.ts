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

/**
 * Did one run hold one egress identity?
 *
 * Asymmetric on purpose, the same way `compareCity` is: a rotation can be
 * PROVEN (two readings, two different IPs), but stability can only be proven
 * for the moments we actually read. A missing reading at either end is
 * `unverified` — never a pass, because "the IP probably held" is precisely the
 * assumption a sticky-session vendor is being paid to make true and therefore
 * the one worth measuring rather than trusting.
 */
export function compareEgressHeld(openingIp: string | null, closingIp: string | null): AxisResult {
  if (openingIp === null) return unverified("no opening egress reading to compare against");
  if (closingIp === null) return unverified("closing egress was never read");
  return closingIp === openingIp
    ? matched(`egress held ${openingIp} for the whole run`)
    : mismatched(`egress rotated mid-run: opened on ${openingIp}, closed on ${closingIp}`);
}

/**
 * Fold a post-journey egress-stability reading into a verification.
 *
 * `trustworthy` can only ever go DOWN here. A run cannot earn trust it did not
 * have by holding its IP, but it can certainly lose it by rotating — every
 * measurement in a rotated run describes a mixture of visitors.
 */
export function withEgressHeld(verification: GeoVerification, egressHeld: AxisResult): GeoVerification {
  return {
    ...verification,
    network: { ...verification.network, egressHeld },
    trustworthy: verification.trustworthy && egressHeld.verdict === "match",
  };
}

/**
 * Do two independent IP-geo databases agree about where this IP is?
 *
 * The finding that produced this axis: one Decodo ISP exit resolved to **São
 * Paulo** per Decodo's own endpoint and **New York** per ipinfo, for the same IP.
 * Either reading alone is a confident, coherent answer, and one of them is wrong.
 * An engine whose whole job is proving where a visitor is cannot treat a single
 * lookup as ground truth, because a wrong database reads exactly like a wrong
 * proxy — and the two demand opposite actions.
 *
 * Three things make this comparison narrower than it first looks.
 *
 * **A different IP is not a disagreement.** If the two reads returned different
 * IPs they describe different visitors, and calling that a geographic
 * disagreement would be a finding invented out of our own probing. Measured on
 * this laptop with no proxy at all: `curl` reached ipinfo over IPv4 and ipwho.is
 * over IPv6, same machine, two addresses. So a changed IP is `unverified` and
 * names both possibilities — a dual-stack route or a rotation between the reads.
 *
 * **Only COUNTRY is compared.** City divergence between databases is normal, not
 * a defect: this machine reads Tønsberg (ipinfo), Rykkin (geojs) and Oslo
 * (ipwho.is) simultaneously. Comparing cities strictly would report a
 * disagreement on essentially every run, which is the failure mode where an
 * engine manufactures defects out of its own instrumentation. City divergence is
 * recorded as a reason, never as a verdict.
 *
 * **A country disagreement IS a `mismatch`, unlike a city mismatch elsewhere.**
 * `compareCity` refuses to call a city wrong because it cannot know. Here the
 * proven fact is not "the country is X" — it is "the reading is unreliable", and
 * that is established rather than suspected: two databases genuinely returned
 * different countries. The verdict is about the agreement, not about the country.
 */
export function compareSources(primary: NetworkObservation, secondary: NetworkObservation): AxisResult {
  if (primary.country === null) return unverified("primary source read no country to corroborate");
  if (secondary.country === null) return unverified("corroborating source read no country");
  if (primary.ip !== null && secondary.ip !== null && primary.ip !== secondary.ip) {
    return unverified(
      `the two sources saw different IPs (${primary.ip} and ${secondary.ip}) — a dual-stack route or a rotation between the reads, so their locations describe different visitors and cannot be compared`,
    );
  }
  const a = primary.country.toUpperCase();
  const b = secondary.country.toUpperCase();
  if (a !== b) {
    return mismatched(
      `two IP-geo sources disagree about the same IP: ${a} and ${b}. One of them is wrong and the reading cannot be trusted — a wrong database looks exactly like a wrong proxy`,
    );
  }
  const cityNote =
    primary.city !== null && secondary.city !== null && primary.city.trim().toLowerCase() !== secondary.city.trim().toLowerCase()
      ? ` (cities differ — ${primary.city} and ${secondary.city} — which is normal between databases and is not a defect)`
      : "";
  return matched(`two independent sources agree the egress is in ${a}${cityNote}`);
}

/**
 * Fold a corroborating reading into a verification.
 *
 * Shaped like `withEgressHeld`, and for the same reason: it can only ever lower
 * trust. Agreement between two databases does not make a mismatched country
 * right; disagreement makes a matched one unreliable. The corroborating
 * observation is kept alongside the primary rather than merged into it — a report
 * has to be able to show both numbers, because "which of these two is wrong" is
 * the question a reader is left holding.
 */
export function withCorroboration(
  verification: GeoVerification,
  corroborating: NetworkObservation,
): GeoVerification {
  const agreement = compareSources(verification.network.observed, corroborating);
  return {
    ...verification,
    network: { ...verification.network, corroborating, agreement },
    // Recomputed with the agreement as a CAP rather than a fifth weighted axis:
    // the question it answers is not "how geographic is this run" but "can the
    // geographic answer be believed at all", and a disagreement should pull a
    // perfect four-axis score down rather than average into it.
    confidence: geoConfidence(
      [verification.network.country, verification.network.city, verification.browser.language, verification.browser.timezone],
      [agreement],
    ),
    trustworthy: verification.trustworthy && agreement.verdict === "match",
  };
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
export function geoConfidence(axes: AxisResult[], caps: AxisResult[] = []): number {
  const weights = [WEIGHT.country, WEIGHT.city, WEIGHT.language, WEIGHT.timezone];
  let score = 0;
  for (const [i, axis] of axes.entries()) score += (weights[i] ?? 0) * (SCORE[axis.verdict] ?? 0);
  // `caps` carry no weight of their own and only ever pull the number DOWN. An
  // axis belongs here when it answers "can this reading be believed" rather than
  // "where are we" — source agreement is the first such axis: two databases
  // disagreeing does not make a run 15% less Norwegian, it makes the whole
  // geographic answer unreliable, and averaging that in would let three good
  // readings hide it.
  const all = [...axes, ...caps];
  const worst = all.some((a) => a.verdict === "mismatch")
    ? 0.5
    : all.some((a) => a.verdict === "unverified")
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
      // Deliberately not knowable yet, and deliberately NOT part of
      // `geoConfidence` below: that score answers "are we where we asked to
      // be?", which is a question about one moment. Stability is a different
      // claim over a different span, and `withEgressHeld` folds it in later.
      egressHeld: unverified("egress stability is only known once the journey has finished"),
      // No second opinion unless one was paid for. `withCorroboration` fills both
      // in; until then the honest state is that nothing checked, which is neither
      // agreement nor disagreement.
      corroborating: null,
      agreement: unverified("no corroborating IP-geo source was read"),
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
    ...v.network.egressHeld.reasons,
    ...v.browser.language.reasons,
    ...v.browser.timezone.reasons,
    ...v.browser.viewport.reasons,
  ];
}
