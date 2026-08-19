import { describe, expect, it, vi } from "vitest";
import type { BrowserResult, BrowserRuntime } from "../../browser/types.js";
import { findingsFromSteps } from "../../findings/classify.js";
import {
  countOutcomes,
  describeAction,
  gatherReading,
  mergeAttempts,
  runJourney,
  verdictFor,
  withExtraStep,
  type JourneyResult,
  type StepResult,
} from "../engine.js";
import type { Check, Journey, Step, StepAction } from "../spec.js";

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
    visibleCount: () => Promise.resolve(ok(1)),
    count: () => Promise.resolve(ok(9)),
    console: () => Promise.resolve(ok([])),
    errors: () => Promise.resolve(ok([])),
    networkRequests: () => Promise.resolve(ok([])),
    vitals: () => Promise.resolve(ok({ lcp: 900, cls: 0, ttfb: 10, fcp: 40, inp: null })),
    a11y: () => Promise.resolve(ok([])),
    snapshot: () => Promise.resolve(ok("- heading")),
    screenshot: () => Promise.resolve(ok(null)),
    click: () => Promise.resolve(ok(null)),
    fill: () => Promise.resolve(ok(null)),
    press: () => Promise.resolve(ok(null)),
    select: () => Promise.resolve(ok(null)),
    check: () => Promise.resolve(ok(null)),
    pinch: () => Promise.resolve(ok(null)),
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

/** Every step defaults to probability 1, so existing tests stay deterministic. */
const journey = (steps: StepAction[], over: Partial<Journey> = {}): Journey => ({
  id: "j",
  title: "J",
  description: "",
  writes: false,
  steps: steps.map((s) => ({ ...s, probability: 1 })),
  ...over,
});
const assertStep = (spec: Check, severity: "critical" | "high" | "medium" | "low" | "info" = "high"): StepAction => ({
  action: "assert",
  severity,
  spec,
});
const opts = { screenshotDir: "/e", afterNavigateMs: 0 };

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

  it("RE-READS vitals once when the metric this check needs came back null", async () => {
    // Found live: the homepage reported "LCP was not measured" on 3 of 3 runs
    // while the evidence written seconds later in the same run recorded
    // lcp: 104. LCP is emitted asynchronously; an early read simply misses it.
    let call = 0;
    const waits: string[] = [];
    const r = runtime({
      vitals: () => {
        call++;
        return Promise.resolve(ok({ lcp: call === 1 ? null : 104, cls: 0.01, ttfb: 20, fcp: 80, inp: null }));
      },
      waitFor: (t) => {
        waits.push(t);
        return Promise.resolve(ok(null));
      },
    });
    const out = await gatherReading(r, { check: "lcp-below", value: 2500 }, null, 5);
    expect(call).toBe(2);
    expect(waits).toEqual(["5"]);
    expect(out.vitals?.lcp).toBe(104);
  });

  it("does NOT re-read when the needed metric arrived first time", async () => {
    let call = 0;
    const r = runtime({
      vitals: () => {
        call++;
        return Promise.resolve(ok({ lcp: 900, cls: null, ttfb: 20, fcp: 80, inp: null }));
      },
    });
    await gatherReading(r, { check: "lcp-below", value: 2500 }, null, 5);
    expect(call).toBe(1);
  });

  it("keeps a null that SURVIVES the re-read — a page can genuinely never emit one", async () => {
    const r = runtime({ vitals: () => Promise.resolve(ok({ lcp: null, cls: null, ttfb: null, fcp: null, inp: null })) });
    const out = await gatherReading(r, { check: "lcp-below", value: 2500 }, null, 5);
    expect(out.vitals?.lcp).toBeNull();
  });

  it("falls back to the first reading when the re-read fails outright", async () => {
    let call = 0;
    const r = runtime({
      vitals: () => {
        call++;
        return call === 1
          ? Promise.resolve(ok({ lcp: null, cls: 0.5, ttfb: 20, fcp: 80, inp: null }))
          : Promise.resolve(bad());
      },
    });
    const out = await gatherReading(r, { check: "lcp-below", value: 2500 }, null, 5);
    expect(out.vitals?.cls).toBe(0.5);
  });

  it("does not re-read for a check that does not depend on vitals", async () => {
    let call = 0;
    const r = runtime({
      vitals: () => {
        call++;
        return Promise.resolve(ok({ lcp: null, cls: null, ttfb: null, fcp: null, inp: null }));
      },
      a11y: () => Promise.resolve(ok([])),
    });
    await gatherReading(r, { check: "no-a11y-critical" }, null, 5);
    expect(call).toBe(0);
  });

  it("leaves selector readings null when the check carries no selector", async () => {
    const r = runtime();
    const out = await gatherReading(r, { check: "text-contains", selector: "body", value: "x" }, null);
    expect(out.text).toBeNull();
  });
});
describe("gatherReading: the attribute read", () => {
  // Through `evaluate`, not a new seam primitive. Both engines already implement it, so this
  // needs neither a `BrowserRuntime` method nor a refusal on the engine that lacks one — and
  // an attribute read has none of the timing subtlety that earned `getText` its own method.

  const check = { check: "attribute-contains" as const, selector: "html", attribute: "lang", value: "nb-NO" };

  it("returns the attribute's value", async () => {
    const r = runtime({ evaluate: <T,>() => Promise.resolve(ok(JSON.stringify({ found: true, value: "nb-NO" }) as unknown as T)) });
    expect((await gatherReading(r, check, "html")).attribute).toBe("nb-NO");
  });

  it("returns an EMPTY STRING when the element exists without the attribute", async () => {
    // A real reading of the page: `attribute-absent` is entitled to pass on it.
    const r = runtime({ evaluate: <T,>() => Promise.resolve(ok(JSON.stringify({ found: true, value: "" }) as unknown as T)) });
    expect((await gatherReading(r, check, "html")).attribute).toBe("");
  });

  it("returns NULL when the element is not there — that is not a reading", async () => {
    const r = runtime({ evaluate: <T,>() => Promise.resolve(ok(JSON.stringify({ found: false }) as unknown as T)) });
    expect((await gatherReading(r, check, "html")).attribute).toBeNull();
  });

  it("returns null rather than throwing when the expression fails or returns nonsense", async () => {
    const failed = runtime({ evaluate: <T,>() => Promise.resolve(bad<T>()) });
    expect((await gatherReading(failed, check, "html")).attribute).toBeNull();
    const garbage = runtime({ evaluate: <T,>() => Promise.resolve(ok("not json" as unknown as T)) });
    expect((await gatherReading(garbage, check, "html")).attribute).toBeNull();
    const wrongShape = runtime({ evaluate: <T,>() => Promise.resolve(ok(42 as unknown as T)) });
    expect((await gatherReading(wrongShape, check, "html")).attribute).toBeNull();
  });

  it("names BOTH the selector and the attribute in the expression it sends", async () => {
    // Serialised with JSON.stringify on both, so a selector carrying a quote cannot break out
    // of the expression — the same reason `CONTENT_EXPRESSION` returns a JSON string.
    let sent = "";
    const r = runtime({
      evaluate: <T,>(expr: string) => {
        sent = expr;
        return Promise.resolve(ok(JSON.stringify({ found: true, value: "x" }) as unknown as T));
      },
    });
    const tricky = 'a[title="hi"]';
    await gatherReading(r, { ...check, selector: tricky }, tricky);
    // Compared against JSON.stringify itself rather than a hand-escaped literal — the escaping
    // is the thing under test, and a hand-written expectation gets it wrong in the same
    // direction as a hand-written implementation would.
    expect(sent).toContain(JSON.stringify(tricky));
    expect(sent).toContain(JSON.stringify("lang"));
    // And the raw selector must NOT appear unescaped, or the quote closed the string early.
    expect(sent).not.toContain(`("${tricky}")`);
  });
});


describe("runJourney", () => {
  it("reports every recorded step to onStep, including ones that did not run", async () => {
    const seen: string[] = [];
    await runJourney(
      runtime(),
      {
        id: "j",
        title: "J",
        description: "",
        writes: false,
        steps: [
          { action: "open", url: "https://x", probability: 1 },
          { action: "pause", minMs: 1, maxMs: 1, probability: 0 },
          { ...assertStep({ check: "title-exists" }), probability: 1 },
        ],
      },
      { ...opts, onStep: (step) => { seen.push(`${step.outcome}:${step.action}`); } },
    );
    expect(seen).toEqual(["passed:open", "skipped:pause", "passed:assert"]);
  });

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

  it("captures a frame after open, click and scroll — a visit without pictures is not evidence", async () => {
    const shots: string[] = [];
    const result = await runJourney(
      runtime({
        screenshot: (p) => {
          shots.push(p);
          return Promise.resolve(ok(null));
        },
      }),
      journey([
        { action: "open", url: "https://digilist.no/", label: "open target" },
        assertStep({ check: "title-exists" }, "critical"),
        { action: "scroll", direction: "down", px: 800, label: "scroll" },
        { action: "click", selector: "main a", label: "click" },
        { action: "fill", selector: "#q", value: "secret" },
      ]),
      opts,
    );
    expect(result.screenshots).toEqual(["00-open-target", "01-title-exists", "02-scroll", "03-click"]);
    expect(shots).toEqual([
      "/e/00-open-target.png",
      "/e/01-title-exists.png",
      "/e/02-scroll.png",
      "/e/03-click.png",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("captures a frame after a failed assert — that is the page we judged", async () => {
    const shots: string[] = [];
    const result = await runJourney(
      runtime({
        getTitle: () => Promise.resolve(ok("")),
        screenshot: (p) => {
          shots.push(p);
          return Promise.resolve(ok(null));
        },
      }),
      journey([assertStep({ check: "title-exists" }, "critical")]),
      opts,
    );
    expect(result.steps[0]?.outcome).toBe("failed");
    expect(result.screenshots).toEqual(["00-title-exists"]);
    expect(shots).toEqual(["/e/00-title-exists.png"]);
  });

  it("does not invent a frame when the capture itself failed", async () => {
    const result = await runJourney(
      runtime({ screenshot: () => Promise.resolve(bad()) }),
      journey([{ action: "open", url: "https://digilist.no/" }]),
      opts,
    );
    expect(result.screenshots).toEqual([]);
    expect(result.steps[0]?.outcome).toBe("passed");
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

const step = (outcome: StepResult["outcome"], severity = "high"): StepResult => ({
  index: 0, action: "assert", label: "l", outcome, severity,
  category: null, check: null,
  detail: "", expected: null, observed: null, durationMs: 0,
});

describe("countOutcomes", () => {
  it("counts each outcome separately", () => {
    const counts = countOutcomes([
      step("passed"),
      step("passed"),
      step("failed", "high"),
      step("errored"),
      step("skipped"),
    ]);
    expect(counts).toEqual({ passed: 2, failed: 1, errored: 1, skipped: 1 });
  });
});

describe("withExtraStep", () => {
  const base = {
    journeyId: "j",
    verdict: "PASS" as const,
    steps: [step("passed"), step("passed")],
    counts: { passed: 2, failed: 0, errored: 0, skipped: 0 },
    screenshots: ["hero"],
    durationMs: 10,
    writes: false,
    seed: 7,
    touchedForm: false,
  };

  it("appends a whole-run check and re-derives the verdict from it", () => {
    // The point of recomputing rather than patching: a check whose answer only
    // exists after the last step gets the same consequences as any other, with
    // no second verdict system growing beside verdictFor.
    const out = withExtraStep(base, step("errored"));
    expect(out.steps).toHaveLength(3);
    expect(out.counts).toEqual({ passed: 2, failed: 0, errored: 1, skipped: 0 });
    expect(out.verdict).toBe("ERROR");
  });

  it("leaves a passing run passing, and keeps everything else intact", () => {
    const out = withExtraStep(base, step("passed"));
    expect(out.verdict).toBe("PASS");
    expect(out.counts.passed).toBe(3);
    expect(out.screenshots).toEqual(["hero"]);
    expect(out.journeyId).toBe("j");
    expect(out.durationMs).toBe(10);
  });

  it("does not mutate the result it was given", () => {
    withExtraStep(base, step("errored"));
    expect(base.steps).toHaveLength(2);
    expect(base.verdict).toBe("PASS");
  });
});

describe("input steps", () => {
  it("drives fill, press, select and check through the runtime", async () => {
    const calls: string[] = [];
    const r = runtime({
      fill: (sel, value) => {
        calls.push(`fill:${sel}:${value}`);
        return Promise.resolve(ok(null));
      },
      press: (key) => {
        calls.push(`press:${key}`);
        return Promise.resolve(ok(null));
      },
      select: (sel, values) => {
        calls.push(`select:${sel}:${values.join("|")}`);
        return Promise.resolve(ok(null));
      },
      check: (sel) => {
        calls.push(`check:${sel}`);
        return Promise.resolve(ok(null));
      },
    });
    const result = await runJourney(
      r,
      journey([
        { action: "fill", selector: "#email", value: "qa@example.test" },
        { action: "press", key: "Enter" },
        { action: "select", selector: "#topic", values: ["support"] },
        { action: "check", selector: "#consent" },
      ]),
      opts,
    );
    expect(result.verdict).toBe("PASS");
    expect(calls).toEqual([
      "fill:#email:qa@example.test",
      "press:Enter",
      "select:#topic:support",
      "check:#consent",
    ]);
  });

  it("receive-otp fills the code and NEVER records it", async () => {
    const filled: string[] = [];
    const after: number[] = [];
    const result = await runJourney(
      runtime({
        fill: (sel, value) => {
          filled.push(`${sel}:${value}`);
          return Promise.resolve(ok(null));
        },
      }),
      journey([
        { action: "click", selector: "[data-testid=login-email-submit]" },
        { action: "receive-otp", selector: "#otp" },
      ]),
      {
        ...opts,
        now: (() => {
          let t = 1_000;
          return () => (t += 10);
        })(),
        receiveOtp: (input) => {
          after.push(input.afterMs);
          return Promise.resolve({ ok: true, code: "482913" });
        },
      },
    );
    expect(result.verdict).toBe("PASS");
    expect(filled).toEqual(["#otp:482913"]);
    expect(JSON.stringify(result)).not.toContain("482913");
    expect(result.steps[1]?.detail).toBe("receive-otp #otp ok (value not recorded)");
    expect(result.touchedForm).toBe(true);
    expect(after[0]).toBeGreaterThan(0);
  });

  it("receive-otp without a mailbox is OUR defect, not a missing field on the page", async () => {
    const result = await runJourney(runtime(), journey([{ action: "receive-otp", selector: "#otp" }]), opts);
    expect(result.verdict).toBe("ERROR");
    expect(result.steps[0]?.outcome).toBe("errored");
    expect(result.steps[0]?.category).toBe("instrumentation");
    expect(result.steps[0]?.detail).toContain("no mailbox");
  });

  it("receive-otp that cannot read a code is instrumentation, not a site finding", async () => {
    const result = await runJourney(runtime(), journey([{ action: "receive-otp", selector: "#otp" }]), {
      ...opts,
      receiveOtp: () => Promise.resolve({ ok: false, detail: "no login code arrived" }),
    });
    expect(result.verdict).toBe("ERROR");
    expect(result.steps[0]?.category).toBe("instrumentation");
    expect(result.steps[0]?.detail).toContain("no login code");
  });

  it("NEVER records what was typed — the rule that makes login journeys safe", async () => {
    const result = await runJourney(
      runtime(),
      journey([{ action: "fill", selector: "#password", value: "hunter2-the-real-one" }]),
      opts,
    );
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("hunter2-the-real-one");
    expect(result.steps[0]?.detail).toBe("fill #password ok (value not recorded)");
  });

  it("does not record selected option values either", async () => {
    const result = await runJourney(
      runtime(),
      journey([{ action: "select", selector: "#plan", values: ["secret-tier"] }]),
      opts,
    );
    expect(JSON.stringify(result)).not.toContain("secret-tier");
    expect(result.steps[0]?.detail).toContain("1 value(s), not recorded");
  });

  it("names WHERE a click, open or scroll acted — 'click ok' is not a report", () => {
    // A run detail that says "click ok" cannot answer "what did it click". The selector
    // is not a secret; the filled value is. Same for the URL an open used and the
    // direction a scroll took — those are the journey, and the evidence has to say them.
    expect(describeAction({ action: "click", selector: "#results a, .result", probability: 1 })).toBe(
      "click #results a, .result ok",
    );
    expect(describeAction({ action: "open", url: "https://digilist.no/", probability: 1 })).toBe(
      "open https://digilist.no/ ok",
    );
    expect(describeAction({ action: "scroll", direction: "down", px: 800, probability: 1 })).toBe("scroll down 800px ok");
    expect(describeAction({ action: "screenshot", label: "landing", fullPage: false, probability: 1 })).toBe(
      "screenshot landing ok",
    );
    expect(describeAction({ action: "snapshot", label: "tree", probability: 1 })).toBe("snapshot tree ok");
  });

  it("still never puts a fill value in the description", () => {
    expect(describeAction({ action: "fill", selector: "#password", value: "hunter2", probability: 1 })).toBe(
      "fill #password ok (value not recorded)",
    );
    expect(describeAction({ action: "receive-otp", selector: "#otp", probability: 1 })).toBe(
      "receive-otp #otp ok (value not recorded)",
    );
    expect(describeAction({ action: "pinch", selector: ".map", direction: "in", probability: 1 })).toBe(
      "pinch in .map ok",
    );
  });

  it("reports which controls a run touched, so screenshots can be flagged", async () => {
    const touched = await runJourney(runtime(), journey([{ action: "fill", selector: "#a", value: "x" }]), opts);
    expect(touched.touchedForm).toBe(true);
    const readOnly = await runJourney(runtime(), journey([{ action: "reload" }]), opts);
    expect(readOnly.touchedForm).toBe(false);
  });

  it("treats a failed fill as fatal — the rest of a form would measure nothing", async () => {
    const result = await runJourney(
      runtime({ fill: () => Promise.resolve(bad()) }),
      journey([
        { action: "fill", selector: "#email", value: "x" },
        { action: "click", selector: "#send" },
      ]),
      opts,
    );
    expect(result.verdict).toBe("ERROR");
    expect(result.steps[0]?.outcome).toBe("errored");
    expect(result.steps[1]?.outcome).toBe("skipped");
  });

  it("carries the journey's writes declaration onto the result", async () => {
    const result = await runJourney(runtime(), journey([{ action: "reload" }], { writes: true }), opts);
    expect(result.writes).toBe(true);
  });
});

describe("human pacing", () => {
  it("pauses for a seeded length inside the declared range", async () => {
    const waits: string[] = [];
    const r = runtime({
      waitFor: (t) => {
        waits.push(t);
        return Promise.resolve(ok(null));
      },
    });
    await runJourney(r, journey([{ action: "pause", minMs: 1_200, maxMs: 3_500 }]), { ...opts, seed: 42 });
    expect(waits).toHaveLength(1);
    const ms = Number(waits[0]);
    expect(ms).toBeGreaterThanOrEqual(1_200);
    expect(ms).toBeLessThanOrEqual(3_500);
  });

  it("is REPRODUCIBLE for a given seed, and different without one", async () => {
    const pauses = async (seed?: number): Promise<string[]> => {
      const waits: string[] = [];
      const r = runtime({
        waitFor: (t) => {
          waits.push(t);
          return Promise.resolve(ok(null));
        },
      });
      await runJourney(
        r,
        journey([
          { action: "pause", minMs: 500, maxMs: 5_000 },
          { action: "pause", minMs: 500, maxMs: 5_000 },
        ]),
        seed === undefined ? opts : { ...opts, seed },
      );
      return waits;
    };
    expect(await pauses(7)).toEqual(await pauses(7));
    expect(await pauses(7)).not.toEqual(await pauses(8));
  });

  it("records the seed it used, so a run can be replayed from its evidence", async () => {
    const result = await runJourney(runtime(), journey([{ action: "reload" }]), { ...opts, seed: 4242 });
    expect(result.seed).toBe(4242);
  });

  it("derives a seed from the journey id when none is given", async () => {
    const result = await runJourney(runtime(), journey([{ action: "reload" }]), opts);
    expect(typeof result.seed).toBe("number");
    expect(result.seed).toBeGreaterThanOrEqual(0);
  });
});

describe("optional steps", () => {
  /** A journey whose steps carry explicit probabilities. */
  const chancy = (steps: Step[]): Journey => ({
    id: "j",
    title: "J",
    description: "",
    writes: false,
    steps,
  });

  it("SKIPS a step that did not happen rather than dropping it", async () => {
    // Dropping it would make "we never looked at the gallery" and "the gallery
    // was fine" the same row, and would shift every later step's index.
    const result = await runJourney(
      runtime(),
      chancy([
        { action: "reload", probability: 1 },
        { action: "screenshot", label: "gallery", fullPage: false, probability: 0 },
        { action: "reload", probability: 1 },
      ]),
      opts,
    );
    expect(result.steps).toHaveLength(3);
    expect(result.steps[1]).toMatchObject({ outcome: "skipped", index: 1 });
    expect(result.steps[1]?.detail).toContain("probability 0");
    // A skipped screenshot never claims to have produced a file. Reloads do
    // capture a frame — that is the visit trail, not the skipped step.
    expect(result.screenshots).toEqual(["00-reload-0", "02-reload-2"]);
    expect(result.screenshots).not.toContain("gallery");
    expect(result.verdict).toBe("PASS");
  });

  it("does not let a skipped optional assert fail the run", async () => {
    const result = await runJourney(
      runtime(),
      chancy([{ action: "assert", severity: "critical", probability: 0, spec: { check: "title-exists" } }]),
      opts,
    );
    expect(result.verdict).toBe("PASS");
    expect(result.counts.skipped).toBe(1);
    expect(result.steps[0]?.check).toBe("title-exists");
  });

  it("skips an optional click when the control is not on the page, and keeps going", async () => {
    const clicked: string[] = [];
    const result = await runJourney(
      runtime({
        isVisible: (sel) => Promise.resolve(ok(sel !== "#book")),
        click: (sel) => {
          clicked.push(sel);
          return Promise.resolve(ok(null));
        },
      }),
      chancy([
        { action: "click", selector: "#book", optional: true, probability: 1, label: "book now" },
        { action: "click", selector: "#contact", optional: true, probability: 1, label: "contact" },
      ]),
      opts,
    );
    expect(result.steps[0]).toMatchObject({ outcome: "skipped", label: "book now" });
    expect(result.steps[0]?.detail).toContain("not on this page");
    expect(result.steps[1]?.outcome).toBe("passed");
    expect(clicked).toEqual(["#contact"]);
    expect(result.verdict).toBe("PASS");
  });

  it("records an unreadable optional target as OUR defect, and does not halt", async () => {
    const result = await runJourney(
      runtime({ isVisible: () => Promise.resolve(bad()) }),
      chancy([
        { action: "click", selector: "#book", optional: true, probability: 1, label: "book now" },
        { action: "reload", probability: 1, label: "still going" },
      ]),
      opts,
    );
    expect(result.steps[0]).toMatchObject({ outcome: "errored", category: "instrumentation" });
    expect(result.steps[1]?.outcome).toBe("passed");
  });

  it("does not halt when an optional click is visible but the click itself fails", async () => {
    const result = await runJourney(
      runtime({
        click: (sel) => (sel === "#book" ? Promise.resolve(bad()) : Promise.resolve(ok(null))),
      }),
      chancy([
        { action: "click", selector: "#book", optional: true, probability: 1, label: "book now" },
        { action: "reload", probability: 1, label: "still going" },
      ]),
      opts,
    );
    expect(result.steps[0]?.outcome).toBe("errored");
    expect(result.steps[1]?.outcome).toBe("passed");
    expect(result.verdict).toBe("ERROR");
  });

  it("picks the same optional steps for the same seed", async () => {
    const taken = async (seed: number): Promise<string[]> => {
      const result = await runJourney(
        runtime(),
        chancy(Array.from({ length: 12 }, () => ({ action: "reload" as const, probability: 0.5 }))),
        { ...opts, seed },
      );
      return result.steps.map((s) => s.outcome);
    };
    expect(await taken(21)).toEqual(await taken(21));
    // …and a mixture, rather than all-or-nothing.
    const outcomes = await taken(21);
    expect(outcomes).toContain("passed");
    expect(outcomes).toContain("skipped");
  });
});

describe("mergeAttempts", () => {
  const attemptStep = (
    index: number,
    label: string,
    outcome: StepResult["outcome"],
    over: Partial<StepResult> = {},
  ): StepResult => ({
    index,
    action: "assert",
    label,
    outcome,
    severity: "high",
    category: null,
    check: "selector-visible",
    detail: `${label}: ${outcome}`,
    expected: "visible",
    observed: outcome === "passed" ? "visible" : "absent",
    durationMs: 5,
    ...over,
  });

  /** One attempt, with counts and verdict derived exactly as a real run's are. */
  const attempt = (steps: StepResult[], over: Partial<JourneyResult> = {}): JourneyResult => ({
    journeyId: "j",
    verdict: verdictFor(steps),
    steps,
    counts: countOutcomes(steps),
    screenshots: [],
    durationMs: 10,
    writes: false,
    seed: 7,
    touchedForm: false,
    ...over,
  });

  const ctx = {
    runId: "run_1",
    target: "https://digilist.no",
    profileId: "oslo-mobile",
    journeyId: "j",
    market: "no-oslo",
    device: "mobile",
    detectedAt: "2026-01-01T00:00:00.000Z",
    evidence: [],
  };

  it("reports each step at the WORST outcome any attempt saw, never the last one", () => {
    // The property the whole feature exists for. Merging on the last attempt
    // would leave this step `passed`, produce NO finding, and silently discard
    // the intermittent site defect the three runs were paid for to find.
    const merged = mergeAttempts([
      attempt([attemptStep(0, "has a primary heading", "failed", { detail: "the h1 was missing", observed: "absent" })]),
      attempt([attemptStep(0, "has a primary heading", "passed")]),
      attempt([attemptStep(0, "has a primary heading", "passed")]),
    ]);
    expect(merged.result.steps[0]?.outcome).toBe("failed");
    expect(merged.result.verdict).toBe("FAIL");
    // …and it quotes the attempt that actually saw it, not a blend of readings.
    expect(merged.result.steps[0]?.detail).toBe("the h1 was missing");
    expect(merged.result.steps[0]?.observed).toBe("absent");
    expect(merged.result.counts).toEqual({ passed: 0, failed: 1, errored: 0, skipped: 0 });
  });

  it("ranks errored over failed over passed over skipped, per step index", () => {
    // `skipped` losing to `passed` matters as much as the rest: "we looked once
    // and it was fine" is a stronger statement than "we never looked".
    const merged = mergeAttempts([
      attempt([
        attemptStep(0, "a", "passed"),
        attemptStep(1, "b", "failed"),
        attemptStep(2, "c", "skipped"),
        attemptStep(3, "d", "passed"),
      ]),
      attempt([
        attemptStep(0, "a", "errored"),
        attemptStep(1, "b", "passed"),
        attemptStep(2, "c", "passed"),
        attemptStep(3, "d", "skipped"),
      ]),
    ]);
    expect(merged.result.steps.map((s) => s.outcome)).toEqual(["errored", "failed", "passed", "passed"]);
    expect(merged.result.verdict).toBe("ERROR");
  });

  it("counts occurrences as the number of attempts a step failed or errored in", () => {
    const merged = mergeAttempts([
      attempt([attemptStep(0, "always", "failed"), attemptStep(1, "sometimes", "errored")]),
      attempt([attemptStep(0, "always", "failed"), attemptStep(1, "sometimes", "passed")]),
      attempt([attemptStep(0, "always", "failed"), attemptStep(1, "sometimes", "passed")]),
    ]);
    expect(merged.occurrences).toEqual({ "0:always": 3, "1:sometimes": 1 });
  });

  it("does not count a skipped step as an occurrence — it was never executed", () => {
    const merged = mergeAttempts([
      attempt([attemptStep(0, "optional", "skipped")]),
      attempt([attemptStep(0, "optional", "passed")]),
    ]);
    expect(merged.occurrences).toEqual({});
  });

  it("keeps two steps that SHARE a label apart, rather than merging their counts", () => {
    // An unlabelled assert's label is its check kind, so a journey with two `text-present`
    // asserts has two steps called the same thing. Keyed by label alone they shared one count:
    // one step failing every attempt and the other never would read as both failing every
    // attempt — `reproduced` on a step never seen to fail twice. And within a single attempt
    // the two would sum to 2 of 1, making `occurrences === attempts` unreachable for exactly
    // the checks that repeat.
    const merged = mergeAttempts([
      attempt([attemptStep(0, "title-exists", "failed"), attemptStep(1, "title-exists", "failed")]),
      attempt([attemptStep(0, "title-exists", "failed"), attemptStep(1, "title-exists", "passed")]),
    ]);
    expect(merged.occurrences).toEqual({ "0:title-exists": 2, "1:title-exists": 1 });
  });

  it("returns a single attempt unchanged, with its occurrences counted over one attempt", () => {
    const only = attempt([attemptStep(0, "a", "passed"), attemptStep(1, "b", "failed")], {
      screenshots: ["hero"],
      durationMs: 42,
      seed: 99,
    });
    const merged = mergeAttempts([only]);
    expect(merged.result).toEqual(only);
    expect(merged.occurrences).toEqual({ "1:b": 1 });
  });

  it("sums the wall clock, keeps the LAST attempt's screenshots, and unions what was touched", () => {
    const merged = mergeAttempts([
      attempt([attemptStep(0, "a", "passed")], { durationMs: 100, screenshots: ["hero-1"], touchedForm: true }),
      attempt([attemptStep(0, "a", "passed")], { durationMs: 250, screenshots: ["hero-2"], writes: true }),
    ]);
    // Every attempt wrote its frames to the same path, so only the last survives.
    expect(merged.result.screenshots).toEqual(["hero-2"]);
    expect(merged.result.durationMs).toBe(350);
    expect(merged.result.touchedForm).toBe(true);
    expect(merged.result.writes).toBe(true);
  });

  it("keeps the BASE seed, so one value replays the whole set rather than one attempt", () => {
    const merged = mergeAttempts([
      attempt([attemptStep(0, "a", "passed")], { seed: 7 }),
      attempt([attemptStep(0, "a", "passed")], { seed: 8 }),
      attempt([attemptStep(0, "a", "passed")], { seed: 9 }),
    ]);
    expect(merged.result.seed).toBe(7);
    expect(merged.result.journeyId).toBe("j");
  });

  it("surfaces an intermittent failure as a finding whose reproducibility is 1 of 3", () => {
    const merged = mergeAttempts([
      attempt([attemptStep(0, "has a primary heading", "failed")]),
      attempt([attemptStep(0, "has a primary heading", "passed")]),
      attempt([attemptStep(0, "has a primary heading", "passed")]),
    ]);
    const findings = findingsFromSteps(merged.result.steps, {
      ...ctx,
      attempts: 3,
      occurrences: merged.occurrences,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reproducibility).toEqual({ attempts: 3, occurrences: 1 });
    // Filed, but not asserted as certain: 92 is what a single sighting scores,
    // and seeing it once in three tries is a weaker claim than that.
    expect(findings[0]?.status).toBe("observed");
    expect(findings[0]?.confidence).toBeLessThan(92);
  });

  it("reaches status REPRODUCED when every attempt saw the same failure", () => {
    const merged = mergeAttempts([
      attempt([attemptStep(0, "has a primary heading", "failed")]),
      attempt([attemptStep(0, "has a primary heading", "failed")]),
      attempt([attemptStep(0, "has a primary heading", "failed")]),
    ]);
    const findings = findingsFromSteps(merged.result.steps, {
      ...ctx,
      attempts: 3,
      occurrences: merged.occurrences,
    });
    expect(findings[0]?.status).toBe("reproduced");
    expect(findings[0]?.confidence).toBeGreaterThan(92);
  });
});

describe("a navigating step records where it landed", () => {
  it("records the URL after a click, press, open and reload — and NOT after a fill", async () => {
    // A live J06 run failed on "the chosen language survived" and the evidence could
    // not say which page the click had reached, so the failure was indistinguishable
    // from a badly chosen marker. Half an hour went into answering a question the run
    // should have answered itself.
    const urls = ["/landed-open", "/landed-click", "/landed-press", "/landed-reload"];
    let call = 0;
    const rt = runtime({
      getUrl: () => Promise.resolve(ok(urls[Math.min(call++, urls.length - 1)] as string)),
    });
    const result = await runJourney(rt, journey([
      { action: "open", url: "https://x", label: "open" },
      { action: "fill", selector: "#q", value: "secret", label: "fill" },
      { action: "click", selector: "#go", label: "click" },
      { action: "press", key: "Enter", label: "press" },
      { action: "reload", label: "reload" },
    ]), opts);

    const observedFor = (label: string): string | null =>
      result.steps.find((s) => s.label === label)?.observed ?? null;
    expect(observedFor("open")).toBe("/landed-open");
    expect(observedFor("click")).toBe("/landed-click");
    expect(observedFor("press")).toBe("/landed-press");
    expect(observedFor("reload")).toBe("/landed-reload");
    // A fill cannot navigate, so a URL there is noise — and a fill must never
    // render anything of its own.
    expect(observedFor("fill")).toBeNull();
  });

  it("leaves the URL null rather than failing the step when it cannot be read", async () => {
    // The observation is a debugging aid. Losing it must never cost a step that
    // otherwise succeeded — that would turn a missing convenience into our defect.
    const rt = runtime({ getUrl: () => Promise.resolve(bad()) });
    const result = await runJourney(rt, journey([{ action: "click", selector: "#go", label: "click" }]), opts);
    expect(result.steps[0]?.outcome).toBe("passed");
    expect(result.steps[0]?.observed).toBeNull();
  });
})

describe("a selector that could have hit more than one element", () => {
  const clickJourney = () => journey([{ action: "click", selector: "#a, .b", label: "click" }]);

  it("RECORDS the ambiguity rather than refusing it", () => {
    // A union in a click is legitimate — `#results a, .result` taking the first of three
    // results is exactly what a journey means. But a CSS comma resolves in DOCUMENT order, not
    // as a preference list, so "the first of three search results" and "the nav link that
    // happened to come first" are the same event in a report that counts neither. One of those
    // is a finding, and it cost a deliberately-broken override run reporting PASS to notice.
    const rt = runtime({ visibleCount: () => Promise.resolve(ok(12)) });
    return runJourney(rt, clickJourney(), opts).then((result) => {
      expect(result.steps[0]?.outcome).toBe("passed");
      expect(result.steps[0]?.detail).toContain("matched 12 visible elements");
      expect(result.steps[0]?.detail).toContain("document order");
    });
  });

  it("says nothing when the selector hit exactly what it named", async () => {
    // A note on every row would bury the rows that matter.
    const result = await runJourney(runtime({ visibleCount: () => Promise.resolve(ok(1)) }), clickJourney(), opts);
    expect(result.steps[0]?.detail).not.toContain("matched");
  });

  it("says nothing when the engine CANNOT count, rather than guessing", async () => {
    // agent-browser has no visible-only count. Reporting its hidden-inclusive number as the
    // number a click could have hit would make an unambiguous click look ambiguous.
    const result = await runJourney(runtime({ visibleCount: () => Promise.resolve(bad()) }), clickJourney(), opts);
    expect(result.steps[0]?.outcome).toBe("passed");
    expect(result.steps[0]?.detail).not.toContain("matched");
  });

  it("counts BEFORE the action, because a click navigates", async () => {
    // Asked afterwards, the selector resolves against the DESTINATION page — so the number
    // would describe a page the step never acted on. A confidently wrong count is worse than
    // no count, and it is exactly the failure this note exists to prevent.
    const counts = [12, 1];
    let clicked = false;
    const rt = runtime({
      visibleCount: () => Promise.resolve(ok(counts[clicked ? 1 : 0] as number)),
      click: () => {
        clicked = true;
        return Promise.resolve(ok(null));
      },
    });
    const result = await runJourney(rt, clickJourney(), opts);
    expect(result.steps[0]?.detail).toContain("matched 12 visible elements");
  });

  it("does not ask about actions that target no element", async () => {
    // `press` sends a key to the page and `scroll` moves the viewport; neither chooses an
    // element from a set, so an ambiguity note would be meaningless.
    const counted = vi.fn(() => Promise.resolve(ok(9)));
    await runJourney(
      runtime({ visibleCount: counted }),
      journey([{ action: "press", key: "Enter", label: "press" }, { action: "scroll", direction: "down", px: 10, label: "scroll" }]),
      opts,
    );
    expect(counted).not.toHaveBeenCalled();
  });
});

describe("after a navigation the page is allowed to finish loading", () => {
  it("waits before the frame, and records how long that was", async () => {
    const order: string[] = [];
    const r = runtime({
      waitFor: (t) => {
        order.push(`wait:${t}`);
        return Promise.resolve(ok(null));
      },
      screenshot: (p) => {
        order.push(`shot:${p}`);
        return Promise.resolve(ok(null));
      },
    });
    const result = await runJourney(r, journey([{ action: "open", url: "https://x", label: "open target" }]), {
      screenshotDir: "/e",
      afterNavigateMs: 3_000,
    });
    expect(order[0]).toBe("wait:3000");
    expect(order[1]).toContain("00-open-target");
    expect(result.steps[0]?.detail).toContain("ready after 3000ms");
  });

  it("does not wait after a scroll or a screenshot — those are not a new page", async () => {
    const waits: string[] = [];
    await runJourney(
      runtime({
        waitFor: (t) => {
          waits.push(t);
          return Promise.resolve(ok(null));
        },
      }),
      journey([
        { action: "scroll", direction: "down", px: 100 },
        { action: "screenshot", label: "hero", fullPage: false },
      ]),
      { screenshotDir: "/e", afterNavigateMs: 3_000 },
    );
    expect(waits).toEqual([]);
  });

  it("skips the wait when afterNavigateMs is 0, so the suite does not pay it", async () => {
    const waits: string[] = [];
    await runJourney(
      runtime({
        waitFor: (t) => {
          waits.push(t);
          return Promise.resolve(ok(null));
        },
      }),
      journey([{ action: "open", url: "https://x" }]),
      opts,
    );
    expect(waits).toEqual([]);
  });
});

describe("pinch", () => {
  it("asks the runtime to pinch in or out, and takes a frame", async () => {
    const pinches: [string, string][] = [];
    const shots: string[] = [];
    const result = await runJourney(
      runtime({
        pinch: (sel, dir) => {
          pinches.push([sel, dir]);
          return Promise.resolve(ok(null));
        },
        screenshot: (p) => {
          shots.push(p);
          return Promise.resolve(ok(null));
        },
      }),
      journey([{ action: "pinch", selector: ".map", direction: "in", label: "zoom the map" }]),
      opts,
    );
    expect(pinches).toEqual([[".map", "in"]]);
    expect(shots[0]).toContain("00-zoom-the-map");
    expect(result.steps[0]?.detail).toBe("pinch in .map ok");
  });
});
