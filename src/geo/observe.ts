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
  latencyMs: null,
};

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
    latencyMs,
  };
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
): Promise<NetworkObservation> {
  const started = now();
  const opened = await runtime.open(endpoint);
  if (!opened.ok) return { ...UNKNOWN_NETWORK };
  const latencyMs = now() - started;
  const body = await runtime.getText("body");
  if (!body.ok) return { ...UNKNOWN_NETWORK, latencyMs };
  return parseNetworkObservation(body.data, latencyMs);
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
