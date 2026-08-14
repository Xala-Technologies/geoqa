import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HISTORY_SCHEMA_VERSION, parseRunRecord, toRunRecord, type RunRecord } from "../records.js";
import {
  appendRun,
  filterHistory,
  findRegressions,
  historyPath,
  nodeHistoryFs,
  readHistory,
  rebuildHistory,
  summariseHistory,
  type HistoryFs,
} from "../store.js";
import type { GeoQaRunResult } from "../../findings/types.js";

/** An in-memory tree, so no test arranges a corrupt index on a real disk. */
const memoryFs = (files: Record<string, string> = {}, dirs: Record<string, string[]> = {}): HistoryFs & { files: Record<string, string> } => ({
  files,
  exists: (p) => p in files,
  read: (p) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p] as string;
  },
  append: (p, text) => {
    files[p] = (files[p] ?? "") + text;
  },
  write: (p, text) => {
    files[p] = text;
  },
  mkdir: () => {},
  listDirs: (p) => dirs[p] ?? [],
});

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  schemaVersion: HISTORY_SCHEMA_VERSION,
  runId: "run_1000_oslo-desktop",
  tenantId: null,
  target: "https://a.test/",
  profileId: "oslo-desktop",
  journeyId: "landing-page",
  verdict: "PASS",
  startedAt: "2026-08-13T10:00:00.000Z",
  durationMs: 1000,
  seed: 7,
  engine: "playwright",
  evidenceId: "ev_1000_oslo-desktop",
  findings: { total: 0, bySeverity: {}, byCategory: {}, labels: [] },
  confidence: { overall: 100, geo: 100, browser: 100, journey: 100, evidence: 100 },
  geo: {
    requestedCountry: "NO",
    requestedCity: "Oslo",
    observedCountry: "NO",
    observedCity: "Oslo",
    country: "match",
    city: "match",
    egressHeld: "match",
    agreement: "unverified",
  },
  latencyMs: 120,
  vitals: { lcp: 400, cls: 0, ttfb: 30, inp: null },
  ...over,
});

describe("toRunRecord", () => {
  const result = (over: Partial<GeoQaRunResult> = {}): GeoQaRunResult =>
    ({
      schemaVersion: 1,
      runId: "run_1_oslo-desktop",
      target: "https://a.test/",
      profileId: "oslo-desktop",
      journeyId: "landing-page",
      verdict: "FAIL",
      startedAt: "2026-08-13T10:00:00.000Z",
      durationMs: 5,
      evidenceId: "ev_1",
      findings: [
        { severity: "critical", category: "functional", stepLabel: "has a primary heading" },
        { severity: "critical", category: "functional", stepLabel: "has a primary heading" },
        { severity: "medium", category: "http", stepLabel: "no 4xx" },
      ],
      confidence: { overall: 50, geo: 100, browser: 100, journey: 40, evidence: 90, searchObservation: null, notes: [] },
      geo: {
        network: {
          requested: { country: "NO", city: "Oslo" },
          observed: { ip: null, country: "NO", city: "Lysaker", region: null, org: null, timezone: null, latencyMs: 88 },
          country: { verdict: "match", reasons: [] },
          city: { verdict: "unverified", reasons: [] },
          egressHeld: { verdict: "match", reasons: [] },
          corroborating: null,
          agreement: { verdict: "unverified", reasons: [] },
        },
      },
      ...over,
    }) as unknown as GeoQaRunResult;

  it("counts and groups findings instead of copying them", () => {
    // The full text is already in the run's evidence; duplicating it would make the
    // index the biggest thing in the tree while adding nothing a reader could not get
    // by opening the run.
    const r = toRunRecord(result(), { tenantId: "acme", seed: 9, engine: "playwright" });
    expect(r.findings.total).toBe(3);
    expect(r.findings.bySeverity).toEqual({ critical: 2, medium: 1 });
    expect(r.findings.byCategory).toEqual({ functional: 2, http: 1 });
  });

  it("keeps step LABELS, de-duplicated, because regressions are a question about labels", () => {
    const r = toRunRecord(result(), { tenantId: null, seed: 1, engine: "playwright" });
    expect(r.findings.labels).toEqual(["has a primary heading", "no 4xx"]);
  });

  it("keeps the SEED, so a run found in the index can be replayed", () => {
    // A regression is only actionable if the older run can be re-run, and the seed is
    // what makes a run with human pacing repeat exactly.
    expect(toRunRecord(result(), { tenantId: null, seed: 424_242, engine: "playwright" }).seed).toBe(424_242);
  });

  it("preserves NULL vitals rather than defaulting them to zero", () => {
    // A metric that was not measured must not become a zero in a trend, which would
    // show a page getting faster the moment it stopped being measurable.
    const unmeasured = toRunRecord(result(), { tenantId: null, seed: 1, engine: "playwright" });
    expect(unmeasured.vitals).toEqual({ lcp: null, cls: null, ttfb: null, inp: null });
    const measured = toRunRecord(result(), { tenantId: null, seed: 1, engine: "playwright", vitals: { lcp: 900, cls: 0, ttfb: 20, inp: null } });
    expect(measured.vitals.lcp).toBe(900);
    expect(measured.vitals.inp).toBeNull();
  });

  it("carries the per-axis geo verdicts and the observed values", () => {
    const r = toRunRecord(result(), { tenantId: null, seed: 1, engine: "playwright" });
    expect(r.geo.city).toBe("unverified");
    expect(r.geo.observedCity).toBe("Lysaker");
    expect(r.latencyMs).toBe(88);
  });
});

describe("parseRunRecord", () => {
  it("reads a line it wrote", () => {
    expect(parseRunRecord(JSON.stringify(record()))?.runId).toBe("run_1000_oslo-desktop");
  });

  it("returns null for a half-written line rather than throwing", () => {
    // A process killed mid-append leaves one, and throwing would make one interrupted
    // run destroy the readability of every run before it.
    expect(parseRunRecord('{"runId":"run_1","start')).toBeNull();
    expect(parseRunRecord("not json")).toBeNull();
    expect(parseRunRecord("[1,2]")).toBeNull();
    expect(parseRunRecord("null")).toBeNull();
  });

  it("refuses a record missing a field every query depends on", () => {
    // Guessing at them would put a fabricated run in a trend.
    expect(parseRunRecord(JSON.stringify({ startedAt: "x", verdict: "PASS" }))).toBeNull();
    expect(parseRunRecord(JSON.stringify({ runId: "r", verdict: "PASS" }))).toBeNull();
    expect(parseRunRecord(JSON.stringify({ runId: "r", startedAt: "x" }))).toBeNull();
  });
});

describe("appendRun", () => {
  it("appends one newline-terminated line per run", () => {
    // Without the newline two records would join into one unparseable line, and the
    // NEXT run would be the one that appeared broken.
    const fs = memoryFs();
    expect(appendRun("/e", record({ runId: "run_1_a" }), fs)).toBeNull();
    expect(appendRun("/e", record({ runId: "run_2_b" }), fs)).toBeNull();
    const text = fs.files[historyPath("/e")] as string;
    expect(text.split("\n").filter((l) => l !== "")).toHaveLength(2);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("REPORTS a failure instead of throwing", () => {
    // A run that verified a site correctly and wrote its evidence has not failed at
    // anything a user cares about if a cache line could not be written.
    const failing: HistoryFs = { ...memoryFs(), append: () => { throw new Error("EROFS: read-only"); } };
    const problem = appendRun("/e", record(), failing);
    expect(problem).toContain("could not append");
    expect(problem).toContain("EROFS");
  });
});

describe("readHistory", () => {
  it("treats a missing index as an empty history, not an error", () => {
    // A tenant's first run has nothing to have appended yet, and refusing would make
    // the history the thing that prevents anybody from having one.
    expect(readHistory("/e", memoryFs())).toEqual({ records: [], skipped: 0 });
  });

  it("skips unparseable lines and COUNTS them", () => {
    const fs = memoryFs({ [historyPath("/e")]: `${JSON.stringify(record())}\n{"half\n${JSON.stringify(record({ runId: "run_2_b" }))}\n` });
    const result = readHistory("/e", fs);
    expect(result.records).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  it("survives an unreadable file rather than propagating", () => {
    const fs: HistoryFs = { ...memoryFs({ [historyPath("/e")]: "x" }), read: () => { throw new Error("EACCES"); } };
    expect(readHistory("/e", fs)).toEqual({ records: [], skipped: 0 });
  });
});

describe("rebuildHistory — what makes the index a CACHE and not the truth", () => {
  it("rebuilds from the run.json files on disk", () => {
    const fs = memoryFs(
      {
        "/e/run_1000_a/run.json": JSON.stringify({ runId: "run_1000_a" }),
        "/e/run_2000_b/run.json": JSON.stringify({ runId: "run_2000_b" }),
      },
      { "/e": ["run_1000_a", "run_2000_b", "visitors"] },
    );
    const result = rebuildHistory("/e", (doc) => record({ runId: (doc as { runId: string }).runId }), fs);
    expect(result.written).toBe(2);
    expect(result.unreadable).toEqual([]);
    // And it OVERWRITES, so a corrupt index is fully replaced rather than appended to.
    expect((fs.files[historyPath("/e")] as string).split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("REPORTS a run directory it could not read rather than omitting it silently", () => {
    // Same rule as `evidence prune`: not knowing what something was is a reason to
    // look, not a licence to drop it from the history.
    const fs = memoryFs(
      { "/e/run_2000_b/run.json": "{ not json" },
      { "/e": ["run_1000_a", "run_2000_b"] },
    );
    const result = rebuildHistory("/e", () => record(), fs);
    expect(result.written).toBe(0);
    expect(result.unreadable).toHaveLength(2);
    expect(result.unreadable[0]).toContain("no run.json");
    expect(result.unreadable[1]).toContain("run_2000_b");
  });

  it("reports a run.json that does not describe a run", () => {
    const fs = memoryFs({ "/e/run_1_a/run.json": "{}" }, { "/e": ["run_1_a"] });
    const result = rebuildHistory("/e", () => null, fs);
    expect(result.unreadable[0]).toContain("did not describe a run");
  });

  it("writes an empty index when the tree cannot be listed, rather than failing", () => {
    const fs: HistoryFs = { ...memoryFs(), listDirs: () => { throw new Error("ENOENT"); } };
    expect(rebuildHistory("/e", () => record(), fs).written).toBe(0);
  });
});

describe("filterHistory", () => {
  const records = [
    record({ runId: "r1", target: "https://a.test/", journeyId: "landing-page", verdict: "PASS", startedAt: "2026-08-01T00:00:00.000Z" }),
    record({ runId: "r2", target: "https://b.test/", journeyId: "browse", verdict: "FAIL", startedAt: "2026-08-10T00:00:00.000Z" }),
    record({ runId: "r3", target: "https://a.test/", journeyId: "browse", verdict: "PASS", profileId: "bergen-mobile", startedAt: "2026-08-12T00:00:00.000Z" }),
  ];

  it("filters on each field, and an absent filter matches everything", () => {
    expect(filterHistory(records, {})).toHaveLength(3);
    expect(filterHistory(records, { target: "https://a.test/" }).map((r) => r.runId)).toEqual(["r1", "r3"]);
    expect(filterHistory(records, { journeyId: "browse" }).map((r) => r.runId)).toEqual(["r2", "r3"]);
    expect(filterHistory(records, { verdict: "FAIL" }).map((r) => r.runId)).toEqual(["r2"]);
    expect(filterHistory(records, { profileId: "bergen-mobile" }).map((r) => r.runId)).toEqual(["r3"]);
  });

  it("filters from a timestamp inclusively", () => {
    expect(filterHistory(records, { since: "2026-08-10T00:00:00.000Z" }).map((r) => r.runId)).toEqual(["r2", "r3"]);
  });

  it("combines filters", () => {
    expect(filterHistory(records, { target: "https://a.test/", journeyId: "browse" }).map((r) => r.runId)).toEqual(["r3"]);
  });
});

describe("findRegressions", () => {
  const at = (iso: string, labels: string[], over: Partial<RunRecord> = {}): RunRecord =>
    record({
      runId: `run_${Date.parse(iso)}_x`,
      startedAt: iso,
      verdict: labels.length > 0 ? "FAIL" : "PASS",
      findings: { total: labels.length, bySeverity: {}, byCategory: {}, labels },
      ...over,
    });

  it("finds a check that used to pass and now does not", () => {
    const found = findRegressions([
      at("2026-08-01T00:00:00.000Z", []),
      at("2026-08-02T00:00:00.000Z", ["has a primary heading"]),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.label).toBe("has a primary heading");
    expect(found[0]?.lastGood.startedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(found[0]?.firstBad.startedAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("reports the TRANSITION once, not every failure since", () => {
    // A check that broke on Monday and has failed every day since is one regression
    // with a Monday date, not five. A list that grows while nothing new breaks is a
    // list nobody reads.
    const found = findRegressions([
      at("2026-08-01T00:00:00.000Z", []),
      at("2026-08-02T00:00:00.000Z", ["h1"]),
      at("2026-08-03T00:00:00.000Z", ["h1"]),
      at("2026-08-04T00:00:00.000Z", ["h1"]),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.firstBad.startedAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("is NOT a regression when the check never passed", () => {
    // It may never have worked, and calling that a regression sends somebody looking
    // for a change that does not exist.
    expect(findRegressions([at("2026-08-01T00:00:00.000Z", ["h1"]), at("2026-08-02T00:00:00.000Z", ["h1"])])).toEqual([]);
  });

  it("SKIPS an ERROR run instead of reading it as a failed check", () => {
    // ERROR means geoqa could not read the page — our defect. Reading it as "the check
    // regressed" would report our instrumentation failure as the site's.
    const found = findRegressions([
      at("2026-08-01T00:00:00.000Z", []),
      at("2026-08-02T00:00:00.000Z", ["h1"], { verdict: "ERROR" }),
    ]);
    expect(found).toEqual([]);
  });

  it("does not merge different targets, profiles or journeys", () => {
    // "The h1 check started failing" is only meaningful for a fixed combination of the
    // three. Merging them is how a real regression gets averaged into noise.
    const found = findRegressions([
      at("2026-08-01T00:00:00.000Z", [], { target: "https://a.test/" }),
      at("2026-08-02T00:00:00.000Z", ["h1"], { target: "https://b.test/" }),
    ]);
    expect(found).toEqual([]);
  });

  it("orders newest breakage first", () => {
    const found = findRegressions([
      at("2026-08-01T00:00:00.000Z", [], { journeyId: "a" }),
      at("2026-08-02T00:00:00.000Z", ["x"], { journeyId: "a" }),
      at("2026-08-03T00:00:00.000Z", [], { journeyId: "b" }),
      at("2026-08-04T00:00:00.000Z", ["y"], { journeyId: "b" }),
    ]);
    expect(found.map((r) => r.label)).toEqual(["y", "x"]);
  });

  it("recovers: a check that broke and was fixed and broke again reports the LATEST break", () => {
    const found = findRegressions([
      at("2026-08-01T00:00:00.000Z", []),
      at("2026-08-02T00:00:00.000Z", ["h1"]),
      at("2026-08-03T00:00:00.000Z", []),
    ]);
    // The break is real and is reported; the later pass does not erase that it happened.
    expect(found).toHaveLength(1);
    expect(found[0]?.firstBad.startedAt).toBe("2026-08-02T00:00:00.000Z");
  });
});

describe("summariseHistory", () => {
  it("counts verdicts and averages confidence", () => {
    const s = summariseHistory([
      record({ verdict: "PASS", confidence: { overall: 100, geo: 1, browser: 1, journey: 1, evidence: 1 } }),
      record({ verdict: "FAIL", confidence: { overall: 50, geo: 1, browser: 1, journey: 1, evidence: 1 } }),
    ]);
    expect(s.runs).toBe(2);
    expect(s.byVerdict).toEqual({ PASS: 1, FAIL: 1 });
    expect(s.meanConfidence).toBe(75);
  });

  it("reports NULL confidence for an empty history, never zero", () => {
    // "No runs" and "runs that scored zero" are different facts and only one of them
    // is bad news.
    const s = summariseHistory([]);
    expect(s.runs).toBe(0);
    expect(s.meanConfidence).toBeNull();
    expect(s.first).toBeNull();
    expect(s.last).toBeNull();
  });

  it("reports the first and last run times", () => {
    const s = summariseHistory([
      record({ startedAt: "2026-08-05T00:00:00.000Z" }),
      record({ startedAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(s.first).toBe("2026-08-01T00:00:00.000Z");
    expect(s.last).toBe("2026-08-05T00:00:00.000Z");
  });
});

describe("nodeHistoryFs", () => {
  // The real adapter, exercised against a real temp tree — the same treatment
  // `nodePruneFs` gets. Every other test in this file replaces it, so without this the
  // one thing that actually touches disk would be the one thing never run.
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "geoqa-history-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("appends, reads, overwrites and lists real directories", () => {
    const nested = path.join(root, "tenant");
    nodeHistoryFs.mkdir(nested);
    const file = historyPath(nested);
    expect(nodeHistoryFs.exists(file)).toBe(false);

    nodeHistoryFs.append(file, "one\n");
    nodeHistoryFs.append(file, "two\n");
    expect(nodeHistoryFs.exists(file)).toBe(true);
    expect(nodeHistoryFs.read(file)).toBe("one\ntwo\n");

    // write REPLACES, which is what makes a rebuild able to drop a corrupt line.
    nodeHistoryFs.write(file, "three\n");
    expect(nodeHistoryFs.read(file)).toBe("three\n");

    mkdirSync(path.join(nested, "run_1_a"), { recursive: true });
    writeFileSync(path.join(nested, "not-a-dir.txt"), "x");
    // Directories only: a stray file must not be mistaken for a run.
    expect(nodeHistoryFs.listDirs(nested)).toEqual(["run_1_a"]);
  });

  it("appends and rebuilds end to end through the real filesystem", () => {
    expect(appendRun(root, record({ runId: "run_1_a" }))).toBeNull();
    expect(readHistory(root).records.map((r) => r.runId)).toEqual(["run_1_a"]);

    mkdirSync(path.join(root, "run_2_b"), { recursive: true });
    writeFileSync(path.join(root, "run_2_b", "run.json"), JSON.stringify({ runId: "run_2_b" }));
    const rebuilt = rebuildHistory(root, (doc) => record({ runId: (doc as { runId: string }).runId }));
    expect(rebuilt.written).toBe(1);
    // The rebuild is authoritative: run_1_a had no directory, so it is gone.
    expect(readHistory(root).records.map((r) => r.runId)).toEqual(["run_2_b"]);
  });
});

describe("things thrown that are not Errors", () => {
  // A filesystem shim, a native binding or a rejected promise can throw a string. `e.message`
  // on one is undefined, and an index error reading "could not append to the run index:
  // undefined" sends the reader looking for a bug in the reporter rather than the disk.
  it("still names the cause when append throws a bare string", () => {
    const failing: HistoryFs = { ...memoryFs(), append: () => { throw "disk quota exceeded"; } };
    expect(appendRun("/e", record(), failing)).toContain("disk quota exceeded");
  });

  it("still names the run and the cause when a rebuild read throws a bare string", () => {
    const fs: HistoryFs = {
      ...memoryFs({}, { "/e": ["run_2000_b"] }),
      exists: () => true,
      read: () => { throw "I/O error 5"; },
    };
    const result = rebuildHistory("/e", () => record(), fs);
    expect(result.unreadable).toEqual(["run_2000_b: I/O error 5"]);
  });
});
