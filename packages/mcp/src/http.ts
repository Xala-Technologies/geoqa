#!/usr/bin/env node
/**
 * Remote MCP over Streamable HTTP (POST/GET/DELETE /mcp).
 *
 * Binds localhost by default; Caddy terminates TLS and forwards /mcp. Requires
 * `GEOQA_API_TOKEN` — same bearer the geoqa console API uses.
 */
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { readBearer, verifyApiToken } from "@geoqa/engine/mcp.js";
import type { NextFunction, Request, Response } from "express";
import { createGeoqaMcpServer } from "./index.js";
import { createMcpConfig, type McpConfig } from "./deps.js";

/** Host headers accepted when sitting behind Caddy (see `GEOQA_MCP_ALLOWED_HOSTS`). */
export function parseAllowedHosts(
  env: NodeJS.ProcessEnv,
  serverUrl: string | null,
): string[] | undefined {
  const raw = env.GEOQA_MCP_ALLOWED_HOSTS;
  if (raw !== undefined && raw !== "") {
    return raw.split(",").map((h) => h.trim()).filter((h) => h.length > 0);
  }
  if (serverUrl !== null) {
    try {
      const hostname = new URL(serverUrl).hostname;
      return [hostname, "127.0.0.1", "localhost"];
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

export function requireBearerToken(configured: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = readBearer(req.headers.authorization);
    if (presented === null || !verifyApiToken(presented, configured)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

async function handleMcpRequest(config: McpConfig, req: Request, res: Response): Promise<void> {
  const server = createGeoqaMcpServer(config);
  try {
    const transport = new StreamableHTTPServerTransport({});
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  } catch (error) {
    console.error("geoqa MCP HTTP error:", error instanceof Error ? error.message : String(error));
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

export function createHttpApp(config: McpConfig) {
  const apiToken = config.apiToken;
  if (apiToken === null) {
    throw new Error("GEOQA_API_TOKEN is required for HTTP MCP");
  }

  const host = process.env.GEOQA_MCP_HOST ?? "127.0.0.1";
  const allowedHosts = parseAllowedHosts(process.env, config.serverUrl);

  const app = createMcpExpressApp({
    host,
    ...(allowedHosts !== undefined ? { allowedHosts } : {}),
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "geoqa-mcp" });
  });

  app.get("/mcp/health", (_req, res) => {
    res.json({ ok: true, service: "geoqa-mcp" });
  });

  app.use("/mcp", requireBearerToken(apiToken));
  app.all("/mcp", (req, res) => {
    void handleMcpRequest(config, req, res);
  });

  return app;
}

export async function startHttpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = createMcpConfig(env);
  const host = env.GEOQA_MCP_HOST ?? "127.0.0.1";
  const port = Number(env.GEOQA_MCP_PORT ?? "4181");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`invalid GEOQA_MCP_PORT: ${env.GEOQA_MCP_PORT ?? ""}`);
  }

  const app = createHttpApp(config);

  await new Promise<void>((resolve, reject) => {
    app.listen(port, host, (err?: Error) => {
      if (err !== undefined) reject(err);
      else resolve();
    });
  });

  console.error(`geoqa MCP HTTP ready — http://${host}:${port}/mcp`);
  console.error(`  evidence ${config.evidenceRoot}`);
}

async function main(): Promise<void> {
  await startHttpServer();
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/http.ts") ||
    process.argv[1].endsWith("\\http.ts") ||
    process.argv[1].includes("geoqa-mcp-http"));

if (isMain) {
  main().catch((err: unknown) => {
    console.error("geoqa MCP HTTP fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
