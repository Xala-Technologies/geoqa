/**
 * Observing where we actually are — on both axes.
 *
 * Both observations are taken THROUGH THE BROWSER, never through Node's own
 * `fetch`. That is a correctness requirement, not a convenience: the browser is
 * the thing whose egress we care about, and a Node request would go out over a
 * different socket, possibly a different interface, and — with a proxy
 * configured at browser launch — a completely different route. Measuring the
 * wrong client is exactly the instrumentation lie that makes an evidence engine
 * worthless.
 */
import { asNumber, asRecord, asString } from "../browser/map.js";
import type { BrowserRuntime } from "../browser/types.js";
import type { BrowserObservation, NetworkObservation } from "./types.js";

/** Default egress-identity endpoint. Free, no key, returns city + ASN. */
export const DEFAULT_VERIFY_ENDPOINT = "https://ipinfo.io/json";

/** The empty observation — every field unread. Never a fabricated default. */
export const UNKNOWN_NETWORK: NetworkObservation = {
  ip: null,
  country: null,
  city: null,
  region: null,
  org: null,
  timezone: null,
  coordinates: null,
  latencyMs: null,
};

/**
 * `"59.9139,10.7522"` → `[59.9139, 10.7522]`, or null.
 *
 * Refuses anything it cannot fully parse rather than returning a partial pair: a coordinate
 * with a plausible latitude and a missing longitude would place a session on the Greenwich
 * meridian, which is a confident wrong answer of exactly the kind a distance check must not
 * produce.
 */
export function parseLoc(value: unknown): [number, number] | null {
  if (typeof value !== "string") return null;
  const parts = value.split(",");
  if (parts.length !== 2) return null;

  // An EMPTY half is rejected before `Number` ever sees it, and this is the guard the comment
  // above was describing while the code did not have it: `Number("")` is 0, not NaN, so it is
  // finite and inside every range check below. `"59.9139,"` parsed to [59.9139, 0] — the prime
  // meridian, several hundred kilometres off the coast of Norway — and these coordinates decide
  // a city verdict by DISTANCE, so a vendor sending a truncated field would have produced a
  // proven city MISMATCH against a correctly-routed exit. Found by testing the guards rather
  // than reading them.
  const [rawLat = "", rawLon = ""] = parts;
  if (rawLat.trim() === "" || rawLon.trim() === "") return null;

  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lat, lon];
}

/**
 * Parse an ipinfo.io payload. Captured live in EXP-000:
 * `{"ip":"213.52.15.251","city":"Lysaker","region":"Akershus","country":"NO",
 *   "org":"AS2116 GLOBALCONNECT AS","timezone":"Europe/Oslo",...}`
 */
export function parseNetworkObservation(raw: string, latencyMs: number | null): NetworkObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...UNKNOWN_NETWORK, latencyMs };
  }
  const r = asRecord(parsed);
  if (!r) return { ...UNKNOWN_NETWORK, latencyMs };
  const country = asString(r.country);
  return {
    ip: asString(r.ip),
    country: country ? country.toUpperCase() : null,
    city: asString(r.city),
    region: asString(r.region),
    org: asString(r.org),
    timezone: asString(r.timezone),
    // `loc` is a "lat,lon" string in ipinfo's payload. Parsed now rather than discarded —
    // it is what lets a city verdict be a measurement instead of a string comparison.
    coordinates: parseLoc(r.loc),
    latencyMs,
  };
}

/**
 * Parse a `geojs.io` payload. Captured live from this machine:
 * `{"asn":2119,"city":"Rykkin","country_code":"NO","ip":"88.88.18.137",
 *   "organization":"AS2119 Telenor Norge AS","region":"Viken",
 *   "timezone":"Europe/Oslo"}`
 *
 * A failure here is an HTML 404 from openresty, not a JSON body with an error
 * flag, so an unparseable response is the only failure shape and it already reads
 * as `UNKNOWN_NETWORK`. That is worth knowing rather than assuming: the sibling
 * candidate for this slot, `ipwho.is`, answers a spent quota with **HTTP 200 and
 * `success: false`**, which a naive parser reads as "no country" — and a
 * corroborating source that reports no country disagrees with every primary
 * reading and manufactures a finding out of its own rate limit.
 */
export function parseGeoJsObservation(raw: string, latencyMs: number | null): NetworkObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...UNKNOWN_NETWORK, latencyMs };
  }
  const r = asRecord(parsed);
  if (!r) return { ...UNKNOWN_NETWORK, latencyMs };
  const country = asString(r.country_code);
  return {
    ip: asString(r.ip),
    country: country ? country.toUpperCase() : null,
    city: asString(r.city),
    region: asString(r.region),
    // Already in ipinfo's `AS2119 Telenor Norge AS` shape, so two sources' org
    // strings are comparable by eye in a report. `organization_name` is the bare
    // name and is deliberately not the one read.
    org: asString(r.organization),
    timezone: asString(r.timezone),
    // geojs gives latitude and longitude as separate STRING fields, unlike ipinfo's single
    // "lat,lon" — so the same reading arrives in two shapes and each parser normalises its own.
    coordinates: parseLoc(typeof r.latitude === "string" && typeof r.longitude === "string" ? `${r.latitude},${r.longitude}` : null),
    latencyMs,
  };
}

/**
 * An egress-identity endpoint AND the parser for its payload, as one unit.
 *
 * They travel together deliberately. `network.verifyEndpoint` is configurable
 * while `parseNetworkObservation` is ipinfo-shaped, so pointing the config at a
 * different vendor today yields every field `null` — an "unverified" that looks
 * like a network problem. A source is a pair, and a second vendor means a second
 * parser, not a second URL.
 */
export interface NetworkSource {
  id: string;
  endpoint: string;
  parse: (raw: string, latencyMs: number | null) => NetworkObservation;
}

export const IPINFO_SOURCE: NetworkSource = {
  id: "ipinfo",
  endpoint: DEFAULT_VERIFY_ENDPOINT,
  parse: parseNetworkObservation,
};

/**
 * The corroborating source, and why it is this one.
 *
 * Measured, and this is the finding that produced the slice: one Decodo ISP exit
 * resolved to **São Paulo** per Decodo's own endpoint and **New York** per
 * ipinfo, for the same IP. An engine whose entire job is proving where a visitor
 * is cannot treat a single lookup as ground truth — a wrong database reads
 * exactly like a wrong proxy, and the two need opposite fixes.
 *
 * A DIFFERENT vendor with a different database, not a mirror: two endpoints
 * reading the same MaxMind snapshot would agree about being wrong. Free, no key,
 * HTTPS (the browser navigates to it), and it reports country, city, region and
 * timezone, so it corroborates the axes that exist rather than a subset.
 *
 * **The `ipv4.` host is the load-bearing part, and it was measured, not assumed.**
 * `ipinfo.io` publishes **no AAAA record** — it is IPv4-only. A corroborating host
 * that IS dual-stack gets read over IPv6 by any dual-stack client, so the two
 * sources see two different addresses and the comparison is permanently
 * `unverified`. That is not hypothetical: `ipwho.is` (which has an AAAA) was the
 * first choice here, and a real Playwright run on this laptop reported
 * `88.88.18.137` from ipinfo and `2001:4656:e2f2:...` from ipwho.is — a
 * corroborating axis that could never corroborate anything. `ipv4.geojs.io`
 * publishes no AAAA either, so both reads use the same IPv4 egress.
 */
export const GEOJS_SOURCE: NetworkSource = {
  id: "geojs",
  endpoint: "https://ipv4.geojs.io/v1/ip/geo.json",
  parse: parseGeoJsObservation,
};

/** Read an egress identity through one named source. */
export function observeNetworkVia(
  runtime: BrowserRuntime,
  source: NetworkSource,
  now: () => number = Date.now,
): Promise<NetworkObservation> {
  return observeNetwork(runtime, source.endpoint, now, source.parse);
}

/**
 * The expression evaluated in the page to read the browser's own beliefs.
 *
 * Geolocation is wrapped in a promise with a short timeout because a headless
 * Chrome denies the permission by default — measured, EXP-000 — and the
 * callback would otherwise never fire. `"denied"` is a real, recorded state.
 */
export const BROWSER_ENV_EXPRESSION = `(async () => {
  const geo = await new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      () => resolve("denied"),
      { timeout: 3000 },
    );
  });
  return JSON.stringify({
    language: navigator.language ?? null,
    languages: Array.from(navigator.languages ?? []),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    userAgent: navigator.userAgent ?? null,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    geolocation: geo,
  });
})()`;

export const UNKNOWN_BROWSER: BrowserObservation = {
  language: null,
  languages: [],
  timezone: null,
  userAgent: null,
  viewport: null,
  geolocation: null,
};

export function parseBrowserObservation(value: unknown): BrowserObservation {
  const r = asRecord(value);
  if (!r) return { ...UNKNOWN_BROWSER };
  const vp = asRecord(r.viewport);
  const width = vp ? asNumber(vp.width) : null;
  const height = vp ? asNumber(vp.height) : null;
  const geoRecord = asRecord(r.geolocation);
  const lat = geoRecord ? asNumber(geoRecord.latitude) : null;
  const lon = geoRecord ? asNumber(geoRecord.longitude) : null;
  return {
    language: asString(r.language),
    languages: Array.isArray(r.languages) ? r.languages.filter((l): l is string => typeof l === "string") : [],
    timezone: asString(r.timezone),
    userAgent: asString(r.userAgent),
    viewport: width !== null && height !== null ? { width, height } : null,
    geolocation:
      r.geolocation === "denied"
        ? "denied"
        : lat !== null && lon !== null
          ? { latitude: lat, longitude: lon }
          : null,
  };
}

/** Read the egress identity by navigating the browser to the probe endpoint. */
export async function observeNetwork(
  runtime: BrowserRuntime,
  endpoint: string,
  now: () => number = Date.now,
  parse: (raw: string, latencyMs: number | null) => NetworkObservation = parseNetworkObservation,
): Promise<NetworkObservation> {
  const started = now();
  const opened = await runtime.open(endpoint);
  if (!opened.ok) return { ...UNKNOWN_NETWORK };
  const latencyMs = now() - started;
  const body = await runtime.getText("body");
  if (!body.ok) return { ...UNKNOWN_NETWORK, latencyMs };
  return parse(body.data, latencyMs);
}

/**
 * The expression that re-reads the egress IP from INSIDE the current page.
 *
 * `observeNetwork` navigates, which is exactly what a closing egress check must
 * not do: the evidence collector reads vitals, console, network and the a11y
 * tree AFTER the journey, and navigating to an identity endpoint first would
 * make every one of those describe ipinfo.io instead of the site under test. A
 * page-context `fetch` leaves over the same browser connection — so it is a
 * genuine reading of the same egress — while leaving the page untouched.
 *
 * A strict `connect-src` CSP can block it. That yields `null`, which
 * `compareEgressHeld` reports as `unverified` — the honest outcome, and strictly
 * better than a corrupted evidence package.
 */
export function egressIpExpression(endpoint: string): string {
  return `(async () => {
  try {
    const response = await fetch(${JSON.stringify(endpoint)}, { cache: "no-store" });
    const body = await response.json();
    return JSON.stringify({ ip: typeof body.ip === "string" ? body.ip : null });
  } catch {
    return JSON.stringify({ ip: null });
  }
})()`;
}

/** Re-read just the egress IP, without navigating away from the page. */
export async function observeEgressIp(runtime: BrowserRuntime, endpoint: string): Promise<string | null> {
  const out = await runtime.evaluate<unknown>(egressIpExpression(endpoint));
  if (!out.ok) return null;
  const value = typeof out.data === "string" ? safeParse(out.data) : out.data;
  const record = asRecord(value);
  return record ? asString(record.ip) : null;
}

/** Read the browser's own beliefs about locale, clock, device and position. */
export async function observeBrowser(runtime: BrowserRuntime): Promise<BrowserObservation> {
  const out = await runtime.evaluate<unknown>(BROWSER_ENV_EXPRESSION);
  if (!out.ok) return { ...UNKNOWN_BROWSER };
  // `evaluate` already JSON-parses when it can; a string means it could not.
  const value = typeof out.data === "string" ? safeParse(out.data) : out.data;
  return parseBrowserObservation(value);
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
