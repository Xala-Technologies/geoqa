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
 * honestly is bound it — see `artifactRisk` — and record the risk in the
 * manifest so a human knows which artifacts need care.
 */

/**
 * Query-PARAMETER names whose values are always masked, matched case-insensitively.
 *
 * Deliberately broad, and deliberately scoped to URLs only. A query parameter's
 * name is chosen by the site, and its value is data on the wire — `?key=…`,
 * `?session=…` and `?card=…` are far more likely to carry a credential than to
 * describe a structure, and over-masking a URL costs nothing. Property names in
 * artifacts we write ourselves are the opposite case and use their own, narrower
 * list; see `isSensitivePropertyName`.
 */
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

/** True for a query-parameter name whose value must not reach disk. */
export function isSensitiveKey(key: string): boolean {
  return keyPattern.test(key);
}

/**
 * Field names that are STRUCTURE in this codebase and must never be masked by
 * name, even though the query-parameter list above contains the same words.
 *
 * Each entry names a field a reader needs in order to know what a record is
 * about, and masking it destroys the record while looking like diligence:
 *
 * - `key`      — `MetricSpec.key` identifies which metric a number belongs to.
 *                Masking it turned every committed experiment summary into
 *                `{"key": "***", "value": 100}`, i.e. a number with no subject.
 * - `sessionid` — `SessionConfig.sessionId` is a browser session *name* (the
 *                runId), not a credential; without it we cannot say which
 *                browser served the run.
 * - `session`  — a network session object (egress IP, market, rotation state).
 * - `auth`     — an auth *mode* ("form", "none"), not a token. `authorization`
 *                and `token` stay masked, which is where a real secret lives.
 * - `card`     — a UI card, not a PAN. `credit_card`/`cvv` stay masked.
 *
 * Removing an entry here re-opens gap B-2 for that field.
 */
export const STRUCTURAL_FIELD_NAMES = ["key", "auth", "session", "sessionid", "card"];

/** Case and separators carry no meaning in a field name: `api_key` === `apiKey`. */
function normaliseFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SECRET_PROPERTY_NAMES = new Set(
  SENSITIVE_KEYS.map(normaliseFieldName).filter((name) => !STRUCTURAL_FIELD_NAMES.includes(name)),
);

/** `userPassword` → ["user", "password"]; splits on camelCase and on separators. */
function fieldNameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
}

/**
 * True for an object property whose value must be masked wholesale.
 *
 * Two matches, both anchored, and nothing in between:
 *
 * 1. the whole normalised name is a secret's name (`apiKey`, `access_token`);
 * 2. the LAST segment is (`userPassword`, `authToken`, `observedCookie`) — a
 *    qualifier in front of a secret still names a secret.
 *
 * What is deliberately absent is substring matching, which is gap B-2's actual
 * cause: a `\bkey\b` regex over the broad URL list masked `MetricSpec.key`, and
 * a plain `includes` would go further and mask `className` (contains `ssn`) and
 * the boolean `cookieIsolated` (contains `cookie`). Anchoring at the tail keeps
 * `metricKey` and `nextSession` readable, because their last segment is a
 * structural name — `STRUCTURAL_FIELD_NAMES` is filtered out of the set this
 * matches against, so that list is load-bearing rather than documentary.
 *
 * The residual gap is a secret named in the MIDDLE (`tokenForUpload`). The fix
 * for such a case is to add the literal name, never to widen the rule: widening
 * is what deleted the field it was meant to protect. And every string still goes
 * through `redact` whatever property it sits under, so credentials in a URL, an
 * email and a personnummer are caught by content regardless of this decision.
 */
export function isSensitivePropertyName(name: string): boolean {
  if (SECRET_PROPERTY_NAMES.has(normaliseFieldName(name))) return true;
  const segments = fieldNameSegments(name);
  const last = segments.at(-1);
  return last !== undefined && SECRET_PROPERTY_NAMES.has(last);
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

/**
 * Recursively redact every string in a JSON-serialisable value.
 *
 * Two independent rules: a value is dropped entirely when its property NAME is a
 * secret's name, and every surviving string is scrubbed by CONTENT. The content
 * pass is the one that catches real leaks (credentials in a URL, an email, a
 * personnummer) and it does not care what the field is called — which is why the
 * name rule can afford to be narrow.
 */
export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitivePropertyName(key) ? MASK : redactDeep(inner);
    }
    return out;
  }
  return value;
}

export type ArtifactRisk = "low" | "review";

/**
 * Whether an artifact needs a human's eye before it leaves the machine.
 *
 * Deliberately crude and deliberately over-cautious: any page that had a form
 * on it, or any authenticated visit, is `review`. This does not detect personal
 * data — nothing here can — it flags the artifacts where personal data is
 * plausible so retention and sharing rules can attach to them.
 *
 * Named for artifacts rather than screenshots because it stopped being about
 * screenshots. A HAR has the same problem and a worse version of it: bodies are
 * omitted at creation, but a request body and a `Cookie` header are not, so a
 * login journey's HAR can hold a filled credential — the one thing R-63 says
 * must never reach disk. A screenshot at least needs a human to read an image;
 * a HAR is grep-able. Both get the same flag from the same two facts.
 */
export function artifactRisk(context: { hadForm: boolean; authenticated: boolean }): ArtifactRisk {
  return context.hadForm || context.authenticated ? "review" : "low";
}
