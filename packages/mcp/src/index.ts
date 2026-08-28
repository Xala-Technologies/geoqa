#!/usr/bin/env node
/**
 * geoqa MCP server — stdio transport.
 *
 * Agents connect through Cursor, Claude Desktop, or any MCP client. All read paths
 * go through the same command functions as `pnpm geoqa`; stdout stays JSON-RPC
 * only — diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpConfig } from "./deps.js";
import { registerResources, registerServerTools } from "./resources.js";
import { registerCatalogTools, registerEvidenceTools, registerRunsTools } from "./tools.js";

export function createGeoqaMcpServer(config = createMcpConfig()): McpServer {
  const server = new McpServer({
    name: "geoqa",
    version: "0.1.0",
  });

  registerCatalogTools(server, config.deps);
  registerRunsTools(server, config.deps);
  registerEvidenceTools(server, config.deps);
  registerResources(server, config);
  registerServerTools(server, config);

  return server;
}

async function main(): Promise<void> {
  const config = createMcpConfig();
  const server = createGeoqaMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`geoqa MCP ready — evidence ${config.evidenceRoot}`);
  if (config.serverUrl !== null) console.error(`  proxying live reads to ${config.serverUrl}`);
}

const isMain = process.argv[1] !== undefined && (
  process.argv[1].endsWith("/index.ts") ||
  process.argv[1].endsWith("\\index.ts") ||
  process.argv[1].includes("geoqa-mcp")
);

if (isMain) {
  main().catch((err: unknown) => {
    console.error("geoqa MCP fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
