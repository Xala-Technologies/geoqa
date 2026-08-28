import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { journeyList, profileList, tenantList, type CommandDeps } from "@geoqa/engine/mcp.js";
import { jsonText } from "../json.js";

export function registerCatalogTools(server: McpServer, deps: CommandDeps): void {
  server.registerTool("profiles_list", { description: "List geographic profiles (market × device)", inputSchema: {} }, async () => jsonText(profileList(deps)));
  server.registerTool("journeys_list", { description: "List visitor journeys", inputSchema: {} }, async () => jsonText(journeyList(deps)));
  server.registerTool("tenants_list", { description: "List tenants with market and quota summary", inputSchema: {} }, async () => jsonText(tenantList(deps)));
}
