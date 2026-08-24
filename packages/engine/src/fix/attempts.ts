/**
 * What happened the last time we tried, and how many times we have tried.
 *
 * Deliberately NOT a second truth about "was this repaired". Authority stays
 * per source and where it already is: growth is `agent_findings.github_issue`
 * plus `status`, geoqa is `filed-issues.json` plus `repaired-issues.json`. This
 * file records only the thing nothing else stores anywhere — that an attempt
 * was made, what it cost, and how it ended.
 *
 * It is also the reason `rejected` and `verify-failed` do not go into
 * `repaired-issues.json`. That store's zod enum is `.strict()`, an unknown
 * status makes it unreadable, and unreadable is a total skip of both filing and
 * repair — one new status string would silently stop the whole pipeline. An
 * attempt belongs in the ledger that counts attempts.
 *
 * Same discipline as the two existing stores: `.strict()`, and unreadable is a
 * SKIP of the whole run rather than a licence to retry everything. A corrupt
 * memory means "we do not know what we already tried", which is exactly when
 * retrying everything is most expensive.
 */
import path from "node:path";
import { z } from "zod";
import type { FiledStore } from "../findings/github.js";
import type { FixStatus } from "./types.js";

export const FIX_ATTEMPTS_FILE = "fix-attempts.json";

export interface FixAttempt {
  key: string;
  attempts: number;
  lastAt: string;
  lastStatus: FixStatus;
  lastDetail?: string;
  prUrl?: string;
  /** Wall clock of the last attempt. Recorded so `maxItems` can stop being a guess. */
  lastMs?: number;
}

const AttemptSchema = z
  .object({
    key: z.string().min(1),
    attempts: z.number().int().nonnegative(),
    lastAt: z.string().min(1),
    lastStatus: z.enum(["opened", "cannot-fix", "no-changes", "rejected", "verify-failed", "failed"]),
    lastDetail: z.string().optional(),
    prUrl: z.string().min(1).optional(),
    lastMs: z.number().nonnegative().optional(),
  })
  .strict();

const Schema = z.object({ items: z.array(AttemptSchema) }).strict();

export const fixAttemptsPath = (evidenceRoot: string): string => path.join(evidenceRoot, FIX_ATTEMPTS_FILE);

export interface AttemptLedger {
  attempts(key: string): number;
  last(key: string): FixAttempt | undefined;
}

export function ledgerOf(items: readonly FixAttempt[]): AttemptLedger {
  const byKey = new Map(items.map((item) => [item.key, item]));
  return {
    attempts: (key) => byKey.get(key)?.attempts ?? 0,
    last: (key) => byKey.get(key),
  };
}

export function loadAttempts(evidenceRoot: string, store: FiledStore): { ok: true; items: FixAttempt[] } | { ok: false } {
  const file = fixAttemptsPath(evidenceRoot);
  if (!store.exists(file)) return { ok: true, items: [] };
  try {
    const parsed = Schema.safeParse(JSON.parse(store.read(file)));
    if (!parsed.success) return { ok: false };
    return {
      ok: true,
      items: parsed.data.items.map((item) => ({
        key: item.key,
        attempts: item.attempts,
        lastAt: item.lastAt,
        lastStatus: item.lastStatus,
        ...(item.lastDetail !== undefined ? { lastDetail: item.lastDetail } : {}),
        ...(item.prUrl !== undefined ? { prUrl: item.prUrl } : {}),
        ...(item.lastMs !== undefined ? { lastMs: item.lastMs } : {}),
      })),
    };
  } catch {
    return { ok: false };
  }
}

export function saveAttempts(evidenceRoot: string, items: readonly FixAttempt[], store: FiledStore): void {
  store.mkdir(evidenceRoot);
  store.write(fixAttemptsPath(evidenceRoot), `${JSON.stringify({ items }, null, 2)}\n`);
}

/**
 * Fold one outcome into the ledger.
 *
 * `opened`, `cannot-fix` and `no-changes` are terminal — the first succeeded,
 * the other two are the model's own decision that there is nothing to do here,
 * and asking it again tomorrow gets the same answer. `failed`, `rejected` and
 * `verify-failed` are counted, because those are the ones a different night
 * might genuinely resolve, and counting is what stops "might" becoming
 * "forever".
 */
export function recordAttempt(
  items: readonly FixAttempt[],
  outcome: { key: string; status: FixStatus; detail?: string; prUrl?: string; ms: number },
  atMs: number,
): FixAttempt[] {
  const kept = items.filter((item) => item.key !== outcome.key);
  const previous = items.find((item) => item.key === outcome.key);
  return [
    ...kept,
    {
      key: outcome.key,
      attempts: (previous?.attempts ?? 0) + 1,
      lastAt: new Date(atMs).toISOString(),
      lastStatus: outcome.status,
      lastMs: outcome.ms,
      ...(outcome.detail !== undefined ? { lastDetail: outcome.detail } : {}),
      ...(outcome.prUrl !== undefined ? { prUrl: outcome.prUrl } : {}),
    },
  ].sort((a, b) => a.key.localeCompare(b.key));
}
