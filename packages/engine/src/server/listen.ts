/**
 * The socket. Thirty lines of adaptation and no judgement.
 *
 * Every decision the server makes is in `router.ts`, as a pure function over plain objects, and
 * is covered there. This binds a port, reads a body, and copies headers — the same split as
 * `browser/playwright-launch.ts`, and coverage-excluded for the same reason: exercising it means
 * opening a socket, and what it does is not a behaviour anybody would assert about.
 *
 * The one decision that IS here, because it cannot be anywhere else: a body size cap. An
 * unbounded read is how a server with no other vulnerability is taken down by one request.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse as NodeResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { route, type RouterDeps, type ServerRequest } from "./router.js";

/** 256 KB. Larger than any legitimate request this API takes, smaller than anything worth worrying about. */
const MAX_BODY = 256 * 1024;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * Read a static asset from a root, refusing anything outside it.
 *
 * The traversal check is duplicated here on purpose — `router.ts` rejects `..` before this is
 * reached, and this re-checks the RESOLVED path. The first check is about the request; this one
 * is about the filesystem, and a symlink turns a clean-looking path into an escape. Containment
 * by `path.relative`, never `startsWith`: `/evidence-old` starts with `/evidence`.
 */
export function assetReader(root: string): (p: string) => { body: string | Buffer; type: string } | null {
  const base = path.resolve(root);
  return (requested) => {
    const resolved = path.resolve(base, `.${requested}`);
    const relative = path.relative(base, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (!existsSync(resolved) || !statSync(resolved).isFile()) return null;
    const ext = path.extname(resolved);
    const type = TYPES[ext] ?? "application/octet-stream";
    const raw = readFileSync(resolved);
    // PNG/ICO must stay bytes. utf-8 decoding a favicon is how a tab icon becomes noise
    // while the SVG next to it looks fine — the same class of defect as reading evidence
    // as text and then wondering why the screenshot would not open.
    const binary = type.startsWith("image/") && ext !== ".svg";
    return { body: binary ? raw : raw.toString("utf8"), type };
  };
}

export function createGeoqaServer(deps: RouterDeps): Server {
  return createServer((incoming: IncomingMessage, out: NodeResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        aborted = true;
        out.writeHead(413, { "content-type": "application/json" });
        out.end(JSON.stringify({ error: "request too large" }));
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });

    incoming.on("end", () => {
      if (aborted) return;
      const request: ServerRequest = {
        method: incoming.method ?? "GET",
        // The query string is dropped: no route uses one, and a path compared with a query
        // attached is a path that fails to match for a reason nobody can see.
        path: (incoming.url ?? "/").split("?")[0] ?? "/",
        headers: incoming.headers as Record<string, string | undefined>,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      const response = route(request, deps);
      out.writeHead(response.status, response.headers);
      out.end(response.body);
    });
  });
}
