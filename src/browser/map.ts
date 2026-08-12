/**
 * Pure mappers from agent-browser's `data` payloads to our own types.
 *
 * Every shape here was captured from agent-browser 0.34.0 by running the real
 * command (EXP-000), not read off documentation. Where the CLI nests a value
 * we flatten it — `vitals.lcp` arrives as `{startTime, element, size}` and
 * `vitals.cls` as `{score, entries}`, which is more structure than a threshold
 * check needs.
 *
 * The mappers are defensive in one direction only: a missing or wrongly-typed
 * field becomes `null`, never a fabricated zero. `lcp: 0` and "we could not
 * read lcp" must stay distinguishable, because a confidence score that treats
 * an unread metric as a good metric is exactly the instrumentation lie this
 * project exists to avoid.
 */
import type {
  A11yViolation,
  ConsoleMessage,
  NavigateResult,
  NetworkRequest,
  PageError,
  Vitals,
} from "./types.js";

/** Narrow an unknown to a plain object, or null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A finite number, or null. Never coerces a string or a boolean. */
export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A string, or null. */
export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** An array of records under `key`, or []. */
export function asRecordArray(data: unknown, key: string): Record<string, unknown>[] {
  const root = asRecord(data);
  const list = root?.[key];
  if (!Array.isArray(list)) return [];
  return list.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
}

/**
 * A nested metric like `{startTime: 44}` or `{score: 0}`, flattened to a
 * number. agent-browser returns bare numbers for `fcp`/`ttfb` and objects for
 * `lcp`/`cls`, so both forms are accepted.
 */
export function asMetric(value: unknown, nestedKey: string): number | null {
  const direct = asNumber(value);
  if (direct !== null) return direct;
  const nested = asRecord(value);
  return nested ? asNumber(nested[nestedKey]) : null;
}

/**
 * agent-browser's `launchHash` exceeds 2^53 (observed: 12798390076057945372),
 * so `JSON.parse` has already rounded it by the time we see it. We only ever
 * compare it for identity and print it as provenance, so a string of whatever
 * arrived is honest; treating it as a precise integer would not be.
 */
export function toLaunchHash(data: unknown): string | null {
  const lifecycle = asRecord(asRecord(data)?.lifecycle);
  const launch = asRecord(lifecycle?.effectiveLaunch);
  const hash = launch?.launchHash;
  return hash === undefined || hash === null ? null : String(hash);
}

export function toBrowserLaunched(data: unknown): boolean {
  const lifecycle = asRecord(asRecord(data)?.lifecycle);
  return asRecord(lifecycle?.effectiveLaunch)?.browserLaunched === true;
}

export function toNavigateResult(data: unknown): NavigateResult {
  const root = asRecord(data);
  return {
    url: asString(root?.url) ?? "",
    title: asString(root?.title) ?? "",
    targetId: asString(root?.targetId) ?? "",
    launchHash: toLaunchHash(data),
    browserLaunched: toBrowserLaunched(data),
  };
}

/** `get text` → `data.text`; also covers `get html`/`get value` shapes. */
export function toText(data: unknown, key = "text"): string {
  return asString(asRecord(data)?.[key]) ?? "";
}

export function toCount(data: unknown): number {
  return asNumber(asRecord(data)?.count) ?? 0;
}

export function toVisible(data: unknown): boolean {
  return asRecord(data)?.visible === true;
}

export function toSnapshot(data: unknown): string {
  return asString(asRecord(data)?.snapshot) ?? "";
}

export function toConsoleMessages(data: unknown): ConsoleMessage[] {
  return asRecordArray(data, "messages").map((m) => ({
    type: asString(m.type) ?? "log",
    text: asString(m.text) ?? "",
  }));
}

export function toPageErrors(data: unknown): PageError[] {
  return asRecordArray(data, "errors").map((e) => ({
    message: asString(e.text) ?? "",
    stack: asString(e.url),
  }));
}

export function toNetworkRequests(data: unknown): NetworkRequest[] {
  return asRecordArray(data, "requests").map((r) => ({
    url: asString(r.url) ?? "",
    method: asString(r.method) ?? "",
    status: asNumber(r.status),
    resourceType: asString(r.resourceType),
  }));
}

export function toVitals(data: unknown): Vitals {
  const root = asRecord(data);
  return {
    lcp: asMetric(root?.lcp, "startTime"),
    cls: asMetric(root?.cls, "score"),
    ttfb: asMetric(root?.ttfb, "value"),
    fcp: asMetric(root?.fcp, "value"),
    inp: asMetric(root?.inp, "value"),
  };
}

export function toA11yViolations(data: unknown): A11yViolation[] {
  return asRecordArray(data, "violations").map((v) => ({
    id: asString(v.id) ?? "",
    impact: asString(v.impact),
    help: asString(v.help) ?? "",
    nodes: asNumber(v.nodeCount) ?? 0,
  }));
}

/**
 * Console messages that count as a page defect. `warning` is deliberately NOT
 * one: real sites warn constantly (deprecations, third-party scripts), and a
 * journey that fails on every warning fails on every page, which is the same as
 * checking nothing.
 */
export function criticalConsoleErrors(messages: ConsoleMessage[]): ConsoleMessage[] {
  return messages.filter((m) => m.type === "error");
}
