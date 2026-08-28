/**
 * Build the same `CommandDeps` the CLI uses, from environment variables.
 *
 * MCP runs as a long-lived stdio process: logging every tool call to stderr would
 * corrupt nothing (stdout is JSON-RPC) but would flood the client's log. The deps
 * therefore use a silent logger unless `GEOQA_MCP_VERBOSE=1`.
 */
import path from "node:path";
import {
  configPath,
  defaultDeps,
  defaultEvidenceRoot,
  findRepoRoot,
  loadConfig,
  resolveEvidenceRoot,
  type CommandDeps,
} from "@geoqa/engine/mcp.js";

export interface McpConfig {
  deps: CommandDeps;
  repoRoot: string;
  evidenceRoot: string;
  /** When set, live endpoints proxy to `geoqa server` instead of refusing. */
  serverUrl: string | null;
  apiToken: string | null;
}

export function createMcpConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): McpConfig {
  const repoRoot = env.GEOQA_REPO_ROOT !== undefined && env.GEOQA_REPO_ROOT !== ""
    ? path.resolve(env.GEOQA_REPO_ROOT)
    : findRepoRoot(cwd);

  const loaded = loadConfig(configPath(repoRoot));
  const configuredRoot = loaded.ok ? loaded.value.config.evidence.root : defaultEvidenceRoot(repoRoot);
  const evidenceRoot = resolveEvidenceRoot(
    repoRoot,
    configuredRoot,
    env.GEOQA_EVIDENCE_ROOT !== undefined && env.GEOQA_EVIDENCE_ROOT !== "" ? env.GEOQA_EVIDENCE_ROOT : undefined,
  );

  const verbose = env.GEOQA_MCP_VERBOSE === "1";
  const deps = defaultDeps(repoRoot, {
    evidenceRoot,
    env,
    log: verbose ? (line) => console.error(`[geoqa-mcp] ${line}`) : () => {},
    ...(env.GEOQA_TENANT !== undefined && env.GEOQA_TENANT !== "" ? { tenantId: env.GEOQA_TENANT } : {}),
  });

  const serverUrl = env.GEOQA_SERVER_URL !== undefined && env.GEOQA_SERVER_URL !== ""
    ? env.GEOQA_SERVER_URL.replace(/\/$/, "")
    : null;
  const apiToken = env.GEOQA_API_TOKEN !== undefined && env.GEOQA_API_TOKEN !== "" ? env.GEOQA_API_TOKEN : null;

  return { deps, repoRoot, evidenceRoot, serverUrl, apiToken };
}
