import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXPERIMENTS, EXP_001, findExperiment } from "../definitions.js";
import {
  appendSample,
  ensureExperimentDir,
  evaluateMetric,
  experimentPaths,
  meanOf,
  overallVerdict,
  rate,
  renderSummary,
  runSamples,
  summarize,
  writeSummary,
  type ExperimentSample,
  type MetricResult,
  type MetricSpec,
} from "../harness.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "geoqa-exp-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sample = (over: Partial<ExperimentSample> = {}): ExperimentSample => ({
  index: 0,
  at: 0,
  ok: true,
  durationMs: 5,
  data: {},
  error: null,
  ...over,
});

const spec = (over: Partial<MetricSpec> = {}): MetricSpec => ({
  key: "country-match",
  description: "d",
  target: 98,
  unit: "percent",
  direction: "min",
  ...over,
});

describe("rate", () => {
  it("is a percentage over all samples", () => {
    expect(rate([sample({ data: { ok: true } }), sample({ data: { ok: false } })], (s) => s.data.ok === true)).toBe(50);
  });

  it("restricts the denominator when one is given", () => {
    const samples = [
      sample({ data: { connected: true, matched: true } }),
      sample({ data: { connected: true, matched: false } }),
      sample({ data: { connected: false } }),
    ];
    expect(rate(samples, (s) => s.data.matched === true, (s) => s.data.connected === true)).toBe(50);
  });

  it("is NULL for an empty denominator — not 0 and not 100", () => {
    // "0 of 0 sessions egressed from Norway" is a question we did not ask.
    expect(rate([], () => true)).toBeNull();
    expect(rate([sample()], () => true, () => false)).toBeNull();
  });
});

describe("meanOf", () => {
  it("averages the samples that carried a finite number", () => {
    const samples = [sample({ data: { ms: 10 } }), sample({ data: { ms: 30 } }), sample({ data: {} })];
    expect(meanOf(samples, (s) => (typeof s.data.ms === "number" ? s.data.ms : null))).toBe(20);
  });

  it("is null when nothing carried the value", () => {
    expect(meanOf([sample()], () => null)).toBeNull();
    expect(meanOf([sample()], () => Number.NaN)).toBeNull();
  });
});

describe("evaluateMetric", () => {
  it("passes and fails a `min` rate", () => {
    expect(evaluateMetric(spec(), 99, "x").verdict).toBe("pass");
    expect(evaluateMetric(spec(), 50, "x").verdict).toBe("fail");
  });

  it("passes and fails a `max` latency", () => {
    const latency = spec({ key: "latency", target: 3000, unit: "ms", direction: "max" });
    expect(evaluateMetric(latency, 250, "x").verdict).toBe("pass");
    expect(evaluateMetric(latency, 9000, "x").verdict).toBe("fail");
    expect(evaluateMetric(latency, 250, "x").reason).toBe("250ms vs ≤ 3000ms");
  });

  it("records a null value as UNMEASURED with the reason, never as a pass", () => {
    const result = evaluateMetric(spec(), null, "no proxy vendor is configured");
    expect(result.verdict).toBe("unmeasured");
    expect(result.reason).toBe("no proxy vendor is configured");
    expect(result.value).toBeNull();
  });

  it("renders a count without a unit suffix", () => {
    const counted = spec({ key: "c", unit: "count", target: 1 });
    expect(evaluateMetric(counted, 5, "x").reason).toBe("5 vs ≥ 1");
  });
});

describe("overallVerdict", () => {
  const m = (verdict: MetricResult["verdict"]): MetricResult => ({ ...spec(), value: 1, verdict, reason: "" });

  it("lets UNMEASURED outrank fail, and fail outrank pass", () => {
    expect(overallVerdict([m("pass"), m("fail"), m("unmeasured")])).toBe("unmeasured");
    expect(overallVerdict([m("pass"), m("fail")])).toBe("fail");
    expect(overallVerdict([m("pass"), m("pass")])).toBe("pass");
  });

  it("is unmeasured when there are no metrics at all", () => {
    expect(overallVerdict([])).toBe("unmeasured");
  });
});

describe("runSamples", () => {
  it("takes n samples and records each one's duration", async () => {
    let clock = 0;
    const samples = await runSamples(async (i) => ({ i }), { samples: 3, now: () => (clock += 5) });
    expect(samples).toHaveLength(3);
    expect(samples[0]?.data).toEqual({ i: 0 });
    expect(samples[0]?.durationMs).toBe(5);
  });

  it("CONTINUES after a throwing sample and records it as failed", async () => {
    // An experiment that aborts on the first failure measures nothing, and the
    // failures are usually the interesting part.
    const samples = await runSamples(
      async (i) => {
        if (i === 1) throw new Error("proxy refused");
        return { i };
      },
      { samples: 3 },
    );
    expect(samples.map((s) => s.ok)).toEqual([true, false, true]);
    expect(samples[1]?.error).toBe("proxy refused");
  });

  it("stringifies a non-Error throw", async () => {
    const samples = await runSamples(async () => {
      throw "just a string";
    }, { samples: 1 });
    expect(samples[0]?.error).toBe("just a string");
  });

  it("notifies a listener per sample", async () => {
    const seen: number[] = [];
    await runSamples(async (i) => ({ i }), { samples: 2, onSample: (s) => seen.push(s.index) });
    expect(seen).toEqual([0, 1]);
  });
});

describe("summarize", () => {
  it("counts successes and failures and takes the overall verdict from the metrics", () => {
    const metrics = [evaluateMetric(spec(), null, "unmeasurable")];
    const summary = summarize(
      EXP_001,
      [sample(), sample({ ok: false })],
      metrics,
      { startedAt: "a", finishedAt: "b" },
      ["a note"],
    );
    expect(summary).toMatchObject({
      id: EXP_001.id,
      samples: 2,
      succeeded: 1,
      failed: 1,
      verdict: "unmeasured",
      notes: ["a note"],
    });
  });

  it("defaults notes to empty", () => {
    expect(summarize(EXP_001, [], [], { startedAt: "a", finishedAt: "b" }).notes).toEqual([]);
  });
});

describe("file layout", () => {
  it("puts results, summary and evidence under the experiment id", () => {
    const paths = experimentPaths(root, "EXP-001-geo-ip");
    expect(paths.results).toBe(path.join(root, "EXP-001-geo-ip", "results.jsonl"));
    ensureExperimentDir(paths);
    appendSample(paths, sample({ index: 0, data: { ip: "1.2.3.4" } }));
    appendSample(paths, sample({ index: 1 }));
    const lines = readFileSync(paths.results, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ index: 0, data: { ip: "1.2.3.4" } });
  });

  it("REDACTS a sample on the way to results.jsonl", () => {
    const paths = experimentPaths(root, "EXP-001-geo-ip");
    ensureExperimentDir(paths);
    appendSample(paths, sample({ data: { proxy: "http://user:s3cret@gw:1" } }));
    expect(readFileSync(paths.results, "utf8")).not.toContain("s3cret");
  });

  it("writes a redacted summary", () => {
    const paths = experimentPaths(root, "EXP-001-geo-ip");
    ensureExperimentDir(paths);
    const summary = summarize(EXP_001, [], [], { startedAt: "a", finishedAt: "b" }, ["proxy http://u:p@gw:1"]);
    writeSummary(paths, summary);
    const written = readFileSync(paths.summary, "utf8");
    expect(written).not.toContain("u:p@");
    expect(JSON.parse(written).id).toBe(EXP_001.id);
  });
});

describe("renderSummary", () => {
  it("marks pass, fail and unmeasured distinctly and lists the notes", () => {
    const metrics = [
      evaluateMetric(spec({ key: "connection-success" }), 100, "x"),
      evaluateMetric(spec({ key: "country-match" }), 10, "x"),
      evaluateMetric(spec({ key: "city-match" }), null, "no vendor"),
    ];
    const rendered = renderSummary(
      summarize(EXP_001, [sample()], metrics, { startedAt: "a", finishedAt: "b" }, ["one note"]),
    );
    expect(rendered).toContain("UNMEASURED");
    expect(rendered).toContain("✓ connection-success");
    expect(rendered).toContain("✗ country-match");
    expect(rendered).toContain("? city-match");
    expect(rendered).toContain("· one note");
  });
});

describe("findExperiment", () => {
  it("finds by full id, by bare number and by short form", () => {
    expect(findExperiment("EXP-001-geo-ip")?.id).toBe(EXP_001.id);
    expect(findExperiment("001")?.id).toBe(EXP_001.id);
    expect(findExperiment("1")?.id).toBe(EXP_001.id);
    expect(findExperiment("exp-001")?.id).toBe(EXP_001.id);
  });

  it("returns null for an unknown id", () => {
    expect(findExperiment("EXP-999")).toBeNull();
  });

  it("registers all eight Phase 0 experiments with unique metric keys", () => {
    expect(Object.keys(EXPERIMENTS)).toHaveLength(8);
    for (const experiment of Object.values(EXPERIMENTS)) {
      const keys = experiment.metrics.map((m) => m.key);
      expect(new Set(keys).size, experiment.id).toBe(keys.length);
      expect(experiment.hypothesis.length).toBeGreaterThan(20);
    }
  });

  it("declares the concurrency experiment the matrix workflow cites, with a target for the OOM it fears", () => {
    const concurrency = findExperiment("EXP-007");
    expect(concurrency?.id).toBe("EXP-007-concurrency");
    // The memory target is the one that keeps concurrency at 1. Declared even
    // though nothing can evaluate it yet — an undeclared fear is an unstated
    // assumption, and this experiment exists to stop being one.
    expect(concurrency?.metrics.map((m) => m.key)).toContain("peak-memory-per-session");
  });

  // A-3b was a citation pointing at nothing: the comment justifying sequential
  // execution named EXP-007, and no spec, sampler or directory existed. A cited
  // experiment that cannot be resolved is worse than an uncited gap, because it
  // reads as "measured elsewhere".
  it("resolves every experiment id cited by the matrix workflow", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const workflows = readFileSync(path.join(here, "..", "..", "temporal", "workflows.ts"), "utf8");
    const cited = [...new Set(workflows.match(/EXP-\d{3}/g) ?? [])];
    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) expect(findExperiment(id)?.id, id).toBeDefined();
  });
});
