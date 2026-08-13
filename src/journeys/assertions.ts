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
  /**
   * A markup attribute's value: `null` when not read, `""` when the attribute is ABSENT.
   *
   * The two are different facts and the check depends on telling them apart — an absent
   * attribute is a real, verifiable reading of the page, while "we could not look" is ours.
   * Empty string does double duty for absent and for `lang=""`, which is deliberate: a page
   * declaring an empty language has declared nothing, and no check should treat those apart.
   */
  attribute: string | null;
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
  attribute: null,
  visible: null,
  count: null,
  console: null,
  pageErrors: null,
  requests: null,
  vitals: null,
  a11y: null,
};

/**
 * Zero characters is not a reading about the page's CONTENT.
 *
 * It is a reading about whether anything had rendered, and the two are not the same claim.
 * `getText` is `innerText`; on a client-rendered site the shell's `<html>` and `<body>` are
 * ATTACHED immediately, so a read that only auto-waits for attachment returns `""` before
 * hydration. Measured on xala.no: 0 characters at `load`, 6,077 one second later, against a
 * site whose `<html lang>` is `nb-NO` and correct.
 *
 * The adapter re-reads once after a settle before it gets here (see `PlaywrightRuntime.getText`),
 * so an empty string at this point has already survived that. It is still not attributed to the
 * SITE: "the page rendered nothing" and "we looked too early" are indistinguishable from here,
 * and when this engine cannot distinguish, it does not blame the page. `unreadable` lands as
 * `errored`/instrumentation, which still blocks the publish gate — a different sentence, the
 * same outcome.
 */
const NOTHING_RENDERED = "0 characters rendered — the page had no text at all, which says nothing about whether it contains the value";

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
    case "attribute-contains":
    case "attribute-absent":
      return ["attribute"];
    case "no-console-errors":
      return ["console"];
    case "no-page-errors":
      return ["pageErrors"];
    case "no-http-5xx":
    case "no-http-4xx":
      return ["requests"];
    case "lcp-below":
    case "cls-below":
    case "inp-below":
      return ["vitals"];
    case "no-a11y-critical":
      return ["a11y"];
  }
}

const statusBand = (requests: NetworkRequest[], low: number, high: number): NetworkRequest[] =>
  requests.filter((r) => r.status !== null && r.status >= low && r.status <= high);

/**
 * A `{placeholder}` that survived substitution.
 *
 * `resolveSteps` leaves an unfilled placeholder INTACT rather than blanking it, and that rule
 * is right where it was made: `open ""` would navigate somewhere meaningless and report a page
 * failure for a config typo ([R-11](../../docs/prd.md)). Carried into an assert, the same rule
 * produces two different lies, and the second is the dangerous one:
 *
 * - `text-contains "{expectLanguageMarker}"` asks whether the page contains that literal
 *   string. It does not, so a HIGH-severity site finding is filed for a variable the operator
 *   forgot to pass.
 * - `text-absent "{forbiddenCurrency}"` asks whether the page LACKS that literal string. Every
 *   page on earth does. **The check passes, green, having verified nothing.**
 *
 * A false FAIL wastes an afternoon. A false PASS is the exact conflation of "we could not
 * measure" with "it is fine" that this engine exists to refuse, and it is invisible — the run
 * reports PASS and nobody looks. So a check that still carries a placeholder is neither: it is
 * OUR defect, reported as unreadable, which lands as `errored` and category `instrumentation`.
 *
 * Matches `resolveSteps`'s own pattern, so a value that merely contains braces (a JSON blob, a
 * template literal in copy) is not caught by accident — only `{word}`, which is the one shape
 * substitution would have filled.
 */
const UNFILLED_PLACEHOLDER = /\{(\w+)\}/;

export function evaluateCheck(check: Check, reading: PageReading): CheckResult {
  if ("value" in check && typeof check.value === "string") {
    const unfilled = UNFILLED_PLACEHOLDER.exec(check.value);
    if (unfilled !== null) {
      return unread(
        `${check.check} "${check.value}"`,
        `the journey variable {${unfilled[1] ?? ""}} was never supplied, so this check would compare against the placeholder itself — pass --var ${unfilled[1] ?? ""}=<value>`,
      );
    }
  }
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
      if (reading.text === "") return unread(`${check.selector} contains "${check.value}"`, NOTHING_RENDERED);
      return verdictOf(
        reading.text.toLowerCase().includes(check.value.toLowerCase()),
        `${check.selector} contains "${check.value}"`,
        `${reading.text.length} chars read`,
      );
    }
    case "text-absent": {
      if (reading.text === null) return unread(`${check.selector} lacks "${check.value}"`, "text was not read");
      // The same guard as `text-contains`, and here it prevents a false PASS rather than a
      // false FAIL: an empty page trivially lacks every string, so this check would go green
      // on a page that rendered nothing at all.
      if (reading.text === "") return unread(`${check.selector} lacks "${check.value}"`, NOTHING_RENDERED);
      return verdictOf(
        !reading.text.toLowerCase().includes(check.value.toLowerCase()),
        `${check.selector} lacks "${check.value}"`,
        `${reading.text.length} chars read`,
      );
    }
    case "attribute-contains": {
      if (reading.attribute === null) return unread(`${check.selector}[${check.attribute}] contains "${check.value}"`, "the attribute was not read");
      return verdictOf(
        reading.attribute.toLowerCase().includes(check.value.toLowerCase()),
        `${check.selector}[${check.attribute}] contains "${check.value}"`,
        // The attribute is QUOTED, so an absent one reads as `""` rather than as blank space
        // in a report — "observed:" followed by nothing is indistinguishable from a rendering
        // bug in whatever is displaying it.
        JSON.stringify(reading.attribute),
      );
    }
    case "attribute-absent": {
      if (reading.attribute === null) return unread(`${check.selector} has no ${check.attribute}`, "the attribute was not read");
      return verdictOf(reading.attribute === "", `${check.selector} has no ${check.attribute}`, JSON.stringify(reading.attribute));
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
    case "inp-below": {
      const inp = reading.vitals?.inp ?? null;
      /**
       * A null INP is UNVERIFIED, and the reason it gives names the likely cause.
       *
       * Unlike LCP, a null here usually means the journey's fault rather than the
       * page's: no interaction happened, so there was nothing to time. Reporting
       * that as a pass would be the worst option — a responsiveness budget met by
       * never touching anything — and reporting it as a failure would blame the site
       * for the journey's ordering. So it is `unverified`, with the sentence that
       * tells whoever reads it what to change.
       */
      if (inp === null) {
        return unread(
          `INP below ${check.value}ms`,
          "INP was not measured — no interaction entry was reported. Either nothing was interacted with yet (this check belongs AFTER a click, press, fill or scroll), or the interaction was faster than the browser reports: Chromium emits event-timing entries only above a threshold, so a page that responds instantly produces no entry at all. The second case is a fact about the page, not a failed read",
        );
      }
      return verdictOf(inp < check.value, `INP below ${check.value}ms`, `${Math.round(inp)}ms`);
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
