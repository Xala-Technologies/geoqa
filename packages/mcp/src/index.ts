#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpConfig } from "./deps.js";
import { registerResources } from "./resources.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerEvidenceTools } from "./tools/evidence.js";
import { registerExecutionTools } from "./tools/execute.js";
import { registerOperatorTools } from "./tools/operator.js";
import { registerRunsTools } from "./tools/runs.js";
import { registerServerTools } from "./tools/server.js";

export function createGeoqaMcpServer(config = createMcpConfig()): McpServer {
  const server = new McpServer({ name: "geoqa", version: "0.2.0" });

  registerCatalogTools(server, config.deps);
  registerRunsTools(server, config.deps);
  registerEvidenceTools(server, config.deps);
  registerOperatorTools(server, config.deps);
  registerExecutionTools(server, config.deps);
  registerServerTools(server, config);
  registerResources(server, config);

  return server;
}

async function main(): Promise<void> {
  const config = createMcpConfig();
  const server = createGeoqaMcpServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`geoqa MCP ready — evidence ${config.evidenceRoot}`);
  if (config.serverUrl !== null) console.error(`  remote API ${config.serverUrl}`);
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/index.ts") || process.argv[1].endsWith("\\index.ts") || process.argv[1].includes("geoqa-mcp"));

if (isMain) {
  main().catch((err: unknown) => {
    console.error("geoqa MCP fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
