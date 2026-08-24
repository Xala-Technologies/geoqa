/**
 * One fix run at a time, across processes.
 *
 * `server/repair-control.ts` already single-flights repair — but it is a
 * module-level object wired only to the HTTP route, so the CLI and the
 * watch loop bypass it entirely. That is fine for `findings repair`, which is
 * seconds of git in a repo geoqa owns. It is not fine here: two fix runs would
 * clone the same repository to the same path, on the same branch, and each
 * would `rm` the other's work mid-model-call.
 *
 * The realistic collision is not two timers — systemd will not start a second
 * instance of a `Type=oneshot` unit while one is active — but an operator
 * running the command by hand at 09:02. Only a file on disk sees that.
 *
 * A lock that can outlive its process is a lock that eventually wedges the
 * timer forever, so it carries a start time and goes STALE. Stale is taken,
 * not refused: a run whose process died holding a lock has already failed, and
 * the next run is the recovery.
 */
import path from "node:path";
import { z } from "zod";
import type { FiledStore } from "../findings/github.js";

export const FIX_LOCK_FILE = "fix.lock";

/** Budget plus an hour: long enough that a legitimately slow run is never evicted. */
export const LOCK_STALE_GRACE_MS = 3_600_000;

export interface FixLock {
  pid: number;
  startedAt: string;
  startedMs: number;
}

const Schema = z.object({ pid: z.number().int(), startedAt: z.string().min(1), startedMs: z.number() }).strict();

export const fixLockPath = (evidenceRoot: string): string => path.join(evidenceRoot, FIX_LOCK_FILE);

export type AcquireResult = { ok: true } | { ok: false; held: FixLock | null };

export function acquireLock(
  evidenceRoot: string,
  store: FiledStore,
  input: { pid: number; nowMs: number; budgetMs: number },
): AcquireResult {
  const file = fixLockPath(evidenceRoot);
  if (store.exists(file)) {
    let held: FixLock | null = null;
    try {
      const parsed = Schema.safeParse(JSON.parse(store.read(file)));
      if (parsed.success) held = parsed.data;
    } catch {
      // An unparseable lock is a lock nobody can prove is held. Treated as stale
      // below, because the alternative is a timer that is red until a human
      // deletes a file they have never heard of.
      held = null;
    }
    const stale = held === null || input.nowMs - held.startedMs > input.budgetMs + LOCK_STALE_GRACE_MS;
    if (!stale) return { ok: false, held };
  }
  store.mkdir(evidenceRoot);
  store.write(
    file,
    `${JSON.stringify({ pid: input.pid, startedAt: new Date(input.nowMs).toISOString(), startedMs: input.nowMs }, null, 2)}\n`,
  );
  return { ok: true };
}

/**
 * Release is best-effort by design.
 *
 * It runs in a `finally` after a run that may already be failing, and a throw
 * from the release path would replace a real error with a filesystem one. The
 * stale window is the backstop for the case where it does not happen at all.
 */
export function releaseLock(evidenceRoot: string, store: FiledStore, rm: (p: string) => void): void {
  try {
    const file = fixLockPath(evidenceRoot);
    if (store.exists(file)) rm(file);
  } catch {
    // See above.
  }
}
