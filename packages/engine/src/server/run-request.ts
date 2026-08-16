/**
 * The body `POST /api/run` accepts.
 *
 * Same fields as `geoqa run`, as JSON rather than flags. Unknown keys are
 * refused: a typo that silently dropped `--city` would run Oslo and report
 * Bergen. `rotateIp` / `evidence` cannot be false — both are how a run
 * already works.
 */
export interface ParsedRunRequest {
  url: string;
  journey: string;
  country?: string;
  city?: string;
  device?: string;
  geo?: string;
  locale?: string;
  timezone?: string;
  sessionDurationMinutes?: number;
  rotateIp?: boolean;
  evidence?: boolean;
  allowWrites?: boolean;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const KEYS = new Set([
  "url",
  "journey",
  "country",
  "city",
  "device",
  "geo",
  "locale",
  "timezone",
  "sessionDurationMinutes",
  "rotateIp",
  "evidence",
  "allowWrites",
]);

const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

export function parseRunRequest(body: unknown): ParseResult<ParsedRunRequest> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["a run request must be a JSON object"] };
  }
  const rec = body as Record<string, unknown>;
  const unknown = Object.keys(rec).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) return { ok: false, errors: [`unknown key(s): ${unknown.join(", ")}`] };

  const url = rec.url;
  if (typeof url !== "string" || url === "") return { ok: false, errors: ["url is required"] };
  if (!isHttpUrl(url)) return { ok: false, errors: [`url must be http(s): ${url}`] };

  const errors: string[] = [];
  const optionalString = (key: string): string | undefined => {
    const value = rec[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value === "") {
      errors.push(`${key} must be a non-empty string`);
      return undefined;
    }
    return value;
  };

  const device = optionalString("device");
  if (device !== undefined && device !== "mobile" && device !== "desktop") {
    errors.push(`device must be mobile or desktop, not ${device}`);
  }
  if (rec.rotateIp === false) errors.push("rotateIp cannot be false — a new run always mints a new proxy session");
  if (rec.evidence === false) errors.push("evidence cannot be false — a run without an evidence package is not a run");
  if (rec.allowWrites !== undefined && typeof rec.allowWrites !== "boolean") {
    errors.push("allowWrites must be a boolean");
  }
  if (rec.rotateIp !== undefined && typeof rec.rotateIp !== "boolean") errors.push("rotateIp must be a boolean");
  if (rec.evidence !== undefined && typeof rec.evidence !== "boolean") errors.push("evidence must be a boolean");

  let sessionDurationMinutes: number | undefined;
  if (rec.sessionDurationMinutes !== undefined) {
    const n = rec.sessionDurationMinutes;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 60) {
      errors.push("sessionDurationMinutes must be an integer from 1 to 60");
    } else {
      sessionDurationMinutes = n;
    }
  }

  const journey = optionalString("journey") ?? "landing-page";
  const country = optionalString("country");
  const city = optionalString("city");
  const geo = optionalString("geo");
  const locale = optionalString("locale");
  const timezone = optionalString("timezone");

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      url,
      journey,
      ...(country ? { country } : {}),
      ...(city ? { city } : {}),
      ...(device ? { device } : {}),
      ...(geo ? { geo } : {}),
      ...(locale ? { locale } : {}),
      ...(timezone ? { timezone } : {}),
      ...(sessionDurationMinutes !== undefined ? { sessionDurationMinutes } : {}),
      ...(rec.rotateIp === true ? { rotateIp: true } : {}),
      ...(rec.evidence === true ? { evidence: true } : {}),
      ...(rec.allowWrites === true ? { allowWrites: true } : {}),
    },
  };
}
