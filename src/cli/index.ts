/**
 * The `geoqa` entrypoint.
 *
 * Deliberately thin — parse, dispatch, print, exit. Every judgement lives in
 * `commands.ts` and `samplers.ts`, both at 100% coverage; this file is
 * coverage-excluded because there is nothing here to assert that those do not
 * already assert.
 *
 * It exits through `exitWhenFlushed`. agent-fleet learned that a process which
 * did real network work keeps a keep-alive socket open, node's event loop never
 * drains, and a run that finished successfully hangs until something kills it
 * twenty minutes later and records it as failed.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  flagBool,
  flagList,
  flagNumber,
  flagPairs,
  flagString,
  flagVars,
  parseArgs,
  parseEngine,
  USAGE,
} from "./args.js";
import {
  browserVerify,
  defaultDeps,
  DEFAULT_ENGINE,
  evidenceInspect,
  evidencePrune,
  experimentRun,
  loadUrlList,
  journeyList,
  journeyRun,
  matrixRun,
  parsePrunePolicy,
  profileList,
  proxyVerify,
  renderMatrixResult,
  renderPruneResult,
  renderRunResult,
  resolveEvidenceRoot,
  resolveProfileId,
} from "./commands.js";
import { configPath, loadConfig } from "../config/load.js";
import { findExperiment } from "../experiments/definitions.js";
import { DEFAULT_MATRIX_CONCURRENCY } from "../run/matrix.js";
import { experimentKnobs, SAMPLERS } from "./samplers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Exit once stdout and stderr have drained. A bare `process.exit()` discards
 * whatever is still queued on a pipe, which would drop the final lines of a
 * run — the one place anybody debugs from.
 */
function exitWhenFlushed(code: number): void {
  process.exitCode = code;
  let pending = 2;
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    process.exit(code);
  };
  const onFlushed = (): void => {
    if (--pending === 0) finish();
  };
  process.stdout.write("", onFlushed);
  process.stderr.write("", onFlushed);
  setTimeout(finish, 2_000).unref?.();
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const [group, action] = args.command;
  const json = flagBool(args, "json");

  if (!group || flagBool(args, "help")) {
    console.log(USAGE);
    return 0;
  }

  /**
   * The config file, read once, and a hard stop if it is wrong.
   *
   * Never a fallback to defaults on error: a malformed or unreadable
   * `geoqa.config.json` that quietly became "the defaults" is the same defect
   * the config surface was built to close — the user edited a setting, the run
   * ignored it, and nothing said so.
   */
  const loaded = loadConfig(configPath(repoRoot));
  if (!loaded.ok) {
    console.error(loaded.errors.join("\n"));
    return 2;
  }
  const config = loaded.value.config;
  // On stderr, so `--json` on stdout stays machine-readable. Printed always,
  // because a run on defaults because the config sits one directory up otherwise
  // looks identical to a run that honoured it.
  console.error(
    loaded.value.source === "file"
      ? `config: ${loaded.value.path}`
      : `config: built-in defaults (no ${path.basename(loaded.value.path)} at ${loaded.value.path})`,
  );

  // Precedence, everywhere below: FLAG > config file > built-in default. The
  // loader has already collapsed the last two, so a flag's fallback IS the
  // configured value.
  const deps = defaultDeps(repoRoot, {
    // An empty string reads as "not given", which is what a bare
    // `--evidence-root` with no value amounts to.
    evidenceRoot: resolveEvidenceRoot(repoRoot, config.evidence.root, flagString(args, "evidence-root", "")),
    browserTimeouts: config.browser,
  });
  const providerName = flagString(args, "provider", config.network.provider);
  const verifyEndpoint = config.network.verifyEndpoint;

  const engine = parseEngine(flagString(args, "engine", DEFAULT_ENGINE));
  if (engine === null) {
    // Refused rather than defaulted: running agent-browser because
    // "--engine playwrite" did not match is a successful run of an engine
    // nobody asked for.
    console.error(`unknown --engine "${String(args.flags["engine"])}" — expected agent-browser or playwright`);
    return 2;
  }

  /**
   * `--country`/`--city` name ONE identity; a matrix's identities are its
   * `--market` axis. Refused rather than ignored, and refused BEFORE resolution
   * so the message names the right flag: resolving first would answer
   * `matrix run --country NO` with "11 profiles match, name one with --geo",
   * which is true and useless.
   */
  if (group === "matrix" && (args.flags.country !== undefined || args.flags.city !== undefined)) {
    console.error("matrix run selects identities with --market, not --country/--city");
    return 2;
  }

  /**
   * The identity, from `--geo` or from `--country`/`--city`.
   *
   * Resolved ONCE for every command, so the three commands that take an identity
   * cannot disagree about how a place becomes a profile. Refusing here rather
   * than defaulting is the same rule as `--engine`: a run that quietly used Oslo
   * because it could not resolve Bergen reports a market nobody asked about.
   */
  const selectedProfile = resolveProfileId(deps, {
    ...(args.flags.geo !== undefined ? { geo: flagString(args, "geo", "") } : {}),
    ...(args.flags.country !== undefined ? { country: flagString(args, "country", "") } : {}),
    ...(args.flags.city !== undefined ? { city: flagString(args, "city", "") } : {}),
    ...(args.flags.device !== undefined ? { device: flagString(args, "device", "") } : {}),
  });
  if (!selectedProfile.ok) {
    console.error(selectedProfile.errors.join("\n"));
    return 2;
  }
  const profileId = selectedProfile.id;

  const emit = (value: unknown, human: string): number => {
    console.log(json ? JSON.stringify(value, null, 2) : human);
    return 0;
  };

  if (group === "profile" && (action === "list" || action === undefined)) {
    const result = profileList(deps);
    return emit(result, result.profiles.map((p) => `${p.id.padEnd(20)} ${p.country}/${p.city} ${p.device}`).join("\n"));
  }

  if (group === "journey" && action === "list") {
    const result = journeyList(deps);
    return emit(result, result.journeys.map((j) => `${j.id.padEnd(20)} ${j.steps} steps  ${j.title}`).join("\n"));
  }

  if (group === "browser" && action === "verify") {
    const result = await browserVerify(deps, flagString(args, "url", "https://example.com"), {
      engine,
      profileId,
    });
    const human = [
      `${result.passed}/${result.total} primitives verified on ${result.engine}`,
      ...result.primitives.map((p) => `  ${p.ok ? "✓" : "✗"} ${p.name.padEnd(18)} ${p.detail}`),
    ].join("\n");
    return emit(result, human) || (result.passed === result.total ? 0 : 1);
  }

  if (group === "proxy" && action === "verify") {
    const result = await proxyVerify(deps, {
      profileId,
      // Default ON here and OFF for runs — the reasoning is on `GeoVerifyOptions`.
      corroborate: !flagBool(args, "no-corroborate"),
      providerName,
      engine,
      verifyEndpoint,
    });
    const v = result.verification;
    const human = [
      `${result.profileId} via ${result.provider}${result.proxy ? ` (${result.proxy})` : ""} on ${result.engine}`,
      `  network  country=${v.network.country.verdict} city=${v.network.city.verdict}  observed ${v.network.observed.country}/${v.network.observed.city} ${v.network.observed.org ?? ""}`,
      // Both readings, side by side, whatever the verdict. When two databases
      // disagree the reader is left holding "which of these is wrong", and one
      // number cannot answer it.
      ...(v.network.corroborating === null
        ? []
        : [
            `  sources  agreement=${v.network.agreement.verdict}  ipinfo ${v.network.observed.country}/${v.network.observed.city}  vs  geojs ${v.network.corroborating.country}/${v.network.corroborating.city}`,
            ...v.network.agreement.reasons.map((r) => `           ${r}`),
          ]),
      `  browser  language=${v.browser.language.verdict} timezone=${v.browser.timezone.verdict} viewport=${v.browser.viewport.verdict}  observed ${v.browser.observed.language}/${v.browser.observed.timezone}/${v.browser.observed.viewport?.width ?? "?"}px`,
      `  confidence ${v.confidence}${v.trustworthy ? "" : " (NOT fully verified)"}`,
      ...result.warnings.map((w) => `  ! ${w}`),
    ].join("\n");
    return emit(result, human);
  }

  if (group === "journey" && action === "run") {
    const result = await journeyRun(deps, {
      url: flagString(args, "url", ""),
      profileId,
      journeyId: flagString(args, "journey", "landing-page"),
      providerName,
      engine,
      verifyEndpoint,
      vars: flagVars(argv),
      headed: flagBool(args, "headed"),
      repeat: flagNumber(args, "repeat", 1),
      corroborate: flagBool(args, "corroborate"),
      ...(args.flags.seed !== undefined ? { seed: flagNumber(args, "seed", 0) } : {}),
    });
    emit(result, renderRunResult(result));
    return result.verdict === "FAIL" || result.verdict === "ERROR" ? 1 : 0;
  }

  if (group === "matrix" && action === "run") {
    // Read and fully validated before anything launches. A bad line refuses the
    // matrix; discovering it two hundred pages in is a bill, not a report.
    const urls = args.flags["urls-file"] === undefined ? null : loadUrlList(flagString(args, "urls-file", ""));
    if (urls !== null && !urls.ok) {
      console.error(urls.errors.join("\n"));
      return 2;
    }
    const result = await matrixRun(deps, {
      url: flagString(args, "url", ""),
      markets: flagList(argv, "market"),
      journeys: flagList(argv, "journey"),
      devices: flagList(argv, "device"),
      ...(urls !== null ? { targets: urls.urls } : {}),
      providerName,
      engine,
      verifyEndpoint,
      vars: flagVars(argv),
      headed: flagBool(args, "headed"),
      repeat: flagNumber(args, "repeat", 1),
      concurrency: flagNumber(args, "concurrency", DEFAULT_MATRIX_CONCURRENCY),
      dryRun: flagBool(args, "dry-run"),
      allowWrites: flagBool(args, "allow-writes"),
      corroborate: flagBool(args, "corroborate"),
      ...(args.flags.seed !== undefined ? { seed: flagNumber(args, "seed", 0) } : {}),
    });
    emit(result, renderMatrixResult(result));
    // A dry run launched nothing and cannot have a verdict. An EXECUTED matrix
    // with zero scenarios is `ERROR`, and therefore exits 1 — deliberately: zero
    // scenarios is zero evidence.
    if (result.result === null) return 0;
    return result.result.verdict === "FAIL" || result.result.verdict === "ERROR" ? 1 : 0;
  }

  if (group === "evidence" && action === "inspect") {
    const runId = args.positional[0];
    if (!runId) {
      console.error("evidence inspect needs a run id");
      return 2;
    }
    const result = evidenceInspect(deps, runId);
    const m = result.manifest;
    const human = [
      `${runId} — ${m?.verdict} (tier ${m?.tier})`,
      `  completeness ${m?.completeness}%`,
      `  artifacts:   ${m?.artifacts.map((a) => `${a.label}(${a.bytes}b)`).join(", ")}`,
      `  missing:     ${m?.missing.length ? m.missing.join(", ") : "none"}`,
      ...(m?.privacyNote ? [`  ! ${m.privacyNote}`] : []),
    ].join("\n");
    return emit(result, human);
  }

  if (group === "evidence" && action === "prune") {
    const policy = parsePrunePolicy({
      maxAge: flagPairs(argv, "max-age"),
      ...(args.flags["max-total"] !== undefined ? { maxTotal: flagString(args, "max-total", "") } : {}),
      ...(args.flags["privacy-days"] !== undefined ? { privacyDays: flagString(args, "privacy-days", "") } : {}),
      sweepTiers: flagList(argv, "sweep-tiers"),
      deleteUnreadable: flagBool(args, "delete-unreadable"),
    });
    if (!policy.ok) {
      console.error(policy.errors.join("\n"));
      return 2;
    }
    const result = evidencePrune(deps, { policy: policy.value, apply: flagBool(args, "apply") });
    emit(result, renderPruneResult(result));
    // Red when something could not be done, whether or not --apply was given: a
    // scheduled prune that cannot meet its cap, or that was refused a path, must
    // not look like one that succeeded.
    const stuck =
      result.execution.failed.length > 0 ||
      result.execution.refused.length > 0 ||
      result.plan.sizeShortfallBytes !== null;
    return stuck ? 1 : 0;
  }

  if (group === "experiment" && action === "run") {
    const id = args.positional[0];
    if (!id) {
      console.error("experiment run needs an id, e.g. EXP-001 or 001");
      return 2;
    }
    const spec = findExperiment(id);
    if (!spec) {
      console.error(`unknown experiment "${id}"`);
      return 2;
    }
    const pair = SAMPLERS[spec.id];
    if (!pair) {
      console.error(`experiment "${spec.id}" has no sampler yet`);
      return 2;
    }
    const knobs = experimentKnobs(args);
    if (!knobs.ok) {
      console.error(knobs.errors.join("\n"));
      return 2;
    }
    /**
     * Declared as a variable, not passed as a literal, deliberately.
     *
     * `experimentRun` takes `ExperimentOptions`, and the per-experiment knobs are
     * declared on the sampler that reads them — so a fresh object literal would
     * trip an excess-property check while a widened shared type would grow a
     * field per experiment. A variable is assignable and the samplers keep
     * stating their own requirements.
     */
    const experimentOptions = {
      id: spec.id,
      samples: flagNumber(args, "samples", 10),
      profileId,
      url: flagString(args, "url", "https://example.com"),
      providerName,
      // The engine and endpoint now reach the samplers (D-1b). Before this,
      // `experiment run --engine playwright` took every sample through
      // agent-browser and reported a clean result for an engine it never touched.
      engine,
      verifyEndpoint,
      ...knobs.knobs,
    };
    const result = await experimentRun(deps, experimentOptions, pair.sample, pair.summarise);
    emit(result.summary, result.rendered);
    return result.summary.verdict === "fail" ? 1 : 0;
  }

  console.error(`unknown command: ${args.command.join(" ")}\n`);
  console.log(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => exitWhenFlushed(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    exitWhenFlushed(1);
  },
);
