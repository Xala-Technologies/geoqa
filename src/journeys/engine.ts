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
import type { FindingCategory } from "../findings/types.js";
import { checkNeeds, evaluateCheck, EMPTY_READING, type CheckResult, type PageReading } from "./assertions.js";
import { pauseMs, seedFrom, seededRandom, takesStep } from "./random.js";
import type { Check, Journey, Step, StepAction } from "./spec.js";

export type StepOutcome = "passed" | "failed" | "errored" | "skipped";

export interface StepResult {
  index: number;
  action: Step["action"];
  label: string;
  outcome: StepOutcome;
  severity: string;
  /** Set only for asserts that declared one; otherwise derived downstream. */
  category: FindingCategory | null;
  /** The check kind, so a finding can be classified without the journey. */
  check: string | null;
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
  /** The journey declared that it changes state on the target. */
  writes: boolean;
  /** The seed every pacing and probability decision came from. */
  seed: number;
  /** True when any step typed into, selected or checked a form control. */
  touchedForm: boolean;
}

export interface EngineOptions {
  /** Where `screenshot` steps write. */
  screenshotDir: string;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * Milliseconds to settle before re-reading a metric that came back null.
   * Lowered in tests so the confirm-the-negative retry costs nothing there.
   */
  metricSettleMs?: number;
  /**
   * Seeds every pause length and probability draw.
   *
   * Recorded on the result and in `run.json`, so a run whose variation mattered
   * can be replayed exactly: pass the same seed and the same choices are made in
   * the same order.
   */
  seed?: number;
}

/** Which Vitals field each vitals-based check depends on. */
const VITAL_FOR_CHECK: Record<string, keyof import("../browser/types.js").Vitals> = {
  "lcp-below": "lcp",
  "cls-below": "cls",
};

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
  settleMs = 600,
): Promise<PageReading> {
  const reading: PageReading = { ...EMPTY_READING };
  const take = <T,>(out: BrowserResult<T>): T | null => (out.ok ? out.data : null);

  /**
   * Read Core Web Vitals, and re-read once if the metric this check needs came
   * back null.
   *
   * Same doctrine as `isVisible`'s confirm-absence retry, and found the same
   * way: on the digilist.no homepage, `lcp-below` reported "LCP was not
   * measured" on 3 of 3 runs while the evidence package written seconds later
   * in the SAME run recorded `lcp: 104`. LCP is emitted asynchronously and is
   * simply not there yet on an early read. Reporting that as unmeasured makes
   * the engine look blind on a page that is, in fact, fast.
   *
   * A null that survives a settle is a real null — a page can genuinely never
   * produce an LCP entry — so the second reading is still allowed to be null.
   */
  const readVitals = async (): Promise<PageReading["vitals"]> => {
    const first = take(await runtime.vitals());
    const needed = VITAL_FOR_CHECK[check.check];
    if (!needed || (first && first[needed] !== null)) return first;
    await runtime.waitFor(String(settleMs));
    return take(await runtime.vitals()) ?? first;
  };

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
        reading.vitals = await readVitals();
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

/**
 * The actions that can change what page we are on.
 *
 * A `press` is in here because Enter submits a form, which is exactly how the
 * search journey navigates — leaving it out would lose the URL for the one
 * navigation nobody thinks of as a click.
 */
const NAVIGATING_ACTIONS = new Set(["click", "press", "open", "reload"]);

/** The current URL, or null when it could not be read. Never throws into a step. */
async function currentUrl(runtime: BrowserRuntime): Promise<string | null> {
  const out = await runtime.getUrl();
  return out.ok ? out.data : null;
}


export async function runJourney(
  runtime: BrowserRuntime,
  journey: Journey,
  options: EngineOptions,
): Promise<JourneyResult> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => {});
  const seed = options.seed ?? seedFrom(journey.id);
  const random = seededRandom(seed);
  const started = now();
  const steps: StepResult[] = [];
  const screenshots: string[] = [];
  let halted = false;
  let touchedForm = false;

  for (const [index, step] of journey.steps.entries()) {
    const label = labelFor(step, index);
    const stepStarted = now();

    if (halted) {
      steps.push({
        index, action: step.action, label, outcome: "skipped", severity: "info",
        category: null, check: step.action === "assert" ? step.spec.check : null,
        detail: "skipped — an earlier state-changing step failed, so this would measure nothing",
        expected: null, observed: null, durationMs: 0,
      });
      continue;
    }

    /**
     * An optional step that did not happen this run is SKIPPED, never dropped.
     *
     * The distinction is the same one the whole engine turns on: a check that did
     * not run must stay distinguishable from one that passed. Silently shortening
     * the step list would make "we did not look at the gallery" and "the gallery
     * was fine" the same row, and would move every later step's index.
     */
    if (!takesStep(random, step.probability)) {
      steps.push({
        index, action: step.action, label, outcome: "skipped", severity: "info",
        category: null, check: step.action === "assert" ? step.spec.check : null,
        detail: `not taken this run — probability ${step.probability}`,
        expected: null, observed: null, durationMs: 0,
      });
      continue;
    }

    if (step.action === "assert") {
      const reading = await gatherReading(runtime, step.spec, selectorOf(step.spec), options.metricSettleMs ?? 600);
      const result = evaluateCheck(step.spec, reading);
      const outcome = outcomeOf(result);
      steps.push({
        index, action: step.action, label, outcome, severity: step.severity,
        category: step.category ?? null, check: step.spec.check,
        detail: `${step.spec.check}: expected ${result.expected}, observed ${result.observed}`,
        expected: result.expected, observed: result.observed, durationMs: now() - stepStarted,
      });
      log(`  ${outcome === "passed" ? "✓" : outcome === "failed" ? "✗" : "!"} ${label}`);
      continue;
    }

    const out = await act(runtime, step, options.screenshotDir, random);
    if (step.action === "screenshot") screenshots.push(step.label);
    if (step.action === "fill" || step.action === "select" || step.action === "check") touchedForm = true;

    if (out.ok) {
      // Where a NAVIGATING action left us, recorded as the step's observation.
      //
      // Without this a click records nothing, and a check that fails after it is
      // unattributable: a live J06 run failed on "the chosen language survived"
      // and the evidence could not say which page the click had reached, so the
      // failure could not be told apart from a badly chosen marker. Half an hour
      // went into answering a question the run should have answered itself. Only
      // for actions that can navigate — a `fill` reading back a URL would be noise,
      // and a `fill` must never render its own value.
      const landedOn = NAVIGATING_ACTIONS.has(step.action) ? await currentUrl(runtime) : null;
      steps.push({
        index, action: step.action, label, outcome: "passed", severity: "info",
        category: null, check: null,
        // `describeAction` exists so a `fill` can never render its own value.
        detail: describeAction(step), expected: null, observed: landedOn, durationMs: now() - stepStarted,
      });
      log(`  ✓ ${label}`);
      continue;
    }

    // A screenshot or snapshot that fails costs us evidence, not the run.
    const fatal = step.action !== "screenshot" && step.action !== "snapshot";
    halted = fatal;
    steps.push({
      index, action: step.action, label, outcome: "errored", severity: fatal ? "critical" : "low",
      category: "instrumentation", check: null,
      detail: `${step.action} failed: ${out.failure.kind} — ${out.failure.detail}`,
      expected: null, observed: null, durationMs: now() - stepStarted,
    });
    log(`  ! ${label} — ${out.failure.kind}`);
  }

  return {
    journeyId: journey.id,
    verdict: verdictFor(steps),
    steps,
    counts: countOutcomes(steps),
    screenshots,
    durationMs: now() - started,
    writes: journey.writes,
    seed,
    touchedForm,
  };
}

/**
 * What a non-assert step did, for the step record.
 *
 * `fill` is the reason this is a function rather than a template literal at the
 * call site: its value must never be rendered. A login journey's password would
 * otherwise appear in `run.json`, in the terminal, and in every finding that
 * carried the step's detail.
 */
export function describeAction(step: Exclude<Step, { action: "assert" }>): string {
  switch (step.action) {
    case "fill":
      return `fill ${step.selector} ok (value not recorded)`;
    case "select":
      return `select ${step.selector} ok (${step.values.length} value(s), not recorded)`;
    case "press":
      return `press ${step.key} ok`;
    case "check":
      return `check ${step.selector} ok`;
    default:
      return `${step.action} ok`;
  }
}

export function countOutcomes(steps: StepResult[]): JourneyResult["counts"] {
  return {
    passed: steps.filter((s) => s.outcome === "passed").length,
    failed: steps.filter((s) => s.outcome === "failed").length,
    errored: steps.filter((s) => s.outcome === "errored").length,
    skipped: steps.filter((s) => s.outcome === "skipped").length,
  };
}

/**
 * Append a step the journey spec did not contain, and re-derive everything that
 * depends on the step list.
 *
 * This is how a whole-run check — one whose answer only exists after the last
 * step, like "did the egress hold?" — gets the same consequences as any other
 * failed check, without a parallel verdict system growing beside `verdictFor`.
 * Recomputing rather than patching is the point: counts, verdict, retention
 * tier, findings and confidence all follow from `steps`, so appending to it is
 * the only edit needed.
 */
export function withExtraStep(result: JourneyResult, step: StepResult): JourneyResult {
  const steps = [...result.steps, step];
  return { ...result, steps, counts: countOutcomes(steps), verdict: verdictFor(steps) };
}

/** Worst first. The order the merge across repeated attempts is ranked by. */
const OUTCOME_RANK: Record<StepOutcome, number> = { errored: 3, failed: 2, passed: 1, skipped: 0 };

export interface MergedAttempts {
  /** One result standing for the whole set: the worst reading of every step. */
  result: JourneyResult;
  /** Per step label, in how many attempts that step failed or errored. */
  occurrences: Record<string, number>;
}

/**
 * Collapse N attempts at the same journey into one result plus per-step
 * occurrence counts.
 *
 * **The merged step list takes the WORST outcome seen at each index, never the
 * last one.** This is the load-bearing decision here, and it is what lets
 * `--repeat` exist without breaking the never-retry rule. A step that failed on
 * attempt 1 and passed on attempt 3 is a real intermittent site defect; a merge
 * that simply used the last attempt would produce NO finding for it, silently
 * hiding the exact thing running the journey three times exists to surface. That
 * is the same damage a silent retry does, arrived at from the other end.
 *
 * `occurrences` keeps the report honest in the other direction: the finding is
 * filed, but 1-of-3 pulls its confidence toward "we saw it once and could not
 * repeat it", while 3-of-3 earns status `reproduced`. Detail, expected and
 * observed all come from the attempt that produced the worst outcome, so the
 * finding quotes a reading that actually happened rather than a blend of two.
 *
 * The parameter is a NON-EMPTY tuple rather than an array, for the same reason
 * `ActableStep` narrows instead of carrying a default arm: a "there were no
 * attempts" branch is unreachable from any caller, so it could never be covered
 * — narrowing the type makes the caller prove there was at least one attempt.
 */
export function mergeAttempts(results: [JourneyResult, ...JourneyResult[]]): MergedAttempts {
  const [first] = results;
  const last = results[results.length - 1] ?? first;

  const steps = first.steps.map((step, index) => {
    let worst = step;
    for (const attempt of results) {
      const candidate = attempt.steps[index];
      if (candidate && OUTCOME_RANK[candidate.outcome] > OUTCOME_RANK[worst.outcome]) worst = candidate;
    }
    return worst;
  });

  /**
   * Counted per ATTEMPT, not per failing step, because a journey may carry two
   * steps with the same label and `findingsFromSteps` looks occurrences up by
   * label. Counting each failing step would let one attempt contribute 2, push
   * occurrences past attempts, and make `occurrences === attempts` —
   * i.e. status `reproduced` — unreachable for exactly the checks that repeat.
   */
  const occurrences: Record<string, number> = {};
  for (const attempt of results) {
    const failing = new Set<string>();
    for (const step of attempt.steps) {
      if (step.outcome === "failed" || step.outcome === "errored") failing.add(step.label);
    }
    for (const label of failing) occurrences[label] = (occurrences[label] ?? 0) + 1;
  }

  return {
    result: {
      journeyId: first.journeyId,
      verdict: verdictFor(steps),
      steps,
      counts: countOutcomes(steps),
      // Every attempt wrote its frames to the same path, so what is on disk is
      // the last attempt's. Naming any other attempt's screenshots here would
      // describe files that were overwritten.
      screenshots: last.screenshots,
      // The SUM: the wall clock a repeated run actually cost, which is the
      // number a human deciding whether to repeat again needs.
      durationMs: results.reduce((total, attempt) => total + attempt.durationMs, 0),
      writes: results.some((attempt) => attempt.writes),
      // The base seed. Attempt k ran at `seed + k`, so this one value replays
      // the whole set — recording an attempt's derived seed would replay one.
      seed: first.seed,
      touchedForm: results.some((attempt) => attempt.touchedForm),
    },
    occurrences,
  };
}

/**
 * The parameter type EXCLUDES `assert` rather than the switch carrying an
 * unreachable default. `assert` is handled by the caller before act() is
 * reached, so a default arm here would be dead code that the coverage gate can
 * only be silenced about, never satisfied by a test. Narrowing the type instead
 * makes the switch genuinely exhaustive, and adding a new action becomes a
 * compile error here rather than a silent no-op at runtime.
 */
type ActableStep = Exclude<StepAction, { action: "assert" }> & { probability: number };

function act(
  runtime: BrowserRuntime,
  step: ActableStep,
  screenshotDir: string,
  random: () => number,
): Promise<BrowserResult<unknown>> {
  switch (step.action) {
    case "open":
      return runtime.open(step.url);
    case "reload":
      return runtime.reload();
    case "click":
      return runtime.click(step.selector);
    case "fill":
      return runtime.fill(step.selector, step.value);
    case "press":
      return runtime.press(step.key);
    case "select":
      return runtime.select(step.selector, step.values);
    case "check":
      return runtime.check(step.selector);
    case "pause":
      // A human-length gap, drawn from the seeded generator and expressed
      // through `waitFor` so no engine needs a second timing primitive.
      return runtime.waitFor(String(pauseMs(random, step.minMs, step.maxMs)));
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
