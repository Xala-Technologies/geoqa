/**
 * Pure evaluation of a check against an already-gathered page reading.
 *
 * Splitting "read the page" (engine) from "judge the reading" (here) is what
 * makes the judgement testable without a browser — and it is also what makes
 * the third outcome possible. A check whose input was never read is
 * `unreadable`, not `failed`: "the page has no console errors" and "we never
 * managed to read the console" must never produce the same verdict, or the
 * engine reports its own blindness as good news.
 */
import { criticalConsoleErrors } from "../browser/map.js";
import type { A11yViolation, ConsoleMessage, NetworkRequest, PageError, Vitals } from "../browser/types.js";
import type { Check } from "./spec.js";

export type CheckVerdict = "passed" | "failed" | "unreadable";

export interface CheckResult {
  verdict: CheckVerdict;
  expected: string;
  observed: string;
}

/**
 * Everything a check might need. `null` means "not read" and is distinct from
 * an empty array, which means "read, and there were none".
 */
export interface PageReading {
  title: string | null;
  url: string | null;
  text: string | null;
  visible: boolean | null;
  count: number | null;
  console: ConsoleMessage[] | null;
  pageErrors: PageError[] | null;
  requests: NetworkRequest[] | null;
  vitals: Vitals | null;
  a11y: A11yViolation[] | null;
}

export const EMPTY_READING: PageReading = {
  title: null,
  url: null,
  text: null,
  visible: null,
  count: null,
  console: null,
  pageErrors: null,
  requests: null,
  vitals: null,
  a11y: null,
};

const pass = (expected: string, observed: string): CheckResult => ({ verdict: "passed", expected, observed });
const fail = (expected: string, observed: string): CheckResult => ({ verdict: "failed", expected, observed });
const unread = (expected: string, why: string): CheckResult => ({
  verdict: "unreadable",
  expected,
  observed: `not read — ${why}`,
});

const verdictOf = (ok: boolean, expected: string, observed: string): CheckResult =>
  ok ? pass(expected, observed) : fail(expected, observed);

/** Which reading a check depends on — used by the engine to fetch only what it needs. */
export function checkNeeds(check: Check): (keyof PageReading)[] {
  switch (check.check) {
    case "title-exists":
    case "title-contains":
      return ["title"];
    case "url-matches":
      return ["url"];
    case "selector-visible":
    case "selector-absent":
      return ["visible"];
    case "selector-count-min":
      return ["count"];
    case "text-contains":
    case "text-absent":
      return ["text"];
    case "no-console-errors":
      return ["console"];
    case "no-page-errors":
      return ["pageErrors"];
    case "no-http-5xx":
    case "no-http-4xx":
      return ["requests"];
    case "lcp-below":
    case "cls-below":
      return ["vitals"];
    case "no-a11y-critical":
      return ["a11y"];
  }
}

const statusBand = (requests: NetworkRequest[], low: number, high: number): NetworkRequest[] =>
  requests.filter((r) => r.status !== null && r.status >= low && r.status <= high);

export function evaluateCheck(check: Check, reading: PageReading): CheckResult {
  switch (check.check) {
    case "title-exists": {
      if (reading.title === null) return unread("a non-empty <title>", "title was not read");
      return verdictOf(reading.title.trim().length > 0, "a non-empty <title>", JSON.stringify(reading.title));
    }
    case "title-contains": {
      if (reading.title === null) return unread(`title contains "${check.value}"`, "title was not read");
      return verdictOf(
        reading.title.toLowerCase().includes(check.value.toLowerCase()),
        `title contains "${check.value}"`,
        JSON.stringify(reading.title),
      );
    }
    case "url-matches": {
      if (reading.url === null) return unread(`url matches /${check.value}/`, "url was not read");
      let re: RegExp;
      try {
        re = new RegExp(check.value);
      } catch {
        // A bad pattern is an authoring fault, not a page defect. Saying so is
        // more useful than failing the page for it.
        return unread(`url matches /${check.value}/`, "the pattern is not a valid regular expression");
      }
      return verdictOf(re.test(reading.url), `url matches /${check.value}/`, reading.url);
    }
    case "selector-visible": {
      if (reading.visible === null) return unread(`${check.selector} is visible`, "visibility was not read");
      return verdictOf(reading.visible, `${check.selector} is visible`, reading.visible ? "visible" : "not visible");
    }
    case "selector-absent": {
      if (reading.visible === null) return unread(`${check.selector} is absent`, "visibility was not read");
      return verdictOf(!reading.visible, `${check.selector} is absent`, reading.visible ? "visible" : "absent");
    }
    case "selector-count-min": {
      if (reading.count === null) return unread(`at least ${check.value} × ${check.selector}`, "count was not read");
      return verdictOf(
        reading.count >= check.value,
        `at least ${check.value} × ${check.selector}`,
        `${reading.count} found`,
      );
    }
    case "text-contains": {
      if (reading.text === null) return unread(`${check.selector} contains "${check.value}"`, "text was not read");
      return verdictOf(
        reading.text.toLowerCase().includes(check.value.toLowerCase()),
        `${check.selector} contains "${check.value}"`,
        `${reading.text.length} chars read`,
      );
    }
    case "text-absent": {
      if (reading.text === null) return unread(`${check.selector} lacks "${check.value}"`, "text was not read");
      return verdictOf(
        !reading.text.toLowerCase().includes(check.value.toLowerCase()),
        `${check.selector} lacks "${check.value}"`,
        `${reading.text.length} chars read`,
      );
    }
    case "no-console-errors": {
      if (reading.console === null) return unread("no console errors", "the console was not read");
      const errors = criticalConsoleErrors(reading.console);
      return verdictOf(
        errors.length === 0,
        "no console errors",
        errors.length ? `${errors.length}: ${errors.map((e) => e.text).join(" | ")}` : "none",
      );
    }
    case "no-page-errors": {
      if (reading.pageErrors === null) return unread("no uncaught exceptions", "page errors were not read");
      return verdictOf(
        reading.pageErrors.length === 0,
        "no uncaught exceptions",
        reading.pageErrors.length ? reading.pageErrors.map((e) => e.message).join(" | ") : "none",
      );
    }
    case "no-http-5xx": {
      if (reading.requests === null) return unread("no 5xx responses", "network requests were not read");
      const bad = statusBand(reading.requests, 500, 599);
      return verdictOf(
        bad.length === 0,
        "no 5xx responses",
        bad.length ? bad.map((r) => `${r.status} ${r.url}`).join(" | ") : "none",
      );
    }
    case "no-http-4xx": {
      if (reading.requests === null) return unread("no 4xx responses", "network requests were not read");
      const bad = statusBand(reading.requests, 400, 499);
      return verdictOf(
        bad.length === 0,
        "no 4xx responses",
        bad.length ? bad.map((r) => `${r.status} ${r.url}`).join(" | ") : "none",
      );
    }
    case "lcp-below": {
      const lcp = reading.vitals?.lcp ?? null;
      if (lcp === null) return unread(`LCP below ${check.value}ms`, "LCP was not measured");
      return verdictOf(lcp < check.value, `LCP below ${check.value}ms`, `${Math.round(lcp)}ms`);
    }
    case "cls-below": {
      const cls = reading.vitals?.cls ?? null;
      if (cls === null) return unread(`CLS below ${check.value}`, "CLS was not measured");
      return verdictOf(cls < check.value, `CLS below ${check.value}`, String(cls));
    }
    case "no-a11y-critical": {
      if (reading.a11y === null) return unread("no critical accessibility violations", "axe did not run");
      const critical = reading.a11y.filter((v) => v.impact === "critical");
      return verdictOf(
        critical.length === 0,
        "no critical accessibility violations",
        critical.length ? critical.map((v) => v.id).join(", ") : "none",
      );
    }
  }
}

/** A one-line, human-readable rendering of a check for a log or a finding. */
export function describeCheck(check: Check, result: CheckResult): string {
  return `${check.check}: expected ${result.expected}, observed ${result.observed}`;
}
