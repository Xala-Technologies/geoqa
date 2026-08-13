/**
 * The request router: every decision the server makes, as a pure function.
 *
 * It takes a plain request object and returns a plain response object. No sockets, no streams,
 * no `http` types — those live in `listen.ts`, which is thirty lines of adaptation and is
 * coverage-excluded for the same reason `playwright-launch.ts` is. Everything with a judgement
 * in it is here and is testable by calling a function.
 *
 * That split matters more than usual for a server. The interesting cases are the ones a manual
 * click-through never reaches: an expired session, a token signed with the previous secret, a
 * path with `..` in it, a POST without a session. Each is one call here.
 *
 * **Default deny.** Every route is authenticated unless it appears in `PUBLIC`, rather than
 * every route being open unless it opts in. The two spellings look equivalent and are not: the
 * second leaks a new endpoint the day somebody forgets a decorator, and the person who forgets
 * is the person adding the endpoint that needed it most.
 */
import { clearedCookie, cookieValue, readSession, sessionCookie, signSession, verifyPassword, SESSION_MS, type AuthConfig } from "./auth.js";

export interface ServerRequest {
  method: string;
  /** Path only, already stripped of the query string. */
  path: string;
  headers: Record<string, string | undefined>;
  /** Raw body, for POSTs. */
  body: string;
}

export interface ServerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface RouterDeps {
  auth: AuthConfig;
  now: () => number;
  /** True when the server is reachable over TLS, which decides the `Secure` cookie attribute. */
  secure: boolean;
  /** Reads a static asset. Returns null when there is none — never throws for a missing file. */
  readAsset: (path: string) => { body: string; type: string } | null;
  /** Everything the settings page shows. Injected so the router does no filesystem work. */
  settings: () => unknown;
}

/** Routes reachable without a session. Deliberately short, and deliberately a whitelist. */
const PUBLIC = new Set(["/api/session", "/login", "/health"]);

const json = (status: number, value: unknown, headers: Record<string, string> = {}): ServerResponse => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
  body: JSON.stringify(value),
});

export function route(request: ServerRequest, deps: RouterDeps): ServerResponse {
  const { method, path } = request;

  // Liveness, before auth: a health check that needed a credential could not be used by the
  // thing that restarts the server.
  if (path === "/health") return json(200, { ok: true });

  if (path === "/api/session" && method === "POST") return login(request, deps);
  if (path === "/api/session" && method === "DELETE") {
    // Logout needs no session: a request to end a session that has already ended is not an
    // error, and returning 401 here would leave a browser holding a cookie it cannot clear.
    return { status: 204, headers: { "set-cookie": clearedCookie(deps.secure) }, body: "" };
  }

  const session = currentSession(request, deps);

  if (path.startsWith("/api/")) {
    if (session === null) return json(401, { error: "not signed in" });
    if (path === "/api/settings" && method === "GET") return json(200, deps.settings());
    if (path === "/api/whoami" && method === "GET") return json(200, { user: session.user, expiresAt: session.expiresAt });
    return json(404, { error: `no such endpoint: ${method} ${path}` });
  }

  if (!PUBLIC.has(path) && session === null) {
    // A redirect rather than a 401 for a document request: a browser asked for a page, and the
    // useful answer is the page it can actually use.
    return { status: 302, headers: { location: "/login" }, body: "" };
  }

  return asset(path, deps);
}

function login(request: ServerRequest, deps: RouterDeps): ServerResponse {
  const parsed = safeJson(request.body);
  const password = typeof parsed?.password === "string" ? parsed.password : null;
  const user = typeof parsed?.user === "string" && parsed.user !== "" ? parsed.user : "admin";
  if (password === null) return json(400, { error: "a password is required" });

  if (!verifyPassword(password, deps.auth.passwordHash)) {
    // One message for every failure mode, and no hint about which half was wrong. "No such user"
    // and "wrong password" told apart is a user enumeration oracle.
    return json(401, { error: "sign-in failed" });
  }

  const expiresAt = deps.now() + SESSION_MS;
  const token = signSession({ user, expiresAt }, deps.auth.secret);
  return json(200, { user, expiresAt }, { "set-cookie": sessionCookie(token, SESSION_MS, deps.secure) });
}

function currentSession(request: ServerRequest, deps: RouterDeps): { user: string; expiresAt: number } | null {
  const token = cookieValue(request.headers["cookie"]);
  if (token === null) return null;
  return readSession(token, deps.auth.secret, deps.now());
}

/**
 * Serve a static file, refusing any path that tries to leave the root.
 *
 * The containment check is here rather than in the file reader because it is a ROUTING decision
 * and belongs where it can be tested without a filesystem. `%2e%2e%2f` is decoded before the
 * check, since a traversal that survives one decode is a traversal.
 */
export function asset(path: string, deps: RouterDeps): ServerResponse {
  const decoded = safeDecode(path);
  if (decoded === null || decoded.includes("..") || decoded.includes("\0")) {
    return { status: 400, headers: { "content-type": "text/plain" }, body: "bad path" };
  }
  // A directory or the login page both resolve to the single-page app's document.
  const wanted = decoded === "/" || decoded === "/login" || !decoded.slice(1).includes(".") ? "/index.html" : decoded;
  const file = deps.readAsset(wanted);
  if (file === null) return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  return {
    status: 200,
    headers: {
      "content-type": file.type,
      // The dashboard's data must never be served from cache: a console showing yesterday's
      // runs while claiming to be live is the one failure a monitoring tool cannot have.
      "cache-control": wanted.endsWith(".json") || wanted === "/index.html" ? "no-store" : "public, max-age=3600",
      // The app is self-contained: no CDN, no inline event handlers, no framing.
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
    body: file.body,
  };
}

const safeJson = (raw: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const safeDecode = (raw: string): string | null => {
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed escape is not a path. Returning null rather than the raw string, because
    // "could not decode" must not fall through to "check the undecoded version".
    return null;
  }
};
