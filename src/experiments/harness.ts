/**
 * The experiment harness.
 *
 * Tests and experiments answer different questions and this file is for the
 * second kind. A test asks "does our implementation behave correctly?" — it is
 * deterministic, it runs in CI, and a failure is a bug. An experiment asks "is
 * our assumption about the external world actually true?" — it is statistical,
 * it needs a network and a browser, and a failure is a FACT about the world we
 * now know.
 *
 * The rule that makes an experiment worth running: **a threshold we could not
 * measure is recorded as `unmeasured`, never as a pass.** Phase 0 has no proxy
 * vendor, so the country-match and city-match targets genuinely cannot be
 * evaluated. Reporting 100% because zero samples contradicted us would be the
 * most expensive kind of lie this project could tell about itself.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactDeep } from "../evidence/redact.js";

export interface ExperimentSample {
  index: number;
  at: number;
  ok: boolean;
  durationMs: number;
  data: Record<string, unknown>;
  error: string | null;
}

export type MetricUnit = "percent" | "ms" | "count";

export interface MetricSpec {
  key: string;
  description: string;
  target: number;
  unit: MetricUnit;
  /** `min` = value must be ≥ target (a rate). `max` = ≤ target (a latency). */
  direction: "min" | "max";
}

export interface ExperimentSpec {
  id: string;
  hypothesis: string;
  metrics: MetricSpec[];
}

export type MetricVerdict = "pass" | "fail" | "unmeasured";

export interface MetricResult {
  key: string;
  description: string;
  value: number | null;
  target: number;
  unit: MetricUnit;
  verdict: MetricVerdict;
  reason: string;
}

export interface ExperimentSummary {
  id: string;
  hypothesis: string;
  samples: number;
  succeeded: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
  metrics: MetricResult[];
  /** `unmeasured` when ANY metric was unmeasured — it outranks pass. */
  verdict: MetricVerdict;
  notes: string[];
}

/**
 * A rate over samples, or null when nothing qualified.
 *
 * Returning null rather than 0 or 1 for an empty denominator is the whole
 * point: "0 of 0 sessions egressed from Norway" is not 0% and it is not 100%,
 * it is a question we did not ask.
 */
export function rate(samples: ExperimentSample[], qualifies: (s: ExperimentSample) => boolean, over?: (s: ExperimentSample) => boolean): number | null {
  const denominator = over ? samples.filter(over) : samples;
  if (denominator.length === 0) return null;
  return (denominator.filter(qualifies).length / denominator.length) * 100;
}

/** The mean of a numeric field, or null when no sample carried it. */
export function meanOf(samples: ExperimentSample[], pick: (s: ExperimentSample) => number | null): number | null {
  const values = samples.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function evaluateMetric(spec: MetricSpec, value: number | null, reasonWhenUnmeasured: string): MetricResult {
  if (value === null) {
    return { ...spec, value: null, verdict: "unmeasured", reason: reasonWhenUnmeasured };
  }
  const ok = spec.direction === "min" ? value >= spec.target : value <= spec.target;
  const rendered = spec.unit === "percent" ? `${value.toFixed(1)}%` : spec.unit === "ms" ? `${Math.round(value)}ms` : String(value);
  return {
    ...spec,
    value,
    verdict: ok ? "pass" : "fail",
    reason: `${rendered} vs ${spec.direction === "min" ? "≥" : "≤"} ${spec.target}${spec.unit === "percent" ? "%" : spec.unit === "ms" ? "ms" : ""}`,
  };
}

/** `unmeasured` outranks `fail`, which outranks `pass`. */
export function overallVerdict(metrics: MetricResult[]): MetricVerdict {
  if (metrics.length === 0) return "unmeasured";
  if (metrics.some((m) => m.verdict === "unmeasured")) return "unmeasured";
  return metrics.some((m) => m.verdict === "fail") ? "fail" : "pass";
}

export interface RunOptions {
  samples: number;
  now?: () => number;
  onSample?: (sample: ExperimentSample) => void;
}

/**
 * Take N samples. A throwing sample is recorded as a failed sample and the run
 * CONTINUES — an experiment that aborts on the first failure measures nothing,
 * and the failures are usually the interesting part.
 */
export async function runSamples(
  take: (index: number) => Promise<Record<string, unknown>>,
  options: RunOptions,
): Promise<ExperimentSample[]> {
  const now = options.now ?? Date.now;
  const samples: ExperimentSample[] = [];
  for (let index = 0; index < options.samples; index++) {
    const startedAt = now();
    let sample: ExperimentSample;
    try {
      const data = await take(index);
      sample = { index, at: startedAt, ok: true, durationMs: now() - startedAt, data, error: null };
    } catch (e) {
      sample = {
        index,
        at: startedAt,
        ok: false,
        durationMs: now() - startedAt,
        data: {},
        error: e instanceof Error ? e.message : String(e),
      };
    }
    samples.push(sample);
    options.onSample?.(sample);
  }
  return samples;
}

export function summarize(
  spec: ExperimentSpec,
  samples: ExperimentSample[],
  metrics: MetricResult[],
  window: { startedAt: string; finishedAt: string },
  notes: string[] = [],
): ExperimentSummary {
  return {
    id: spec.id,
    hypothesis: spec.hypothesis,
    samples: samples.length,
    succeeded: samples.filter((s) => s.ok).length,
    failed: samples.filter((s) => !s.ok).length,
    startedAt: window.startedAt,
    finishedAt: window.finishedAt,
    metrics,
    verdict: overallVerdict(metrics),
    notes,
  };
}

export interface ExperimentPaths {
  dir: string;
  results: string;
  summary: string;
  evidence: string;
}

export function experimentPaths(root: string, id: string): ExperimentPaths {
  const dir = path.join(root, id);
  return {
    dir,
    results: path.join(dir, "results.jsonl"),
    summary: path.join(dir, "summary.json"),
    evidence: path.join(dir, "evidence"),
  };
}

export function ensureExperimentDir(paths: ExperimentPaths): void {
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(paths.evidence, { recursive: true });
}

/** Append one sample as a JSON line, redacted. */
export function appendSample(paths: ExperimentPaths, sample: ExperimentSample): void {
  appendFileSync(paths.results, `${JSON.stringify(redactDeep(sample))}\n`);
}

export function writeSummary(paths: ExperimentPaths, summary: ExperimentSummary): void {
  writeFileSync(paths.summary, `${JSON.stringify(redactDeep(summary), null, 2)}\n`);
}

/** A human-readable table for the terminal. */
export function renderSummary(summary: ExperimentSummary): string {
  const lines = [
    `${summary.id} — ${summary.verdict.toUpperCase()}`,
    `  hypothesis: ${summary.hypothesis}`,
    `  samples:    ${summary.samples} (${summary.succeeded} ok, ${summary.failed} failed)`,
  ];
  for (const metric of summary.metrics) {
    const mark = metric.verdict === "pass" ? "✓" : metric.verdict === "fail" ? "✗" : "?";
    lines.push(`  ${mark} ${metric.key.padEnd(24)} ${metric.reason}`);
  }
  for (const note of summary.notes) lines.push(`  · ${note}`);
  return lines.join("\n");
}
