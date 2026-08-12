/**
 * The journey DSL — deterministic by construction.
 *
 * There is no LLM in this layer and no natural-language step. A journey is a
 * list of actions and a list of checks, and the same file run twice on the same
 * page produces the same steps in the same order. That is the whole point: a
 * failing run has to be reproducible, and "the agent decided to click something
 * else this time" makes an evidence package worthless.
 *
 * Adaptive recovery (PRD §37) belongs on top of this, later, and only once the
 * deterministic path is reliable enough to have a baseline worth deviating from.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { FindingCategory } from "../findings/types.js";
import { formatIssues, type ParseResult } from "../geo/profile.js";

/** Checks that read the page. */
export const CheckSchema = z.discriminatedUnion("check", [
  z.object({ check: z.literal("title-exists") }),
  z.object({ check: z.literal("title-contains"), value: z.string().min(1) }),
  z.object({ check: z.literal("url-matches"), value: z.string().min(1) }),
  z.object({ check: z.literal("selector-visible"), selector: z.string().min(1) }),
  z.object({ check: z.literal("selector-absent"), selector: z.string().min(1) }),
  z.object({ check: z.literal("selector-count-min"), selector: z.string().min(1), value: z.number().int().min(0) }),
  z.object({ check: z.literal("text-contains"), selector: z.string().min(1), value: z.string().min(1) }),
  z.object({ check: z.literal("text-absent"), selector: z.string().min(1), value: z.string().min(1) }),
  z.object({ check: z.literal("no-console-errors") }),
  z.object({ check: z.literal("no-page-errors") }),
  z.object({ check: z.literal("no-http-5xx") }),
  z.object({ check: z.literal("no-http-4xx") }),
  z.object({ check: z.literal("lcp-below"), value: z.number().positive() }),
  z.object({ check: z.literal("cls-below"), value: z.number().nonnegative() }),
  z.object({ check: z.literal("no-a11y-critical") }),
]);

export type Check = z.infer<typeof CheckSchema>;

/**
 * `severity` is per-step. A missing CTA on a conversion probe is a different
 * kind of news than an LCP 200ms over budget, and forcing both to fail the run
 * equally is how a QA system trains its owner to ignore it.
 */
const Severity = z.enum(["critical", "high", "medium", "low", "info"]);

export const StepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), url: z.string().min(1), label: z.string().optional() }),
  z.object({ action: z.literal("reload"), label: z.string().optional() }),
  z.object({ action: z.literal("click"), selector: z.string().min(1), label: z.string().optional() }),
  /**
   * Input, so journeys can exercise functionality rather than only read pages:
   * search, registration, login, contact forms, CRUD.
   *
   * A `fill` value is a SECRET as far as everything downstream is concerned. It
   * is interpolated from `--var` like any other value, which is how a password
   * reaches a login journey — and why no step result, log line or evidence
   * artifact ever records it.
   */
  z.object({
    action: z.literal("fill"),
    selector: z.string().min(1),
    value: z.string(),
    label: z.string().optional(),
  }),
  z.object({ action: z.literal("press"), key: z.string().min(1), label: z.string().optional() }),
  z.object({
    action: z.literal("select"),
    selector: z.string().min(1),
    values: z.array(z.string()).min(1),
    label: z.string().optional(),
  }),
  z.object({ action: z.literal("check"), selector: z.string().min(1), label: z.string().optional() }),
  /**
   * A human-length pause, drawn from a seeded generator.
   *
   * Not `wait`, which takes a fixed number: a visitor reading a blog post does
   * not spend exactly 500ms on it, and a runner that always does produces load
   * patterns and timings that represent nobody. The range is bounded and the
   * draw is seeded, so the pacing is realistic AND repeatable.
   */
  z.object({
    action: z.literal("pause"),
    minMs: z.number().int().nonnegative(),
    maxMs: z.number().int().nonnegative(),
    label: z.string().optional(),
  }),
  z.object({
    action: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]).default("down"),
    px: z.number().int().optional(),
    label: z.string().optional(),
  }),
  z.object({ action: z.literal("wait"), target: z.string().min(1), label: z.string().optional() }),
  z.object({
    action: z.literal("screenshot"),
    label: z.string().min(1),
    fullPage: z.boolean().default(false),
  }),
  z.object({ action: z.literal("snapshot"), label: z.string().min(1) }),
]);

/**
 * `assert` is absent from `StepSchema` on purpose. A step is discriminated by
 * `action` and a check by `check`, and zod cannot intersect two discriminated
 * unions keyed on different fields. So an assert is validated in two passes —
 * this schema for the step envelope, `CheckSchema` for the check itself —
 * which also means `{action: "assert"}` with no check is a named error rather
 * than a silently accepted no-op step.
 */
export const AssertStepSchema = z.object({
  action: z.literal("assert"),
  label: z.string().optional(),
  severity: Severity.default("high"),
  /**
   * Overrides the category derived from the check kind. A `text-absent` check
   * is `content` by default, but in the localization journey the same check is
   * how a leaked foreign currency is caught — and filing that as a content bug
   * sends it to the wrong person.
   */
  category: z
    .enum([
      "functional", "content", "localization", "performance", "network",
      "navigation", "conversion", "accessibility", "javascript", "http",
      "redirect", "instrumentation", "unknown",
    ])
    .optional(),
});

/**
 * Fields every step carries, whatever its action.
 *
 * Parsed as a second pass rather than repeated on each member of the union —
 * the same trick `assert` already needs, and it keeps `probability` from having
 * to be declared eleven times.
 */
export const StepEnvelopeSchema = z.object({
  /**
   * How often this step happens, 0..1. Default 1.
   *
   * "Sometimes inspect the gallery, sometimes expand the description, sometimes
   * abandon" is what makes a set of runs representative instead of eleven
   * identical robots. A step that does not happen is reported `skipped`, never
   * silently dropped — see the engine.
   */
  probability: z.number().min(0).max(1).default(1),
});

export type StepAction =
  | { action: "open"; url: string; label?: string }
  | { action: "reload"; label?: string }
  | { action: "click"; selector: string; label?: string }
  | { action: "fill"; selector: string; value: string; label?: string }
  | { action: "press"; key: string; label?: string }
  | { action: "select"; selector: string; values: string[]; label?: string }
  | { action: "check"; selector: string; label?: string }
  | { action: "pause"; minMs: number; maxMs: number; label?: string }
  | { action: "scroll"; direction: "up" | "down" | "left" | "right"; px?: number; label?: string }
  | { action: "wait"; target: string; label?: string }
  | { action: "screenshot"; label: string; fullPage: boolean }
  | { action: "snapshot"; label: string }
  | {
      action: "assert";
      label?: string;
      severity: z.infer<typeof Severity>;
      category?: FindingCategory;
      spec: Check;
    };

export type Step = StepAction & { probability: number };

export const JourneySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  /**
   * Does this journey CHANGE anything on the target?
   *
   * Declared per journey, and false by default. Registering an account, sending a
   * contact form or completing a booking creates real records, and a run that did
   * that must not look identical to one that only read pages. It drives a loud
   * warning, it is recorded in the evidence metadata, and it is what makes the
   * screenshot privacy flag honest — a form journey's screenshots plausibly
   * contain personal data.
   */
  writes: z.boolean().default(false),
  steps: z.array(z.unknown()).min(1),
});

export interface Journey {
  id: string;
  title: string;
  description: string;
  writes: boolean;
  steps: Step[];
}

/** Validate one raw step, resolving the two-pass assert and envelope shapes. */
export function parseStep(raw: unknown, index: number): ParseResult<Step> {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!record) return { ok: false, errors: [`steps[${index}]: not an object`] };

  const envelope = StepEnvelopeSchema.safeParse(record);
  if (!envelope.success) return { ok: false, errors: prefix(index, formatIssues(envelope.error)) };
  const { probability } = envelope.data;

  if (record.action === "assert") {
    const head = AssertStepSchema.safeParse(record);
    if (!head.success) return { ok: false, errors: prefix(index, formatIssues(head.error)) };
    const body = CheckSchema.safeParse(record);
    if (!body.success) return { ok: false, errors: prefix(index, formatIssues(body.error)) };
    const step: Step = { action: "assert", severity: head.data.severity, spec: body.data, probability };
    if (head.data.label !== undefined) step.label = head.data.label;
    if (head.data.category !== undefined) step.category = head.data.category;
    return { ok: true, value: step };
  }

  const parsed = StepSchema.safeParse(record);
  if (!parsed.success) return { ok: false, errors: prefix(index, formatIssues(parsed.error)) };
  return { ok: true, value: { ...(parsed.data as StepAction), probability } };
}

const prefix = (index: number, errors: string[]): string[] => errors.map((e) => `steps[${index}].${e}`);

export function parseJourney(raw: unknown): ParseResult<Journey> {
  const head = JourneySchema.safeParse(raw);
  if (!head.success) return { ok: false, errors: formatIssues(head.error) };

  const steps: Step[] = [];
  const errors: string[] = [];
  for (const [index, rawStep] of head.data.steps.entries()) {
    const parsed = parseStep(rawStep, index);
    if (parsed.ok) steps.push(parsed.value);
    else errors.push(...parsed.errors);
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id: head.data.id,
      title: head.data.title,
      description: head.data.description,
      writes: head.data.writes,
      steps,
    },
  };
}

export function loadJourney(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): ParseResult<Journey> {
  let doc: unknown;
  try {
    doc = parseYaml(read(path));
  } catch (e) {
    return { ok: false, errors: [`${path}: ${(e as Error).message}`] };
  }
  const parsed = parseJourney(doc);
  return parsed.ok ? parsed : { ok: false, errors: parsed.errors.map((e) => `${path}: ${e}`) };
}

/**
 * Substitute `{name}` placeholders. An unknown placeholder is left alone rather
 * than replaced with an empty string — `open ""` would navigate somewhere
 * meaningless and report a page failure for what is really a config typo.
 */
export function interpolate(input: string, vars: Record<string, string>): string {
  return input.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/**
 * Apply variables to every step field that can carry one.
 *
 * `fill` values are interpolated like any other, which is how a credential
 * reaches a login journey without being committed to a YAML file. Nothing else
 * about them is special HERE — the secrecy is enforced downstream, where results
 * are recorded, because that is the only place it can be.
 */
export function resolveSteps(steps: Step[], vars: Record<string, string>): Step[] {
  return steps.map((step) => {
    if (step.action === "open") return { ...step, url: interpolate(step.url, vars) };
    if (step.action === "fill") return { ...step, value: interpolate(step.value, vars) };
    if (step.action === "select") return { ...step, values: step.values.map((v) => interpolate(v, vars)) };
    if (step.action === "assert" && "value" in step.spec && typeof step.spec.value === "string") {
      return { ...step, spec: { ...step.spec, value: interpolate(step.spec.value, vars) } as Check };
    }
    return step;
  });
}
