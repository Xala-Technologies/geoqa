/**
 * The growth database, as a port and a set of statements — no driver.
 *
 * `growth.agent_findings` is owned by the growth fleet, which upserts on
 * `(agent, finding_key)` every night. This module is READ-ONLY except for one
 * guarded UPDATE that records the issue we opened, and that UPDATE is written
 * to survive the fleet's own upsert rather than fight it:
 *
 *   - `github_issue` is only written where it is still `''`, so we can never
 *     overwrite an issue the fleet already filed.
 *   - `status` is moved to `filed` and never to `fixed`. Whether the fix WORKED
 *     is not ours to assert — the fleet's next crawl either still sees the
 *     finding or does not, and `RESOLVE_FINDINGS_SQL` writes `fixed` from that.
 *     A repair agent that marked its own work fixed would be grading itself.
 *   - `fixed` and `dismissed` are human verdicts and are left exactly alone.
 *
 * The connection convention is `growth-fleet/core/goals-store.ts`, variable for
 * variable: POSTGRES_HOST/PORT/USER/PASSWORD/DB, with `POSTGRES_PASSWORD` as the
 * gate because it is the one setting with no default. Everything that opens a
 * socket lives in `growth-pg.ts`; every decision about a row lives here.
 */

/** One row of `growth.v_agent_findings_open`. */
export interface GrowthFindingRow {
  id: number;
  runId: number | null;
  agent: string;
  foundAt: string;
  firstSeen: string;
  lastSeen: string;
  daysOpen: number;
  findingKey: string;
  severity: string;
  severityRank: number;
  category: string;
  rule: string;
  surface: string;
  /** A site ID from the fleet's config (`marketing`, `app`), NOT a hostname. */
  site: string;
  url: string;
  keyword: string;
  title: string;
  detail: string;
  recommendedAction: string;
  estimatedImpact: string;
  status: "open" | "filed" | "fixed" | "dismissed";
  targetRepo: string;
  linearIssue: string;
  githubIssue: string;
}

/**
 * Every I/O the growth source needs. The only thing `fix/` knows about Postgres.
 *
 * A port and not a pool, for the same reason `RepairExec` is a port: the whole
 * decision surface above it is then coverable without a database, and the suite
 * cannot accidentally be pointed at the live growth schema.
 */
export interface GrowthDb {
  openFindings(input: { limit: number }): Promise<GrowthFindingRow[]>;
  markFiled(input: { agent: string; findingKeys: string[]; githubIssue: string }): Promise<string[]>;
  openRun(input: {
    runKey: string;
    startedAt: string;
    hostRepo: string;
    triggeredBy: "timer" | "manual";
    runMode: "dry-run" | "apply";
    workflow: string;
  }): Promise<number | null>;
  closeRun(input: {
    runId: number | null;
    status: "success" | "failed";
    itemsFiled: number;
    apiCalls: number;
    error?: string;
  }): Promise<void>;
  close(): Promise<void>;
}

/** The agent slug this run reports under. Not in the fleet registry — see AGENTS.md. */
export const FIX_AGENT_SLUG = "fixer";

/** A backstop, not the working size. Grouping collapses hundreds of rows into one item. */
export const MAX_OPEN_FINDINGS = 2_000;

/**
 * `status IN ('open','filed')` on purpose, and it is the view's own filter.
 *
 * A `filed` row is precisely a repair candidate: it already carries
 * `github_issue`, which is the only thing that makes an unattended fix
 * unambiguous. Reading only `open` would have skipped the entire real workload
 * — the 339 meta-length rows behind issue #343 are all `filed`.
 */
export const OPEN_FINDINGS_SQL = `
  SELECT f.id, f.run_id, f.agent,
         to_char(f.found_at, 'YYYY-MM-DD"T"HH24:MI:SSZ')  AS found_at,
         to_char(f.first_seen, 'YYYY-MM-DD')              AS first_seen,
         to_char(f.last_seen, 'YYYY-MM-DD')               AS last_seen,
         f.days_open, f.finding_key, f.severity, f.severity_rank,
         f.category, f.rule, f.surface, f.site, f.url, f.keyword,
         f.title, f.detail, f.recommended_action, f.estimated_impact,
         f.status, f.target_repo, f.linear_issue, f.github_issue
    FROM growth.v_agent_findings_open f
   ORDER BY f.severity_rank DESC, f.last_seen DESC
   LIMIT $1
`;

/**
 * Record the issue this run is working, without ever contradicting the fleet.
 *
 * `github_issue = ''` in the WHERE is the idempotency guard: a second night
 * matches no rows and files no twin. `status` never becomes `fixed` here.
 */
export const MARK_FILED_SQL = `
  UPDATE growth.agent_findings
     SET github_issue      = $3,
         status            = CASE WHEN status IN ('fixed','dismissed') THEN status ELSE 'filed' END,
         status_changed_at = CASE WHEN status IN ('fixed','dismissed','filed')
                                  THEN status_changed_at ELSE now() END
   WHERE agent = $1 AND finding_key = ANY($2::text[]) AND github_issue = ''
  RETURNING finding_key
`;

export const OPEN_RUN_SQL = `
  INSERT INTO growth.agent_runs
      (agent, run_key, started_at, status, host_repo, triggered_by, run_mode, workflow,
       findings_written, items_filed, api_calls, cost_usd)
  VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, 0, 0, 0, 0)
  ON CONFLICT (agent, run_key) WHERE run_key <> '' DO UPDATE SET
      started_at   = EXCLUDED.started_at,
      status       = 'running',
      finished_at  = NULL,
      host_repo    = EXCLUDED.host_repo,
      triggered_by = EXCLUDED.triggered_by,
      run_mode     = EXCLUDED.run_mode,
      workflow     = EXCLUDED.workflow,
      error        = NULL
  RETURNING id
`;

export const CLOSE_RUN_SQL = `
  UPDATE growth.agent_runs
     SET finished_at = now(), status = $2, items_filed = $3, api_calls = $4, error = $5
   WHERE id = $1
`;

const str = (value: unknown): string => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));

const num = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(str(value));
  return Number.isFinite(n) ? n : 0;
};

const STATUSES = new Set(["open", "filed", "fixed", "dismissed"]);

/**
 * One database row → one `GrowthFindingRow`.
 *
 * Every column that 005 declares `NOT NULL DEFAULT ''` is read through `str`
 * anyway: node-postgres hands back whatever the driver decoded, and a mapping
 * that assumed a type would fail at the end of a run rather than at the row.
 */
export function toFindingRow(raw: Record<string, unknown>): GrowthFindingRow {
  const status = str(raw.status);
  return {
    id: num(raw.id),
    runId: raw.run_id === null || raw.run_id === undefined ? null : num(raw.run_id),
    agent: str(raw.agent),
    foundAt: str(raw.found_at),
    firstSeen: str(raw.first_seen),
    lastSeen: str(raw.last_seen),
    daysOpen: num(raw.days_open),
    findingKey: str(raw.finding_key),
    severity: str(raw.severity),
    severityRank: num(raw.severity_rank),
    category: str(raw.category),
    rule: str(raw.rule),
    surface: str(raw.surface),
    site: str(raw.site),
    url: str(raw.url),
    keyword: str(raw.keyword),
    title: str(raw.title),
    detail: str(raw.detail),
    recommendedAction: str(raw.recommended_action),
    estimatedImpact: str(raw.estimated_impact),
    status: STATUSES.has(status) ? (status as GrowthFindingRow["status"]) : "open",
    targetRepo: str(raw.target_repo),
    linearIssue: str(raw.linear_issue),
    githubIssue: str(raw.github_issue),
  };
}

/** Connection settings — the same names and defaults as `goals-store.ts`. */
export interface GrowthDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max: number;
  connectionTimeoutMillis: number;
  statement_timeout: number;
}

export const GROWTH_DB_CONNECT_TIMEOUT_MS = 5_000;
export const GROWTH_DB_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Resolve the connection, or `null` when this host is not pointed at the growth
 * database at all.
 *
 * `POSTGRES_PASSWORD` is the gate for the reason `goals-store.ts` gives: host,
 * port, user and database all fall back, so their presence proves nothing about
 * whether anybody configured this. `null` makes the growth source `off`, which
 * is a different report from `unavailable`.
 */
export function growthDbConfig(env: NodeJS.ProcessEnv): GrowthDbConfig | null {
  const password = env.POSTGRES_PASSWORD ?? "";
  if (password === "") return null;
  return {
    host: env.POSTGRES_HOST || "postgres",
    port: Number(env.POSTGRES_PORT || 5432),
    user: env.POSTGRES_USER || "digilist",
    password,
    database: env.POSTGRES_DB || "digilist_growth",
    max: 2,
    connectionTimeoutMillis: GROWTH_DB_CONNECT_TIMEOUT_MS,
    statement_timeout: GROWTH_DB_STATEMENT_TIMEOUT_MS,
  };
}
