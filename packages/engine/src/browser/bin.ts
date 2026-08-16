/**
 * Resolve the `agent-browser` binary to an ABSOLUTE path so spawning it never
 * depends on the caller's PATH.
 *
 * Ported from agent-fleet's `claude-bin.ts`, which exists because every LLM
 * spawn there ran a bare `spawn("claude", …)`. That works when the spawning
 * process happens to have the install dir on PATH — systemd units set it, but
 * dashboard buttons, nested spawns and manual runs often do not, so the same
 * code ran green on a timer and died with ENOENT everywhere else. A Temporal
 * worker is exactly such an "everywhere else": it inherits whatever environment
 * the service manager gave it, which is usually not a login shell's PATH.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolveBinOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Package root, injectable so the resolver is deterministic in tests. */
  packageRoot?: string;
  /** Existence probe — injectable for the same reason. */
  exists?: (p: string) => boolean;
}

/** This file lives at packages/engine/src/browser/bin.ts, so the package root is two up. */
export function defaultPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * The absolute path to `agent-browser`, or the bare name as a last resort
 * (letting PATH decide) when nothing is found. An explicit
 * `GEOQA_AGENT_BROWSER_BIN` / `AGENT_BROWSER_BIN` wins; otherwise the project's
 * own `node_modules/.bin` is preferred over anything global, so a run can never
 * silently execute a different version than the one this repo pinned.
 */
export function resolveAgentBrowserBin(opts: ResolveBinOptions = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const root = opts.packageRoot ?? defaultPackageRoot();
  // fs.existsSync never throws for a string path — it returns false on any error.
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));

  const explicit = env.GEOQA_AGENT_BROWSER_BIN || env.AGENT_BROWSER_BIN;
  if (explicit && exists(explicit)) return explicit;

  const candidates = [
    path.join(root, "node_modules", ".bin", "agent-browser"),
    path.join(home, ".local", "bin", "agent-browser"),
    "/usr/local/bin/agent-browser",
    "/opt/homebrew/bin/agent-browser",
  ];
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return "agent-browser"; // last resort: rely on PATH
}

/**
 * A copy of `env` with the resolved binary's directory prepended to PATH, so
 * anything agent-browser itself launches can find it too. A bare name
 * (nothing resolved) changes nothing.
 */
export function withBinOnPath(env: NodeJS.ProcessEnv, bin: string): NodeJS.ProcessEnv {
  if (!bin.includes(path.sep) && !bin.includes("/")) return env;
  const dir = path.dirname(bin);
  const sep = path.delimiter;
  const current = env.PATH ?? "";
  if (current.split(sep).filter(Boolean).includes(dir)) return env;
  return { ...env, PATH: current ? `${dir}${sep}${current}` : dir };
}
