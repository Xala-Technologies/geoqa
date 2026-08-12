/**
 * Spawn `agent-browser` and return a *typed, verified* result — or an explicit,
 * marked failure. Never anything in between.
 *
 * The rule this file exists to enforce: **transport garbage must never be
 * parseable as a result.** agent-fleet learned that the expensive way — an LLM
 * runner returned whatever text it got, so a killed process, an empty stdout and
 * a real answer all looked alike to the caller, and downstream parsers happily
 * turned a crash into "no findings". Here the equivalent mistake would be worse:
 * "no console errors" and "we never managed to read the console" would score the
 * same, and an evidence engine that cannot tell those apart is not evidence.
 *
 * So every non-success path returns `ok: false` with a named `kind`, and
 * `describeExecFailure` renders it for a human. There is no code path that
 * returns `ok: true` with absent data.
 *
 * Three timeouts, deliberately separate (the shape is ported from agent-fleet's
 * `claude-agent.ts`, where one combined timeout repeatedly hid stalls):
 *   - idle:    no output for N ms → the command is wedged, kill it
 *   - absolute: total wall clock cap, regardless of chattiness
 *   - neither fires for a process that exits on its own, however slowly
 */
import { spawn } from "node:child_process";
import { resolveAgentBrowserBin, withBinOnPath } from "./bin.js";

/** Prefix on any failure text, so a failure can never be mistaken for output. */
export const EXEC_FAILED_MARKER = "GEOQA-EXEC-FAILED";

export type ExecFailureKind =
  /** The process could not be started at all (ENOENT, EACCES…). */
  | "spawn"
  /** Killed at the absolute wall-clock cap. */
  | "timeout"
  /** Killed after producing no output for `idleMs`. */
  | "idle"
  /** Exited non-zero and stdout held no usable envelope. */
  | "exit"
  /** Exited fine but stdout was not an agent-browser JSON envelope. */
  | "unparseable"
  /** A well-formed envelope that reports `success: false`. */
  | "reported";

export interface ExecFailure {
  kind: ExecFailureKind;
  detail: string;
  exitCode: number | null;
  signal: string | null;
}

export interface ExecMeta {
  stdout: string;
  stderr: string;
  durationMs: number;
  /** The exact argv, so a failing run is reproducible by hand from the log. */
  command: string;
}

export type ExecOutcome<T> =
  | ({ ok: true; data: T } & ExecMeta)
  | ({ ok: false; failure: ExecFailure } & ExecMeta);

/** agent-browser's response shape: `{"success":…,"data":…,"error":…}`. */
export interface Envelope {
  success: boolean;
  data: unknown;
  error: string | null;
}

/**
 * Pull the envelope out of raw stdout.
 *
 * agent-browser prints one JSON object per command under `--json`, but the
 * daemon can prepend lifecycle chatter on a cold start, so we scan lines and
 * take the LAST object that structurally looks like an envelope rather than
 * assuming stdout is exactly one JSON document. Returns null when nothing
 * qualifies — the caller turns that into an `unparseable` failure, never into
 * an empty success.
 */
export function parseEnvelope(raw: string): Envelope | null {
  let found: Envelope | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.success !== "boolean") continue;
    found = {
      success: obj.success,
      data: obj.data ?? null,
      error: typeof obj.error === "string" ? obj.error : null,
    };
  }
  return found;
}

/** One-line, human-readable rendering of a failure. Always marker-prefixed. */
export function describeExecFailure(f: ExecFailure): string {
  const bits = [`${EXEC_FAILED_MARKER}[${f.kind}]`, f.detail];
  if (f.exitCode !== null) bits.push(`exit=${f.exitCode}`);
  if (f.signal !== null) bits.push(`signal=${f.signal}`);
  return bits.join(" · ");
}

/** Minimal structural type for the spawn function, so tests can inject a fake. */
export type SpawnFn = typeof spawn;

export interface ExecOptions {
  args: string[];
  bin?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Absolute wall-clock cap in ms. 0 disables. */
  timeoutMs?: number;
  /** Kill after this long with no stdout/stderr byte. 0 disables. */
  idleMs?: number;
  spawnFn?: SpawnFn;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_MS = 45_000;

/**
 * Run one agent-browser command and return its envelope `data`, typed by the
 * caller. `T` is unchecked at runtime by design: agent-browser's payloads vary
 * per command and validating each here would duplicate the adapter's own
 * knowledge of what it asked for.
 */
export function execAgentBrowser<T = unknown>(opts: ExecOptions): Promise<ExecOutcome<T>> {
  const spawnFn = opts.spawnFn ?? spawn;
  const now = opts.now ?? Date.now;
  const bin = opts.bin ?? resolveAgentBrowserBin({ ...(opts.env ? { env: opts.env } : {}) });
  const env = withBinOnPath(opts.env ?? process.env, bin);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const started = now();
  const command = [bin, ...opts.args].join(" ");

  return new Promise<ExecOutcome<T>>((resolve) => {
    const child = spawnFn(bin, opts.args, {
      cwd: opts.cwd ?? process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killedFor: ExecFailureKind | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let absoluteTimer: NodeJS.Timeout | null = null;

    const clearTimers = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (absoluteTimer) clearTimeout(absoluteTimer);
      idleTimer = null;
      absoluteTimer = null;
    };

    const meta = (): ExecMeta => ({ stdout, stderr, durationMs: now() - started, command });

    const fail = (kind: ExecFailureKind, detail: string, exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ ok: false, failure: { kind, detail, exitCode, signal }, ...meta() });
    };

    const succeed = (data: T): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ ok: true, data, ...meta() });
    };

    const kill = (kind: ExecFailureKind): void => {
      killedFor = kind;
      child.kill("SIGKILL");
    };

    const armIdle = (): void => {
      if (idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => kill("idle"), idleMs);
    };

    if (timeoutMs > 0) absoluteTimer = setTimeout(() => kill("timeout"), timeoutMs);
    armIdle();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
      armIdle();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      armIdle();
    });

    child.on("error", (e: Error) => {
      fail("spawn", e.message, null, null);
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      // A watchdog kill is reported as what the watchdog saw, not as a signal
      // death — "idle for 45s" is the actionable fact; "SIGKILL" is not.
      if (killedFor) {
        const limit = killedFor === "idle" ? idleMs : timeoutMs;
        fail(killedFor, `killed after ${limit}ms with no ${killedFor === "idle" ? "output" : "exit"}`, code, signal);
        return;
      }
      const envelope = parseEnvelope(stdout);
      if (!envelope) {
        // Exit code first: a non-zero exit with no envelope is more precisely
        // "the command failed" than "we could not parse it".
        if (code !== 0) fail("exit", stderr.trim() || "non-zero exit with no JSON envelope", code, signal);
        else fail("unparseable", "stdout held no agent-browser JSON envelope", code, signal);
        return;
      }
      if (!envelope.success) {
        fail("reported", envelope.error ?? "agent-browser reported success:false with no error", code, signal);
        return;
      }
      succeed(envelope.data as T);
    });
  });
}
