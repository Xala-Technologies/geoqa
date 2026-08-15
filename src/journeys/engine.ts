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
  /**
   * Fires after every step is recorded, including skipped ones.
   *
   * The live board needs to know which step is on screen *during* the journey,
   * not after it. A hook rather than a log-line parse: the log is for humans
   * and its wording is not a contract.
   */
  onStep?: (step: StepResult) => void | Promise<void>;
}

/** Which Vitals field each vitals-based check depends on. */
const VITAL_FOR_CHECK: Record<string, keyof import("../browser/types.js").Vitals> = {
  "lcp-below": "lcp",
  "cls-below": "cls",
  // INP gets the same confirm-the-null re-read. An interaction's entry is emitted
  // asynchronously like LCP's, so a read taken immediately after a click can miss
  // one that arrives a frame later — and "not measured" for a page that WAS
  // interacted with is the same false blindness the LCP retry was added for.
  "inp-below": "inp",
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
  // Derived from the check rather than added to the signature: `selector` is a parameter for
  // historical reasons and growing that list makes every call site and fake carry a field only
  // two checks use.
  const attribute = attributeOf(check);

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
      case "attribute":
        reading.attribute = selector === null || attribute === null ? null : await readAttribute(runtime, selector, attribute);
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
const attributeOf = (check: Check): string | null => ("attribute" in check ? check.attribute : null);

/**
 * Read a markup attribute, through `evaluate` rather than a new seam primitive.
 *
 * Both engines already implement `evaluate`, so this needs neither a `BrowserRuntime` method
 * nor a refusal on the engine that lacks one — and an attribute read has none of the timing
 * subtlety that earned `getText` and `isVisible` their own methods. Adding a primitive to the
 * seam is a cost paid by both adapters and every test fake, and it buys nothing here.
 *
 * Returns `""` for an element that exists without the attribute, and `null` for "we could not
 * look" — a missing element, or an expression that threw. The distinction is the whole point:
 * an absent attribute is a real reading of the page and `attribute-absent` is entitled to pass
 * on it, while a missing element is not something a check may build a verdict on.
 */
async function readAttribute(runtime: BrowserRuntime, selector: string, attribute: string): Promise<string | null> {
  // Serialised through the same JSON-string convention `CONTENT_EXPRESSION` uses, so the value
  // crosses both engines identically rather than depending on how each marshals a bare string.
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return JSON.stringify({ found: false });
    return JSON.stringify({ found: true, value: el.getAttribute(${JSON.stringify(attribute)}) ?? "" });
  })()`;
  const out = await runtime.evaluate<unknown>(expression);
  if (!out.ok) return null;
  const raw = typeof out.data === "string" ? safeJson(out.data) : out.data;
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { found?: unknown; value?: unknown };
  if (r.found !== true) return null;
  return typeof r.value === "string" ? r.value : null;
}

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

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
const FRAME_ACTIONS = new Set(["open", "click", "scroll", "press", "reload"]);

const frameName = (index: number, label: string): string => {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${String(index).padStart(2, "0")}-${slug || "frame"}`;
};

const captureFrame = async (
  runtime: BrowserRuntime,
  dir: string,
  index: number,
  label: string,
): Promise<string | null> => {
  const name = frameName(index, label);
  const shot = await runtime.screenshot(`${dir}/${name}.png`, { fullPage: false });
  return shot.ok ? name : null;
};

/** Actions that act on ONE element chosen from a selector's matches. */
const TARGETED_ACTIONS = new Set(["click", "fill", "select", "check"]);

/**
 * "matched N visible elements, acted on the first", or null when there is nothing to say.
 *
 * Only for actions that TARGET a selector, and only when the count is above one — a step that
 * hit exactly what it named needs no note, and adding one to every row would bury the rows that
 * matter. An engine that cannot count returns null rather than a guess: agent-browser has no
 * visible-only count, and saying so by omission is better than reporting its hidden-inclusive
 * number as the number a click could have hit.
 */
async function ambiguityNote(runtime: BrowserRuntime, step: Step): Promise<string | null> {
  if (!("selector" in step) || typeof step.selector !== "string") return null;
  if (!TARGETED_ACTIONS.has(step.action)) return null;
  const out = await runtime.visibleCount(step.selector);
  if (!out.ok || out.data <= 1) return null;
  return `matched ${out.data} visible elements and acted on the first — a CSS comma resolves in document order, not as a preference list`;
}


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
  const record = async (step: StepResult): Promise<void> => {
    steps.push(step);
    await options.onStep?.(step);
  };

  for (const [index, step] of journey.steps.entries()) {
    const label = labelFor(step, index);
    const stepStarted = now();

    if (halted) {
      await record({
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
      await record({
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
      await record({
        index, action: step.action, label, outcome, severity: step.severity,
        category: step.category ?? null, check: step.spec.check,
        detail: `${step.spec.check}: expected ${result.expected}, observed ${result.observed}`,
        expected: result.expected, observed: result.observed, durationMs: now() - stepStarted,
      });
      log(`  ${outcome === "passed" ? "✓" : outcome === "failed" ? "✗" : "!"} ${label}`);
      continue;
    }

    // How many elements this action's selector could plausibly have hit — counted BEFORE the
    // action, which is the whole subtlety.
    //
    // Recorded, never refused. A union in a click is legitimate — `#results a, .result` taking
    // the first of three results is exactly what a journey means — but a CSS comma resolves in
    // DOCUMENT order rather than as a preference list, so "the first of three search results"
    // and "the nav link that happened to come first" are the same event in a report that counts
    // neither. One of those is a finding.
    //
    // Counted first because a click NAVIGATES. Asking afterwards resolves the selector against
    // the destination page, so the number describes a page the step never acted on — a
    // confidently wrong count, which is worse than none and is precisely the failure this whole
    // note exists to prevent.
    const ambiguity = await ambiguityNote(runtime, step);

    const out = await act(runtime, step, options.screenshotDir, random);
    if (step.action === "screenshot") screenshots.push(step.label);
    if (step.action === "fill" || step.action === "select" || step.action === "check") touchedForm = true;

    if (out.ok) {
      // A frame after every visual action. An explicit `screenshot` step already
      // wrote one; fill/select/check do not — those frames can hold a typed value.
      if (step.action !== "screenshot" && FRAME_ACTIONS.has(step.action)) {
        const frame = await captureFrame(runtime, options.screenshotDir, index, label);
        if (frame !== null) screenshots.push(frame);
      }
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
      await record({
        index, action: step.action, label, outcome: "passed", severity: "info",
        category: null, check: null,
        // `describeAction` exists so a `fill` can never render its own value.
        detail: ambiguity === null ? describeAction(step) : `${describeAction(step)} — ${ambiguity}`,
        expected: null, observed: landedOn, durationMs: now() - stepStarted,
      });
      log(`  ✓ ${label}`);
      continue;
    }

    // A screenshot or snapshot that fails costs us evidence, not the run.
    const fatal = step.action !== "screenshot" && step.action !== "snapshot";
    halted = fatal;
    await record({
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
    case "click":
      return `click ${step.selector} ok`;
    case "open":
      return `open ${step.url} ok`;
    case "scroll":
      return `scroll ${step.direction}${step.px !== undefined ? ` ${step.px}px` : ""} ok`;
    case "screenshot":
      return `screenshot ${step.label} ok`;
    case "snapshot":
      return `snapshot ${step.label} ok`;
    case "wait":
      return `wait ${step.target} ok`;
    case "pause":
    case "reload":
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
  /** Per `occurrenceKey`, in how many attempts that step failed or errored. */
  occurrences: Record<string, number>;
}

/**
 * The key an occurrence count is filed under: the step's INDEX and its label.
 *
 * The index is what makes it correct and the label is what makes it readable. Keyed by label
 * alone — which is what this used to do — two steps sharing a label share one count, and an
 * unlabelled assert's label is its check kind, so a journey with two `text-present` asserts
 * silently merges them. One failing in every attempt and the other in none then reads as both
 * failing in every attempt: `reproduced` on a step that was never seen to fail twice.
 *
 * No shipped journey has ever done that — all six were checked — which is why this was latent
 * rather than active. It is closed by construction now rather than by a naming convention
 * nobody can enforce.
 *
 * Safe because a journey is DETERMINISTIC (R-10): the same file produces the same steps in the
 * same order, so index N is the same step in every attempt. That is the same assumption
 * `mergeAttempts` already makes when it takes the worst outcome at each index.
 */
export const occurrenceKey = (step: { index: number; label: string }): string => `${step.index}:${step.label}`;

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
   * One increment per attempt per step, which the KEY is what makes safe.
   *
   * This used to count into a per-attempt `Set` of labels first, because a label can repeat
   * within one journey and counting each failing step would let a single attempt contribute 2
   * — pushing occurrences past attempts and making `occurrences === attempts`, i.e. status
   * `reproduced`, unreachable for exactly the checks that repeat. `occurrenceKey` carries the
   * step's index, so a key appears at most once per attempt and the dedup has nothing left to
   * do. Kept as a plain increment rather than a Set that can never fire: defensive code with no
   * reachable failure is a claim that the guard above it might not hold.
   */
  const occurrences: Record<string, number> = {};
  for (const attempt of results) {
    for (const step of attempt.steps) {
      if (step.outcome !== "failed" && step.outcome !== "errored") continue;
      const key = occurrenceKey(step);
      occurrences[key] = (occurrences[key] ?? 0) + 1;
    }
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
