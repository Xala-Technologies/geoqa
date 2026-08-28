/**
 * Read-only surface for the MCP server.
 *
 * MCP sits above the CLI the same way the CLI sits above the stages: it calls
 * the same functions, with the same `CommandDeps` injection, and adds no second
 * derivation of a run or an index. Exporting through one file keeps the engine's
 * package boundary explicit — the MCP package imports `@geoqa/engine/mcp.js`,
 * not forty paths into `cli/`.
 */
export {
  defaultDeps,
  runsList,
  runsRebuild,
  evidenceInspect,
  profileList,
  journeyList,
  tenantList,
  dashboardBuild,
  siteAnalyse,
  nodePackageFs,
  resolveEvidenceRoot,
  type CommandDeps,
  type RunsListResult,
} from "../cli/commands.js";
export { loadEvidencePackage, loadEvidenceShot, type EvidencePackage } from "../evidence/package.js";
export { readManifest } from "../evidence/store.js";
export { GEOQA_SCHEMA_VERSION } from "../evidence/manifest.js";
export { findRepoRoot, defaultEvidenceRoot } from "../repo.js";
export { nodeHistoryFs } from "../history/store.js";
export { loadConfig, configPath } from "../config/load.js";
