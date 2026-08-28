import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  dashboardBuild,
  loadEvidencePackage,
  nodeHistoryFs,
  nodePackageFs,
  runsList,
} from "@geoqa/engine/mcp.js";
import type { McpConfig } from "./deps.js";

/** MCP resources — stable URIs agents can fetch without a tool round-trip. */
export function registerResources(server: McpServer, config: McpConfig): void {
  const { deps } = config;

  server.registerResource(
    "dashboard",
    "geoqa://dashboard",
    {
      description: "Operator dashboard JSON (rebuilt from evidence on each read)",
      mimeType: "application/json",
    },
    async (uri) => {
      const { view } = dashboardBuild({
        evidenceRoot: deps.evidenceRoot,
        historyFs: nodeHistoryFs,
        now: deps.now,
      });
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(view, null, 2) }],
      };
    },
  );

  server.registerResource(
    "runs-recent",
    "geoqa://runs/recent",
    {
      description: "The 20 most recent runs (newest first) with summary and regressions",
      mimeType: "application/json",
    },
    async (uri) => {
      const result = runsList(deps, { limit: 20 });
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerResource(
    "run-evidence",
    new ResourceTemplate("geoqa://runs/{runId}", { list: undefined }),
    {
      description: "Full evidence package for a specific run id",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const runId = variables.runId;
      if (typeof runId !== "string") {
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "runId missing from URI" }) }],
        };
      }
      const loaded = loadEvidencePackage(deps.evidenceRoot, runId, nodePackageFs);
      const text = loaded.ok ? JSON.stringify(loaded.value, null, 2) : JSON.stringify({ error: loaded.error });
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text }],
      };
    },
  );
}

export function registerServerTools(server: McpServer, config: McpConfig): void {
  if (config.serverUrl === null) return;

  server.registerTool(
    "server_health",
    {
      description: "Check whether geoqa server is reachable (requires GEOQA_SERVER_URL)",
      inputSchema: {},
    },
    async () => {
      const response = await fetch(`${config.serverUrl}/health`);
      const body = await response.text();
      return {
        content: [{ type: "text", text: JSON.stringify({ status: response.status, body: safeJson(body) }, null, 2) }],
      };
    },
  );

  server.registerTool(
    "server_settings",
    {
      description: "Read operator settings from a running geoqa server (requires GEOQA_SERVER_URL and GEOQA_API_TOKEN)",
      inputSchema: {},
    },
    async () => proxyGet(config, "/api/settings"),
  );

  server.registerTool(
    "server_watch_status",
    {
      description: "Read watch/live board state from geoqa server",
      inputSchema: {},
    },
    async () => proxyGet(config, "/api/watch"),
  );
}

async function proxyGet(
  config: McpConfig,
  path: string,
): Promise<{ content: [{ type: "text"; text: string }]; isError?: boolean }> {
  if (config.serverUrl === null) {
    return { isError: true, content: [{ type: "text", text: "GEOQA_SERVER_URL is not set" }] };
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.apiToken !== null) headers.authorization = `Bearer ${config.apiToken}`;
  const response = await fetch(`${config.serverUrl}${path}`, { headers });
  const text = await response.text();
  if (!response.ok) {
    return { isError: true, content: [{ type: "text", text: `${response.status}: ${text}` }] };
  }
  return { content: [{ type: "text", text }] };
}

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};
