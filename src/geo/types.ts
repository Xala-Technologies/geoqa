/**
 * Geography as a first-class dimension.
 *
 * The single most important shape here is that a "geo profile" has TWO
 * independent axes, and they are verified separately:
 *
 *   network identity   — the IP the SERVER sees. Drives CDN edge selection,
 *                        geo-redirects, currency, tax, latency.
 *   browser environment — what the PAGE'S JAVASCRIPT believes. Drives
 *                        `navigator.language`, `Intl` timezone, the
 *                        Geolocation API, layout via viewport.
 *
 * Collapsing them into one number is the mistake this file exists to prevent.
 * A run with Oslo coordinates arriving from a Frankfurt IP is a plausible
 * production bug and a worthless QA profile, and only a two-axis verification
 * can tell you which one you are looking at.
 */

/** A place we care about serving correctly. */
export interface Market {
  id: string;
  /** ISO-3166 alpha-2, upper case. */
  country: string;
  city: string;
  /** BCP-47, e.g. "nb-NO". */
  language: string;
  /** IANA zone, e.g. "Europe/Oslo". */
  timezone: string;
  currency: string;
  /** [latitude, longitude] — fed to the Geolocation API. */
  coordinates: [number, number];
}

export interface DeviceProfile {
  id: string;
  kind: "mobile" | "desktop";
  viewport: { width: number; height: number };
  /** agent-browser `set device` name, when one applies. */
  emulate?: string;
  userAgent?: string;
}

export interface GeoProfile {
  id: string;
  label: string;
  market: Market;
  device: DeviceProfile;
  visitorType: "anonymous" | "returning";
}

/** What the network says about where we are. Every field is nullable: an
 *  unread value must never be confused with a read one. */
export interface NetworkObservation {
  ip: string | null;
  country: string | null;
  city: string | null;
  region: string | null;
  /** Provider/ASN string, e.g. "AS2116 GLOBALCONNECT AS". */
  org: string | null;
  timezone: string | null;
  latencyMs: number | null;
}

/** What the page's own JavaScript says about where we are. */
export interface BrowserObservation {
  language: string | null;
  languages: string[];
  timezone: string | null;
  userAgent: string | null;
  viewport: { width: number; height: number } | null;
  /**
   * The Geolocation API result. `"denied"` is its own state and is the DEFAULT
   * for a headless browser — measured in EXP-000: `set geo` stores coordinates
   * but the page still gets "User denied Geolocation" unless permission is
   * granted, which agent-browser 0.34.0 exposes no command for. Recording that
   * honestly is the difference between a known limitation and a silent lie.
   */
  geolocation: { latitude: number; longitude: number } | "denied" | null;
}

export type AxisVerdict = "match" | "mismatch" | "unverified";

export interface AxisResult {
  verdict: AxisVerdict;
  /** Why — always populated, including on a match. */
  reasons: string[];
}

export interface GeoVerification {
  profileId: string;
  network: {
    requested: { country: string; city: string };
    observed: NetworkObservation;
    country: AxisResult;
    city: AxisResult;
  };
  browser: {
    requested: { language: string; timezone: string; viewport: { width: number; height: number } };
    observed: BrowserObservation;
    language: AxisResult;
    timezone: AxisResult;
    /**
     * The device axis. Present because a profile ASKING for 390×844 and a
     * browser actually rendering at 390×844 are different claims — the first
     * live run rendered a mobile profile at 1280px and every other check still
     * passed.
     */
    viewport: AxisResult;
  };
  /** 0..100, capped by the weaker axis. See confidence/geo.ts. */
  confidence: number;
  /** True only when nothing is mismatched AND nothing is unverified. */
  trustworthy: boolean;
}
