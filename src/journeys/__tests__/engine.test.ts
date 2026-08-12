import { describe, expect, it, vi } from "vitest";
import type { BrowserResult, BrowserRuntime } from "../../browser/types.js";
import { gatherReading, runJourney, verdictFor, type StepResult } from "../engine.js";
import type { Check, Journey, Step } from "../spec.js";

const meta = { stdout: "", stderr: "", durationMs: 1, command: "c" };
const ok = <T,>(data: T): BrowserResult<T> => ({ ok: true, data, ...meta });
const bad = <T,>(kind = "exit"): BrowserResult<T> => ({
  ok: false,
  failure: { kind: kind as never, detail: "nope", exitCode: 1, signal: null },
  ...meta,
});

const nav = ok({ url: "https://x", title: "T", targetId: "t", launchHash: null, browserLaunched: false });

/** Everything succeeds and the page is healthy, unless overridden. */
function runtime(over: Partial<BrowserRuntime> = {}): BrowserRuntime {
  return {
    sessionId: "s",
    open: () => Promise.resolve(nav),
    reload: () => Promise.resolve(nav),
    getTitle: () => Promise.resolve(ok("Digilist")),
    getUrl: () => Promise.resolve(ok("https://digilist.no/")),
    getText: () => Promise.resolve(ok("body text")),
    isVisible: () => Promise.resolve(ok(true)),
    count: () => Promise.resolve(ok(9)),
    console: () => Promise.resolve(ok([])),
    errors: () => Promise.resolve(ok([])),
    networkRequests: () => Promise.resolve(ok([])),
    vitals: () => Promise.resolve(ok({ lcp: 900, cls: 0, ttfb: 10, fcp: 40, inp: null })),
    a11y: () => Promise.resolve(ok([])),
    snapshot: () => Promise.resolve(ok("- heading")),
    screenshot: () => Promise.resolve(ok(null)),
    click: () => Promise.resolve(ok(null)),
    scroll: () => Promise.resolve(ok(null)),
    waitFor: () => Promise.resolve(ok(null)),
    evaluate: <T,>() => Promise.resolve(ok(null as T)),
    harStart: () => Promise.resolve(ok(null)),
    harStop: () => Promise.resolve(ok(null)),
    traceStart: () => Promise.resolve(ok(null)),
    traceStop: () => Promise.resolve(ok(null)),
    close: () => Promise.resolve(ok(null)),
    ...over,
  } as BrowserRuntime;
}

const journey = (steps: Step[]): Journey => ({ id: "j", title: "J", description: "", steps });
const assertStep = (spec: Check, severity: Step extends { severity: infer S } ? S : never = "high" as never): Step => ({
  action: "assert",
  severity,
  spec,
});
const opts = { screenshotDir: "/e" };

describe("gatherReading", () => {
  it("fetches only what the check needs", async () => {
    const getTitle = vi.fn(() => Promise.resolve(ok("T")));
    const vitals = vi.fn(() => Promise.resolve(ok({ lcp: 1, cls: 1, ttfb: 1, fcp: 1, inp: 1 })));
    const r = runtime({ getTitle, vitals });
    await gatherReading(r, { check: "title-exists" }, null);
    expect(getTitle).toHaveBeenCalledTimes(1);
    expect(vitals).not.toHaveBeenCalled();
  });

  it("reads each source for its own check kind", async () => {
    const r = runtime();
    expect((await gatherReading(r, { check: "url-matches", value: "x" }, null)).url).toBe("https://digilist.no/");
    expect((await gatherReading(r, { check: "text-contains", selector: "body", value: "x" }, "body")).text).toBe("body text");
    expect((await gatherReading(r, { check: "selector-visible", selector: "h1" }, "h1")).visible).toBe(true);
    expect((await gatherReading(r, { check: "selector-count-min", selector: "a", value: 1 }, "a")).count).toBe(9);
    expect((await gatherReading(r, { check: "no-console-errors" }, null)).console).toEqual([]);
    expect((await gatherReading(r, { check: "no-page-errors" }, null)).pageErrors).toEqual([]);
    expect((await gatherReading(r, { check: "no-http-5xx" }, null)).requests).toEqual([]);
    expect((await gatherReading(r, { check: "lcp-below", value: 1 }, null)).vitals).toMatchObject({ lcp: 900 });
    expect((await gatherReading(r, { check: "no-a11y-critical" }, null)).a11y).toEqual([]);
  });

  it("leaves a reading NULL when the browser call failed", async () => {
    const r = runtime({ console: () => Promise.resolve(bad()) });
    expect((await gatherReading(r, { check: "no-console-errors" }, null)).console).toBeNull();
  });

  it("leaves selector readings null when the check carries no selector", async () => {
    const r = runtime();
    const out = await gatherReading(r, { check: "text-contains", selector: "body", value: "x" }, null);
    expect(out.text).toBeNull();
  });
});

describe("runJourney", () => {
  it("passes a healthy page", async () => {
    const result = await runJourney(
      runtime(),
      journey([{ action: "open", url: "https://x" }, assertStep({ check: "title-exists" })]),
      opts,
    );
    expect(result.verdict).toBe("PASS");
    expect(result.counts).toMatchObject({ passed: 2, failed: 0, errored: 0, skipped: 0 });
  });

  it("collects EVERY assertion failure in one pass rather than stopping at the first", async () => {
    const result = await runJourney(
      runtime({ getTitle: () => Promise.resolve(ok("")), isVisible: () => Promise.resolve(ok(false)) }),
      journey([
        assertStep({ check: "title-exists" }),
        assertStep({ check: "selector-visible", selector: "h1" }),
        assertStep({ check: "selector-count-min", selector: "a", value: 100 }),
      ]),
      opts,
    );
    expect(result.counts.failed).toBe(3);
    expect(result.counts.skipped).toBe(0);
  });

  it("HALTS after a failed state-changing step and marks the rest skipped, not passed", async () => {
    const result = await runJourney(
      runtime({ open: () => Promise.resolve(bad()) }),
      journey([
        { action: "open", url: "https://x" },
        assertStep({ check: "title-exists" }),
        assertStep({ check: "no-console-errors" }),
      ]),
      opts,
    );
    expect(result.counts).toMatchObject({ errored: 1, skipped: 2, passed: 0, failed: 0 });
    expect(result.steps[1]?.detail).toContain("would measure nothing");
    expect(result.verdict).toBe("ERROR");
  });

  it("does NOT halt when a screenshot or snapshot fails — that costs evidence, not the run", async () => {
    const result = await runJourney(
      runtime({ screenshot: () => Promise.resolve(bad()), snapshot: () => Promise.resolve(bad()) }),
      journey([
        { action: "screenshot", label: "hero", fullPage: false },
        { action: "snapshot", label: "tree" },
        assertStep({ check: "title-exists" }),
      ]),
      opts,
    );
    expect(result.counts).toMatchObject({ errored: 2, passed: 1, skipped: 0 });
    expect(result.steps[0]?.severity).toBe("low");
  });

  it("records a screenshot label even when the capture failed, so the gap is visible", async () => {
    const result = await runJourney(
      runtime({ screenshot: () => Promise.resolve(bad()) }),
      journey([{ action: "screenshot", label: "hero", fullPage: false }]),
      opts,
    );
    expect(result.screenshots).toEqual(["hero"]);
  });

  it("writes screenshots into the configured directory, honouring fullPage", async () => {
    const shots: [string, unknown][] = [];
    await runJourney(
      runtime({
        screenshot: (p, o) => {
          shots.push([p, o]);
          return Promise.resolve(ok(null));
        },
      }),
      journey([{ action: "screenshot", label: "hero", fullPage: true }]),
      { screenshotDir: "/evidence/run1" },
    );
    expect(shots).toEqual([["/evidence/run1/hero.png", { fullPage: true }]]);
  });

  it("issues each interaction action, passing scroll pixels only when set", async () => {
    const scrolls: unknown[][] = [];
    await runJourney(
      runtime({
        scroll: (d, px) => {
          scrolls.push([d, px]);
          return Promise.resolve(ok(null));
        },
      }),
      journey([
        { action: "reload" },
        { action: "click", selector: "@e1" },
        { action: "scroll", direction: "down", px: 800 },
        { action: "scroll", direction: "up" },
        { action: "wait", target: "500" },
      ]),
      opts,
    );
    expect(scrolls).toEqual([["down", 800], ["up", undefined]]);
  });

  it("reports an unreadable assertion as ERRORED, not failed", async () => {
    // The rule the whole engine exists to protect: our blindness is not the
    // site's defect.
    const result = await runJourney(
      runtime({ console: () => Promise.resolve(bad()) }),
      journey([assertStep({ check: "no-console-errors" })]),
      opts,
    );
    expect(result.counts).toMatchObject({ errored: 1, failed: 0 });
    expect(result.verdict).toBe("ERROR");
  });

  it("labels steps from the label, the check name, or the action index", async () => {
    const result = await runJourney(
      runtime(),
      journey([
        { action: "open", url: "https://x", label: "go" },
        assertStep({ check: "title-exists" }),
        { action: "reload" },
      ]),
      opts,
    );
    expect(result.steps.map((s) => s.label)).toEqual(["go", "title-exists", "reload#2"]);
  });

  it("logs a line per step when a logger is given, and works without one", async () => {
    const lines: string[] = [];
    await runJourney(
      runtime({ getTitle: () => Promise.resolve(ok("")) }),
      journey([{ action: "reload" }, assertStep({ check: "title-exists" }), { action: "open", url: "x" }]),
      { ...opts, log: (l) => lines.push(l) },
    );
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).toContain("✗");
    await expect(runJourney(runtime(), journey([{ action: "reload" }]), opts)).resolves.toBeTruthy();
  });

  it("measures durations from an injectable clock", async () => {
    let t = 0;
    const result = await runJourney(runtime(), journey([{ action: "reload" }]), {
      ...opts,
      now: () => (t += 10),
    });
    expect(result.durationMs).toBeGreaterThan(0);
  });
});

describe("verdictFor", () => {
  const step = (outcome: StepResult["outcome"], severity = "high"): StepResult => ({
    index: 0, action: "assert", label: "l", outcome, severity,
    category: null, check: null,
    detail: "", expected: null, observed: null, durationMs: 0,
  });

  it("is PASS when everything passed", () => {
    expect(verdictFor([step("passed")])).toBe("PASS");
    expect(verdictFor([])).toBe("PASS");
  });

  it("is FAIL for a critical or high failure", () => {
    expect(verdictFor([step("failed", "critical")])).toBe("FAIL");
    expect(verdictFor([step("failed", "high")])).toBe("FAIL");
  });

  it("is PASS_WITH_WARNINGS for medium and below", () => {
    expect(verdictFor([step("failed", "medium")])).toBe("PASS_WITH_WARNINGS");
    expect(verdictFor([step("failed", "low")])).toBe("PASS_WITH_WARNINGS");
  });

  it("lets ERROR outrank FAIL — 'we do not know' is not 'the page is broken'", () => {
    expect(verdictFor([step("failed", "critical"), step("errored")])).toBe("ERROR");
  });

  it("ignores skipped steps", () => {
    expect(verdictFor([step("passed"), step("skipped")])).toBe("PASS");
  });
});
