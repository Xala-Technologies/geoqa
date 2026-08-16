/**
 * Read an evidence package for a human looking at one run.
 *
 * The dashboard index keeps counts, not the step log — that is deliberate, and
 * this is the other half: open the run's own `run.json` and say what the
 * journey did, where it clicked, and which frames it kept. Inventing either
 * from the index would be a second derivation of one fact.
 *
 * Path safety is the same rule as the tenant root: `path.relative`, never
 * `startsWith`, and a pattern that refuses a slash before resolve is asked.
 */
import path from "node:path";
import { formatIssueBrief, issuesFromSteps, parseConsoleLog, type ConsoleLine, type EvidenceIssue } from "./issue.js";

const RUN_ID = /^run_[A-Za-z0-9._-]+$/;
const SHOT_LABEL = /^[A-Za-z0-9._-]+$/;

export interface PackageFs {
  readText: (path: string) => string;
  exists: (path: string) => boolean;
  list: (dir: string) => string[];
  readBytes: (path: string) => Buffer;
}

export interface EvidenceStep {
  index: number;
  action: string;
  label: string;
  outcome: string;
  detail: string;
  expected: string | null;
  observed: string | null;
  durationMs: number;
  severity: string;
}

export interface EvidenceShot {
  label: string;
  file: string;
  present: boolean;
}

export interface EvidencePackage {
  runId: string;
  target: string;
  journeyId: string;
  verdict: string;
  seed: number;
  writes: boolean;
  steps: EvidenceStep[];
  screenshots: EvidenceShot[];
  issues: EvidenceIssue[];
  console: ConsoleLine[];
  /** Paste-ready ticket body: verdict, reasons, console. */
  brief: string;
}

export type LoadResult = { ok: true; value: EvidencePackage } | { ok: false; error: string };

export function evidenceRunDir(root: string, runId: string): string | null {
  if (!RUN_ID.test(runId)) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, runId);
  const relative = path.relative(base, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

export function parseEvidencePackage(raw: unknown, files: string[]): EvidencePackage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.runId !== "string" || typeof rec.target !== "string") return null;
  if (typeof rec.journey !== "object" || rec.journey === null) return null;
  const journey = rec.journey as Record<string, unknown>;
  if (typeof journey.id !== "string" || !Array.isArray(journey.steps)) return null;

  const steps = journey.steps.map(parseStep).filter((s): s is EvidenceStep => s !== null);
  const names = new Set(files);
  const screenshots: EvidenceShot[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.action !== "screenshot" || !SHOT_LABEL.test(step.label)) continue;
    const file = `${step.label}.png`;
    screenshots.push({ label: step.label, file, present: names.has(file) });
    seen.add(step.label);
  }
  for (const file of files) {
    if (!file.endsWith(".png") || file.includes("/")) continue;
    const label = file.slice(0, -4);
    if (!SHOT_LABEL.test(label) || seen.has(label)) continue;
    screenshots.push({ label, file, present: true });
    seen.add(label);
  }
  screenshots.sort((a, b) => a.label.localeCompare(b.label));

  const verdict = typeof journey.verdict === "string" ? journey.verdict : "ERROR";
  const issues = issuesFromSteps(steps);
  const emptyConsole: ConsoleLine[] = [];
  return {
    runId: rec.runId,
    target: rec.target,
    journeyId: journey.id,
    verdict,
    seed: typeof journey.seed === "number" ? journey.seed : 0,
    writes: journey.writes === true,
    steps,
    screenshots,
    issues,
    console: emptyConsole,
    brief: formatIssueBrief({
      runId: rec.runId,
      target: rec.target,
      journeyId: journey.id,
      verdict,
      issues,
      console: emptyConsole,
    }),
  };
}

/**
 * The step log a dashboard can carry, from `run.json` alone.
 *
 * The index is counts. The run page is the log. A second HTTP request for that
 * log is how a signed-in console shows a visit with no evidence — dashboard.json
 * loaded and the package route did not. This reads the same file the run already
 * wrote, so opening a row cannot come up empty when the folder is there.
 */
export function readJourneyFromRunJson(
  root: string,
  runId: string,
  fs: { exists: (path: string) => boolean; read: (path: string) => string },
): EvidencePackage | null {
  const dir = evidenceRunDir(root, runId);
  if (dir === null) return null;
  const file = path.join(dir, "run.json");
  if (!fs.exists(file)) return null;
  try {
    const pack = parseEvidencePackage(JSON.parse(fs.read(file)), []);
    if (pack === null) return null;
    return {
      ...pack,
      screenshots: pack.screenshots.map((shot) => ({
        ...shot,
        present: fs.exists(path.join(dir, shot.file)),
      })),
    };
  } catch {
    return null;
  }
}

export function loadEvidencePackage(root: string, runId: string, fs: PackageFs): LoadResult {
  const dir = evidenceRunDir(root, runId);
  if (dir === null) return { ok: false, error: "that is not a run id" };
  const file = path.join(dir, "run.json");
  if (!fs.exists(file)) return { ok: false, error: "no evidence package for this run" };
  try {
    const pack = parseEvidencePackage(JSON.parse(fs.readText(file)), fs.list(dir));
    if (pack === null) return { ok: false, error: "run.json did not describe a journey" };
    const consoleFile = path.join(dir, "console.json");
    let consoleLines: ConsoleLine[] = [];
    if (fs.exists(consoleFile)) {
      try {
        consoleLines = parseConsoleLog(JSON.parse(fs.readText(consoleFile)));
      } catch {
        consoleLines = [];
      }
    }
    return {
      ok: true,
      value: {
        ...pack,
        console: consoleLines,
        brief: formatIssueBrief({
          runId: pack.runId,
          target: pack.target,
          journeyId: pack.journeyId,
          verdict: pack.verdict,
          issues: pack.issues,
          console: consoleLines,
        }),
      },
    };
  } catch {
    return { ok: false, error: "run.json could not be read" };
  }
}

export function loadEvidenceShot(
  root: string,
  runId: string,
  label: string,
  fs: PackageFs,
): { body: Buffer; type: string } | null {
  if (!SHOT_LABEL.test(label)) return null;
  const loaded = loadEvidencePackage(root, runId, fs);
  if (!loaded.ok) return null;
  const shot = loaded.value.screenshots.find((s) => s.label === label);
  if (shot === undefined || !shot.present) return null;
  const dir = evidenceRunDir(root, runId);
  if (dir === null) return null;
  const full = path.resolve(dir, shot.file);
  const relative = path.relative(dir, full);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.includes("/")) return null;
  if (!fs.exists(full)) return null;
  return { body: fs.readBytes(full), type: "image/png" };
}

function parseStep(raw: unknown): EvidenceStep | null {
  if (typeof raw !== "object" || raw === null) return null;
  const step = raw as Record<string, unknown>;
  if (
    typeof step.index !== "number" ||
    typeof step.action !== "string" ||
    typeof step.label !== "string" ||
    typeof step.outcome !== "string"
  ) {
    return null;
  }
  return {
    index: step.index,
    action: step.action,
    label: step.label,
    outcome: step.outcome,
    detail: typeof step.detail === "string" ? step.detail : "",
    expected: typeof step.expected === "string" ? step.expected : null,
    observed: typeof step.observed === "string" ? step.observed : null,
    durationMs: typeof step.durationMs === "number" ? step.durationMs : 0,
    severity: typeof step.severity === "string" ? step.severity : "",
  };
}
