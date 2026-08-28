import type { McpConfig } from "./deps.js";

export type ProxyResult = { content: [{ type: "text"; text: string }]; isError?: true };

export async function proxyRequest(
  config: McpConfig,
  method: string,
  path: string,
  body?: unknown,
  auth = true,
): Promise<ProxyResult> {
  if (config.serverUrl === null) {
    return { isError: true, content: [{ type: "text", text: "GEOQA_SERVER_URL is not set — add it to MCP env for remote API tools" }] };
  }
  if (auth && config.apiToken === null) {
    return { isError: true, content: [{ type: "text", text: "GEOQA_API_TOKEN is not set — run `pnpm geoqa server hash` and set the token on server and MCP" }] };
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (auth && config.apiToken !== null) headers.authorization = `Bearer ${config.apiToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${config.serverUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    return { isError: true, content: [{ type: "text", text: `${response.status} ${response.statusText}: ${text}` }] };
  }
  return { content: [{ type: "text", text }] };
}
