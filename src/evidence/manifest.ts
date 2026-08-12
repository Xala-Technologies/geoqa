/**
 * The evidence manifest.
 *
 * An evidence package exists to answer one question months later: *can we
 * reproduce this?* So the manifest records not only what we captured but what
 * we EXPECTED to capture and did not. A package that quietly omits the console
 * log on a JavaScript failure looks identical to one where the console was
 * clean — `completeness` and `missing` exist so it does not.
 */
import type { JourneyVerdict } from "../journeys/engine.js";
import type { ScreenshotRisk } from "./redact.js";

/**
 * The version of the consumed JSON shapes: this manifest AND `GeoQaRunResult`.
 *
 * One constant for both, because both are read by other programs — `--json` is
 * the integration contract, and an evidence package is opened by whatever tool a
 * human points at it months later. A consumer that finds a version it does not
 * know can refuse; without one its only way to detect a breaking change is to
 * crash on a field that moved, which is the failure this closes.
 *
 * BUMP IT when an existing field is removed or renamed, changes type, or changes
 * meaning — anything that makes a consumer written against the old shape wrong.
 * Do NOT bump for a purely additive field: a reader that ignores unknown keys is
 * still correct, and a version that changes on every addition trains consumers to
 * ignore it. The key-set tests are what make an addition or removal deliberate;
 * this number is what tells a consumer which of the two happened.
 */
export const GEOQA_SCHEMA_VERSION = 1;

export type ArtifactKind =
  | "metadata"
  | "screenshot"
  | "snapshot"
  | "console"
  | "network"
  | "har"
  | "trace"
  | "vitals"
  | "a11y";

/**
 * One kind, possibly several container formats.
 *
 * A `trace` from agent-browser is a Chrome trace in JSON; a `trace` from
 * Playwright is a ZIP. The kind stays the same for both because retention and
 * completeness ask *did this run keep a trace*, not what it was packaged in — so
 * `path` (its real extension) and `mime` are the authority on the format, and a
 * reader must use them rather than assuming one per kind.
 */
export interface Artifact {
  kind: ArtifactKind;
  label: string;
  /** Relative to the run's evidence directory. */
  path: string;
  bytes: number;
  mime: string;
  /** Only meaningful for screenshots. */
  risk?: ScreenshotRisk;
}

export interface EvidenceManifest {
  /** `GEOQA_SCHEMA_VERSION` at the time of writing. */
  schemaVersion: number;
  evidenceId: string;
  runId: string;
  createdAt: string;
  verdict: JourneyVerdict;
  tier: RetentionTier;
  artifacts: Artifact[];
  /** Artifact kinds the tier required that are absent. */
  missing: ArtifactKind[];
  /** 0..100. */
  completeness: number;
  /** Present when any screenshot is flagged for review. */
  privacyNote: string | null;
}

export type RetentionTier = "pass" | "warning" | "fail" | "investigation";

/**
 * What each tier keeps.
 *
 * Deliberately asymmetric: a passing run keeps almost nothing, because keeping
 * a trace and a HAR for every green run costs gigabytes to prove something
 * nobody will ever look at. A failure keeps everything, because that is the one
 * a human will open, and re-running to collect what we discarded is often
 * impossible — the bug may not reproduce.
 */
export const RETENTION: Record<RetentionTier, ArtifactKind[]> = {
  pass: ["metadata", "screenshot", "vitals"],
  warning: ["metadata", "screenshot", "vitals", "console", "network"],
  fail: ["metadata", "screenshot", "vitals", "console", "network", "har", "trace", "snapshot"],
  investigation: ["metadata", "screenshot", "vitals", "console", "network", "har", "trace", "snapshot", "a11y"],
};

/**
 * An ERROR verdict maps to `investigation`, not `fail`.
 *
 * When the engine could not read the page we know least and need most: the
 * diagnosis is about our own tooling, and the artifacts that answer it (trace,
 * HAR) are exactly the ones a `fail` tier would already keep — plus a11y, which
 * is cheap and occasionally reveals that the page never rendered at all.
 */
export function tierFor(verdict: JourneyVerdict): RetentionTier {
  switch (verdict) {
    case "PASS":
      return "pass";
    case "PASS_WITH_WARNINGS":
      return "warning";
    case "FAIL":
      return "fail";
    case "ERROR":
      return "investigation";
  }
}

export function missingArtifacts(tier: RetentionTier, artifacts: Artifact[]): ArtifactKind[] {
  const present = new Set(artifacts.filter((a) => a.bytes > 0).map((a) => a.kind));
  return RETENTION[tier].filter((kind) => !present.has(kind));
}

/**
 * Completeness is the share of REQUIRED kinds present, not the count of files.
 *
 * Counting files would let twelve screenshots paper over a missing trace, which
 * is precisely backwards — the trace is the one that makes a failure
 * reproducible.
 */
export function completenessOf(tier: RetentionTier, artifacts: Artifact[]): number {
  const required = RETENTION[tier];
  const missing = missingArtifacts(tier, artifacts);
  return Math.round(((required.length - missing.length) / required.length) * 100);
}

/** A zero-byte artifact is worse than an absent one — it looks like evidence. */
export function emptyArtifacts(artifacts: Artifact[]): Artifact[] {
  return artifacts.filter((a) => a.bytes === 0);
}

export interface BuildManifestInput {
  evidenceId: string;
  runId: string;
  createdAt: string;
  verdict: JourneyVerdict;
  artifacts: Artifact[];
}

export function buildManifest(input: BuildManifestInput): EvidenceManifest {
  const tier = tierFor(input.verdict);
  const flagged = input.artifacts.filter((a) => a.risk === "review");
  return {
    schemaVersion: GEOQA_SCHEMA_VERSION,
    evidenceId: input.evidenceId,
    runId: input.runId,
    createdAt: input.createdAt,
    verdict: input.verdict,
    tier,
    artifacts: input.artifacts,
    missing: missingArtifacts(tier, input.artifacts),
    completeness: completenessOf(tier, input.artifacts),
    privacyNote:
      flagged.length > 0
        ? `${flagged.length} screenshot(s) taken on a page with a form or an authenticated session — review before sharing: ${flagged
            .map((a) => a.path)
            .join(", ")}`
        : null,
  };
}

/** The questions an evidence package must be able to answer (PRD §24). */
export const REQUIRED_QUESTIONS = [
  "What happened?",
  "Where?",
  "When?",
  "In which market?",
  "On which device?",
  "At which journey step?",
  "Can we reproduce it?",
  "What technical evidence exists?",
] as const;
