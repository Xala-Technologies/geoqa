/**
 * Redaction, applied BEFORE anything reaches disk.
 *
 * This runs at capture time rather than as a cleanup pass, because the moment
 * an unredacted value is written it exists in a file, a backup, and possibly a
 * git object — and "we redact on export" is how credentials end up in evidence
 * archives. The engine's own proxy URL is the most likely leak (it carries a
 * vendor password), followed by anything a page put in a query string.
 *
 * Screenshots are a different problem and are NOT solved here: an image of a
 * filled-in form is personal data and no regex will find it. What we can do
 * honestly is bound it — see `screenshotRisk` — and record the risk in the
 * manifest so a human knows which artifacts need care.
 */

/** Query/JSON keys whose values are always masked, matched case-insensitively. */
export const SENSITIVE_KEYS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "key",
  "authorization",
  "auth",
  "session",
  "sessionid",
  "cookie",
  "credit_card",
  "card",
  "cvv",
  "ssn",
  "personnummer",
  "fodselsnummer",
];

export const MASK = "***";

const keyPattern = new RegExp(`\\b(${SENSITIVE_KEYS.join("|")})\\b`, "i");

export function isSensitiveKey(key: string): boolean {
  return keyPattern.test(key);
}

/** Mask `user:pass@host` credentials in any URL-ish substring. */
export function redactCredentials(input: string): string {
  return input.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, `$1${MASK}:${MASK}@`);
}

/** Mask the values of sensitive query parameters, keeping the shape readable. */
export function redactQueryParams(input: string): string {
  return input.replace(/([?&])([\w.\-[\]]+)=([^&\s"']*)/g, (whole, sep: string, key: string, value: string) =>
    isSensitiveKey(key) && value.length > 0 ? `${sep}${key}=${MASK}` : whole,
  );
}

/**
 * A Norwegian national identity number is 11 digits and appears in exactly the
 * kind of form this engine walks past. Masked on sight — the false-positive
 * cost (an 11-digit order number) is trivial next to writing a real one to disk.
 */
export function redactNationalIds(input: string): string {
  return input.replace(/\b\d{6}[ ]?\d{5}\b/g, MASK);
}

export function redactEmails(input: string): string {
  return input.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, MASK);
}

/** Everything, in the order that keeps each pattern intact for the next. */
export function redact(input: string): string {
  return redactEmails(redactNationalIds(redactQueryParams(redactCredentials(input))));
}

/** Recursively redact every string in a JSON-serialisable value. */
export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? MASK : redactDeep(inner);
    }
    return out;
  }
  return value;
}

export type ScreenshotRisk = "low" | "review";

/**
 * Whether a screenshot needs a human's eye before it leaves the machine.
 *
 * Deliberately crude and deliberately over-cautious: any page that had a form
 * on it, or any authenticated visit, is `review`. This does not detect personal
 * data — nothing here can — it flags the artifacts where personal data is
 * plausible so retention and sharing rules can attach to them.
 */
export function screenshotRisk(context: { hadForm: boolean; authenticated: boolean }): ScreenshotRisk {
  return context.hadForm || context.authenticated ? "review" : "low";
}
