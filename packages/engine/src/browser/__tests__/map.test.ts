/**
 * Fixtures here are VERBATIM payloads from agent-browser 0.34.0, captured by
 * running the real commands during EXP-000. If the CLI changes shape, these
 * fail — which is the point.
 */
import { describe, expect, it } from "vitest";
import {
  asMetric,
  asNumber,
  asRecord,
  asRecordArray,
  asString,
  criticalConsoleErrors,
  toA11yViolations,
  toBrowserLaunched,
  toConsoleMessages,
  toCount,
  toLaunchHash,
  toNavigateResult,
  toNetworkRequests,
  toPageErrors,
  toSnapshot,
  toText,
  toVisible,
  toVitals,
} from "../map.js";

const LIFECYCLE = {
  effectiveLaunch: { browserLaunched: true, engine: "chrome", launchHash: 12798390076057945372 },
  launched: false,
  reused: true,
};

describe("narrowing helpers", () => {
  it("asRecord accepts plain objects and rejects arrays, null and primitives", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord("x")).toBeNull();
  });

  it("asNumber rejects NaN, Infinity and numeric strings", () => {
    expect(asNumber(1.5)).toBe(1.5);
    expect(asNumber(0)).toBe(0);
    expect(asNumber(NaN)).toBeNull();
    expect(asNumber(Infinity)).toBeNull();
    expect(asNumber("3")).toBeNull();
  });

  it("asString accepts only strings", () => {
    expect(asString("a")).toBe("a");
    expect(asString(3)).toBeNull();
  });

  it("asRecordArray returns [] for a missing key, a non-array, or a bad root", () => {
    expect(asRecordArray({ xs: [{ a: 1 }, "junk", null] }, "xs")).toEqual([{ a: 1 }]);
    expect(asRecordArray({ xs: "no" }, "xs")).toEqual([]);
    expect(asRecordArray(null, "xs")).toEqual([]);
  });

  it("asMetric flattens both the bare-number and nested-object forms", () => {
    expect(asMetric(44, "startTime")).toBe(44);
    expect(asMetric({ startTime: 44, size: 13446 }, "startTime")).toBe(44);
    expect(asMetric({ other: 1 }, "startTime")).toBeNull();
    expect(asMetric(null, "startTime")).toBeNull();
  });
});

describe("lifecycle", () => {
  it("stringifies launchHash, which JSON.parse has already rounded past 2^53", () => {
    expect(toLaunchHash({ lifecycle: LIFECYCLE })).toBe("12798390076057946000");
  });

  it("reports a null hash rather than inventing one", () => {
    expect(toLaunchHash({})).toBeNull();
    expect(toLaunchHash({ lifecycle: { effectiveLaunch: { launchHash: null } } })).toBeNull();
  });

  it("reads browserLaunched strictly", () => {
    expect(toBrowserLaunched({ lifecycle: LIFECYCLE })).toBe(true);
    expect(toBrowserLaunched({ lifecycle: { effectiveLaunch: { browserLaunched: "yes" } } })).toBe(false);
    expect(toBrowserLaunched({})).toBe(false);
  });
});

describe("toNavigateResult", () => {
  it("maps a real `open` payload", () => {
    const data = {
      lifecycle: LIFECYCLE,
      targetId: "3DD7473CC9CC7950C5A45078D476B72C",
      title: "Example Domain",
      url: "https://example.com/",
    };
    expect(toNavigateResult(data)).toEqual({
      url: "https://example.com/",
      title: "Example Domain",
      targetId: "3DD7473CC9CC7950C5A45078D476B72C",
      launchHash: "12798390076057946000",
      browserLaunched: true,
    });
  });

  it("degrades to empty strings, never to undefined fields", () => {
    expect(toNavigateResult(null)).toEqual({
      url: "", title: "", targetId: "", launchHash: null, browserLaunched: false,
    });
  });
});

describe("simple readers", () => {
  it("toText reads the default and a named key", () => {
    expect(toText({ origin: "https://example.com/", text: "Example Domain" })).toBe("Example Domain");
    expect(toText({ result: "42" }, "result")).toBe("42");
    expect(toText({})).toBe("");
  });

  it("toCount reads a real `get count` payload and defaults to 0", () => {
    expect(toCount({ count: 2, selector: "p" })).toBe(2);
    expect(toCount({})).toBe(0);
  });

  it("toVisible is strict about true", () => {
    expect(toVisible({ visible: true })).toBe(true);
    expect(toVisible({ visible: "true" })).toBe(false);
  });

  it("toSnapshot reads the rendered tree", () => {
    expect(toSnapshot({ snapshot: '- heading "Example Domain" [level=1, ref=e1]' })).toContain("heading");
    expect(toSnapshot({})).toBe("");
  });
});

describe("toConsoleMessages", () => {
  it("maps a real `console` payload", () => {
    const data = {
      lifecycle: LIFECYCLE,
      messages: [
        { args: [{ type: "string", value: "hello" }], text: "hello", type: "log" },
        { args: [{ type: "string", value: "warned" }], text: "warned", type: "warning" },
      ],
    };
    expect(toConsoleMessages(data)).toEqual([
      { type: "log", text: "hello" },
      { type: "warning", text: "warned" },
    ]);
  });

  it("defaults a missing type to log and a missing text to empty", () => {
    expect(toConsoleMessages({ messages: [{}] })).toEqual([{ type: "log", text: "" }]);
  });
});

describe("toPageErrors", () => {
  it("maps a real `errors` payload", () => {
    const data = {
      errors: [{ column: 66, line: 0, text: "Error: boom\n    at <anonymous>:1:67", url: null }],
      lifecycle: LIFECYCLE,
    };
    expect(toPageErrors(data)).toEqual([{ message: "Error: boom\n    at <anonymous>:1:67", stack: null }]);
  });

  it("defaults a missing message to empty", () => {
    expect(toPageErrors({ errors: [{ url: "u" }] })).toEqual([{ message: "", stack: "u" }]);
  });
});

describe("toNetworkRequests", () => {
  it("maps a real `network requests` entry", () => {
    const data = {
      requests: [{ method: "GET", mimeType: "text/html", resourceType: "Document", url: "https://example.com/", status: 200 }],
    };
    expect(toNetworkRequests(data)).toEqual([
      { url: "https://example.com/", method: "GET", status: 200, resourceType: "Document" },
    ]);
  });

  it("keeps an unread status as null, not 0", () => {
    expect(toNetworkRequests({ requests: [{}] })).toEqual([
      { url: "", method: "", status: null, resourceType: null },
    ]);
  });
});

describe("toVitals", () => {
  it("flattens a real `vitals` payload", () => {
    const data = {
      cls: { entries: [], score: 0.0 },
      fcp: 44.0,
      inp: null,
      lcp: { element: "p", size: 13446, startTime: 44, url: null },
      ttfb: 7.6,
      url: "https://example.com/",
    };
    expect(toVitals(data)).toEqual({ lcp: 44, cls: 0, ttfb: 7.6, fcp: 44, inp: null });
  });

  it("keeps an unmeasured metric null rather than reporting a good zero", () => {
    // The whole point: `inp: null` must not become `inp: 0`, which would read
    // as a perfect interaction score for a page we never interacted with.
    expect(toVitals({}).inp).toBeNull();
    expect(toVitals(null)).toEqual({ lcp: null, cls: null, ttfb: null, fcp: null, inp: null });
  });
});

describe("toA11yViolations", () => {
  it("maps a real `a11y` violation", () => {
    const data = {
      axeVersion: "4.12.1",
      counts: { violations: 2 },
      violations: [
        { help: "Document should have one main landmark", id: "landmark-one-main", impact: "moderate", nodeCount: 1 },
      ],
    };
    expect(toA11yViolations(data)).toEqual([
      { id: "landmark-one-main", impact: "moderate", help: "Document should have one main landmark", nodes: 1 },
    ]);
  });

  it("defaults missing fields without dropping the violation", () => {
    expect(toA11yViolations({ violations: [{}] })).toEqual([{ id: "", impact: null, help: "", nodes: 0 }]);
  });
});

describe("criticalConsoleErrors", () => {
  it("keeps errors and drops warnings and logs", () => {
    const msgs = [
      { type: "error", text: "bad" },
      { type: "warning", text: "deprecated" },
      { type: "log", text: "hi" },
    ];
    expect(criticalConsoleErrors(msgs)).toEqual([{ type: "error", text: "bad" }]);
  });
});
