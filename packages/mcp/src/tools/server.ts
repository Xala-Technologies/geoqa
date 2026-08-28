import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpConfig } from "../deps.js";
import { proxyRequest } from "../server-http.js";
import { runIdSchema } from "../schemas.js";

/** Remote tools mirroring `geoqa server` HTTP API (router.ts + control.ts). */
export function registerServerTools(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "server_health",
    { description: "GET /health — liveness, no auth", inputSchema: {} },
    async () => proxyRequest(config, "GET", "/health", undefined, false),
  );

  server.registerTool("server_whoami", { description: "GET /api/whoami — current API session", inputSchema: {} }, async () =>
    proxyRequest(config, "GET", "/api/whoami"),
  );

  server.registerTool("server_settings", { description: "GET /api/settings", inputSchema: {} }, async () =>
    proxyRequest(config, "GET", "/api/settings"),
  );

  server.registerTool(
    "server_dashboard_rebuild",
    { description: "POST /api/dashboard/rebuild — refresh dashboard.json from evidence", inputSchema: {}, annotations: { destructiveHint: true } },
    async () => proxyRequest(config, "POST", "/api/dashboard/rebuild"),
  );

  server.registerTool("server_watch_get", { description: "GET /api/watch — watch spec and board state", inputSchema: {} }, async () =>
    proxyRequest(config, "GET", "/api/watch"),
  );

  server.registerTool(
    "server_watch_update",
    { description: "PUT /api/watch — patch watch configuration", inputSchema: z.object({ patch: z.record(z.unknown()) }) },
    async ({ patch }) => proxyRequest(config, "PUT", "/api/watch", patch),
  );

  server.registerTool("server_watch_log", { description: "GET /api/watch/log — persisted operator log", inputSchema: {} }, async () =>
    proxyRequest(config, "GET", "/api/watch/log"),
  );

  server.registerTool(
    "server_watch_start",
    { description: "POST /api/watch/start — force a sweep now", inputSchema: {}, annotations: { destructiveHint: true, openWorldHint: true } },
    async () => proxyRequest(config, "POST", "/api/watch/start"),
  );

  server.registerTool(
    "server_watch_target_add",
    { description: "POST /api/watch/targets — add URL to watch list", inputSchema: z.object({ url: z.string().url() }) },
    async ({ url }) => proxyRequest(config, "POST", "/api/watch/targets", { url }),
  );

  server.registerTool(
    "server_watch_target_remove",
    { description: "DELETE /api/watch/targets — remove URL from watch list", inputSchema: z.object({ url: z.string().url() }) },
    async ({ url }) => proxyRequest(config, "DELETE", "/api/watch/targets", { url }),
  );

  server.registerTool("server_live_board", { description: "GET /api/live — active browser sessions", inputSchema: {} }, async () =>
    proxyRequest(config, "GET", "/api/live"),
  );

  server.registerTool(
    "server_live_session",
    { description: "GET /api/live/:id — one live session", inputSchema: z.object({ sessionId: z.string() }) },
    async ({ sessionId }) => proxyRequest(config, "GET", `/api/live/${encodeURIComponent(sessionId)}`),
  );

  server.registerTool(
    "server_live_frame",
    { description: "GET /api/live/:id/frame — latest screenshot as base64 JSON", inputSchema: z.object({ sessionId: z.string() }) },
    async ({ sessionId }) => proxyRequest(config, "GET", `/api/live/${encodeURIComponent(sessionId)}/frame`),
  );

  server.registerTool("server_run_status", { description: "GET /api/run — run queue status", inputSchema: {} }, async () =>
    proxyRequest(config, "GET", "/api/run"),
  );

  server.registerTool(
    "server_run_start",
    {
      description: "POST /api/run — start one journey (same as console Run)",
      inputSchema: z.object({ request: z.record(z.unknown()) }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ request }) => proxyRequest(config, "POST", "/api/run", request),
  );

  server.registerTool(
    "server_findings_repair_status",
    { description: "GET /api/findings/repair — repair job progress",
      inputSchema: {},
    },
    async () => proxyRequest(config, "GET", "/api/findings/repair"),
  );

  server.registerTool(
    "server_findings_repair_start",
    {
      description: "POST /api/findings/repair — start repair job",
      inputSchema: z.object({ keys: z.array(z.string()).optional() }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ keys }) => proxyRequest(config, "POST", "/api/findings/repair", keys !== undefined ? { keys } : {}),
  );

  server.registerTool(
    "server_evidence_get",
    { description: "GET /api/evidence/:runId", inputSchema: z.object({ runId: runIdSchema }) },
    async ({ runId }) => proxyRequest(config, "GET", `/api/evidence/${runId}`),
  );

  server.registerTool(
    "server_evidence_screenshot",
    {
      description: "GET /api/evidence/:runId/shot/:label — screenshot as base64 JSON",
      inputSchema: z.object({ runId: runIdSchema, label: z.string().regex(/^[A-Za-z0-9._-]+$/) }),
    },
    async ({ runId, label }) => proxyRequest(config, "GET", `/api/evidence/${runId}/shot/${label}`),
  );

  server.registerTool(
    "server_evidence_artifact",
    {
      description: "GET /api/evidence/:runId/artifact/:kind — trace, HAR, snapshot, vitals, …",
      inputSchema: z.object({
        runId: runIdSchema,
        kind: z.enum(["snapshot", "trace", "har", "vitals", "console", "network", "a11y", "content"]),
        label: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
      }),
    },
    async ({ runId, kind, label }) =>
      proxyRequest(
        config,
        "GET",
        label !== undefined ? `/api/evidence/${runId}/artifact/${kind}/${label}` : `/api/evidence/${runId}/artifact/${kind}`,
      ),
  );

  server.registerTool(
    "server_evidence_screenshots",
    {
      description: "GET /api/evidence/:runId/screenshots — all present screenshots as base64 JSON",
      inputSchema: z.object({ runId: runIdSchema }),
    },
    async ({ runId }) => proxyRequest(config, "GET", `/api/evidence/${runId}/screenshots`),
  );
}
