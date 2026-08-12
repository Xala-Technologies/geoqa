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
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AgentBrowserRuntime } from "../browser/agent-browser.js";
import type { BrowserRuntime } from "../browser/types.js";
import { localeInitScript, toSessionConfig } from "../geo/profile.js";
import type { GeoProfile } from "../geo/types.js";

/** Everything a stage needs, JSON-serialisable so Temporal can pass it around. */
export interface RunSpec {
  runId: string;
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
  headed: boolean;
  verifyEndpoint: string;
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
  const config = toSessionConfig(profile, {
    sessionId: spec.runId,
    proxyUrl: spec.proxyUrl,
    proxyBypass: spec.proxyBypass,
    headed: spec.headed,
    ...(spec.initScriptPath ? { initScriptPath: spec.initScriptPath } : {}),
    baseEnv: process.env,
  });
  return new AgentBrowserRuntime(config);
}

/** `run_<epoch>_<profile>` — sortable, and says which profile it was. */
export function newRunId(profileId: string, nowMs: number): string {
  return `run_${nowMs}_${profileId}`;
}

export function newEvidenceId(runId: string): string {
  return runId.replace(/^run_/, "ev_");
}
