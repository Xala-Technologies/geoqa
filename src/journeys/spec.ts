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
});

export type Step =
  | { action: "open"; url: string; label?: string }
  | { action: "reload"; label?: string }
  | { action: "click"; selector: string; label?: string }
  | { action: "scroll"; direction: "up" | "down" | "left" | "right"; px?: number; label?: string }
  | { action: "wait"; target: string; label?: string }
  | { action: "screenshot"; label: string; fullPage: boolean }
  | { action: "snapshot"; label: string }
  | { action: "assert"; label?: string; severity: z.infer<typeof Severity>; spec: Check };

export const JourneySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  steps: z.array(z.unknown()).min(1),
});

export interface Journey {
  id: string;
  title: string;
  description: string;
  steps: Step[];
}

/** Validate one raw step, resolving the two-pass assert shape. */
export function parseStep(raw: unknown, index: number): ParseResult<Step> {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!record) return { ok: false, errors: [`steps[${index}]: not an object`] };

  if (record.action === "assert") {
    const head = AssertStepSchema.safeParse(record);
    if (!head.success) return { ok: false, errors: prefix(index, formatIssues(head.error)) };
    const body = CheckSchema.safeParse(record);
    if (!body.success) return { ok: false, errors: prefix(index, formatIssues(body.error)) };
    const step: Step = { action: "assert", severity: head.data.severity, spec: body.data };
    if (head.data.label !== undefined) step.label = head.data.label;
    return { ok: true, value: step };
  }

  const parsed = StepSchema.safeParse(record);
  if (!parsed.success) return { ok: false, errors: prefix(index, formatIssues(parsed.error)) };
  return { ok: true, value: parsed.data as Step };
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
  return { ok: true, value: { id: head.data.id, title: head.data.title, description: head.data.description, steps } };
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

/** Apply variables to every step field that can carry one. */
export function resolveSteps(steps: Step[], vars: Record<string, string>): Step[] {
  return steps.map((step) => {
    if (step.action === "open") return { ...step, url: interpolate(step.url, vars) };
    if (step.action === "assert" && "value" in step.spec && typeof step.spec.value === "string") {
      return { ...step, spec: { ...step.spec, value: interpolate(step.spec.value, vars) } as Check };
    }
    return step;
  });
}
