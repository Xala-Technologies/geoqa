import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest, type Artifact, type EvidenceManifest } from "../manifest.js";
import { writeManifest } from "../store.js";
import {
  DEFAULT_POLICY,
  describePrunePlan,
  executePrune,
  formatBytes,
  nodePruneFs,
  planPrune,
  resolveRunDir,
  type PruneFs,
  type RetentionPolicy,
} from "../prune.js";
import type { JourneyVerdict } from "../../journeys/engine.js";

const ROOT = "/evidence";
const NOW = Date.parse("2026-08-12T00:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();

const shot = (risk: "low" | "review"): Artifact => ({
  kind: "screenshot",
  label: "step 1",
  path: "step-1.png",
  bytes: 1024,
  mime: "image/png",
  risk,
});

const manifestFor = (
  runId: string,
  verdict: JourneyVerdict,
  createdAt: string,
  artifacts: Artifact[] = [],
): EvidenceManifest =>
  buildManifest({ evidenceId: `ev_${runId}`, runId, createdAt, verdict, artifacts });

interface FakeRun {
  manifest: EvidenceManifest | null;
  bytes: number;
}

interface FakeFs extends PruneFs {
  removed: string[];
}

/** A PruneFs over plain objects — no disk, so no way to reach the real evidence/. */
const fakeFs = (
  runs: Record<string, FakeRun>,
  options: { names?: string[]; throwOn?: string } = {},
): FakeFs => {
  const removed: string[] = [];
  const lookup = (dir: string): FakeRun | undefined => runs[path.basename(dir)];
  return {
    removed,
    listRunDirs: () => options.names ?? Object.keys(runs),
    readManifest: (dir) => lookup(dir)?.manifest ?? null,
    measure: (dir) => ({ bytes: lookup(dir)?.bytes ?? 0, files: 3 }),
    removeDir: (dir) => {
      if (path.basename(dir) === options.throwOn) throw new Error("EACCES");
      removed.push(dir);
    },
  };
};

const plan = (fs: PruneFs, policy: RetentionPolicy = DEFAULT_POLICY) =>
  planPrune({ root: ROOT, policy, nowMs: NOW, fs });

describe("the tier asymmetry", () => {
  it("DISCARDS a stale passing run but KEEPS a failing run of the same age, because a trace may be impossible to reproduce", () => {
    const fs = fakeFs({
      run_pass: { manifest: manifestFor("run_pass", "PASS", daysAgo(8)), bytes: 2048 },
      run_fail: { manifest: manifestFor("run_fail", "FAIL", daysAgo(8)), bytes: 900_000 },
    });
    const result = plan(fs);
    expect(result.doomed.map((e) => e.runId)).toEqual(["run_pass"]);
    expect(result.doomed[0]?.reason).toBe("age");
    expect(result.reclaimedBytes).toBe(2048);
    expect(result.keptBytes).toBe(900_000);
    expect(result.runCount).toBe(2);
  });

  it("gives an ERROR run the same long life as a failure, since a blind engine is the case we know least about", () => {
    const fs = fakeFs({
      run_err: { manifest: manifestFor("run_err", "ERROR", daysAgo(179)), bytes: 10 },
      run_warn: { manifest: manifestFor("run_warn", "PASS_WITH_WARNINGS", daysAgo(31)), bytes: 10 },
    });
    expect(plan(fs).doomed.map((e) => e.runId)).toEqual(["run_warn"]);
  });

  it("does eventually let a failure go once its own ceiling is passed", () => {
    const fs = fakeFs({
      run_fail: { manifest: manifestFor("run_fail", "FAIL", daysAgo(181)), bytes: 10 },
    });
    expect(plan(fs).doomed).toHaveLength(1);
  });

  it("NEVER selects by age for a tier whose ceiling is null", () => {
    const fs = fakeFs({
      run_old: { manifest: manifestFor("run_old", "PASS", daysAgo(9999)), bytes: 10 },
    });
    const policy: RetentionPolicy = {
      ...DEFAULT_POLICY,
      maxAgeDays: { pass: null, warning: null, fail: null, investigation: null },
    };
    expect(plan(fs, policy).doomed).toEqual([]);
  });

  it("treats a createdAt in the future as age zero rather than doing negative-age arithmetic", () => {
    const fs = fakeFs({
      run_skew: { manifest: manifestFor("run_skew", "PASS", daysAgo(-5)), bytes: 10 },
    });
    expect(plan(fs).doomed).toEqual([]);
  });
});

describe("privacy-flagged runs", () => {
  it("ages a flagged FAIL out on the SHORT privacy clock, not the tier's six months", () => {
    const fs = fakeFs({
      run_form: { manifest: manifestFor("run_form", "FAIL", daysAgo(20), [shot("review")]), bytes: 4096 },
    });
    const result = plan(fs);
    expect(result.doomed).toHaveLength(1);
    expect(result.doomed[0]?.reason).toBe("privacy");
  });

  it("REPEATS the privacy note in the plan, so nobody learns what a flagged frame held after it is gone", () => {
    const fs = fakeFs({
      run_form: { manifest: manifestFor("run_form", "FAIL", daysAgo(20), [shot("review")]), bytes: 4096 },
    });
    expect(plan(fs).doomed[0]?.privacyNote).toContain("review before sharing");
  });

  it("flags on the artifact risk even when the derived note is absent, so a wording change cannot un-flag a run", () => {
    const withoutNote = manifestFor("run_x", "FAIL", daysAgo(20), [shot("review")]);
    const fs = fakeFs({ run_x: { manifest: { ...withoutNote, privacyNote: null }, bytes: 10 } });
    expect(plan(fs).doomed[0]?.reason).toBe("privacy");
  });

  it("lets privacy SHORTEN a ceiling but never EXTEND one", () => {
    const fs = fakeFs({
      run_pass: { manifest: manifestFor("run_pass", "PASS", daysAgo(8), [shot("review")]), bytes: 10 },
    });
    // pass ages out at 7 days; a 14-day privacy window must not rescue it.
    const result = plan(fs);
    expect(result.doomed[0]?.reason).toBe("age");
  });

  it("falls back to the tier ceiling when the privacy clock is switched off", () => {
    const fs = fakeFs({
      run_form: { manifest: manifestFor("run_form", "FAIL", daysAgo(20), [shot("review")]), bytes: 10 },
    });
    expect(plan(fs, { ...DEFAULT_POLICY, privacyMaxAgeDays: null }).doomed).toEqual([]);
  });

  it("keeps an unflagged screenshot on the ordinary tier clock", () => {
    const fs = fakeFs({
      run_ok: { manifest: manifestFor("run_ok", "FAIL", daysAgo(20), [shot("low")]), bytes: 10 },
    });
    expect(plan(fs).doomed).toEqual([]);
  });
});

describe("a run we cannot identify", () => {
  it("REPORTS a directory with no readable manifest as unknown and LEAVES IT, because we do not know what it was", () => {
    const fs = fakeFs({ run_mystery: { manifest: null, bytes: 5000 } });
    const result = plan(fs);
    expect(result.doomed).toEqual([]);
    expect(result.unknown[0]).toMatchObject({ runId: "run_mystery", bytes: 5000, why: "no readable manifest.json" });
    expect(result.keptBytes).toBe(5000);
  });

  it("refuses to guess an age from an unparseable createdAt rather than calling it new or ancient", () => {
    const broken = { ...manifestFor("run_b", "PASS", daysAgo(1)), createdAt: "last tuesday" };
    const fs = fakeFs({ run_b: { manifest: broken, bytes: 1 } });
    const result = plan(fs);
    expect(result.doomed).toEqual([]);
    expect(result.unknown[0]?.why).toContain("unparseable createdAt");
  });

  it("treats an unrecognised tier as unknown instead of defaulting to the cheapest policy", () => {
    const broken = { ...manifestFor("run_t", "PASS", daysAgo(9999)), tier: "whatever" } as unknown as EvidenceManifest;
    const fs = fakeFs({ run_t: { manifest: broken, bytes: 1 } });
    expect(plan(fs).unknown[0]?.why).toContain("unknown retention tier");
  });

  it("survives a manifest whose artifacts array did not survive the write", () => {
    const truncated = { ...manifestFor("run_a", "PASS", daysAgo(8)), artifacts: undefined } as unknown as EvidenceManifest;
    const fs = fakeFs({ run_a: { manifest: truncated, bytes: 1 } });
    expect(plan(fs).doomed).toHaveLength(1);
  });

  it("deletes an unidentifiable run ONLY under the explicit flag, and labels the reason", () => {
    const fs = fakeFs({ run_mystery: { manifest: null, bytes: 5000 } });
    const result = plan(fs, { ...DEFAULT_POLICY, deleteUnreadable: true });
    expect(result.unknown).toEqual([]);
    expect(result.doomed[0]).toMatchObject({ reason: "unreadable", tier: null, ageDays: null, createdAt: null });
  });
});

describe("the size sweep", () => {
  const overCap = (bytes: number): RetentionPolicy => ({ ...DEFAULT_POLICY, maxTotalBytes: bytes });

  it("spends the cheapest tier first and oldest first, and STOPS the moment it is under the cap", () => {
    const fs = fakeFs({
      run_pass_new: { manifest: manifestFor("run_pass_new", "PASS", daysAgo(1)), bytes: 100 },
      run_pass_old: { manifest: manifestFor("run_pass_old", "PASS", daysAgo(6)), bytes: 100 },
      run_warn: { manifest: manifestFor("run_warn", "PASS_WITH_WARNINGS", daysAgo(29)), bytes: 100 },
    });
    const result = plan(fs, overCap(200));
    expect(result.doomed.map((e) => e.runId)).toEqual(["run_pass_old"]);
    expect(result.doomed[0]?.reason).toBe("size");
    expect(result.keptBytes).toBe(200);
    expect(result.sizeShortfallBytes).toBeNull();
  });

  it("reaches the warning tier only after the passing runs are gone", () => {
    const fs = fakeFs({
      run_pass: { manifest: manifestFor("run_pass", "PASS", daysAgo(1)), bytes: 100 },
      run_warn: { manifest: manifestFor("run_warn", "PASS_WITH_WARNINGS", daysAgo(1)), bytes: 100 },
    });
    expect(plan(fs, overCap(10)).doomed.map((e) => e.runId)).toEqual(["run_pass", "run_warn"]);
  });

  it("REPORTS a shortfall rather than eating a failure or a flagged run to satisfy a disk cap", () => {
    const fs = fakeFs({
      run_fail: { manifest: manifestFor("run_fail", "FAIL", daysAgo(1)), bytes: 500 },
      run_form: { manifest: manifestFor("run_form", "PASS", daysAgo(1), [shot("review")]), bytes: 400 },
    });
    const result = plan(fs, overCap(100));
    expect(result.doomed).toEqual([]);
    expect(result.sizeShortfallBytes).toBe(800);
  });

  it("counts unknown directories against the cap even though it may not spend them", () => {
    const fs = fakeFs({
      run_mystery: { manifest: null, bytes: 900 },
      run_pass: { manifest: manifestFor("run_pass", "PASS", daysAgo(1)), bytes: 100 },
    });
    const result = plan(fs, overCap(950));
    expect(result.doomed.map((e) => e.runId)).toEqual(["run_pass"]);
    expect(result.sizeShortfallBytes).toBeNull();
  });

  it("selects nothing by size when the tree already fits", () => {
    const fs = fakeFs({ run_pass: { manifest: manifestFor("run_pass", "PASS", daysAgo(1)), bytes: 100 } });
    const result = plan(fs, overCap(1000));
    expect(result.doomed).toEqual([]);
    expect(result.sizeShortfallBytes).toBeNull();
  });

  it("does not select by size at all when no cap was given", () => {
    const fs = fakeFs({ run_pass: { manifest: manifestFor("run_pass", "PASS", daysAgo(1)), bytes: 10 ** 9 } });
    expect(plan(fs).doomed).toEqual([]);
  });
});

describe("the evidence root is a boundary", () => {
  it("REFUSES a name that resolves outside the root instead of planning to delete it", () => {
    const fs = fakeFs({}, { names: ["../../etc", "/tmp", "."] });
    const result = plan(fs);
    expect(result.doomed).toEqual([]);
    expect(result.refused.map((r) => r.runId)).toEqual(["../../etc", "/tmp", "."]);
    expect(result.runCount).toBe(0);
  });

  it("never resolves the root itself, an absolute path, or a parent traversal into a deletable directory", () => {
    expect(resolveRunDir(ROOT, ".")).toBeNull();
    expect(resolveRunDir(ROOT, "..")).toBeNull();
    expect(resolveRunDir(ROOT, "/etc")).toBeNull();
    expect(resolveRunDir(ROOT, "run_1")).toBe(path.join(ROOT, "run_1"));
  });
});

describe("executePrune", () => {
  const stalePass = () =>
    fakeFs({ run_pass: { manifest: manifestFor("run_pass", "PASS", daysAgo(8)), bytes: 2048 } });

  it("DELETES NOTHING by default — the destructive path must be a word someone typed", () => {
    const fs = stalePass();
    const result = executePrune(plan(fs), fs);
    expect(result.dryRun).toBe(true);
    expect(fs.removed).toEqual([]);
    expect(result.deletedRunIds).toEqual([]);
    expect(result.reclaimedBytes).toBe(0);
  });

  it("removes exactly the planned directories once applied", () => {
    const fs = stalePass();
    const result = executePrune(plan(fs), fs, { apply: true });
    expect(result.dryRun).toBe(false);
    expect(fs.removed).toEqual([path.join(ROOT, "run_pass")]);
    expect(result.deletedRunIds).toEqual(["run_pass"]);
    expect(result.reclaimedBytes).toBe(2048);
  });

  it("RE-DERIVES each path and refuses a tampered plan entry rather than trusting the JSON it was handed", () => {
    const fs = stalePass();
    const tampered = plan(fs);
    const entry = tampered.doomed[0];
    if (entry) entry.dir = "/etc";
    const result = executePrune(tampered, fs, { apply: true });
    expect(fs.removed).toEqual([]);
    expect(result.refused[0]?.runId).toBe("run_pass");
  });

  it("surfaces refusals on a DRY RUN too, while they are still free", () => {
    const fs = fakeFs({}, { names: ["../escape"] });
    expect(executePrune(plan(fs), fs).refused.map((r) => r.why)).toEqual([
      "does not resolve inside the evidence root",
    ]);
  });

  it("records a delete that threw as failed and does NOT count it as reclaimed", () => {
    const fs = fakeFs(
      { run_pass: { manifest: manifestFor("run_pass", "PASS", daysAgo(8)), bytes: 2048 } },
      { throwOn: "run_pass" },
    );
    const result = executePrune(plan(fs), fs, { apply: true });
    expect(result.failed).toEqual([{ runId: "run_pass", error: "EACCES" }]);
    expect(result.deletedRunIds).toEqual([]);
    expect(result.reclaimedBytes).toBe(0);
  });

  it("stringifies a non-Error throw rather than losing the reason", () => {
    const fs = stalePass();
    const throwing: PruneFs = { ...fs, removeDir: () => { throw "nope"; } };
    expect(executePrune(plan(fs), throwing, { apply: true }).failed[0]?.error).toBe("nope");
  });
});

describe("the human-readable plan", () => {
  it("names every doomed run with its size and reason, the privacy note, the unknowns and the shortfall", () => {
    const fs = fakeFs({
      run_form: { manifest: manifestFor("run_form", "FAIL", daysAgo(20), [shot("review")]), bytes: 2_097_152 },
      run_mystery: { manifest: null, bytes: 1536 },
      run_keep: { manifest: manifestFor("run_keep", "FAIL", daysAgo(1)), bytes: 4096 },
    });
    const text = describePrunePlan(plan(fs, { ...DEFAULT_POLICY, maxTotalBytes: 1000 })).join("\n");
    expect(text).toContain("planning deletes nothing");
    expect(text).toContain("run_form");
    expect(text).toContain("2.0 MB");
    expect(text).toContain("[privacy]");
    expect(text).toContain("PRIVACY:");
    expect(text).toContain("we cannot tell what these were");
    expect(text).toContain("run_mystery");
    expect(text).toContain("size cap NOT met");
  });

  it("labels an unidentified run as tier- and age-unknown instead of printing a blank", () => {
    const fs = fakeFs({ run_mystery: { manifest: null, bytes: 1 } });
    const text = describePrunePlan(plan(fs, { ...DEFAULT_POLICY, deleteUnreadable: true })).join("\n");
    expect(text).toContain("tier unknown");
    expect(text).toContain("age unknown");
  });

  it("shows a refused name as REFUSED so it cannot be mistaken for a deletion", () => {
    const fs = fakeFs({}, { names: ["../escape"] });
    expect(describePrunePlan(plan(fs)).join("\n")).toContain("REFUSED ../escape");
  });

  it("scales bytes without pretending to precision it does not have", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3_145_728)).toBe("3.0 MB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatBytes(5 * 1024 ** 4)).toBe("5120.0 GB");
  });
});

describe("nodePruneFs", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "geoqa-prune-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("treats only DIRECTORIES as runs, so a loose verify.png or a symlink is never a prune candidate", () => {
    mkdirSync(path.join(root, "run_1"));
    writeFileSync(path.join(root, "verify.png"), "x");
    symlinkSync(path.join(root, "run_1"), path.join(root, "link_to_run"));
    expect(nodePruneFs().listRunDirs(root)).toEqual(["run_1"]);
  });

  it("measures nested artifacts, reads the manifest back, and removes a whole run directory", () => {
    const fs = nodePruneFs();
    const dir = path.join(root, "run_1");
    mkdirSync(path.join(dir, "screens"), { recursive: true });
    writeFileSync(path.join(dir, "console.json"), "12345");
    writeFileSync(path.join(dir, "screens", "step-1.png"), "abc");
    const manifest = manifestFor("run_1", "PASS", daysAgo(1));
    writeManifest(dir, manifest);

    const size = fs.measure(dir);
    expect(size.files).toBe(3); // console.json + nested png + manifest.json
    expect(size.bytes).toBeGreaterThan(8);
    expect(fs.readManifest(dir)?.runId).toBe("run_1");

    fs.removeDir(dir);
    expect(fs.listRunDirs(root)).toEqual([]);
  });

  it("reports an ABSENT root as nothing to prune", () => {
    expect(nodePruneFs().listRunDirs(path.join(root, "never-created"))).toEqual([]);
  });
});
