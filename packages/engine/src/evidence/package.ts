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
import type { Artifact, EvidenceManifest } from "./manifest.js";
import { MANIFEST_FILE } from "./store.js";

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
  const declared = Array.isArray(journey.screenshots) ? journey.screenshots : [];
  for (const label of declared) {
    if (typeof label !== "string" || !SHOT_LABEL.test(label) || seen.has(label)) continue;
    const file = `${label}.png`;
    screenshots.push({ label, file, present: names.has(file) });
    seen.add(label);
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
  fs: {
    exists: (path: string) => boolean;
    read: (path: string) => string;
    /** File names in the run directory. Absent or throwing is not a missing journey. */
    listFiles?: (dir: string) => string[];
  },
): EvidencePackage | null {
  const dir = evidenceRunDir(root, runId);
  if (dir === null) return null;
  const file = path.join(dir, "run.json");
  if (!fs.exists(file)) return null;
  try {
    let files: string[] = [];
    try {
      files = fs.listFiles?.(dir) ?? [];
    } catch {
      files = [];
    }
    const pack = parseEvidencePackage(JSON.parse(fs.read(file)), files);
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
  // Resolved ONCE, before the package is read. It used to be resolved again
  // after, which produced a second `dir === null` guard that could not fire —
  // `loadEvidencePackage` had already refused the same run id on the same
  // check. A guard with no reachable failure is a claim that the invariant
  // above it might not hold, so the resolution moved rather than the check.
  const dir = evidenceRunDir(root, runId);
  if (dir === null) return null;
  const loaded = loadEvidencePackage(root, runId, fs);
  if (!loaded.ok) return null;
  const shot = loaded.value.screenshots.find((s) => s.label === label);
  if (shot === undefined || !shot.present) return null;
  const full = path.resolve(dir, shot.file);
  const relative = path.relative(dir, full);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.includes("/")) return null;
  if (!fs.exists(full)) return null;
  return { body: fs.readBytes(full), type: "image/png" };
}

/** Artifact kinds agents fetch by manifest path — not screenshots (use `loadEvidenceShot`). */
export const EVIDENCE_ARTIFACT_KINDS = ["snapshot", "trace", "har", "vitals", "console", "network", "a11y", "content"] as const;
export type EvidenceArtifactKind = (typeof EVIDENCE_ARTIFACT_KINDS)[number];

export type LoadedEvidenceArtifact =
  | {
      ok: true;
      kind: EvidenceArtifactKind;
      label: string;
      path: string;
      mime: string;
      bytes: number;
      encoding: "text";
      text: string;
    }
  | {
      ok: true;
      kind: EvidenceArtifactKind;
      label: string;
      path: string;
      mime: string;
      bytes: number;
      encoding: "json";
      value: unknown;
    }
  | {
      ok: true;
      kind: EvidenceArtifactKind;
      label: string;
      path: string;
      mime: string;
      bytes: number;
      encoding: "base64";
      dataBase64: string;
    }
  | { ok: false; error: string };

export type LoadedEvidenceScreenshots =
  | { ok: true; runId: string; shots: Array<{ label: string; mime: string; dataBase64: string }> }
  | { ok: false; error: string };

function artifactPathSafe(dir: string, file: string): string | null {
  const full = path.resolve(dir, file);
  const relative = path.relative(dir, full);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return full;
}

function encodeArtifactBytes(
  artifact: Artifact,
  body: Buffer,
):
  | { encoding: "text"; text: string }
  | { encoding: "json"; value: unknown }
  | { encoding: "base64"; dataBase64: string } {
  if (artifact.mime === "text/plain" || artifact.kind === "snapshot") {
    return { encoding: "text", text: body.toString("utf8") };
  }
  if (artifact.mime === "application/json" || artifact.path.endsWith(".json") || artifact.path.endsWith(".har")) {
    try {
      return { encoding: "json", value: JSON.parse(body.toString("utf8")) as unknown };
    } catch {
      return { encoding: "text", text: body.toString("utf8") };
    }
  }
  return { encoding: "base64", dataBase64: body.toString("base64") };
}

/** Load one retained artifact listed in manifest.json (trace, HAR, snapshot, vitals, …). */
export function loadEvidenceArtifact(
  root: string,
  runId: string,
  kind: EvidenceArtifactKind,
  fs: PackageFs,
  label?: string,
): LoadedEvidenceArtifact {
  const dir = evidenceRunDir(root, runId);
  if (dir === null) return { ok: false, error: "that is not a run id" };
  const manifestFile = path.join(dir, MANIFEST_FILE);
  if (!fs.exists(manifestFile)) return { ok: false, error: "no evidence manifest for this run" };
  let manifest: EvidenceManifest;
  try {
    manifest = JSON.parse(fs.readText(manifestFile)) as EvidenceManifest;
  } catch {
    return { ok: false, error: "no evidence manifest for this run" };
  }

  const matches = manifest.artifacts.filter((a) => a.kind === kind && a.bytes > 0);
  if (matches.length === 0) return { ok: false, error: `no ${kind} artifact for this run` };

  let artifact: Artifact;
  if (label !== undefined) {
    const found = matches.find((a) => a.label === label);
    if (found === undefined) return { ok: false, error: `no ${kind} artifact with label "${label}"` };
    artifact = found;
  } else if (matches.length === 1) {
    artifact = matches[0]!;
  } else {
    return {
      ok: false,
      error: `multiple ${kind} artifacts — pass label (${matches.map((m) => m.label).join(", ")})`,
    };
  }

  const full = artifactPathSafe(dir, artifact.path);
  if (full === null) return { ok: false, error: "artifact path escapes the run directory" };
  if (!fs.exists(full)) return { ok: false, error: "artifact file is missing on disk" };

  const body = fs.readBytes(full);
  const encoded = encodeArtifactBytes(artifact, body);
  const base = {
    ok: true as const,
    kind: artifact.kind,
    label: artifact.label,
    path: artifact.path,
    mime: artifact.mime,
    bytes: body.length,
  };
  if (encoded.encoding === "text") return { ...base, encoding: "text", text: encoded.text };
  if (encoded.encoding === "json") return { ...base, encoding: "json", value: encoded.value };
  return { ...base, encoding: "base64", dataBase64: encoded.dataBase64 };
}

/** All present screenshots for a run as base64 (optional label filter). */
export function loadEvidenceScreenshots(
  root: string,
  runId: string,
  fs: PackageFs,
  labels?: string[],
): LoadedEvidenceScreenshots {
  const loaded = loadEvidencePackage(root, runId, fs);
  if (!loaded.ok) return loaded;
  const wanted = labels !== undefined ? new Set(labels) : null;
  const shots: Array<{ label: string; mime: string; dataBase64: string }> = [];
  for (const shot of loaded.value.screenshots) {
    if (!shot.present) continue;
    if (wanted !== null && !wanted.has(shot.label)) continue;
    const bytes = loadEvidenceShot(root, runId, shot.label, fs);
    if (bytes === null) continue;
    shots.push({ label: shot.label, mime: bytes.type, dataBase64: bytes.body.toString("base64") });
  }
  return { ok: true, runId, shots };
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
