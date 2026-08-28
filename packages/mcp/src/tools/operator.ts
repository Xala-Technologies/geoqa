import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  assistExplain,
  digestSend,
  findingsFile,
  findingsRepair,
  fixRun,
  keywordsResearch,
  loadTenant,
  settingsView,
  tenantPath,
  type CommandDeps,
} from "@geoqa/engine/mcp.js";
import { jsonError, jsonText, runTool } from "../json.js";
import { runIdSchema } from "../schemas.js";

export function registerOperatorTools(server: McpServer, deps: CommandDeps): void {
  server.registerTool(
    "settings_get",
    { description: "Operator settings from local config (same shape as GET /api/settings)", inputSchema: {} },
    async () => {
      const view = settingsView(deps);
      return view.ok ? jsonText(view.value) : jsonError(view.error);
    },
  );

  server.registerTool(
    "assist_explain",
    {
      description: "Turn a run brief into a ticket draft via claude -p (Max subscription, not API)",
      inputSchema: z.object({ runId: runIdSchema }),
      annotations: { openWorldHint: true },
    },
    async ({ runId }) => runTool(() => assistExplain(deps, runId)),
  );

  server.registerTool(
    "digest_send",
    {
      description: "Send daily operator digest email via AgentMail",
      inputSchema: z.object({ to: z.string().email().optional(), since: z.string().optional(), dryRun: z.boolean().optional() }),
      annotations: { destructiveHint: true },
    },
    async (input) =>
      runTool(() =>
        digestSend(deps, {
          ...(input.to !== undefined ? { to: input.to } : {}),
          ...(input.since !== undefined ? { since: input.since } : {}),
          ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
        }),
      ),
  );

  server.registerTool(
    "findings_file",
    {
      description: "File current index findings as GitHub issues",
      inputSchema: z.object({ dryRun: z.boolean().optional() }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (input) =>
      runTool(() => findingsFile(deps, { ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}) })),
  );

  server.registerTool(
    "findings_repair",
    {
      description: "Run Claude repair pass on filed findings (opens PRs)",
      inputSchema: z.object({ dryRun: z.boolean().optional(), onlyKeys: z.array(z.string()).optional() }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (input) =>
      runTool(() =>
        findingsRepair(deps, {
          ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
          ...(input.onlyKeys !== undefined ? { onlyKeys: input.onlyKeys } : {}),
        }),
      ),
  );

  server.registerTool(
    "fix_run",
    {
      description: "Implementation agent: intake from growth/github, repair, review, PR",
      inputSchema: z.object({
        dryRun: z.boolean().optional(),
        source: z.enum(["both", "github", "growth"]).optional(),
        maxItems: z.number().int().optional(),
        merge: z.boolean().optional(),
      }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (input) =>
      runTool(() =>
        fixRun(deps, {
          ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.maxItems !== undefined ? { maxItems: input.maxItems } : {}),
          ...(input.merge !== undefined ? { merge: input.merge } : {}),
        }),
      ),
  );

  server.registerTool(
    "keywords_research",
    {
      description: "Research tenant keyword rankings per market (uses SERP credits)",
      inputSchema: z.object({
        tenantId: z.string(),
        markets: z.array(z.string()).optional(),
        budget: z.number().int().optional(),
        limit: z.number().int().optional(),
      }),
      annotations: { openWorldHint: true },
    },
    async (input) =>
      runTool(async () => {
        const loaded = loadTenant(tenantPath(deps, input.tenantId));
        if (!loaded.ok) throw new Error(loaded.errors.join("\n"));
        return keywordsResearch(deps, loaded.value, {
          ...(input.markets !== undefined ? { markets: input.markets } : {}),
          ...(input.budget !== undefined ? { budget: input.budget } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
      }),
  );
}
