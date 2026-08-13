/**
 * Generic cooldown store — "this resource is unusable until <time>, unless it
 * proves otherwise."
 *
 * Ported from agent-fleet's `core/cooldown.ts`, which earned its shape twice:
 * once on a Max subscription that hit a weekly cap, and once on a paid data
 * provider that ran out of credit. A geo-proxy vendor is the same animal — it
 * has a balance, it has rate limits, and it will fail in the middle of a run.
 *
 * The whole contract is three rules:
 *
 *  1. A cooldown is an OPTIMISATION, never correctness. Every read failure —
 *     missing file, corrupt JSON, unwritable dir — resolves to "not cooling
 *     down", so a broken store can never silence a caller. Writes swallow
 *     errors for the same reason.
 *  2. **Success CLEARS.** `withoutCooldown` exists because a store that only
 *     ever adds freezes everything the first time a resource recovers early.
 *     That has happened (agent-fleet, 2026-07-25). Any caller that records
 *     failures must also record successes.
 *  3. Elapsed entries are PRUNED on read, so the file cannot grow without
 *     bound and a stale key cannot outlive its window.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path, { dirname } from "node:path";

/** The store's filename, beside `runs.jsonl` under the evidence root. */
export const COOLDOWN_FILE = "cooldowns.json";

/**
 * Where this installation's provider cooldowns live.
 *
 * Under the evidence root, and therefore under the TENANT's root when one is scoped: a tenant
 * with its own proxy account must not inherit another tenant's frozen vendor, and must not
 * freeze theirs. Derived in one place so no command can look at a different file than the one
 * the last run wrote — two paths for one vendor's health is how a cooled-down provider gets
 * retried by whichever command read the other.
 */
export const cooldownStorePath = (evidenceRoot: string): string => path.join(evidenceRoot, COOLDOWN_FILE);

/** resource key → cooldown-until epoch-ms. Absent or past ⇒ available. */
export type Cooldowns = Record<string, number>;

/** Is `key` cooling down right now? Absent or elapsed ⇒ false (available). */
export function coolingDown(cools: Cooldowns, key: string, nowMs: number): boolean {
  const until = cools[key];
  return typeof until === "number" && until > nowMs;
}

/** Pure update — a new map with `key` cooled down until `untilMs`. */
export function withCooldown(cools: Cooldowns, key: string, untilMs: number): Cooldowns {
  return { ...cools, [key]: untilMs };
}

/** Pure clear — a new map with `key` removed (proof it is available). */
export function withoutCooldown(cools: Cooldowns, key: string): Cooldowns {
  if (!(key in cools)) return cools;
  const out = { ...cools };
  delete out[key];
  return out;
}

/** Drop elapsed cooldowns, so the store does not grow unbounded. */
export function pruneCooldowns(cools: Cooldowns, nowMs: number): Cooldowns {
  const out: Cooldowns = {};
  for (const [key, until] of Object.entries(cools)) if (until > nowMs) out[key] = until;
  return out;
}

/** Load the map; a missing or corrupt file is an empty map (never throws). */
export function loadCooldowns(storePath: string): Cooldowns {
  try {
    if (!existsSync(storePath)) return {};
    const raw = JSON.parse(readFileSync(storePath, "utf8")) as unknown;
    // `Array.isArray` is not redundant: `typeof [] === "object"`, so without it
    // a store corrupted into `[1,2]` yields the keys "0" and "1" instead of the
    // empty map this function promises. agent-fleet's `core/cooldown.ts` — the
    // original this was ported from — still has that hole.
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Cooldowns = {};
    for (const [key, until] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof until === "number" && Number.isFinite(until)) out[key] = until;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the map (best-effort; a write failure is swallowed). */
export function saveCooldowns(storePath: string, cools: Cooldowns): void {
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify(cools, null, 2));
  } catch {
    /* an optimisation, not correctness — never fail a run on it */
  }
}

/**
 * Read-modify-write one key: cool it until `untilMs`, or clear it when
 * `untilMs` is null. Prunes elapsed entries in the same pass.
 *
 * Deliberately NOT atomic. Two runs recording outcomes for different providers
 * in the same millisecond can lose one update, and that is fine: the loser's
 * provider is simply re-probed on its next call, which re-records the same
 * outcome. Locking a file that exists to save round-trips would cost more than
 * the round-trips.
 */
export function recordCooldown(
  storePath: string,
  key: string,
  untilMs: number | null,
  nowMs: number,
): Cooldowns {
  const cools = pruneCooldowns(loadCooldowns(storePath), nowMs);
  const next = untilMs === null ? withoutCooldown(cools, key) : withCooldown(cools, key, untilMs);
  saveCooldowns(storePath, next);
  return next;
}
