/**
 * The journey executor.
 *
 * Two rules shape everything here.
 *
 * **1. A failed assertion and a broken tool are different events.** An assert
 * that reads the page and finds it wrong is `failed` — a defect in the site.
 * An assert whose reading never arrived is `errored` — a defect in US. They
 * are counted separately, they produce different run verdicts, and the run
 * summary always states how many of each. A QA engine that reports its own
 * blindness as a green run is worse than no QA engine.
 *
 * **2. State-changing steps are fatal; observations are not.** If `open` fails
 * there is no page, so every later step would be measuring nothing and is
 * marked `skipped` rather than executed and reported as passing. Assertions,
 * screenshots and snapshots never stop the run — the whole point is to collect
 * every failure in one pass, not to stop at the first.
 */
import type { BrowserResult, BrowserRuntime } from "../browser/types.js";
import { checkNeeds, evaluateCheck, EMPTY_READING, type CheckResult, type PageReading } from "./assertions.js";
import type { Check, Journey, Step } from "./spec.js";

export type StepOutcome = "passed" | "failed" | "errored" | "skipped";

export interface StepResult {
  index: number;
  action: Step["action"];
  label: string;
  outcome: StepOutcome;
  severity: string;
  detail: string;
  expected: string | null;
  observed: string | null;
  durationMs: number;
}

export type JourneyVerdict = "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "ERROR";

export interface JourneyResult {
  journeyId: string;
  verdict: JourneyVerdict;
  steps: StepResult[];
  counts: { passed: number; failed: number; errored: number; skipped: number };
  /** Labels of screenshots the journey asked for, in order. */
  screenshots: string[];
  durationMs: number;
}

export interface EngineOptions {
  /** Where `screenshot` steps write. */
  screenshotDir: string;
  now?: () => number;
  log?: (line: string) => void;
}

const labelFor = (step: Step, index: number): string => {
  if ("label" in step && step.label) return step.label;
  if (step.action === "assert") return step.spec.check;
  return `${step.action}#${index}`;
};

/**
 * Gather exactly the readings a check needs.
 *
 * Only what is needed: `vitals` and `a11y` each cost a real round-trip into the
 * page, and fetching them for a journey that never asserts on them would double
 * a run's wall clock for nothing.
 */
export async function gatherReading(
  runtime: BrowserRuntime,
  check: Check,
  selector: string | null,
): Promise<PageReading> {
  const reading: PageReading = { ...EMPTY_READING };
  const take = <T,>(out: BrowserResult<T>): T | null => (out.ok ? out.data : null);

  for (const need of checkNeeds(check)) {
    switch (need) {
      case "title":
        reading.title = take(await runtime.getTitle());
        break;
      case "url":
        reading.url = take(await runtime.getUrl());
        break;
      case "text":
        reading.text = selector === null ? null : take(await runtime.getText(selector));
        break;
      case "visible":
        reading.visible = selector === null ? null : take(await runtime.isVisible(selector));
        break;
      case "count":
        reading.count = selector === null ? null : take(await runtime.count(selector));
        break;
      case "console":
        reading.console = take(await runtime.console());
        break;
      case "pageErrors":
        reading.pageErrors = take(await runtime.errors());
        break;
      case "requests":
        reading.requests = take(await runtime.networkRequests());
        break;
      case "vitals":
        reading.vitals = take(await runtime.vitals());
        break;
      case "a11y":
        reading.a11y = take(await runtime.a11y());
        break;
    }
  }
  return reading;
}

const selectorOf = (check: Check): string | null => ("selector" in check ? check.selector : null);

/** Verdicts map straight onto step outcomes, except `unreadable` → errored. */
const outcomeOf = (result: CheckResult): StepOutcome =>
  result.verdict === "passed" ? "passed" : result.verdict === "failed" ? "failed" : "errored";

export async function runJourney(
  runtime: BrowserRuntime,
  journey: Journey,
  options: EngineOptions,
): Promise<JourneyResult> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => {});
  const started = now();
  const steps: StepResult[] = [];
  const screenshots: string[] = [];
  let halted = false;

  for (const [index, step] of journey.steps.entries()) {
    const label = labelFor(step, index);
    const stepStarted = now();

    if (halted) {
      steps.push({
        index, action: step.action, label, outcome: "skipped", severity: "info",
        detail: "skipped — an earlier state-changing step failed, so this would measure nothing",
        expected: null, observed: null, durationMs: 0,
      });
      continue;
    }

    if (step.action === "assert") {
      const reading = await gatherReading(runtime, step.spec, selectorOf(step.spec));
      const result = evaluateCheck(step.spec, reading);
      const outcome = outcomeOf(result);
      steps.push({
        index, action: step.action, label, outcome, severity: step.severity,
        detail: `${step.spec.check}: expected ${result.expected}, observed ${result.observed}`,
        expected: result.expected, observed: result.observed, durationMs: now() - stepStarted,
      });
      log(`  ${outcome === "passed" ? "✓" : outcome === "failed" ? "✗" : "!"} ${label}`);
      continue;
    }

    const out = await act(runtime, step, options.screenshotDir);
    if (step.action === "screenshot") screenshots.push(step.label);

    if (out.ok) {
      steps.push({
        index, action: step.action, label, outcome: "passed", severity: "info",
        detail: `${step.action} ok`, expected: null, observed: null, durationMs: now() - stepStarted,
      });
      log(`  ✓ ${label}`);
      continue;
    }

    // A screenshot or snapshot that fails costs us evidence, not the run.
    const fatal = step.action !== "screenshot" && step.action !== "snapshot";
    halted = fatal;
    steps.push({
      index, action: step.action, label, outcome: "errored", severity: fatal ? "critical" : "low",
      detail: `${step.action} failed: ${out.failure.kind} — ${out.failure.detail}`,
      expected: null, observed: null, durationMs: now() - stepStarted,
    });
    log(`  ! ${label} — ${out.failure.kind}`);
  }

  const counts = {
    passed: steps.filter((s) => s.outcome === "passed").length,
    failed: steps.filter((s) => s.outcome === "failed").length,
    errored: steps.filter((s) => s.outcome === "errored").length,
    skipped: steps.filter((s) => s.outcome === "skipped").length,
  };

  return { journeyId: journey.id, verdict: verdictFor(steps), steps, counts, screenshots, durationMs: now() - started };
}

/**
 * The parameter type EXCLUDES `assert` rather than the switch carrying an
 * unreachable default. `assert` is handled by the caller before act() is
 * reached, so a default arm here would be dead code that the coverage gate can
 * only be silenced about, never satisfied by a test. Narrowing the type instead
 * makes the switch genuinely exhaustive, and adding a new action becomes a
 * compile error here rather than a silent no-op at runtime.
 */
type ActableStep = Exclude<Step, { action: "assert" }>;

function act(runtime: BrowserRuntime, step: ActableStep, screenshotDir: string): Promise<BrowserResult<unknown>> {
  switch (step.action) {
    case "open":
      return runtime.open(step.url);
    case "reload":
      return runtime.reload();
    case "click":
      return runtime.click(step.selector);
    case "scroll":
      return step.px === undefined ? runtime.scroll(step.direction) : runtime.scroll(step.direction, step.px);
    case "wait":
      return runtime.waitFor(step.target);
    case "screenshot":
      return runtime.screenshot(`${screenshotDir}/${step.label}.png`, { fullPage: step.fullPage });
    case "snapshot":
      return runtime.snapshot({ interactiveOnly: true });
  }
}

/**
 * The run verdict.
 *
 * `ERROR` outranks `FAIL` deliberately. If the engine could not read the page,
 * the honest headline is "we do not know", not "the page is broken" — those
 * lead a human to completely different next actions.
 */
export function verdictFor(steps: StepResult[]): JourneyVerdict {
  if (steps.some((s) => s.outcome === "errored")) return "ERROR";
  const failures = steps.filter((s) => s.outcome === "failed");
  if (failures.some((s) => s.severity === "critical" || s.severity === "high")) return "FAIL";
  if (failures.length > 0) return "PASS_WITH_WARNINGS";
  return "PASS";
}
