/**
 * Talk to the operator's Claude Code CLI (`claude -p`).
 *
 * This is how a Max subscription is spent instead of an API key: the CLI
 * uses the logged-in account. ANTHROPIC_API_KEY is stripped from the child
 * env so a leftover key cannot silently switch the bill to API tokens.
 *
 * Not imported by journeys/, run/, or geo/. A model in the measurement
 * path would make a failing run unreproducible.
 */
import type { AssistFailureKind, AssistOutcome } from "./types.js";

export type { AssistOutcome };

export interface ClaudeSpawnOptions {
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
  bin: string;
}

export type ClaudeSpawn = (
  args: string[],
  options: ClaudeSpawnOptions,
) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: NodeJS.ErrnoException;
}>;

export const DEFAULT_CLAUDE_TIMEOUT_MS = 120_000;

export function envForMaxSubscription(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ANTHROPIC_API_KEY;
  delete next.ANTHROPIC_AUTH_TOKEN;
  return next;
}

export async function runClaudePrint(
  prompt: string,
  options: {
    env: NodeJS.ProcessEnv;
    spawn: ClaudeSpawn;
    bin?: string;
    timeoutMs?: number;
  },
): Promise<AssistOutcome> {
  const bin = options.bin ?? options.env.GEOQA_CLAUDE_BIN ?? "claude";
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS;
  const env = envForMaxSubscription(options.env);
  const reply = await options.spawn(["-p", "--output-format", "text"], {
    env,
    stdin: prompt,
    timeoutMs,
    bin,
  });
  if (reply.error) {
    if (reply.error.code === "ETIMEDOUT") return fail("timeout", reply.error.message);
    const detail =
      reply.error.code === "ENOENT"
        ? "claude CLI not found on PATH — install Claude Code and log in so Max is billed"
        : reply.error.message;
    return fail("spawn", detail);
  }
  if (reply.exitCode !== 0 && reply.exitCode !== null) {
    const detail = reply.stderr.trim() || `claude -p exited ${reply.exitCode}`;
    return fail("exit", detail);
  }
  const text = reply.stdout.trim();
  if (text === "") return fail("empty", "claude -p printed nothing");
  return { ok: true, text };
}

const fail = (kind: AssistFailureKind, detail: string): AssistOutcome => ({
  ok: false,
  failure: { kind, detail },
});

/** Wire `runClaudePrint` to a spawn. What defaultDeps closes over. */
export function bindAssistComplete(
  env: NodeJS.ProcessEnv,
  spawn: ClaudeSpawn,
): (prompt: string) => Promise<AssistOutcome> {
  return (prompt) => runClaudePrint(prompt, { env, spawn });
}
