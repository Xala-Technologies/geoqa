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
import { formatEvent } from "./events.js";
import {
  browserVerify,
  defaultDeps,
  DEFAULT_ENGINE,
  assistExplain,
  evidenceInspect,
  evidencePrune,
  experimentRun,
  dashboardBuild,
  digestSend,
  findingsFile,
  findingsRepair,
  fixRun,
  renderFixRun,
  renderFindingsFile,
  renderFindingsRepair,
  enforceQuota,
  gateCheck,
  keywordsResearch,
  loadUrlList,
  renderDashboardBuild,
  renderDigestResult,
  contentAnalyse,
  renderContentAnalysis,
  renderGateResult,
  renderKeywordReport,
  renderSiteAnalysis,
  siteAnalyse,
  resolveTenant,
  tenantList,
  checkTenantScope,
  journeyList,
  controlRun,
  journeyRun,
  matrixRun,
  parsePrunePolicy,
  profileList,
  proxyVerify,
  renderMatrixResult,
  renderPruneResult,
  renderRunResult,
  renderRunsList,
  runsList,
  runsRebuild,
  resolveEvidenceRoot,
  resolveProfileId,
} from "./commands.js";
import { configPath, loadConfig } from "../config/load.js";
import { cooldownStorePath } from "../network/cooldown.js";
import { renderHash, startServer } from "../server/start.js";
import { durableMatrix } from "../temporal/client.js";
import { nativeConnector } from "../temporal/connect.js";
import { findExperiment } from "../experiments/definitions.js";
import { DEFAULT_MATRIX_CONCURRENCY } from "../run/matrix.js";
import { gateExitCode } from "../gate/publish.js";
import { experimentKnobs, SAMPLERS } from "./samplers.js";
import { describeThrown } from "../errors.js";
import { findRepoRoot, uiDistRoot } from "../repo.js";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

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
    // The loader already deep-copied it, so `deps` holds the run's own table and nothing here
    // aliases the module-level `RETENTION` that every other run reads.
    retention: config.evidence.retention,
    // Beside `runs.jsonl` under the evidence root: both are derived state about this
    // installation, and `--tenant` replaces that root, so a tenant with its own proxy account
    // gets its own cooldowns rather than inheriting another tenant's frozen vendor.
    //
    // Resolved here rather than inside a command because the tenant swap happens below and
    // every command must see the same store — two paths for one vendor's health is how a
    // cooled-down provider gets retried by whichever command looked at the other file.
    cooldownMs: config.network.cooldownMs,
    // The connector is bound HERE and nowhere else, so `commands.ts` never names a Temporal
    // type it would then have to construct, and the SDK stays out of every other caller's
    // import graph — `nativeConnector` imports it dynamically, on use.
    startDurable: (runs, opts) => durableMatrix(runs, { ...opts, connector: nativeConnector }),
  });
  /**
   * `--tenant`, resolved BEFORE anything else that touches the filesystem.
   *
   * It replaces `deps.evidenceRoot`, so every path below derives from the tenant's
   * own directory rather than being nested by each caller — a caller that forgot
   * would write one tenant's run into the shared tree, which is the cross-tenant
   * read this whole slice exists to prevent.
   */
  const tenancy = resolveTenant(deps, args.flags.tenant === undefined ? undefined : flagString(args, "tenant", ""));
  if (!tenancy.ok) {
    console.error(tenancy.errors.join("\n"));
    return 2;
  }
  const tenant = tenancy.tenant;
  if (tenant !== null) {
    deps.evidenceRoot = tenancy.evidenceRoot;
    // The tenant's own profiles and journeys now take precedence over the shared set.
    deps.tenantId = tenant.id;
    console.error(`tenant: ${tenant.id} (${tenant.name}) — evidence under ${tenancy.evidenceRoot}`);
  }
  // AFTER the tenant swap, and derived from the root that survived it. Set here rather than in
  // `defaultDeps` because that runs before the swap, and a cooldown path pointing at the shared
  // root would let one tenant's failed vendor freeze another's.
  deps.cooldownPath = cooldownStorePath(deps.evidenceRoot);

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
    ...(args.flags.visitor !== undefined ? { visitor: flagString(args, "visitor", "") as "anonymous" | "returning" } : {}),
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
    return emit(
      result,
      result.profiles.map((p) => `${p.id.padEnd(20)} ${p.country}/${p.city} ${p.device.padEnd(8)} ${p.visitorType}`).join("\n"),
    );
  }

  if (group === "tenant" && (action === "list" || action === undefined)) {
    const result = tenantList(deps);
    return emit(
      result,
      result.tenants.map((t) => `${t.id.padEnd(16)} ${t.name.padEnd(24)} ${t.markets} market(s)  ${t.targets} target(s)  ${t.trafficMb}MB`).join("\n"),
    );
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

  if (group === "run" && action === undefined) {
    const scope = tenant === null ? [] : checkTenantScope(tenant, { url: flagString(args, "url", "") });
    if (scope.length > 0) {
      console.error(scope.join("\n"));
      return 2;
    }
    if (tenant !== null) {
      const quota = await enforceQuota(deps, tenant, flagNumber(args, "repeat", 1));
      for (const w of quota.warnings) console.error(`warning: ${w}`);
      if (quota.state === "refused") {
        console.error(quota.errors.join("\n"));
        return 2;
      }
    }
    const { result } = await controlRun(deps, {
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
      ...(tenant !== null ? { tenantId: tenant.id } : {}),
      ...(args.flags.seed !== undefined ? { seed: flagNumber(args, "seed", 0) } : {}),
      ...(args.flags.locale !== undefined ? { locale: flagString(args, "locale", "") } : {}),
      ...(args.flags.timezone !== undefined ? { timezone: flagString(args, "timezone", "") } : {}),
      ...(args.flags["rotate-ip"] !== undefined ? { rotateIp: flagBool(args, "rotate-ip") } : {}),
      ...(args.flags.evidence !== undefined ? { evidence: flagBool(args, "evidence") } : {}),
      ...(args.flags["session-duration"] !== undefined
        ? { sessionDurationMinutes: flagNumber(args, "session-duration", 10) }
        : {}),
      ...(json ? { onEvent: (event) => console.log(formatEvent(event)) } : {}),
    });
    if (!json) emit(result, renderRunResult(result));
    return result.verdict === "FAIL" || result.verdict === "ERROR" ? 1 : 0;
  }

  if (group === "journey" && action === "run") {
    // Refused before anything launches. A run against a site the tenant does not own
    // is either a mistake or this engine aimed at somebody else's product from
    // residential IPs.
    const scope = tenant === null ? [] : checkTenantScope(tenant, { url: flagString(args, "url", "") });
    if (scope.length > 0) {
      console.error(scope.join("\n"));
      return 2;
    }
    if (tenant !== null) {
      // One journey is one page load's worth of budget, roughly — the estimate is
      // coarse on purpose and named as an estimate wherever it surfaces.
      const quota = await enforceQuota(deps, tenant, flagNumber(args, "repeat", 1));
      for (const w of quota.warnings) console.error(`warning: ${w}`);
      if (quota.state === "refused") {
        console.error(quota.errors.join("\n"));
        return 2;
      }
    }
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
      ...(tenant !== null ? { tenantId: tenant.id } : {}),
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
    const scope =
      tenant === null ? [] : checkTenantScope(tenant, { url: flagString(args, "url", ""), markets: flagList(argv, "market") });
    if (scope.length > 0) {
      console.error(scope.join("\n"));
      return 2;
    }
    // Expanded first, so the quota check knows the real page count rather than
    // guessing at it — a 430-page sweep against a tenant with 100 MB left is exactly
    // the case worth refusing, and the number is free from the dry run.
    const planned = await matrixRun(deps, {
      url: flagString(args, "url", ""),
      markets: flagList(argv, "market"),
      journeys: flagList(argv, "journey"),
      devices: flagList(argv, "device"),
      ...(urls !== null ? { targets: urls.urls } : {}),
      dryRun: true,
    });
    if (tenant !== null) {
      const quota = await enforceQuota(deps, tenant, planned.scenarios.length * flagNumber(args, "repeat", 1));
      for (const w of quota.warnings) console.error(`warning: ${w}`);
      if (quota.state === "refused") {
        console.error(quota.errors.join("\n"));
        return 2;
      }
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
      durable: flagBool(args, "durable"),
      ...(args.flags["temporal-address"] !== undefined ? { temporalAddress: flagString(args, "temporal-address", "") } : {}),
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

  /**
   * `geoqa server` — the one command that keeps running.
   *
   * Separate from every other command on purpose. The dashboard is a static build that needs no
   * server (R-147), and it still is: this ADDS authentication and, later, the ability to trigger
   * a run, without taking away the read-only path. A team that only wants the report keeps
   * copying a directory.
   */
  if (group === "server") {
    if (action === "hash") {
      const password = argv[2];
      if (password === undefined || password === "") {
        console.error("geoqa server hash <password> — prints the environment variables to set");
        return 2;
      }
      console.log(renderHash(password));
      return 0;
    }
    const started = startServer({
      repoRoot,
      evidenceRoot: deps.evidenceRoot,
      uiRoot: flagString(args, "ui-root", uiDistRoot(repoRoot)),
      port: flagNumber(args, "port", 4180),
      env: process.env,
      // Off unless asked for: a `Secure` cookie on plain http is a cookie the browser silently
      // drops, and a login that appears to work and does not is worse than one that refuses.
      secure: flagBool(args, "secure"),
      log: (line) => console.error(line),
    });
    if (!started.ok) {
      console.error(started.error);
      return 2;
    }
    // Resolves only when the process is killed. Returning here would close the port.
    await new Promise<void>(() => undefined);
    return 0;
  }

  if (group === "dashboard" && (action === "build" || action === undefined)) {
    const result = dashboardBuild(deps, {
      ...(args.flags.since !== undefined ? { since: flagString(args, "since", "") } : {}),
    });
    return emit(result.view, renderDashboardBuild(result));
  }

  if (group === "content" && (action === "analyse" || action === "analyze" || action === undefined)) {
    const result = contentAnalyse(deps);
    emit(result, renderContentAnalysis(result));
    // Red on a near-duplicate: two pages that are substantially the same text compete with each
    // other in search, and that is a finding somebody has to act on rather than read past.
    return result.findings.duplicates.length > 0 ? 1 : 0;
  }

  if (group === "site" && (action === "analyse" || action === "analyze" || action === undefined)) {
    const result = siteAnalyse(deps, {
      ...(args.flags.journey !== undefined ? { journeyId: flagString(args, "journey", "") } : {}),
      ...(args.flags.since !== undefined ? { since: flagString(args, "since", "") } : {}),
    });
    emit(result, renderSiteAnalysis(result));
    // Red when geography changed the outcome anywhere: that is the finding this analysis
    // exists to surface, and a scheduled check should not have to read the output to know.
    return result.report.geographicallyDivergent.length > 0 ? 1 : 0;
  }

  if (group === "gate" && (action === "check" || action === undefined)) {
    // Tenant scope applies here too: a gate asked about a page the tenant does not own is
    // either a mistake or this engine being pointed somewhere it was not invited.
    const scope = tenant === null ? [] : checkTenantScope(tenant, { url: flagString(args, "url", "") });
    if (scope.length > 0) {
      console.error(scope.join("\n"));
      return 2;
    }
    const result = await gateCheck(deps, {
      url: flagString(args, "url", ""),
      profileId,
      journeyId: flagString(args, "journey", "landing-page"),
      providerName,
      engine,
      verifyEndpoint,
      ...(tenant !== null ? { tenantId: tenant.id } : {}),
      ...(args.flags.seed !== undefined ? { seed: flagNumber(args, "seed", 0) } : {}),
      ...(args.flags["block-at"] !== undefined
        ? { blockAtOrAbove: flagString(args, "block-at", "high") as "critical" | "high" | "medium" | "low" }
        : {}),
      ...(args.flags["min-confidence"] !== undefined ? { minConfidence: flagNumber(args, "min-confidence", 70) } : {}),
      ...(args.flags["min-geo-confidence"] !== undefined ? { minGeoConfidence: flagNumber(args, "min-geo-confidence", 0) } : {}),
    });
    emit(result, renderGateResult(result));
    // 0 allows and ANYTHING else does not — including `unknown`. A publisher conditioning
    // on this exit code cannot accidentally publish on a run that could not be read.
    return gateExitCode(result.gate);
  }

  if (group === "keywords" && (action === "research" || action === undefined)) {
    // Requires a tenant: the seeds, the markets and the site to look for all come from
    // one, and there is no sensible default for any of them. Without this the command
    // would research something against somewhere.
    if (tenant === null) {
      console.error("keywords research needs --tenant: the seeds, the markets and the site to look for all come from a tenant");
      return 2;
    }
    const result = await keywordsResearch(deps, tenant, {
      markets: flagList(argv, "market"),
      ...(args.flags.budget !== undefined ? { budget: flagNumber(args, "budget", 0) } : {}),
      ...(args.flags.limit !== undefined ? { limit: flagNumber(args, "limit", 10) } : {}),
    });
    emit(result, renderKeywordReport(result));
    // Red when nothing could be measured but queries were planned — a report of all
    // unmeasured rows reads like a tenant with no search presence, and it is a provider
    // problem.
    return result.queried > 0 && result.measured === 0 ? 1 : 0;
  }

  if (group === "runs" && (action === "list" || action === undefined)) {
    const result = runsList(deps, {
      ...(args.flags.url !== undefined ? { target: flagString(args, "url", "") } : {}),
      ...(args.flags.geo !== undefined || args.flags.country !== undefined ? { profileId } : {}),
      ...(args.flags.journey !== undefined ? { journeyId: flagString(args, "journey", "") } : {}),
      ...(args.flags.verdict !== undefined ? { verdict: flagString(args, "verdict", "") } : {}),
      ...(args.flags.since !== undefined ? { since: flagString(args, "since", "") } : {}),
      limit: flagNumber(args, "limit", 20),
    });
    emit(result, renderRunsList(result));
    // Red when a check that used to pass now does not. A regression report nobody's CI
    // notices is a report nobody reads.
    return result.regressions.length > 0 ? 1 : 0;
  }

  if (group === "findings" && (action === "file" || action === undefined)) {
    const result = await findingsFile(deps, { dryRun: flagBool(args, "dry-run") });
    emit(result, renderFindingsFile(result));
    if (result.skipped === "store-unreadable" || result.failed.length > 0) return 1;
    return 0;
  }

  if (group === "findings" && action === "repair") {
    const result = await findingsRepair(deps, { dryRun: flagBool(args, "dry-run") });
    emit(result, renderFindingsRepair(result));
    if (result.skipped === "store-unreadable" || result.failed.length > 0) return 1;
    return 0;
  }

  if (group === "fix" && (action === "run" || action === undefined)) {
    const source = flagString(args, "source", "both");
    if (source !== "both" && source !== "growth" && source !== "github") {
      console.error("--source is both, growth or github");
      return 2;
    }
    const only = flagList(argv, "only");
    const result = await fixRun(deps, {
      dryRun: flagBool(args, "dry-run"),
      source,
      merge: flagBool(args, "merge"),
      triggeredBy: flagBool(args, "timer") ? "timer" : "manual",
      ...(only.length > 0 ? { only } : {}),
      ...(args.flags.max !== undefined ? { maxItems: flagNumber(args, "max", 3) } : {}),
      ...(args.flags["budget-min"] !== undefined ? { budgetMin: flagNumber(args, "budget-min", 240) } : {}),
    });
    emit(result, renderFixRun(result));
    // A REJECTED fix is the agent working correctly and must not turn a timer
    // red. What is red: we could not read a source, we could not take the lock,
    // or a step threw.
    if (result.skipped === "no-sources" || result.skipped === "store-unreadable" || result.skipped === "locked") return 1;
    return result.outcomes.some((outcome) => outcome.status === "failed") ? 1 : 0;
  }

  if (group === "runs" && action === "rebuild") {
    const result = runsRebuild(deps);
    emit(
      result,
      [
        `rebuilt the run index from the evidence tree — ${result.written} run(s)`,
        ...result.unreadable.map((u) => `  ! ${u}`),
      ].join("\n"),
    );
    // A run directory the rebuild could not read is a gap in the history, and a
    // scheduled rebuild must go red rather than look fine.
    return result.unreadable.length > 0 ? 1 : 0;
  }

  if (group === "digest" && action === "send") {
    const result = await digestSend(deps, {
      dryRun: flagBool(args, "dry-run"),
      ...(args.flags.to !== undefined ? { to: flagString(args, "to", "") } : {}),
      ...(args.flags.since !== undefined ? { since: flagString(args, "since", "") } : {}),
    });
    emit(result, renderDigestResult(result));
    if (!result.ok) return result.skipped === "bad-window" ? 2 : 1;
    return 0;
  }

  if (group === "assist" && action === "explain") {
    const runId = args.positional[0];
    if (!runId) {
      console.error("assist explain needs a run id");
      return 2;
    }
    const result = await assistExplain(deps, runId);
    emit(result, result.ok ? result.draft : result.error);
    return result.ok ? 0 : 1;
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
    console.error(describeThrown(e));
    exitWhenFlushed(1);
  },
);
