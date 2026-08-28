import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  contentAnalyse,
  dashboardBuild,
  nodeHistoryFs,
  runsList,
  runsRebuild,
  siteAnalyse,
  type CommandDeps,
} from "@geoqa/engine/mcp.js";
import { jsonText, runTool } from "../json.js";
import { historyFilter } from "../schemas.js";

export function registerRunsTools(server: McpServer, deps: CommandDeps): void {
  server.registerTool(
    "runs_list",
    {
      description: "List runs from the evidence index with filters, summary, and regressions",
      inputSchema: z.object({ ...historyFilter, limit: z.number().int().min(1).max(500).optional() }),
    },
    async (input) =>
      jsonText(
        runsList(deps, {
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.geo !== undefined ? { geo: input.geo } : {}),
          ...(input.journey !== undefined ? { journey: input.journey } : {}),
          ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
          ...(input.since !== undefined ? { since: input.since } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "runs_rebuild",
    { description: "Rebuild runs.jsonl from run.json on disk", inputSchema: {}, annotations: { destructiveHint: true } },
    async () => jsonText(runsRebuild(deps)),
  );

  server.registerTool(
    "site_analyse",
    { description: "Cross-market site analysis from run history", inputSchema: z.object(historyFilter) },
    async (input) =>
      jsonText(
        siteAnalyse(deps, {
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.geo !== undefined ? { geo: input.geo } : {}),
          ...(input.journey !== undefined ? { journey: input.journey } : {}),
          ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
          ...(input.since !== undefined ? { since: input.since } : {}),
        }),
      ),
  );

  server.registerTool(
    "content_analyse",
    { description: "Content-level SEO signals across run history", inputSchema: {} },
    async () => jsonText(contentAnalyse(deps)),
  );

  server.registerTool(
    "dashboard_get",
    { description: "Build operator dashboard JSON (same as the console)", inputSchema: {} },
    async () => {
      const { view, path: dashboardPath } = dashboardBuild({ evidenceRoot: deps.evidenceRoot, historyFs: nodeHistoryFs, now: deps.now });
      return jsonText({ path: dashboardPath, view, warnings: view.warnings });
    },
  );
}
