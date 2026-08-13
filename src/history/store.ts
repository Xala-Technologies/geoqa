/**
 * The run index on disk, and the queries that make it worth keeping.
 *
 * `<evidenceRoot>/runs.jsonl`, one JSON object per line, appended as each run
 * finishes. Under a tenant's evidence root when a run is scoped, so a tenant's history
 * is inside the directory that is already isolated from every other tenant's — the
 * index inherits the containment proven in `tenant/registry.ts` rather than inventing
 * its own.
 *
 * Every filesystem touch goes through `HistoryFs`, injected, for the same reason
 * `PruneFs` exists: a test must be able to exercise a corrupt index, a missing file
 * and a half-written line without arranging any of them on a real disk.
 *
 * The rule that shapes all of it: **appending must never be able to fail a run.** A
 * run that verified a site correctly, wrote its evidence, and then could not append a
 * line to a cache has not failed at anything a user cares about. So `appendRun`
 * reports its problem and returns; it does not throw.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseRunRecord, type RunRecord } from "./records.js";

export const HISTORY_FILE = "runs.jsonl";

export interface HistoryFs {
  exists: (p: string) => boolean;
  read: (p: string) => string;
  append: (p: string, text: string) => void;
  write: (p: string, text: string) => void;
  mkdir: (p: string) => void;
  listDirs: (p: string) => string[];
}

export const nodeHistoryFs: HistoryFs = {
  exists: existsSync,
  read: (p) => readFileSync(p, "utf8"),
  append: (p, text) => appendFileSync(p, text),
  write: (p, text) => writeFileSync(p, text),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  listDirs: (p) => readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
};

export const historyPath = (evidenceRoot: string): string => path.join(evidenceRoot, HISTORY_FILE);

/**
 * Append one run. Returns the problem it hit, or null.
 *
 * A trailing newline per line, always — an append that omitted it would join two
 * records into one unparseable line, and the NEXT run would be the one that appeared
 * broken. That is the kind of defect that gets attributed to the wrong change.
 */
export function appendRun(evidenceRoot: string, record: RunRecord, fs: HistoryFs = nodeHistoryFs): string | null {
  try {
    fs.mkdir(evidenceRoot);
    fs.append(historyPath(evidenceRoot), `${JSON.stringify(record)}\n`);
    return null;
  } catch (e) {
    // Reported, never thrown. A run that verified a site correctly and then could not
    // write a cache line has not failed at anything a user cares about.
    return `could not append to the run index: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export interface HistoryReadResult {
  records: RunRecord[];
  /** Lines that could not be parsed. A half-written last line is normal, not alarming. */
  skipped: number;
}

/**
 * Read the index, newest last.
 *
 * A missing file is an empty history, not an error: a tenant's first run has nothing
 * to have appended yet, and refusing here would make the history the thing that
 * prevents anybody from having one.
 */
export function readHistory(evidenceRoot: string, fs: HistoryFs = nodeHistoryFs): HistoryReadResult {
  const file = historyPath(evidenceRoot);
  if (!fs.exists(file)) return { records: [], skipped: 0 };
  let text: string;
  try {
    text = fs.read(file);
  } catch {
    return { records: [], skipped: 0 };
  }
  const records: RunRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const record = parseRunRecord(line);
    if (record === null) skipped += 1;
    else records.push(record);
  }
  return { records, skipped };
}

/**
 * Rebuild the index from the runs that actually exist.
 *
 * This is what makes the index safe to treat as a cache rather than as truth. Every
 * `run.json` in the tree is the authority on its own run, so a corrupt, truncated,
 * hand-edited or simply deleted index costs nothing permanent.
 *
 * `reduce` is passed in rather than imported so this file needs no knowledge of a run
 * result's shape — it walks directories and writes lines; interpreting a `run.json` is
 * `records.ts`'s job and the CLI's.
 *
 * Ordered by run id, which sorts chronologically because a run id is
 * `run_<epochMs>_<slug>`. That is worth stating: the ordering is a property of the
 * naming scheme, so a change to run ids would silently unsort the history.
 */
export function rebuildHistory(
  evidenceRoot: string,
  reduce: (runJson: unknown, runId: string) => RunRecord | null,
  fs: HistoryFs = nodeHistoryFs,
): { written: number; unreadable: string[] } {
  const unreadable: string[] = [];
  const records: RunRecord[] = [];
  let dirs: string[];
  try {
    dirs = fs.listDirs(evidenceRoot).filter((d) => d.startsWith("run_")).sort();
  } catch {
    dirs = [];
  }
  for (const dir of dirs) {
    const file = path.join(evidenceRoot, dir, "run.json");
    if (!fs.exists(file)) {
      // A run directory with no manifest is reported and left alone, the same way
      // `evidence prune` treats one: not knowing what something was is a reason to
      // look, not a licence to omit it silently.
      unreadable.push(`${dir}: no run.json`);
      continue;
    }
    try {
      const record = reduce(JSON.parse(fs.read(file)), dir);
      if (record === null) unreadable.push(`${dir}: run.json did not describe a run`);
      else records.push(record);
    } catch (e) {
      unreadable.push(`${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  fs.mkdir(evidenceRoot);
  fs.write(historyPath(evidenceRoot), records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return { written: records.length, unreadable };
}

export interface HistoryFilter {
  target?: string | undefined;
  profileId?: string | undefined;
  journeyId?: string | undefined;
  verdict?: string | undefined;
  /** Only runs at or after this ISO timestamp. */
  since?: string | undefined;
}

export function filterHistory(records: RunRecord[], filter: HistoryFilter): RunRecord[] {
  return records.filter(
    (r) =>
      (filter.target === undefined || r.target === filter.target) &&
      (filter.profileId === undefined || r.profileId === filter.profileId) &&
      (filter.journeyId === undefined || r.journeyId === filter.journeyId) &&
      (filter.verdict === undefined || r.verdict === filter.verdict) &&
      (filter.since === undefined || r.startedAt >= filter.since),
  );
}

export interface Regression {
  /** The check that changed. */
  label: string;
  profileId: string;
  journeyId: string;
  target: string;
  /** The most recent run where it did NOT produce a finding. */
  lastGood: { runId: string; startedAt: string };
  /** The oldest run since then where it did. */
  firstBad: { runId: string; startedAt: string };
}

/**
 * Checks that used to pass and now do not.
 *
 * The payoff of keeping an index at all, and the reason it groups by
 * profile + journey + target: "the h1 check started failing" is only meaningful for a
 * fixed combination of those three. The same check on a different page is a different
 * question, and merging them is how a real regression gets averaged into noise.
 *
 * Deliberately narrow in two ways.
 *
 * A run whose verdict is `ERROR` is SKIPPED, not treated as a failure. `ERROR` means
 * geoqa could not read the page — an instrumentation failure — and reading it as "the
 * check regressed" would report our own defect as the site's. That distinction is the
 * one this whole codebase is built around and it would be absurd to drop it here.
 *
 * Only the transition is reported, not every subsequent failure. A check that broke on
 * Monday and has failed every day since is ONE regression with a Monday date, not
 * five. A list that grows while nothing new breaks is a list nobody reads.
 */
export function findRegressions(records: RunRecord[]): Regression[] {
  const byScope = new Map<string, RunRecord[]>();
  for (const record of records) {
    // Instrumentation failures carry no information about whether a check passed.
    if (record.verdict === "ERROR") continue;
    const key = `${record.profileId} ${record.journeyId} ${record.target}`;
    byScope.set(key, [...(byScope.get(key) ?? []), record]);
  }

  const regressions: Regression[] = [];
  for (const [key, scoped] of byScope) {
    const runs = [...scoped].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const [profileId = "", journeyId = "", target = ""] = key.split(" ");
    // Every label that has ever failed in this scope; each is asked about once.
    const labels = new Set(runs.flatMap((r) => r.findings.labels));
    for (const label of labels) {
      let lastGood: RunRecord | null = null;
      for (const run of runs) {
        const failed = run.findings.labels.includes(label);
        if (!failed) {
          lastGood = run;
          continue;
        }
        // A failure with no earlier pass is not a regression — it may never have
        // worked, and calling that a regression sends somebody looking for a change
        // that does not exist.
        if (lastGood !== null) {
          regressions.push({
            label,
            profileId,
            journeyId,
            target,
            lastGood: { runId: lastGood.runId, startedAt: lastGood.startedAt },
            firstBad: { runId: run.runId, startedAt: run.startedAt },
          });
        }
        // Only the transition. Everything after it is the same regression.
        break;
      }
    }
  }
  return regressions.sort((a, b) => b.firstBad.startedAt.localeCompare(a.firstBad.startedAt));
}

export interface HistorySummary {
  runs: number;
  byVerdict: Record<string, number>;
  /** Mean overall confidence, or null with no runs — never 0. */
  meanConfidence: number | null;
  first: string | null;
  last: string | null;
}

export function summariseHistory(records: RunRecord[]): HistorySummary {
  const byVerdict: Record<string, number> = {};
  for (const r of records) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  const times = records.map((r) => r.startedAt).sort();
  return {
    runs: records.length,
    byVerdict,
    // Null rather than 0 for an empty history, for the reason every rate in this
    // codebase returns null on an empty denominator: "no runs" and "runs that scored
    // zero" are different facts and only one of them is bad news.
    meanConfidence:
      records.length === 0 ? null : Math.round(records.reduce((sum, r) => sum + r.confidence.overall, 0) / records.length),
    first: times[0] ?? null,
    last: times[times.length - 1] ?? null,
  };
}
