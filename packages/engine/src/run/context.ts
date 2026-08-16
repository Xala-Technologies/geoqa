/**
 * A run's identity, in a form that survives serialisation.
 *
 * Every Temporal Activity has to be able to rebuild the browser it is talking
 * to from nothing but its arguments — Activities are stateless by construction
 * and may not even run in the same process. That works here for a reason worth
 * stating: **agent-browser is a daemon.** The browser state lives in the daemon,
 * keyed by session name and launch flags, so an Activity does not carry a
 * browser handle — it carries the flags that identify one, and the daemon hands
 * back the same browser.
 *
 * The consequence is that `RunSpec` must contain everything needed to
 * reconstruct those flags exactly. Get one wrong and the daemon silently gives
 * you a DIFFERENT browser rather than an error.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AgentBrowserRuntime } from "../browser/agent-browser.js";
import { createPlaywrightRuntime, type PlaywrightContextOptions } from "../browser/engines.js";
import type { BrowserRuntime } from "../browser/types.js";
import type { RetentionPolicy } from "../evidence/manifest.js";
import { localeInitScript, toSessionConfig } from "../geo/profile.js";
import type { GeoProfile } from "../geo/types.js";

/**
 * Which browser engine serves a run.
 *
 * A string on the spec rather than an injected object, because a Temporal
 * Activity has to be able to rebuild the runtime from serialisable arguments
 * alone. It is part of the run's identity for the same reason the proxy URL is:
 * two runs of the same journey on different engines are not the same run.
 */
export type RunEngine = "agent-browser" | "playwright";

/** Everything a stage needs, JSON-serialisable so Temporal can pass it around. */
export interface RunSpec {
  runId: string;
  engine: RunEngine;
  /** The page under test. */
  target: string;
  profilePath: string;
  journeyPath: string;
  evidenceRoot: string;
  /** Resolved by the network provider; null means direct egress. */
  proxyUrl: string | null;
  proxyBypass: string | null;
  /** Written to disk before the browser launches. */
  initScriptPath: string | null;
  /** Journey variable substitutions. */
  vars: Record<string, string>;
  /**
   * Seeds the journey's pauses and probability draws.
   *
   * On the spec, not generated in the engine, for the same reason the engine
   * choice is: a Temporal Activity rebuilds everything from serialisable
   * arguments, and a seed regenerated per Activity would make a run's pacing
   * differ between its own stages.
   */
  seed: number;
  headed: boolean;
  verifyEndpoint: string;
  /**
   * Read a second IP-geo database at verification time and report whether the two
   * agree.
   *
   * On the spec rather than a stage argument, for the reason `seed` and `engine`
   * are: a Temporal Activity rebuilds every stage from serialisable arguments, and
   * a corroboration decision taken inside a stage would differ between a local run
   * and a durable one — which would make two runs of the same spec produce
   * different `agreement` verdicts and neither of them wrong.
   */
  corroborateGeo: boolean;
  /**
   * The retention policy this run collects under. Absent means the built-in table.
   *
   * On the spec for the reason `seed`, `engine` and `corroborateGeo` are: a Temporal Activity
   * rebuilds every stage from serialisable arguments, and a policy read from a config file
   * inside a stage would differ between a local run and a durable one — two runs of the same
   * spec producing different `completeness` numbers, neither of them wrong. A plain record of
   * string arrays, so it crosses that boundary unchanged.
   *
   * Carried as a COPY, never a reference to the module-level `RETENTION`: one run narrowing a
   * tier must not narrow what every later run in the process collects.
   */
  retention?: RetentionPolicy;
  /**
   * agent-browser command caps, from `geoqa.config.json`'s `browser` block.
   *
   * These reached `browser verify` and `proxy verify` — which build a runtime from
   * `CommandDeps` — and NOT `journey run` or `matrix run`, which build one from the spec. So a
   * config that capped a hung command capped it on the two commands least likely to hang, and
   * silently not on the two that do the work.
   *
   * Both are plain numbers and neither changes agent-browser's launch identity, so putting them
   * on the spec is safe for the durable path. Absent means `exec.ts` applies its own default:
   * the numbers are private to that file and copying them here would be the second source of
   * truth the config module exists to avoid.
   */
  commandTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export function runEvidenceDir(spec: Pick<RunSpec, "evidenceRoot" | "runId">): string {
  return path.join(spec.evidenceRoot, spec.runId);
}

/**
 * The init script has to exist on disk BEFORE the browser launches, because
 * `--init-script` is a launch flag: agent-browser hashes it into the launch
 * identity and registers it before first navigation. Writing it later means the
 * page has already loaded with the host's locale.
 */
export function writeInitScript(spec: Pick<RunSpec, "evidenceRoot" | "runId">, profile: GeoProfile): string {
  const dir = runEvidenceDir(spec);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "init-locale.js");
  writeFileSync(file, localeInitScript(profile));
  return file;
}

/**
 * Rebuild the browser handle for this run.
 *
 * Called once per Activity. The session id is the run id, so every command in a
 * run reaches the same browser and two concurrent runs cannot collide.
 */
export function buildRuntime(spec: RunSpec, profile: GeoProfile): BrowserRuntime {
  if (spec.engine === "playwright") return buildPlaywrightRuntime(spec, profile);
  const config = toSessionConfig(profile, {
    sessionId: spec.runId,
    proxyUrl: spec.proxyUrl,
    proxyBypass: spec.proxyBypass,
    headed: spec.headed,
    ...(spec.initScriptPath ? { initScriptPath: spec.initScriptPath } : {}),
    baseEnv: process.env,
  });
  return new AgentBrowserRuntime(config, {
    ...(spec.commandTimeoutMs !== undefined ? { timeoutMs: spec.commandTimeoutMs } : {}),
    ...(spec.idleTimeoutMs !== undefined ? { idleMs: spec.idleTimeoutMs } : {}),
  });
}

/**
 * Where a profile's saved session lives, under the evidence root.
 *
 * NOT inside a run directory, for two reasons. A session that expires with one
 * run cannot make the next visitor a returning one, which is the entire point.
 * And the file holds live cookies — it is a credential, not evidence, and an
 * evidence package is the one thing in this system that gets copied to a human.
 */
export const VISITOR_STATE_DIR = "visitors";

export interface VisitorState {
  /** This profile's session file, or `null` when the engine cannot use one. */
  path: string | null;
  /** True ONLY when a saved session was found and will be loaded. */
  restored: boolean;
  /**
   * Non-null when the profile claims `returning` and this run is not one.
   *
   * The whole point of B-7: a `returning` profile whose session could not be
   * restored has tested a FIRST-TIME visitor, and `run.json` will still record
   * `visitorType: returning` from the profile. Something has to say which of the
   * two actually happened, or the two are indistinguishable in the evidence —
   * which is the same class of lie as an unmeasured metric reported as fine.
   */
  unmet: string | null;
}

/**
 * Decide what a run's visitor actually is, as opposed to what it claims.
 *
 * Injected `exists` rather than a hard `existsSync` so the judgement — not the
 * filesystem — is what the tests pin.
 */
export function resolveVisitorState(
  spec: Pick<RunSpec, "engine" | "evidenceRoot">,
  profile: GeoProfile,
  exists: (file: string) => boolean = existsSync,
): VisitorState {
  if (profile.visitorType === "anonymous") {
    // An anonymous visitor arrives with nothing AND keeps nothing. Saving a
    // session here would make the NEXT run of this profile a returning visitor
    // nobody asked for — the same substitution as the reverse, and just as
    // invisible in the evidence.
    return { path: null, restored: false, unmet: null };
  }
  if (spec.engine !== "playwright") {
    return {
      path: null,
      restored: false,
      unmet: `profile "${profile.id}" declares visitorType "returning", but the agent-browser engine cannot restore a session: it isolates cookies and storage per --session and the session name is the run id, so every run arrives as a first-time visitor. Use --engine playwright.`,
    };
  }
  const file = path.join(spec.evidenceRoot, VISITOR_STATE_DIR, `${profile.id}.json`);
  if (exists(file)) return { path: file, restored: true, unmet: null };
  return {
    path: file,
    restored: false,
    // Still saved on close: the first run of a returning profile has to be the
    // one that seeds the session, or no run ever gets to be a returning visitor.
    unmet: `profile "${profile.id}" declares visitorType "returning" but no saved session exists at ${file} — this run tested a FIRST-TIME visitor. Its session is saved when the browser closes, so the next run of this profile is a real returning one.`,
  };
}

/**
 * A profile, as Playwright context options.
 *
 * Pure and separate from `buildPlaywrightRuntime` so the mapping is testable
 * without a browser — this is where a wrong axis would silently produce a run
 * that claims Oslo and renders Frankfurt, so it is the part that needs pinning.
 *
 * The context carries what agent-browser needed launch flags, a `TZ` env var and
 * an injected script to approximate: locale, timezone, coordinates and viewport
 * are all context options, and the geolocation permission is GRANTED rather than
 * stubbed. `spec.initScriptPath` is therefore unused on this engine — it stays
 * written to the evidence directory because it records what the run asked for.
 *
 * Two more context-creation facts land here because there is nowhere later to put
 * them: the HAR path and the visitor's saved session. Both are decided before the
 * browser exists and neither can be changed once it does.
 */
export function playwrightContextOptions(
  spec: RunSpec,
  profile: GeoProfile,
  exists: (file: string) => boolean = existsSync,
): PlaywrightContextOptions {
  const [latitude, longitude] = profile.market.coordinates;
  const visitor = resolveVisitorState(spec, profile, exists);
  return {
    proxyUrl: spec.proxyUrl,
    proxyBypass: spec.proxyBypass,
    locale: profile.market.language,
    timezoneId: profile.market.timezone,
    coordinates: { latitude, longitude },
    viewport: profile.device.viewport,
    userAgent: profile.device.userAgent ?? null,
    hasTouch: profile.device.hasTouch ?? null,
    deviceScaleFactor: profile.device.deviceScaleFactor ?? null,
    deviceName: profile.device.emulate ?? null,
    headed: spec.headed,
    identity: spec.runId,
    // Armed for EVERY run, because the retention tier is not known until the
    // journey has finished — the same record-always/keep-on-failure shape as the
    // trace, and for the same reason: a HAR cannot be started retroactively for
    // the run that turned out to need one. The difference is that Playwright
    // writes it when the context CLOSES, which happens after `collectEvidence`
    // has already described the directory, so the manifest still reports `har`
    // as missing (B-3). The run directory exists by now: `writeInitScript` made
    // it during `prepareRun`.
    harPath: path.join(runEvidenceDir(spec), "network.har"),
    // Restore only what is really there — Playwright throws on a missing
    // `storageState` path, and a returning visitor that cannot be restored must
    // become a reported warning, not a launch failure.
    restoreStatePath: visitor.restored ? visitor.path : null,
    saveStatePath: visitor.path,
  };
}

/**
 * A Playwright runtime for this run's profile.
 *
 * `playwrightOpener` returns a function without calling it, so constructing a
 * runtime launches nothing — the browser starts on first use, which is what lets
 * this stay synchronous and what keeps the test suite browser-free.
 */
export function buildPlaywrightRuntime(spec: RunSpec, profile: GeoProfile): BrowserRuntime {
  return createPlaywrightRuntime(spec.runId, playwrightContextOptions(spec, profile));
}

/** `run_<epoch>_<profile>` — sortable, and says which profile it was. */
export function newRunId(profileId: string, nowMs: number): string {
  return `run_${nowMs}_${profileId}`;
}

export function newEvidenceId(runId: string): string {
  return runId.replace(/^run_/, "ev_");
}
