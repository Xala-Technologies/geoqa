/**
 * Geo profiles: YAML in, validated `GeoProfile` out.
 *
 * A profile file is SELF-CONTAINED — it embeds its market rather than
 * referencing one by id from a shared config. That is deliberate and it costs
 * some duplication: an evidence package has to be able to answer "what exactly
 * was this run's identity?" from one artifact, months later, without also
 * needing the config file as it stood that day.
 *
 * `toSessionConfig` is where a profile becomes browser flags, and it is the
 * only place that knows which overrides actually work. Every one of them was
 * measured against agent-browser 0.34.0 in EXP-000, because three plausible
 * ones silently do nothing.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { BrowserSessionConfig } from "../browser/types.js";
import type { GeoProfile } from "./types.js";

const MarketSchema = z.object({
  id: z.string().min(1),
  country: z.string().length(2).transform((s) => s.toUpperCase()),
  city: z.string().min(1),
  language: z.string().min(2),
  timezone: z.string().min(1),
  currency: z.string().min(1),
  coordinates: z.tuple([z.number(), z.number()]),
});

const DeviceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["mobile", "desktop"]),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  emulate: z.string().min(1).optional(),
  userAgent: z.string().min(1).optional(),
  hasTouch: z.boolean().optional(),
  // A positive number rather than an integer: 2.75 is a real device's ratio, and rounding it
  // would change which `srcset` candidate a page picks — the one thing this option affects.
  deviceScaleFactor: z.number().positive().optional(),
});

export const GeoProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  market: MarketSchema,
  device: DeviceSchema,
  visitorType: z.enum(["anonymous", "returning"]).default("anonymous"),
});

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Flatten zod issues into one line each, so a bad profile names its own fault. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const at = i.path.length ? i.path.join(".") : "(root)";
    return `${at}: ${i.message}`;
  });
}

export function parseGeoProfile(raw: unknown): ParseResult<GeoProfile> {
  const result = GeoProfileSchema.safeParse(raw);
  return result.success
    ? { ok: true, value: result.data as GeoProfile }
    : { ok: false, errors: formatIssues(result.error) };
}

export function loadGeoProfile(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): ParseResult<GeoProfile> {
  let doc: unknown;
  try {
    doc = parseYaml(read(path));
  } catch (e) {
    return { ok: false, errors: [`${path}: ${(e as Error).message}`] };
  }
  const parsed = parseGeoProfile(doc);
  return parsed.ok ? parsed : { ok: false, errors: parsed.errors.map((e) => `${path}: ${e}`) };
}

/**
 * The JavaScript injected before first navigation to make the page's own
 * beliefs match the profile.
 *
 * This exists because the obvious mechanisms do not work. Measured, EXP-000:
 *   - `--args "--lang=de-DE"`      → navigator.language unchanged (nb-NO)
 *   - `set headers Accept-Language`→ moves the HTTP header ONLY; page JS
 *                                    still reads the host's language
 *   - `--init-script`              → works; navigator.language became de-DE
 *
 * Geolocation is stubbed for the same class of reason: `set geo` records
 * coordinates, but a headless browser denies the permission and the page gets
 * "User denied Geolocation". A site that localises off the Geolocation API
 * would otherwise be untestable. The stub is honest in that the observer can
 * still tell a stubbed reading from a granted one — `observeBrowser` reports
 * what the page actually saw.
 */
export function localeInitScript(profile: GeoProfile): string {
  const { language, coordinates } = profile.market;
  // `split` always returns at least one element, so the index is provably a string and the
  // `?? language` this replaces was a branch nothing could execute. The assertion states the
  // fact for the type checker rather than paying for it at runtime — `noUncheckedIndexedAccess`
  // is right about arrays in general and wrong about the first element of a split.
  const primary = language.split("-")[0] as string;
  const [latitude, longitude] = coordinates;
  return `(() => {
  const langs = ${JSON.stringify([language, primary])};
  Object.defineProperty(navigator, 'language', { get: () => langs[0], configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => langs, configurable: true });
  if (navigator.geolocation) {
    const position = {
      coords: { latitude: ${latitude}, longitude: ${longitude}, accuracy: 20,
                altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: Date.now(),
    };
    navigator.geolocation.getCurrentPosition = (ok) => ok(position);
    navigator.geolocation.watchPosition = (ok) => { ok(position); return 0; };
  }
})();`;
}

export interface SessionConfigOptions {
  sessionId: string;
  /** Written by the caller; the init script must exist on disk before launch. */
  initScriptPath?: string;
  proxyUrl?: string | null;
  proxyBypass?: string | null;
  headed?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * A profile plus a network session becomes a browser identity.
 *
 * `namespace` is set to the market id on purpose. agent-browser keys a browser
 * process by its launch flags, so two markets can never share one — giving each
 * market its own daemon namespace makes that explicit instead of leaving it to
 * a hash collision to decide.
 */
export function toSessionConfig(profile: GeoProfile, options: SessionConfigOptions): BrowserSessionConfig {
  const config: BrowserSessionConfig = {
    sessionId: options.sessionId,
    namespace: profile.market.id,
    // TZ is the ONLY thing that moves the browser's clock. Nothing in the
    // agent-browser CLI does it.
    env: { ...(options.baseEnv ?? {}), TZ: profile.market.timezone },
  };
  if (options.proxyUrl) config.proxy = options.proxyUrl;
  if (options.proxyBypass) config.proxyBypass = options.proxyBypass;
  if (profile.device.userAgent) config.userAgent = profile.device.userAgent;
  if (options.initScriptPath) config.initScripts = [options.initScriptPath];
  if (options.headed) config.headed = true;
  return config;
}
