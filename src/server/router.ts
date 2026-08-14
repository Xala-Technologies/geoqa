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
 * **Default deny, applied to DATA.** Every route that carries a reading is authenticated
 * unless it opts out, rather than open unless it opts in. The two spellings look equivalent
 * and are not: the second leaks a new endpoint the day somebody forgets a decorator, and the
 * person who forgets is the person adding the endpoint that needed it most.
 *
 * **The app shell is not data, and putting it behind the session was a bug.** The first
 * version of this file authenticated *every* path, including `/assets/index-*.js`. That is
 * circular: the login form lives inside the bundle, so the bundle must load before anyone
 * can sign in, and the bundle could not load without a session. Served through `geoqa
 * server` the console was a blank white page — the JS request followed the redirect to
 * `/login`, received `index.html`, and failed to execute as a module. Every router test
 * passed, because each asserted on a path and none asserted that the app could boot.
 *
 * So the line is drawn where it actually matters: **the UI root is public, and everything
 * that carries a measurement is not.** The bundle is the same bytes for every visitor and
 * names no tenant, no run and no credential. The consequence is a rule about the directory
 * rather than about this file — nothing may be placed in the UI root that is not intended
 * for every browser that asks. It is build output; that is already true of it.
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
  /**
   * The built dashboard, as JSON text, or null when none has been built yet.
   *
   * Text rather than a parsed object because it is passed straight through: re-serialising a
   * hundred kilobytes to hand back the same bytes is work that can only introduce a
   * difference. It lives in the EVIDENCE tree, not the UI root, which is why it needs a route
   * of its own — the asset reader is rooted at the bundle and would never find it.
   */
  dashboard: () => string | null;
}

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

  // The one reading served outside `/api/`, and it is protected exactly like the ones inside.
  // 401 rather than a redirect: this is fetched by script, and a 302 to a page would hand the
  // caller HTML with a 200 attached — which is what a `.json()` call chokes on, several frames
  // away from the thing that actually went wrong.
  if (path === "/dashboard.json") {
    if (session === null) return json(401, { error: "not signed in" });
    const built = deps.dashboard();
    if (built === null) {
      return json(404, { error: "no dashboard has been built yet — run `geoqa dashboard build`" });
    }
    return { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: built };
  }

  // The shell and its bundle, for anyone who asks. See the note at the top of this file: the
  // login form cannot be behind the session it exists to obtain.
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
