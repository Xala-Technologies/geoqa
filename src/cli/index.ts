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
import { flagBool, flagNumber, flagString, flagVars, parseArgs, USAGE } from "./args.js";
import {
  browserVerify,
  defaultDeps,
  evidenceInspect,
  experimentRun,
  journeyList,
  journeyRun,
  profileList,
  proxyVerify,
  renderRunResult,
} from "./commands.js";
import { findExperiment } from "../experiments/definitions.js";
import { SAMPLERS } from "./samplers.js";

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
  const deps = defaultDeps(repoRoot, {
    evidenceRoot: path.resolve(flagString(args, "evidence-root", path.join(repoRoot, "evidence"))),
  });

  const emit = (value: unknown, human: string): number => {
    console.log(json ? JSON.stringify(value, null, 2) : human);
    return 0;
  };

  if (!group || flagBool(args, "help")) {
    console.log(USAGE);
    return 0;
  }

  if (group === "profile" && (action === "list" || action === undefined)) {
    const result = profileList(deps);
    return emit(result, result.profiles.map((p) => `${p.id.padEnd(20)} ${p.country}/${p.city} ${p.device}`).join("\n"));
  }

  if (group === "journey" && action === "list") {
    const result = journeyList(deps);
    return emit(result, result.journeys.map((j) => `${j.id.padEnd(20)} ${j.steps} steps  ${j.title}`).join("\n"));
  }

  if (group === "browser" && action === "verify") {
    const result = await browserVerify(deps, flagString(args, "url", "https://example.com"));
    const human = [
      `${result.passed}/${result.total} primitives verified`,
      ...result.primitives.map((p) => `  ${p.ok ? "✓" : "✗"} ${p.name.padEnd(18)} ${p.detail}`),
    ].join("\n");
    return emit(result, human) || (result.passed === result.total ? 0 : 1);
  }

  if (group === "proxy" && action === "verify") {
    const result = await proxyVerify(deps, {
      profileId: flagString(args, "geo", "oslo-mobile"),
      providerName: flagString(args, "provider", "direct"),
    });
    const v = result.verification;
    const human = [
      `${result.profileId} via ${result.provider}${result.proxy ? ` (${result.proxy})` : ""}`,
      `  network  country=${v.network.country.verdict} city=${v.network.city.verdict}  observed ${v.network.observed.country}/${v.network.observed.city} ${v.network.observed.org ?? ""}`,
      `  browser  language=${v.browser.language.verdict} timezone=${v.browser.timezone.verdict} viewport=${v.browser.viewport.verdict}  observed ${v.browser.observed.language}/${v.browser.observed.timezone}/${v.browser.observed.viewport?.width ?? "?"}px`,
      `  confidence ${v.confidence}${v.trustworthy ? "" : " (NOT fully verified)"}`,
      ...result.warnings.map((w) => `  ! ${w}`),
    ].join("\n");
    return emit(result, human);
  }

  if (group === "journey" && action === "run") {
    const result = await journeyRun(deps, {
      url: flagString(args, "url", ""),
      profileId: flagString(args, "geo", "oslo-mobile"),
      journeyId: flagString(args, "journey", "landing-page"),
      providerName: flagString(args, "provider", "direct"),
      vars: flagVars(argv),
      headed: flagBool(args, "headed"),
    });
    emit(result, renderRunResult(result));
    return result.verdict === "FAIL" || result.verdict === "ERROR" ? 1 : 0;
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
    const result = await experimentRun(
      deps,
      {
        id: spec.id,
        samples: flagNumber(args, "samples", 10),
        profileId: flagString(args, "geo", "oslo-mobile"),
        url: flagString(args, "url", "https://example.com"),
        providerName: flagString(args, "provider", "direct"),
      },
      pair.sample,
      pair.summarise,
    );
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
