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
    { description: "Operator dashboard JSON (rebuilt on each read)", mimeType: "application/json" },
    async (uri) => {
      const { view } = dashboardBuild({ evidenceRoot: deps.evidenceRoot, historyFs: nodeHistoryFs, now: deps.now });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(view, null, 2) }] };
    },
  );

  server.registerResource(
    "runs-recent",
    "geoqa://runs/recent",
    { description: "Last 20 runs with summary and regressions", mimeType: "application/json" },
    async (uri) => {
      const result = runsList(deps, { limit: 20 });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerResource(
    "run-evidence",
    new ResourceTemplate("geoqa://runs/{runId}", { list: undefined }),
    { description: "Full evidence package for a run id", mimeType: "application/json" },
    async (uri, variables) => {
      const runId = variables.runId;
      if (typeof runId !== "string") {
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "runId missing" }) }] };
      }
      const loaded = loadEvidencePackage(deps.evidenceRoot, runId, nodePackageFs);
      const text = loaded.ok ? JSON.stringify(loaded.value, null, 2) : JSON.stringify({ error: loaded.error });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
    },
  );
}
