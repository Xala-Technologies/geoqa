/**
 * One process that starts the API and the Vite UI together.
 *
 * Operators were running `pnpm geoqa server` and `pnpm ui:dev` in two terminals,
 * and forgetting the first — Vite then proxied `/api` at a port nothing was
 * listening on, which looks like a broken console rather than a missing server.
 * `pnpm dev` is that pair, with `.env` loaded the way a person sources it, and
 * the same auth refusal the server already makes: no default password, no UI
 * pointed at a dead API.
 *
 * Docker is the tempting alternative and the wrong one here. A run launches
 * Chrome, reads `GEOQA_PROXY_*` from the host environment, and the UI is Vite
 * HMR on :5173. None of that wants a container for local work.
 */
import path from "node:path";
import { readAuthConfig } from "@geoqa/engine/server/auth.js";

export const DEV_API_PORT = 4180;
export const DEV_UI_PORT = 5173;

export interface DevChildSpec {
  name: "api" | "ui";
  command: string;
  args: string[];
}

export interface DevPlan {
  children: DevChildSpec[];
  urls: { api: string; ui: string };
}

export interface DevChild {
  onExit: (fn: (code: number | null) => void) => void;
  kill: (signal?: string) => void;
}

export type DevSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => DevChild;

export type HealthProbe = (url: string) => Promise<boolean>;

export interface StartDevOptions {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
  read: (p: string) => string;
  spawn: DevSpawn;
  log: (line: string) => void;
  /** Injected so tests do not open a socket. Production probes `GET /health`. */
  probe: HealthProbe;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  readyTimeoutMs?: number;
}

export const READY_TIMEOUT_MS = 20_000;
export const READY_INTERVAL_MS = 150;

export type WaitHealthy = { ok: true } | { ok: false; error: string };

/**
 * Poll until the API accepts connections, or the budget runs out.
 *
 * Vite is up in tens of milliseconds. `tsx` + watch attach is not. Starting both
 * at once is how `/dashboard.json` hits ECONNREFUSED and the console looks broken
 * while the server is still printing its boot lines.
 */
export async function waitUntilHealthy(
  url: string,
  options: {
    probe: HealthProbe;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    timeoutMs: number;
    intervalMs: number;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const deadline = options.now() + options.timeoutMs;
  while (options.now() < deadline) {
    if (await options.probe(url)) return { ok: true };
    await options.sleep(options.intervalMs);
  }
  return {
    ok: false,
    error: `API at ${url} did not become ready within ${options.timeoutMs}ms. Is port ${DEV_API_PORT} already taken?`,
  };
}

/**
 * A `.env` file, not a shell. Comments, blanks, `export`, and double-quoted
 * values — enough to load what `pnpm geoqa server hash` printed, without
 * becoming a second config language.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq < 0) continue;
    const key = body.slice(0, eq).trim();
    if (key === "") continue;
    let value = body.slice(eq + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * An already-set variable wins, including an explicit empty string. A shell
 * export is a decision; `.env` fills gaps, it does not overwrite them.
 */
export function mergeEnv(current: NodeJS.ProcessEnv, file: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...current };
  for (const [key, value] of Object.entries(file)) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

export function planDev(_repoRoot: string): DevPlan {
  return {
    children: [
      { name: "api", command: "pnpm", args: ["geoqa", "server", "--port", String(DEV_API_PORT)] },
      { name: "ui", command: "pnpm", args: ["--filter", "geoqa-ui", "dev"] },
    ],
    urls: {
      api: `http://127.0.0.1:${DEV_API_PORT}`,
      ui: `http://127.0.0.1:${DEV_UI_PORT}`,
    },
  };
}

export function startDev(
  options: StartDevOptions,
):
  | { ok: true; stop: () => void; ready: Promise<WaitHealthy> }
  | { ok: false; error: string } {
  const envPath = path.join(options.repoRoot, ".env");
  const fromFile = options.exists(envPath) ? parseDotenv(options.read(envPath)) : {};
  const env = mergeEnv(options.env, fromFile);
  const auth = readAuthConfig(env);
  if (!auth.ok) return { ok: false, error: auth.error };

  const plan = planDev(options.repoRoot);
  const api = plan.children[0];
  const ui = plan.children[1];
  if (api === undefined || ui === undefined) return { ok: false, error: "dev plan is missing a child" };

  options.log(`geoqa console — UI ${plan.urls.ui}  (API ${plan.urls.api})`);

  const children: DevChild[] = [];
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
  };

  const child = options.spawn(api.command, api.args, { cwd: options.repoRoot, env });
  child.onExit(() => {
    if (!stopping) stop();
  });
  children.push(child);

  const ready = (async (): Promise<WaitHealthy> => {
    const health = await waitUntilHealthy(`${plan.urls.api}/health`, {
      probe: options.probe,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: options.now ?? Date.now,
      timeoutMs: options.readyTimeoutMs ?? READY_TIMEOUT_MS,
      intervalMs: READY_INTERVAL_MS,
    });
    if (!health.ok) {
      options.log(health.error);
      stop();
      return health;
    }
    if (stopping) return { ok: false, error: "stopped before the UI started" };
    const vite = options.spawn(ui.command, ui.args, { cwd: options.repoRoot, env });
    vite.onExit(() => {
      if (!stopping) stop();
    });
    children.push(vite);
    options.log(`API is up — starting Vite on ${plan.urls.ui}`);
    return { ok: true };
  })();

  return { ok: true, stop, ready };
}
