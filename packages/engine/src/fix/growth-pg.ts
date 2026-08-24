/**
 * The only file in geoqa that opens a socket to the growth database.
 *
 * Coverage-excluded, and the exclusion names its reason the way every other one
 * in `vitest.config.ts` does: exercising this means connecting to Postgres,
 * which the unit suite must never do, and every DECISION about a row lives in
 * `growth-db.ts` and `intake-growth.ts` where it is covered against an injected
 * `GrowthDb`. Same shape as `assist/repair-exec.ts` and `assist/claude-spawn.ts`.
 *
 * `pg` arrives by dynamic import for the reason `growth-fleet/core/goals-store.ts`
 * gives: `importPg` is a parameter, so both the driver-present and the
 * driver-absent paths are reachable from a test without `vi.mock("pg")` — and a
 * `vi.mock` on a specifier that stops resolving does not error, it silently
 * stops mocking.
 */
import { describeThrown } from "../errors.js";
import {
  CLOSE_RUN_SQL,
  FIX_AGENT_SLUG,
  MARK_FILED_SQL,
  OPEN_FINDINGS_SQL,
  OPEN_RUN_SQL,
  toFindingRow,
  type GrowthDb,
  type GrowthDbConfig,
  type GrowthFindingRow,
} from "./growth-db.js";

/** The `pg` surface this module uses, structurally — so `tsc` runs with no driver installed. */
export interface PgLikeResult {
  rows: Record<string, unknown>[];
}

export interface PgLikePool {
  query(text: string, values?: unknown[]): Promise<PgLikeResult>;
  end(): Promise<void>;
  on?(event: "error", listener: (err: Error) => void): unknown;
}

export type PgModuleLike = { Pool?: new (cfg: GrowthDbConfig) => PgLikePool; default?: { Pool?: new (cfg: GrowthDbConfig) => PgLikePool } };
export type PgModuleImporter = () => Promise<PgModuleLike>;

const PG_SPECIFIER = "pg";
export const importPgModule: PgModuleImporter = () => import(PG_SPECIFIER) as Promise<PgModuleLike>;

export class GrowthDriverMissingError extends Error {
  constructor(cause: unknown) {
    super(`the "pg" driver did not load in @geoqa/engine — run \`pnpm install\` (${describeThrown(cause)})`);
    this.name = "GrowthDriverMissingError";
  }
}

/**
 * A client that fails while sitting IDLE in the pool is emitted as a pool
 * `'error'` EVENT, from a callback outside every `try` here. An EventEmitter
 * `'error'` with no listener is rethrown as an uncaught exception and would
 * take the whole run down — which is precisely what `fix/run.ts` promises
 * cannot happen. No `catch` can reach it; the listener is the only fix.
 */
export function attachIdleErrorGuard(pool: PgLikePool, log: (line: string) => void): PgLikePool {
  pool.on?.("error", (error) => {
    log(`growth pool idle client error: ${error.message}`);
  });
  return pool;
}

export async function createGrowthPool(
  cfg: GrowthDbConfig,
  log: (line: string) => void,
  importPg: PgModuleImporter = importPgModule,
): Promise<PgLikePool> {
  let mod: PgModuleLike;
  try {
    mod = await importPg();
  } catch (error) {
    throw new GrowthDriverMissingError(error);
  }
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (Pool === undefined) throw new GrowthDriverMissingError(new Error('"pg" exported no Pool'));
  return attachIdleErrorGuard(new Pool(cfg), log);
}

/** Wrap a pool as the port the rest of `fix/` sees. */
export function growthDbOver(pool: PgLikePool): GrowthDb {
  return {
    openFindings: async (input): Promise<GrowthFindingRow[]> => {
      const result = await pool.query(OPEN_FINDINGS_SQL, [input.limit]);
      return result.rows.map(toFindingRow);
    },
    markFiled: async (input): Promise<string[]> => {
      if (input.findingKeys.length === 0) return [];
      const result = await pool.query(MARK_FILED_SQL, [input.agent, input.findingKeys, input.githubIssue]);
      return result.rows.map((row) => String(row.finding_key ?? ""));
    },
    openRun: async (input): Promise<number | null> => {
      const result = await pool.query(OPEN_RUN_SQL, [
        FIX_AGENT_SLUG,
        input.runKey,
        input.startedAt,
        input.hostRepo,
        input.triggeredBy,
        input.runMode,
        input.workflow,
      ]);
      const id = result.rows[0]?.id;
      return typeof id === "number" ? id : id === undefined || id === null ? null : Number(id);
    },
    closeRun: async (input): Promise<void> => {
      if (input.runId === null) return;
      await pool.query(CLOSE_RUN_SQL, [input.runId, input.status, input.itemsFiled, input.apiCalls, input.error ?? null]);
    },
    close: () => pool.end(),
  };
}

/**
 * The `GrowthDb` factory the CLI hands to `fix/run.ts`, or `null` for a host
 * that is not pointed at the growth database.
 *
 * It lives here rather than as a closure in `cli/commands.ts` because calling
 * it opens a socket, and a closure in a covered file is a line the coverage
 * gate insists somebody execute — which for this one means a unit test dialling
 * Postgres. Same reason `growth-pg.ts` is coverage-excluded at all: everything
 * that connects is in this file, everything that decides is not.
 */
export function growthPortFor(cfg: GrowthDbConfig | null, log: (line: string) => void): (() => Promise<GrowthDb>) | null {
  if (cfg === null) return null;
  return async () => growthDbOver(await createGrowthPool(cfg, log));
}
