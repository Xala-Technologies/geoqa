/**
 * Read-only surface for the MCP server.
 *
 * MCP sits above the CLI the same way the CLI sits above the stages: it calls
 * the same functions, with the same `CommandDeps` injection, and adds no second
 * derivation of a run or an index.
 */
export {
  defaultDeps,
  runsList,
  runsRebuild,
  evidenceInspect,
  evidencePrune,
  parsePrunePolicy,
  profileList,
  journeyList,
  tenantList,
  tenantPath,
  dashboardBuild,
  siteAnalyse,
  contentAnalyse,
  browserVerify,
  proxyVerify,
  journeyRun,
  gateCheck,
  matrixRun,
  experimentRun,
  digestSend,
  findingsFile,
  findingsRepair,
  fixRun,
  assistExplain,
  keywordsResearch,
  loadUrlList,
  nodePackageFs,
  resolveEvidenceRoot,
  type CommandDeps,
  type RunsListResult,
  type JourneyRunOptions,
  type MatrixRunOptions,
  type GateCheckOptions,
  type ExperimentOptions,
  type KeywordsResearchOptions,
  type DigestSendOptions,
  type FixRunCommandOptions,
} from "../cli/commands.js";
export { loadEvidencePackage, loadEvidenceShot, type EvidencePackage } from "../evidence/package.js";
export { readManifest } from "../evidence/store.js";
export { GEOQA_SCHEMA_VERSION } from "../evidence/manifest.js";
export { findRepoRoot, defaultEvidenceRoot, profilesRoot, tenantsRoot } from "../repo.js";
export { nodeHistoryFs } from "../history/store.js";
export { loadConfig, configPath } from "../config/load.js";
export { buildSettings, type SettingsView } from "../server/settings.js";
export { loadTenant } from "../tenant/registry.js";
export { SAMPLERS } from "../cli/samplers.js";
export { findExperiment } from "../experiments/definitions.js";
export { settingsView } from "./settings.js";
