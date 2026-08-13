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
import { observeBrowser, observeEgressIp, observeNetwork, observeNetworkVia, GEOJS_SOURCE } from "../geo/observe.js";
import { loadGeoProfile } from "../geo/profile.js";
import type { AxisResult, GeoProfile, GeoVerification } from "../geo/types.js";
import { compareEgressHeld, verifyGeo, withCorroboration } from "../geo/verify.js";
import { CONTENT_EXPRESSION, parsePageContent } from "../analysis/content.js";
import type { BrowserRuntime } from "../browser/types.js";
import { runJourney, type JourneyResult, type StepResult } from "../journeys/engine.js";
import { loadJourney, resolveSteps, type Journey } from "../journeys/spec.js";
import { buildManifest, GEOQA_SCHEMA_VERSION, type Artifact, type EvidenceManifest } from "../evidence/manifest.js";
import { describeExisting, ensureRunDirectory, writeJsonArtifact, writeManifest, writeTextArtifact } from "../evidence/store.js";
import { screenshotRisk } from "../evidence/redact.js";
import { findingsFromSteps, rankFindings } from "../findings/classify.js";
import type { GeoQaRunResult } from "../findings/types.js";
import { scoreRun } from "../confidence/score.js";
import { newEvidenceId, runEvidenceDir, type RunEngine, type RunSpec } from "./context.js";
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
 * Apply the profile's device before anything is observed or asserted.
 *
 * Missed on the first live run and caught only by opening the screenshot: an
 * `oslo-mobile` run rendered at 1280px, because nothing ever set the viewport.
 * Every check still passed, the evidence package was 100% complete, and the
 * whole run was quietly measuring a desktop layout under a mobile profile's
 * name. Nothing in the logs said so — the artifact did. Hence the rule this
 * function exists to enforce, and hence `verifyEnvironment` reading the
 * viewport back rather than assuming the request took.
 *
 * Ordering matters: this runs BEFORE geo verification, so the viewport the
 * verification reports is the one the journey will actually use.
 */
export async function applyDeviceProfile(runtime: BrowserRuntime, profile: GeoProfile): Promise<string[]> {
  const warnings: string[] = [];
  if (profile.device.emulate) {
    const out = await runtime.setDevice(profile.device.emulate);
    if (!out.ok) warnings.push(`could not emulate device "${profile.device.emulate}": ${out.failure.detail}`);
  }
  const { width, height } = profile.device.viewport;
  const out = await runtime.setViewport(width, height);
  if (!out.ok) warnings.push(`could not set viewport ${width}×${height}: ${out.failure.detail}`);
  return warnings;
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
  /**
   * Read a second IP-geo database and report whether the two agree.
   *
   * OFF by default here, unlike `proxy verify`. This function runs once per RUN,
   * and a 430-page sweep would spend 430 extra probes against a free endpoint's
   * monthly allowance — an engine that exhausts its own corroborating source
   * reports `unverified` for every subsequent run, which is the shape of failure
   * an exhausted proxy already produced once. Opt in for the runs where the
   * geographic claim is the point.
   */
  corroborate = false,
): Promise<GeoVerification> {
  const network = await observeNetwork(runtime, verifyEndpoint);
  const browser = await observeBrowser(runtime);
  const verified = verifyGeo(profile, network, browser);
  if (!corroborate) return verified;
  return withCorroboration(verified, await observeNetworkVia(runtime, GEOJS_SOURCE));
}

/**
 * Run the journey, with variables resolved against the spec.
 *
 * `seed` overrides `spec.seed` for one attempt. A repeated run needs each attempt
 * to pace differently — otherwise every attempt makes identical choices and the
 * repetition measures nothing about variability — while the whole set stays
 * reproducible, because the per-attempt seeds are derived from the base one.
 */
export async function executeJourney(
  runtime: BrowserRuntime,
  spec: RunSpec,
  journey: Journey,
  log?: (line: string) => void,
  seed?: number,
): Promise<JourneyResult> {
  const vars = { target: spec.target, ...spec.vars };
  const resolved = { ...journey, steps: resolveSteps(journey.steps, vars) };
  return runJourney(runtime, resolved, {
    screenshotDir: runEvidenceDir(spec),
    seed: seed ?? spec.seed,
    ...(log ? { log } : {}),
  });
}

/** The check kind reported for a mid-run egress rotation. */
export const EGRESS_HELD_CHECK = "egress-held";

export interface EgressHeldResult {
  axis: AxisResult;
  /** Present ONLY when a rotation was proven. */
  step: StepResult | null;
}

/**
 * Confirm the run held one network identity from first navigation to last.
 *
 * Runs AFTER the journey and BEFORE evidence collection, so a proven rotation
 * reaches `verdictFor` in time to set the retention tier — a run whose
 * measurements came from two exits is exactly the run whose trace you want.
 *
 * A rotation is `errored`, not `failed`, and categorised `instrumentation`. The
 * page did nothing wrong; our own network moved under the measurement, so
 * nothing observed can be attributed to the site. Filing it against the site
 * would be the same mistake as reporting a dead browser as a broken page.
 *
 * `unverified` produces NO step. We are not entitled to a verdict we could not
 * read, and an unreadable closing probe (a strict CSP, an offline endpoint) must
 * not discard an otherwise good run.
 */
export async function verifyEgressHeld(
  runtime: BrowserRuntime,
  verifyEndpoint: string,
  openingIp: string | null,
  index: number,
  now: () => number = Date.now,
): Promise<EgressHeldResult> {
  const started = now();
  const closingIp = await observeEgressIp(runtime, verifyEndpoint);
  const axis = compareEgressHeld(openingIp, closingIp);
  if (axis.verdict !== "mismatch") return { axis, step: null };
  return {
    axis,
    step: {
      index,
      action: "assert",
      label: "egress held for the whole run",
      outcome: "errored",
      severity: "critical",
      category: "instrumentation",
      check: EGRESS_HELD_CHECK,
      detail: axis.reasons.join("; "),
      expected: `egress stays ${openingIp}`,
      observed: closingIp,
      durationMs: now() - started,
    },
  };
}

/**
 * The trace file's name and type, which differ by ENGINE.
 *
 * Both engines produce the `trace` artifact kind and neither produces the same
 * file: agent-browser's `trace stop` writes a Chrome trace (`{"traceEvents": …}`,
 * JSON), Playwright's `tracing.stop` writes a ZIP. Both used to land on
 * `trace.json`, so on a Playwright run the extension lied and the manifest
 * advertised `application/json` for a zip archive — the file was valid and every
 * ordinary way of opening it failed, leaving `npx playwright show-trace` as
 * something you had to already know.
 *
 * The kind stays `trace` for both, because retention and completeness ask whether
 * the run kept a trace, not what container it arrived in. The path and the mime
 * carry the format; that is the whole honest expression of it.
 *
 * This lives in `run/`, not in `evidence/`: the engine is part of the RunSpec's
 * identity and nothing in `evidence/` may learn an engine's name.
 */
export function traceArtifactFormat(engine: RunEngine): { file: string; mime: string } {
  return engine === "playwright"
    ? { file: "trace.zip", mime: "application/zip" }
    : { file: "trace.json", mime: "application/json" };
}

export interface CollectInput {
  spec: RunSpec;
  profile: GeoProfile;
  geo: GeoVerification;
  journey: JourneyResult;
  createdAt: string;
  /**
   * What kind of visitor this run ACTUALLY tested.
   *
   * `run.json` recorded `visitorType: returning` straight off the profile whether
   * or not a session was restored, so a run that tested a first-time visitor and a
   * run that tested a returning one were indistinguishable in the evidence — the
   * same class of lie as an unmeasured metric reported as fine. The declaration is
   * an intention; `restored` is an observation, and only one of them is evidence.
   *
   * Optional so a caller that has not resolved it records nothing rather than
   * recording a default that would read as "not restored".
   */
  visitor?: { declared: GeoProfile["visitorType"]; restored: boolean; unmet: string | null };
  /**
   * How many attempts the merged journey stands for, and which steps failed in how many.
   *
   * Without it a `--repeat 3` run emitted findings whose `reproducibility` said 3 while the
   * evidence package held no trace of the other two attempts — and R-24 makes "can we reproduce
   * this?" a question the package itself must answer. A number in a result nobody can check
   * against the evidence is exactly the shape of claim this project refuses everywhere else.
   *
   * `steps` in `run.json` is still the MERGED list (worst outcome per index), so this does not
   * make the package a record of each attempt: it records what the merge was over. That
   * distinction is stated here so nobody later reads `attempts: 3` as three step lists.
   *
   * Optional, so a single-attempt run records nothing rather than a `1` that would read as a
   * deliberate choice not to repeat.
   */
  reproducibility?: { attempts: number; occurrences: Record<string, number> };
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

  /**
   * Page content, for the site-wide signals a single run cannot produce.
   *
   * Captured on EVERY run and written as its own artifact rather than folded into `run.json`,
   * because it is the one artifact whose value is entirely cross-run: thin pages, orphans and
   * near-duplicates are all comparisons between pages, and none of them mean anything for one.
   *
   * A failure here is a MISSING artifact, never a failed run. The content read is a bonus
   * observation; a run that verified geography and executed its journey has not failed because
   * a word count could not be taken.
   */
  const content = await runtime.evaluate<unknown>(CONTENT_EXPRESSION);
  const parsedContent = content.ok ? parsePageContent(content.data) : null;
  if (parsedContent !== null) {
    artifacts.push(writeJsonArtifact(dir, "metadata", "content", "content.json", parsedContent));
  }

  artifacts.push(
    writeJsonArtifact(dir, "metadata", "run", "run.json", {
      runId: spec.runId,
      target: spec.target,
      profile: input.profile,
      geo: input.geo,
      journey: {
        id: journey.journeyId,
        verdict: journey.verdict,
        counts: journey.counts,
        // The seed is the only way to replay a run whose pacing and optional
        // steps were drawn from it, so it belongs in the artifact, not the log.
        seed: journey.seed,
        writes: journey.writes,
        touchedForm: journey.touchedForm,
        // The MERGED steps: the worst outcome at each index across every attempt. `attempts`
        // below says what that merge was over; it does not promise a list per attempt.
        steps: journey.steps,
        // Purely additive and omitted entirely for a single run, so a consumer that does not
        // know the field is unaffected and one that does can check a finding's
        // `reproducibility` against the evidence instead of taking the result's word for it.
        ...(input.reproducibility ? { reproducibility: input.reproducibility } : {}),
      },
      // Purely additive, so no schema bump: a consumer that does not know the field
      // is unaffected, and one that does can tell a returning-visitor run from a
      // run that merely asked to be one.
      ...(input.visitor ? { visitor: input.visitor } : {}),
      createdAt: input.createdAt,
    }),
  );

  // Screenshots were written by the journey itself; describe what landed.
  //
  // The risk flags are DERIVED, not hardcoded. They used to be `false, false`,
  // which was harmless while journeys only read pages and became a lie the moment
  // one could register an account or send a contact form: a screenshot taken
  // mid-form plausibly contains a name, an email or a password, and no regex will
  // ever find it in an image. Flagging it is all we can honestly do.
  const risk = screenshotRisk({ hadForm: journey.touchedForm, authenticated: journey.writes });
  for (const label of journey.screenshots) {
    const artifact = describeExisting(dir, "screenshot", label, `${label}.png`);
    artifacts.push({ ...artifact, risk });
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
    const trace = traceArtifactFormat(spec.engine);
    await runtime.traceStop(`${dir}/${trace.file}`);
    // `describeExisting` types an artifact by kind, and a kind cannot know which
    // engine wrote it — so the format the engine actually produced overrides the
    // per-kind default rather than the manifest describing a zip as JSON.
    artifacts.push({ ...describeExisting(dir, "trace", "trace", trace.file), mime: trace.mime });
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
  /**
   * How many times the journey was executed, and how many of those attempts each
   * step was failed or errored in.
   *
   * Optional because one attempt is the common case, and absent they default to
   * a single observation. Supplying them is what turns a finding from `observed`
   * into `reproduced` and moves its confidence off the flat base — "we saw it
   * once and could not repeat it" and "it failed 3 of 3 times" are very different
   * claims about the world, and the finding must say which one it is.
   */
  attempts?: number;
  occurrences?: Record<string, number>;
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
      ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
      ...(input.occurrences !== undefined ? { occurrences: input.occurrences } : {}),
    }),
  );

  return {
    // Stamped here, at the one place a run result is built, so no consumer can
    // receive one without a version telling it which shape it is holding.
    schemaVersion: GEOQA_SCHEMA_VERSION,
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
