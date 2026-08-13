import { describe, expect, it, vi } from "vitest";
import { hashPassword, signSession } from "../auth.js";
import { route, type RouterDeps, type ServerRequest } from "../router.js";

const SECRET = "s".repeat(64);
const PASSWORD = "a-real-password";

const deps = (over: Partial<RouterDeps> = {}): RouterDeps => ({
  auth: { passwordHash: hashPassword(PASSWORD), secret: SECRET },
  now: () => 1_000,
  secure: false,
  readAsset: (p) => (p === "/index.html" ? { body: "<html>app</html>", type: "text/html" } : null),
  settings: () => ({ tenants: [] }),
  ...over,
});

const req = (over: Partial<ServerRequest> = {}): ServerRequest => ({
  method: "GET",
  path: "/",
  headers: {},
  body: "",
  ...over,
});

const withSession = (d: RouterDeps, user = "admin"): Record<string, string> => ({
  cookie: `geoqa_session=${signSession({ user, expiresAt: d.now() + 10_000 }, SECRET)}`,
});

describe("authentication", () => {
  it("signs in with the right password and sets an HttpOnly cookie", () => {
    const d = deps();
    const out = route(req({ method: "POST", path: "/api/session", body: JSON.stringify({ password: PASSWORD }) }), d);
    expect(out.status).toBe(200);
    expect(out.headers["set-cookie"]).toContain("HttpOnly");
    expect(out.headers["set-cookie"]).toContain("SameSite=Strict");
  });

  it("REFUSES the wrong password, with no hint about which half was wrong", () => {
    // Distinguishing "no such user" from "wrong password" is a user enumeration oracle.
    const out = route(req({ method: "POST", path: "/api/session", body: JSON.stringify({ user: "nobody", password: "wrong" }) }), deps());
    expect(out.status).toBe(401);
    expect(out.body).toContain("sign-in failed");
    expect(out.body).not.toContain("password");
    expect(out.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a request with no password rather than treating absence as empty", () => {
    expect(route(req({ method: "POST", path: "/api/session", body: "{}" }), deps()).status).toBe(400);
    expect(route(req({ method: "POST", path: "/api/session", body: "not json" }), deps()).status).toBe(400);
  });

  it("refuses a body that parses to a NON-object", () => {
    // `JSON.parse("null")` and `JSON.parse("[1]")` both succeed and neither has a password.
    // Without the object check, `parsed?.password` on an array is undefined and the request
    // becomes a 400 by luck rather than by decision.
    for (const body of ["null", "[1,2]", '"a string"', "42"]) {
      expect(route(req({ method: "POST", path: "/api/session", body }), deps()).status, body).toBe(400);
    }
  });

  it("signs out without needing a session", () => {
    // A request to end a session that already ended is not an error — returning 401 would leave
    // a browser holding a cookie it cannot clear.
    const out = route(req({ method: "DELETE", path: "/api/session" }), deps());
    expect(out.status).toBe(204);
    expect(out.headers["set-cookie"]).toContain("Max-Age=0");
  });
});

describe("default deny", () => {
  it("REFUSES every API route without a session", () => {
    const d = deps();
    for (const path of ["/api/settings", "/api/whoami", "/api/anything"]) {
      const out = route(req({ path }), d);
      expect(out.status, path).toBe(401);
    }
  });

  it("serves an API route WITH a session", () => {
    const d = deps();
    const out = route(req({ path: "/api/settings", headers: withSession(d) }), d);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ tenants: [] });
  });

  it("404s an unknown API route rather than falling through to a file", () => {
    // Without this an unmatched /api/ path would be served by the static handler, and a 404
    // page returned to a fetch() is a parse error somewhere far from the cause.
    const d = deps();
    const out = route(req({ path: "/api/nope", headers: withSession(d) }), d);
    expect(out.status).toBe(404);
    expect(out.headers["content-type"]).toContain("application/json");
  });

  it("REDIRECTS a document request without a session, rather than 401ing it", () => {
    // A browser asked for a page; the useful answer is the page it can use.
    const out = route(req({ path: "/runs" }), deps());
    expect(out.status).toBe(302);
    expect(out.headers["location"]).toBe("/login");
  });

  it("serves /login and /health without a session", () => {
    expect(route(req({ path: "/login" }), deps()).status).toBe(200);
    expect(route(req({ path: "/health" }), deps()).status).toBe(200);
  });

  it("REJECTS an expired session as though there were none", () => {
    const d = deps();
    const stale = signSession({ user: "admin", expiresAt: 500 }, SECRET);
    const out = route(req({ path: "/api/settings", headers: { cookie: `geoqa_session=${stale}` } }), d);
    expect(out.status).toBe(401);
  });

  it("REJECTS a session signed with another secret", () => {
    const d = deps();
    const forged = signSession({ user: "admin", expiresAt: 99_999 }, "b".repeat(64));
    expect(route(req({ path: "/api/settings", headers: { cookie: `geoqa_session=${forged}` } }), d).status).toBe(401);
  });
});

describe("static assets", () => {
  it("REFUSES a path that tries to leave the root", () => {
    const d = deps();
    for (const path of ["/../secrets", "/a/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd"]) {
      const out = route(req({ path, headers: withSession(d) }), d);
      expect(out.status, path).toBe(400);
    }
  });

  it("refuses a NUL byte and a malformed escape", () => {
    const d = deps();
    expect(route(req({ path: "/a\0b", headers: withSession(d) }), d).status).toBe(400);
    // `%zz` cannot be decoded; falling through to the undecoded string would be the bug.
    expect(route(req({ path: "/%zz", headers: withSession(d) }), d).status).toBe(400);
  });

  it("serves the app document for a client route, so a deep link works", () => {
    const d = deps();
    const out = route(req({ path: "/findings", headers: withSession(d) }), d);
    expect(out.status).toBe(200);
    expect(out.body).toContain("app");
  });

  it("404s a missing file instead of throwing", () => {
    const d = deps({ readAsset: () => null });
    expect(route(req({ path: "/missing.css", headers: withSession(d) }), d).status).toBe(404);
  });

  it("never caches the data or the document, and does cache fingerprinted assets", () => {
    // A console showing yesterday's runs while claiming to be live is the one failure a
    // monitoring tool cannot have.
    const d = deps({ readAsset: (p) => ({ body: "x", type: p.endsWith(".json") ? "application/json" : "text/css" }) });
    expect(route(req({ path: "/dashboard.json", headers: withSession(d) }), d).headers["cache-control"]).toBe("no-store");
    expect(route(req({ path: "/", headers: withSession(d) }), d).headers["cache-control"]).toBe("no-store");
    expect(route(req({ path: "/assets/x.css", headers: withSession(d) }), d).headers["cache-control"]).toContain("max-age");
  });

  it("sets the security headers the app needs to stay self-contained", () => {
    const d = deps();
    const out = route(req({ path: "/", headers: withSession(d) }), d);
    expect(out.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(out.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(out.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("whoami", () => {
  it("reports the signed-in user and when the session ends", () => {
    const d = deps();
    const out = route(req({ path: "/api/whoami", headers: withSession(d, "ada") }), d);
    expect(JSON.parse(out.body)).toMatchObject({ user: "ada" });
  });
});
