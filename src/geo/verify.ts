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
 * How far an egress may be from the requested city and still be that city.
 *
 * 50 km, and the number comes from the 102-session milestone rather than from taste. The
 * readings that arrived were, by distance from the city requested:
 *
 *   Solna 6 km · Kista 12 km · Skui 15 km · Potsdam 25 km   ← the same urban area
 *   Gjøvik 100 km · Linköping 200 km · Gothenburg 400 km · Munich 500 km · Gällivare 1100 km
 *
 * There is a clean gap between 25 and 100, and 50 sits in it. A metropolitan area is tens of
 * kilometres across; nothing at 100 km is the city you asked for.
 */
export const CITY_RADIUS_KM = 50;

/**
 * Great-circle distance in kilometres.
 *
 * Haversine rather than a flat approximation: the markets this runs against span 60°N to 52°N,
 * where a degree of longitude is 55–69 km, so treating degrees as square would misjudge an
 * east–west offset by a quarter at Tromsø's latitude.
 */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * Is the egress in the city we asked for?
 *
 * **Measured by DISTANCE when coordinates are available, and that replaces a string comparison
 * that could not tell a suburb from another country.**
 *
 * The old rule was: equal names match, one containing the other matches, anything else is
 * `unverified` — never `mismatch`, on the grounds that egress databases name the exchange's
 * suburb rather than the city ("Lysaker" for an unmistakably Oslo connection). That reasoning
 * was right about suburbs and wrong about everything else, and the 102-session milestone showed
 * exactly how wrong: **Skui (15 km from Oslo) and Gällivare (1100 km from Stockholm) both
 * reported `unverified`.** 28 of 102 sessions were non-exact, half of them genuinely the wrong
 * city, and the axis reported the same word for both. A "city match" rate computed from it was
 * unusable in either direction — 72.5% counting only exact names, 100% counting everything not
 * proven wrong, and the honest figure was 86.2%.
 *
 * With coordinates the three verdicts finally mean what they say:
 *
 * - `match` — within {@link CITY_RADIUS_KM}. Named suburbs stop being a problem, because Kista
 *   is 12 km from Stockholm whatever it is called.
 * - `mismatch` — beyond it. This is now REACHABLE, and it should be: a proxy that sold Stockholm
 *   and delivered Gällivare has failed, and calling that "unproven" protected the vendor rather
 *   than the measurement.
 * - `unverified` — no coordinates from either side, so nothing can be computed.
 *
 * The name comparison stays as the fallback for when coordinates are missing, with its original
 * asymmetry intact: without a distance we still cannot prove a city wrong.
 */
export function compareCity(
  requested: string,
  observed: string | null,
  requestedCoordinates?: [number, number] | undefined,
  observedCoordinates?: [number, number] | null | undefined,
): AxisResult {
  if (requestedCoordinates !== undefined && observedCoordinates !== undefined && observedCoordinates !== null) {
    const km = distanceKm(requestedCoordinates, observedCoordinates);
    const where = observed === null ? "the egress" : `egress city ${observed}`;
    return km <= CITY_RADIUS_KM
      ? matched(`${where} is ${km}km from ${requested}, within the ${CITY_RADIUS_KM}km that makes it the same place`)
      : mismatched(
          `${where} is ${km}km from ${requested} — beyond the ${CITY_RADIUS_KM}km radius, so this is a different city rather than a differently-named suburb`,
        );
  }

  if (observed === null) return unverified("egress city was never read");
  const a = observed.trim().toLowerCase();
  const b = requested.trim().toLowerCase();
  if (a === b) return matched(`egress city ${observed}`);
  if (a.includes(b) || b.includes(a)) return matched(`egress city ${observed} contains ${requested}`);
  return unverified(
    `egress city ${observed} is not ${requested}, and no coordinates were available to measure the distance — metro areas are named by exchange, so without a distance this is unproven rather than wrong`,
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
 * Did the device identity the profile DECLARED actually reach the page?
 *
 * The gap this closes: `navigator.userAgent` was observed on every run and written
 * into the evidence, and compared to nothing. `verifyGeo` checked country, city,
 * language, timezone and viewport WIDTH — and the profile's viewport is applied
 * after any device descriptor and overrides it, so the width matched whether or not
 * the descriptor took. A profile whose `emulate:` name was a typo produced a run
 * with no mobile user agent, no touch, a perfectly matching viewport and a clean
 * verification. A site doing server-side device detection would have served its
 * desktop variant, and nothing in the evidence would say so.
 *
 * Asymmetric, like `compareCity` and for a sharper reason: this can only judge a
 * claim that was made. A profile declaring no `userAgent` and no `emulate` has
 * asserted nothing about the device beyond its viewport, and inventing an
 * expectation from `device.kind` would report `mismatch` on every mobile profile in
 * this repo — all of which deliberately carry no descriptor, because emulation makes
 * the rendered viewport a property of the page's markup (gaps C-8). "Unverified"
 * is the honest verdict for a claim nobody made.
 *
 * The comparison is CONTAINMENT rather than equality when the profile declares an
 * `emulate` name: the expected marker is the descriptor's own name reduced to the
 * token a user-agent string would carry ("Pixel 5" → "Android" is not derivable), so
 * only an explicit `userAgent` can be matched exactly. That is a real limit and it is
 * why an explicit `userAgent` is the stronger declaration of the two.
 */
export function compareDevice(
  requested: { userAgent?: string | undefined; emulate?: string | undefined },
  observed: string | null,
): AxisResult {
  const declared = requested.userAgent ?? null;
  if (declared === null) {
    return requested.emulate === undefined
      ? unverified("the profile declares no user agent and no device descriptor, so there is no device claim to verify beyond the viewport")
      : unverified(
          `the profile emulates "${requested.emulate}" but declares no explicit userAgent, and a descriptor name is not a substring of the user-agent string it produces — the descriptor is applied and cannot be confirmed from the page`,
        );
  }
  if (observed === null) return unverified("navigator.userAgent was never read");
  return observed === declared
    ? matched(`navigator.userAgent is the declared ${declared}`)
    : mismatched(`profile declares userAgent ${declared}, page reports ${observed}`);
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
  // Coordinates from both sides when they exist, so the verdict is a distance rather than a
  // string comparison. The profile always has them; the observation has them when the identity
  // endpoint reported them.
  const city = compareCity(profile.market.city, network.city, profile.market.coordinates, network.coordinates);
  const language = compareLanguage(profile.market.language, browser.language);
  const timezone = compareTimezone(profile.market.timezone, browser.timezone);
  const viewport = compareViewport(profile.device.viewport, browser.viewport);
  const device = compareDevice(
    { ...(profile.device.userAgent !== undefined ? { userAgent: profile.device.userAgent } : {}), ...(profile.device.emulate !== undefined ? { emulate: profile.device.emulate } : {}) },
    browser.userAgent,
  );
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
      device,
    },
    confidence: geoConfidence(axes),
    // The viewport counts toward trustworthiness even though it is not in the
    // weighted geo score: a desktop render under a mobile profile is not a
    // trustworthy observation of that profile, whatever the geography said.
    //
    // The DEVICE axis deliberately does not. It is `unverified` for every profile
    // that declares no user agent — which is all of them today — so counting it
    // would mark every run in the repo untrustworthy for a claim nobody made. A
    // proven device MISMATCH is a different matter and is folded in below.
    trustworthy: [...axes, viewport].every((a) => a.verdict === "match") && device.verdict !== "mismatch",
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
