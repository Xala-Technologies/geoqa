import { z } from "zod";
import {
  dashboardBuild,
  evidenceInspect,
  journeyList,
  loadEvidencePackage,
  loadEvidenceShot,
  nodeHistoryFs,
  nodePackageFs,
  profileList,
  runsList,
  runsRebuild,
  siteAnalyse,
  tenantList,
  GEOQA_SCHEMA_VERSION,
  type CommandDeps,
} from "@geoqa/engine/mcp.js";

const jsonText = (value: unknown): { content: [{ type: "text"; text: string }] } => ({
  content: [{ type: "text", text: JSON.stringify({ schemaVersion: GEOQA_SCHEMA_VERSION, ...value as object }, null, 2) }],
});

const historyFilter = {
  url: z.string().optional().describe("Filter by target URL prefix"),
  geo: z.string().optional().describe("Filter by profile id (e.g. oslo-mobile)"),
  journey: z.string().optional().describe("Filter by journey id"),
  verdict: z.enum(["PASS", "FAIL", "ERROR", "WARNING"]).optional(),
  since: z.string().optional().describe("ISO timestamp — runs started at or after this instant"),
};

export function registerCatalogTools(server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, deps: CommandDeps): void {
  server.registerTool(
    "profiles_list",
    {
      description: "List geographic profiles (market × device) available for runs",
      inputSchema: z.object({}),
    },
    async () => jsonText(profileList(deps)),
  );

  server.registerTool(
    "journeys_list",
    {
      description: "List visitor journeys that can be executed against a site",
      inputSchema: z.object({}),
    },
    async () => jsonText(journeyList(deps)),
  );

  server.registerTool(
    "tenants_list",
    {
      description: "List configured tenants (customers) with market and quota summary",
      inputSchema: z.object({}),
    },
    async () => jsonText(tenantList(deps)),
  );
}

export function registerRunsTools(server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, deps: CommandDeps): void {
  server.registerTool(
    "runs_list",
    {
      description: "List runs from the evidence index with optional filters, summary, and regressions",
      inputSchema: z.object({
        ...historyFilter,
        limit: z.number().int().min(1).max(500).optional().describe("Max runs returned (default 20)"),
      }),
    },
    async (input) => {
      const result = runsList(deps, {
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.geo !== undefined ? { geo: input.geo } : {}),
        ...(input.journey !== undefined ? { journey: input.journey } : {}),
        ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
        ...(input.since !== undefined ? { since: input.since } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return jsonText(result);
    },
  );

  server.registerTool(
    "runs_rebuild",
    {
      description: "Rebuild runs.jsonl from run.json files on disk (safe when the index is stale or corrupt)",
      inputSchema: z.object({}),
      annotations: { destructiveHint: true },
    },
    async () => jsonText(runsRebuild(deps)),
  );

  server.registerTool(
    "site_analyse",
    {
      description: "Cross-market site analysis from run history (geo divergence, vitals trends)",
      inputSchema: z.object(historyFilter),
    },
    async (input) => {
      const result = siteAnalyse(deps, {
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.geo !== undefined ? { geo: input.geo } : {}),
        ...(input.journey !== undefined ? { journey: input.journey } : {}),
        ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
        ...(input.since !== undefined ? { since: input.since } : {}),
      });
      return jsonText(result);
    },
  );

  server.registerTool(
    "dashboard_get",
    {
      description: "Build and return the operator dashboard view (same JSON the console renders)",
      inputSchema: z.object({}),
    },
    async () => {
      const { view, path: dashboardPath } = dashboardBuild({
        evidenceRoot: deps.evidenceRoot,
        historyFs: nodeHistoryFs,
        now: deps.now,
      });
      return jsonText({ path: dashboardPath, view, warnings: view.warnings });
    },
  );
}

export function registerEvidenceTools(server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, deps: CommandDeps): void {
  server.registerTool(
    "evidence_manifest",
    {
      description: "Read the evidence manifest for one run (artifacts, tier, completeness)",
      inputSchema: z.object({
        runId: z.string().regex(/^run_[A-Za-z0-9._-]+$/).describe("Run id, e.g. run_20260813_abc"),
      }),
    },
    async ({ runId }) => jsonText(evidenceInspect(deps, runId)),
  );

  server.registerTool(
    "evidence_get",
    {
      description: "Load the full evidence package for a run: steps, issues, console, screenshots list, ticket brief",
      inputSchema: z.object({
        runId: z.string().regex(/^run_[A-Za-z0-9._-]+$/),
      }),
    },
    async ({ runId }) => {
      const loaded = loadEvidencePackage(deps.evidenceRoot, runId, nodePackageFs);
      if (!loaded.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: loaded.error }],
        };
      }
      return jsonText(loaded.value);
    },
  );

  server.registerTool(
    "evidence_screenshot",
    {
      description: "Fetch one screenshot from a run as base64 (for vision models)",
      inputSchema: z.object({
        runId: z.string().regex(/^run_[A-Za-z0-9._-]+$/),
        label: z.string().regex(/^[A-Za-z0-9._-]+$/).describe("Screenshot label from the journey step"),
      }),
    },
    async ({ runId, label }) => {
      const shot = loadEvidenceShot(deps.evidenceRoot, runId, label, nodePackageFs);
      if (shot === null) {
        return {
          isError: true,
          content: [{ type: "text", text: `no screenshot "${label}" for run "${runId}"` }],
        };
      }
      return jsonText({ runId, label, mime: shot.type, dataBase64: shot.body.toString("base64") });
    },
  );
}
