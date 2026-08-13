import { describe, expect, it } from "vitest";
import { EMPTY_READING, checkNeeds, describeCheck, evaluateCheck, type PageReading } from "../assertions.js";
import type { Check } from "../spec.js";

const reading = (over: Partial<PageReading>): PageReading => ({ ...EMPTY_READING, ...over });
const verdict = (check: Check, over: Partial<PageReading>): string => evaluateCheck(check, reading(over)).verdict;

describe("checkNeeds", () => {
  it("names exactly one reading per check, and covers every check kind", () => {
    const checks: Check[] = [
      { check: "title-exists" },
      { check: "title-contains", value: "x" },
      { check: "url-matches", value: "x" },
      { check: "selector-visible", selector: "h1" },
      { check: "selector-absent", selector: "h1" },
      { check: "selector-count-min", selector: "a", value: 1 },
      { check: "text-contains", selector: "body", value: "x" },
      { check: "text-absent", selector: "body", value: "x" },
      { check: "no-console-errors" },
      { check: "no-page-errors" },
      { check: "no-http-5xx" },
      { check: "no-http-4xx" },
      { check: "lcp-below", value: 1 },
      { check: "cls-below", value: 1 },
      { check: "no-a11y-critical" },
    ];
    for (const c of checks) expect(checkNeeds(c)).toHaveLength(1);
    expect(checkNeeds({ check: "no-http-4xx" })).toEqual(["requests"]);
  });
});

describe("the unreadable verdict", () => {
  it("is returned — never `passed` — for EVERY check when its input was not read", () => {
    // The single most important property in this file. A check that reads
    // nothing must not report good news.
    const checks: Check[] = [
      { check: "title-exists" },
      { check: "title-contains", value: "x" },
      { check: "url-matches", value: "x" },
      { check: "selector-visible", selector: "h1" },
      { check: "selector-absent", selector: "h1" },
      { check: "selector-count-min", selector: "a", value: 1 },
      { check: "text-contains", selector: "body", value: "x" },
      { check: "text-absent", selector: "body", value: "x" },
      { check: "no-console-errors" },
      { check: "no-page-errors" },
      { check: "no-http-5xx" },
      { check: "no-http-4xx" },
      { check: "lcp-below", value: 1 },
      { check: "cls-below", value: 1 },
      { check: "no-a11y-critical" },
    ];
    for (const c of checks) {
      const result = evaluateCheck(c, EMPTY_READING);
      expect(result.verdict, `${c.check} on an empty reading`).toBe("unreadable");
      expect(result.observed).toContain("not read");
    }
  });
});

describe("title and url", () => {
  it("title-exists rejects an empty or whitespace title", () => {
    expect(verdict({ check: "title-exists" }, { title: "Digilist" })).toBe("passed");
    expect(verdict({ check: "title-exists" }, { title: "   " })).toBe("failed");
  });

  it("title-contains is case-insensitive", () => {
    expect(verdict({ check: "title-contains", value: "digilist" }, { title: "Digilist — Utleie" })).toBe("passed");
    expect(verdict({ check: "title-contains", value: "airbnb" }, { title: "Digilist" })).toBe("failed");
  });

  it("url-matches applies a regular expression", () => {
    expect(verdict({ check: "url-matches", value: "^https://digilist\\.no/" }, { url: "https://digilist.no/blogg" })).toBe("passed");
    expect(verdict({ check: "url-matches", value: "^https://x/" }, { url: "https://digilist.no" })).toBe("failed");
  });

  it("treats an invalid regex as an AUTHORING fault, not a page defect", () => {
    const result = evaluateCheck({ check: "url-matches", value: "([" }, reading({ url: "https://x" }));
    expect(result.verdict).toBe("unreadable");
    expect(result.observed).toContain("not a valid regular expression");
  });
});

describe("selectors", () => {
  it("selector-visible and selector-absent are opposites", () => {
    expect(verdict({ check: "selector-visible", selector: "h1" }, { visible: true })).toBe("passed");
    expect(verdict({ check: "selector-visible", selector: "h1" }, { visible: false })).toBe("failed");
    expect(verdict({ check: "selector-absent", selector: ".err" }, { visible: false })).toBe("passed");
    expect(verdict({ check: "selector-absent", selector: ".err" }, { visible: true })).toBe("failed");
  });

  it("selector-count-min compares inclusively", () => {
    expect(verdict({ check: "selector-count-min", selector: "a", value: 3 }, { count: 3 })).toBe("passed");
    expect(verdict({ check: "selector-count-min", selector: "a", value: 3 }, { count: 2 })).toBe("failed");
  });

  it("text-contains and text-absent are case-insensitive opposites", () => {
    expect(verdict({ check: "text-contains", selector: "body", value: "NOK" }, { text: "Pris: 500 nok" })).toBe("passed");
    expect(verdict({ check: "text-absent", selector: "body", value: "EUR" }, { text: "Pris: 500 nok" })).toBe("passed");
    expect(verdict({ check: "text-absent", selector: "body", value: "nok" }, { text: "500 NOK" })).toBe("failed");
    expect(verdict({ check: "text-contains", selector: "body", value: "SEK" }, { text: "500 NOK" })).toBe("failed");
  });
});

describe("errors and network", () => {
  it("no-console-errors ignores warnings and logs", () => {
    expect(
      verdict({ check: "no-console-errors" }, { console: [{ type: "warning", text: "deprecated" }] }),
    ).toBe("passed");
    const failed = evaluateCheck({ check: "no-console-errors" }, reading({ console: [{ type: "error", text: "boom" }] }));
    expect(failed.verdict).toBe("failed");
    expect(failed.observed).toContain("boom");
  });

  it("distinguishes an empty console (read, none found) from an unread one", () => {
    expect(verdict({ check: "no-console-errors" }, { console: [] })).toBe("passed");
    expect(verdict({ check: "no-console-errors" }, { console: null })).toBe("unreadable");
  });

  it("no-page-errors reports the exception text", () => {
    expect(verdict({ check: "no-page-errors" }, { pageErrors: [] })).toBe("passed");
    const failed = evaluateCheck({ check: "no-page-errors" }, reading({ pageErrors: [{ message: "boom", stack: null }] }));
    expect(failed.verdict).toBe("failed");
    expect(failed.observed).toContain("boom");
  });

  it("bands 4xx and 5xx separately and ignores requests with no status", () => {
    const requests = [
      { url: "https://x/a", method: "GET", status: 200, resourceType: null },
      { url: "https://x/b", method: "GET", status: 404, resourceType: null },
      { url: "https://x/c", method: "GET", status: 503, resourceType: null },
      { url: "https://x/d", method: "GET", status: null, resourceType: null },
    ];
    const five = evaluateCheck({ check: "no-http-5xx" }, reading({ requests }));
    expect(five.verdict).toBe("failed");
    expect(five.observed).toContain("503");
    expect(five.observed).not.toContain("404");
    const four = evaluateCheck({ check: "no-http-4xx" }, reading({ requests }));
    expect(four.observed).toContain("404");
    expect(verdict({ check: "no-http-5xx" }, { requests: [] })).toBe("passed");
    expect(verdict({ check: "no-http-4xx" }, { requests: [] })).toBe("passed");
  });
});

describe("vitals and accessibility", () => {
  const vitals = (over: Partial<NonNullable<PageReading["vitals"]>>) => ({
    lcp: null, cls: null, ttfb: null, fcp: null, inp: null, ...over,
  });

  it("compares LCP and CLS against the budget", () => {
    expect(verdict({ check: "lcp-below", value: 2500 }, { vitals: vitals({ lcp: 1800 }) })).toBe("passed");
    expect(verdict({ check: "lcp-below", value: 2500 }, { vitals: vitals({ lcp: 5100 }) })).toBe("failed");
    expect(verdict({ check: "cls-below", value: 0.1 }, { vitals: vitals({ cls: 0 }) })).toBe("passed");
    expect(verdict({ check: "cls-below", value: 0.1 }, { vitals: vitals({ cls: 0.4 }) })).toBe("failed");
  });

  it("compares INP against the budget", () => {
    expect(verdict({ check: "inp-below", value: 200 }, { vitals: vitals({ inp: 120 }) })).toBe("passed");
    expect(verdict({ check: "inp-below", value: 200 }, { vitals: vitals({ inp: 340 }) })).toBe("failed");
  });

  it("reports an unmeasured INP as unreadable, and says the journey probably never interacted", () => {
    // Not a pass: a responsiveness budget met by never touching anything is the
    // emptiest green tick available. Not a fail either — that blames the site for
    // the journey's step ordering. Unlike LCP, a null INP is usually the journey's
    // fault, so the reason names the fix.
    const result = evaluateCheck({ check: "inp-below", value: 200 }, reading({ vitals: vitals({}) }));
    expect(result.verdict).toBe("unreadable");
    // The reason names BOTH causes, because they need different actions: move the
    // check after an interaction, or accept that the page responds too fast to
    // measure. Only the first is the journey's fault.
    expect(result.observed).toContain("no interaction entry was reported");
    expect(result.observed).toContain("AFTER a click, press, fill or scroll");
    expect(result.observed).toContain("a fact about the page, not a failed read");
  });

  it("asks only for vitals", () => {
    expect(checkNeeds({ check: "inp-below", value: 200 })).toEqual(["vitals"]);
  });

  it("treats an unmeasured metric as unreadable even when the vitals object exists", () => {
    // The trap: `vitals` came back, but `lcp` inside it is null. Reading that
    // as 0 would score an unmeasured page as the fastest possible.
    expect(verdict({ check: "lcp-below", value: 2500 }, { vitals: vitals({}) })).toBe("unreadable");
    expect(verdict({ check: "cls-below", value: 0.1 }, { vitals: vitals({}) })).toBe("unreadable");
  });

  it("no-a11y-critical counts only critical impact", () => {
    const a11y = [
      { id: "landmark-one-main", impact: "moderate", help: "h", nodes: 1 },
      { id: "color-contrast", impact: "critical", help: "h", nodes: 3 },
    ];
    const failed = evaluateCheck({ check: "no-a11y-critical" }, reading({ a11y }));
    expect(failed.verdict).toBe("failed");
    expect(failed.observed).toBe("color-contrast");
    expect(verdict({ check: "no-a11y-critical" }, { a11y: [a11y[0]!] })).toBe("passed");
  });
});

describe("describeCheck", () => {
  it("renders expected and observed on one line", () => {
    const check: Check = { check: "title-exists" };
    const line = describeCheck(check, evaluateCheck(check, reading({ title: "T" })));
    expect(line).toBe('title-exists: expected a non-empty <title>, observed "T"');
  });
});

describe("a check whose variable was never supplied", () => {
  // `resolveSteps` leaves an unfilled placeholder INTACT rather than blanking it (R-11), which
  // is right for `open` and produces two different lies inside an assert.

  it("REFUSES rather than filing a site finding for a variable the operator forgot", () => {
    const result = evaluateCheck(
      { check: "text-contains", selector: "html", value: "{expectLanguageMarker}" },
      reading({ text: "Vi bygger saksbehandlingssystemer" }),
    );
    expect(result.verdict).toBe("unreadable");
    expect(result.observed).toContain("expectLanguageMarker");
    expect(result.observed).toContain("--var");
  });

  it("REFUSES the absent-check too, which would otherwise pass VACUOUSLY", () => {
    // The dangerous half. "Does the body lack the literal string {forbiddenCurrency}?" is true
    // of every page on earth, so this check went green having verified nothing — and unlike a
    // false FAIL, nobody ever looks at it.
    const result = evaluateCheck(
      { check: "text-absent", selector: "body", value: "{forbiddenCurrency}" },
      reading({ text: "kr 1 200 per måned" }),
    );
    expect(result.verdict).not.toBe("passed");
    expect(result.verdict).toBe("unreadable");
  });

  it("applies to every check carrying a value, not just the text pair", () => {
    expect(evaluateCheck({ check: "title-contains", value: "{brand}" }, reading({ title: "Xala" })).verdict).toBe("unreadable");
  });

  it("does NOT catch a value that merely contains braces", () => {
    // A JSON blob or a template literal in real copy is not an unfilled variable, and refusing
    // it would replace a false failure with a false refusal. Only `{word}` — the one shape
    // substitution would have filled.
    const result = evaluateCheck(
      { check: "text-contains", selector: "body", value: "{ }" },
      reading({ text: "a { } b" }),
    );
    expect(result.verdict).toBe("passed");
  });
});

describe("a page that rendered no text at all", () => {
  it("is UNREADABLE, not a failed site check", () => {
    // Zero characters is a reading about whether anything rendered, not about what the page
    // contains. On a client-rendered site the shell is attached before a single character
    // exists — measured on xala.no: 0 chars at load, 6,077 one second later — and the engine
    // filed "0 chars read" as a high-severity site defect against a correct page.
    const result = evaluateCheck({ check: "text-contains", selector: "html", value: "nb-NO" }, reading({ text: "" }));
    expect(result.verdict).toBe("unreadable");
    expect(result.observed).toContain("0 characters rendered");
  });

  it("cannot pass an absent-check by vacuity either", () => {
    // An empty page trivially lacks every string, so this went green on a page that rendered
    // nothing — the same false PASS as an unfilled placeholder, from a different direction.
    expect(evaluateCheck({ check: "text-absent", selector: "body", value: "USD" }, reading({ text: "" })).verdict).toBe("unreadable");
  });

  it("still judges a page that rendered SOMETHING and lacks the value", () => {
    // The line that matters: a real reading that simply does not contain the value is a real
    // site finding, and softening it would hide the defects this check exists to catch.
    expect(evaluateCheck({ check: "text-contains", selector: "body", value: "nb-NO" }, reading({ text: "hello" })).verdict).toBe("failed");
  });
});
