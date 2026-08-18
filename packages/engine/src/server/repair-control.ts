/**
 * Whether a findings repair may start, and how far the one in flight is.
 *
 * The actual clone / claude / PR work lives in `cli/commands.ts`. This is
 * only the gate: one repair at a time, so two clicks cannot open two PRs
 * for the same issue.
 */

export interface RepairProgress {
  running: boolean;
  queued: number;
  done: number;
  failed: number;
  last: string | null;
}

export interface RepairStart extends RepairProgress {
  started: boolean;
  reason?: string;
}

export type KeysParse = { ok: true; keys?: string[] } | { ok: false; error: string };

export function keysFromBody(body: string): KeysParse {
  if (body === "" || body === "{}") return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: "body must be JSON with an optional keys array" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "body must be JSON with an optional keys array" };
  }
  const record = parsed as Record<string, unknown>;
  if (!("keys" in record)) return { ok: true };
  if (!Array.isArray(record.keys) || record.keys.some((key) => typeof key !== "string")) {
    return { ok: false, error: "body must be JSON with an optional keys array" };
  }
  return { ok: true, keys: record.keys as string[] };
}

export function createRepairGate(): {
  status: () => RepairProgress;
  begin: (queued?: number) => RepairStart;
  note: (last: string, outcome: "done" | "failed") => void;
  finish: (last: string) => void;
} {
  let progress: RepairProgress = idle();
  return {
    status: () => ({ ...progress }),
    begin: (queued?: number) => {
      if (progress.running) return { started: false, ...progress, reason: "already running" };
      if (queued === 0) return { started: false, ...progress, reason: "nothing to fix" };
      progress = { running: true, queued: queued ?? 0, done: 0, failed: 0, last: "starting" };
      return { started: true, ...progress };
    },
    note: (last, outcome) => {
      progress =
        outcome === "done"
          ? { ...progress, done: progress.done + 1, last }
          : { ...progress, failed: progress.failed + 1, last };
    },
    finish: (last) => {
      progress = { ...progress, running: false, last };
    },
  };
}

const idle = (): RepairProgress => ({ running: false, queued: 0, done: 0, failed: 0, last: null });
