/**
 * The stages of a run, each independently callable.
 *
 * This is the seam that lets the same logic run two ways: the CLI calls these
 * in sequence in one process, and each Temporal Activity calls exactly one of
 * them. Neither knows about the other. If a stage needed a Temporal import it
 * would stop being runnable from a plain CLI, and Phase 0's experiments would
 * need a Temporal server to do anything at all.
 *
 * Every stage takes its dependencies as arguments rather than importing them,
 * so each is testable without a browser, a proxy or a workflow engine.
 */
import { observeBrowser, observeNetwork } from "../geo/observe.js";
import { loadGeoProfile } from "../geo/profile.js";
import type { GeoProfile, GeoVerification } from "../geo/types.js";
import { verifyGeo } from "../geo/verify.js";
import type { BrowserRuntime } from "../browser/types.js";
import { runJourney, type JourneyResult } from "../journeys/engine.js";
import { loadJourney, resolveSteps } from "../journeys/spec.js";
import { buildManifest, type Artifact, type EvidenceManifest } from "../evidence/manifest.js";
import { describeExisting, ensureRunDirectory, writeJsonArtifact, writeManifest, writeTextArtifact } from "../evidence/store.js";
import { screenshotRisk } from "../evidence/redact.js";
import { findingsFromSteps, rankFindings } from "../findings/classify.js";
import type { GeoQaRunResult } from "../findings/types.js";
import { scoreRun } from "../confidence/score.js";
import { newEvidenceId, runEvidenceDir, type RunSpec } from "./context.js";
import { RETENTION } from "../evidence/manifest.js";

export class StageError extends Error {
  constructor(
    message: string,
    readonly stage: string,
  ) {
    super(message);
    this.name = "StageError";
  }
}

/** Load and validate the run's profile and journey. Fails loudly and early. */
export function loadInputs(spec: RunSpec): { profile: GeoProfile; journey: ReturnType<typeof loadJourney> } {
  const profile = loadGeoProfile(spec.profilePath);
  if (!profile.ok) throw new StageError(`invalid profile: ${profile.errors.join("; ")}`, "load");
  const journey = loadJourney(spec.journeyPath);
  if (!journey.ok) throw new StageError(`invalid journey: ${journey.errors.join("; ")}`, "load");
  return { profile: profile.value, journey };
}

/**
 * Verify both geographic axes.
 *
 * Runs BEFORE the journey, deliberately. Verifying afterwards would tell us the
 * run was geographically wrong only once we had already spent the wall clock on
 * it — and worse, would leave a full evidence package that looks authoritative
 * about a market it never reached.
 */
export async function verifyEnvironment(
  runtime: BrowserRuntime,
  profile: GeoProfile,
  verifyEndpoint: string,
): Promise<GeoVerification> {
  const network = await observeNetwork(runtime, verifyEndpoint);
  const browser = await observeBrowser(runtime);
  return verifyGeo(profile, network, browser);
}

/** Run the journey, with variables resolved against the spec. */
export async function executeJourney(
  runtime: BrowserRuntime,
  spec: RunSpec,
  journey: { id: string; title: string; description: string; steps: Parameters<typeof resolveSteps>[0] },
  log?: (line: string) => void,
): Promise<JourneyResult> {
  const vars = { target: spec.target, ...spec.vars };
  const resolved = { ...journey, steps: resolveSteps(journey.steps, vars) };
  return runJourney(runtime, resolved, {
    screenshotDir: runEvidenceDir(spec),
    ...(log ? { log } : {}),
  });
}

export interface CollectInput {
  spec: RunSpec;
  profile: GeoProfile;
  geo: GeoVerification;
  journey: JourneyResult;
  createdAt: string;
}

/**
 * Write the evidence package.
 *
 * Only the artifacts the verdict's tier requires are collected — but a required
 * artifact that could not be produced is still DESCRIBED, at zero bytes, so the
 * manifest's `missing` list is honest rather than the package merely looking
 * complete.
 */
export async function collectEvidence(
  runtime: BrowserRuntime,
  input: CollectInput,
): Promise<EvidenceManifest> {
  const { spec, journey } = input;
  const dir = ensureRunDirectory({ root: spec.evidenceRoot, runId: spec.runId });
  const tier = RETENTION[verdictTier(journey.verdict)];
  const artifacts: Artifact[] = [];

  artifacts.push(
    writeJsonArtifact(dir, "metadata", "run", "run.json", {
      runId: spec.runId,
      target: spec.target,
      profile: input.profile,
      geo: input.geo,
      journey: { id: journey.journeyId, verdict: journey.verdict, counts: journey.counts, steps: journey.steps },
      createdAt: input.createdAt,
    }),
  );

  // Screenshots were written by the journey itself; describe what landed.
  for (const label of journey.screenshots) {
    const artifact = describeExisting(dir, "screenshot", label, `${label}.png`);
    artifacts.push({ ...artifact, risk: screenshotRisk({ hadForm: false, authenticated: false }) });
  }

  if (tier.includes("vitals")) {
    const vitals = await runtime.vitals();
    artifacts.push(writeJsonArtifact(dir, "vitals", "vitals", "vitals.json", vitals.ok ? vitals.data : null));
  }
  if (tier.includes("console")) {
    const messages = await runtime.console();
    artifacts.push(writeJsonArtifact(dir, "console", "console", "console.json", messages.ok ? messages.data : null));
  }
  if (tier.includes("network")) {
    const requests = await runtime.networkRequests();
    artifacts.push(writeJsonArtifact(dir, "network", "network", "network.json", requests.ok ? requests.data : null));
  }
  if (tier.includes("snapshot")) {
    const tree = await runtime.snapshot({ interactiveOnly: false });
    artifacts.push(writeTextArtifact(dir, "snapshot", "tree", "snapshot.txt", tree.ok ? tree.data : ""));
  }
  if (tier.includes("har")) {
    await runtime.harStop(`${dir}/network.har`);
    artifacts.push(describeExisting(dir, "har", "har", "network.har"));
  }
  if (tier.includes("trace")) {
    await runtime.traceStop(`${dir}/trace.json`);
    artifacts.push(describeExisting(dir, "trace", "trace", "trace.json"));
  }
  if (tier.includes("a11y")) {
    const violations = await runtime.a11y();
    artifacts.push(writeJsonArtifact(dir, "a11y", "a11y", "a11y.json", violations.ok ? violations.data : null));
  }

  const manifest = buildManifest({
    evidenceId: newEvidenceId(spec.runId),
    runId: spec.runId,
    createdAt: input.createdAt,
    verdict: journey.verdict,
    artifacts,
  });
  writeManifest(dir, manifest);
  return manifest;
}

function verdictTier(verdict: JourneyResult["verdict"]): keyof typeof RETENTION {
  return verdict === "PASS" ? "pass" : verdict === "PASS_WITH_WARNINGS" ? "warning" : verdict === "FAIL" ? "fail" : "investigation";
}

export interface AssembleInput {
  spec: RunSpec;
  profile: GeoProfile;
  geo: GeoVerification;
  journey: JourneyResult;
  manifest: EvidenceManifest | null;
  startedAt: string;
  durationMs: number;
}

/** Combine every stage's output into the run result an agent consumes. */
export function assembleResult(input: AssembleInput): GeoQaRunResult {
  const { spec, journey, manifest } = input;
  const findings = rankFindings(
    findingsFromSteps(journey.steps, {
      runId: spec.runId,
      target: spec.target,
      profileId: input.profile.id,
      journeyId: journey.journeyId,
      market: input.profile.market.id,
      device: input.profile.device.id,
      detectedAt: input.startedAt,
      evidence: manifest ? manifest.artifacts.map((a) => ({ label: a.label, path: a.path, mime: a.mime })) : [],
    }),
  );

  return {
    runId: spec.runId,
    target: spec.target,
    profileId: input.profile.id,
    journeyId: journey.journeyId,
    verdict: journey.verdict,
    geo: input.geo,
    confidence: scoreRun({ geo: input.geo, journey, manifest }),
    findings,
    evidenceId: manifest?.evidenceId ?? null,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
  };
}
