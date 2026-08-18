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
  dashboard: () => JSON.stringify({ summary: { total: 3 } }),
  rebuild: () => ({ generatedAt: "2026-08-14T10:00:00.000Z", total: 3, warnings: [] }),
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

const asText = (body: string | Buffer): string => (typeof body === "string" ? body : body.toString("utf8"));

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
    expect(asText(out.body)).toContain("sign-in failed");
    expect(asText(out.body)).not.toContain("password");
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

describe("the dashboard's data is protected like every other reading", () => {
  it("401s without a session — a status a fetch can act on", () => {
    // NOT a redirect. This is fetched by script, and a 302 to a page hands the caller HTML
    // with a 200 attached, which fails inside `.json()` several frames from the cause. That
    // is precisely how the blank page presented before this fix.
    const out = route(req({ path: "/dashboard.json" }), deps());
    expect(out.status).toBe(401);
    expect(out.headers["content-type"]).toContain("application/json");
  });

  it("serves the built dashboard byte-for-byte with a session", () => {
    // Passed through as text rather than re-serialised: re-encoding a hundred kilobytes to
    // hand back the same bytes can only introduce a difference.
    const body = JSON.stringify({ summary: { total: 3 }, runs: [] });
    const d = deps({ dashboard: () => body });
    const out = route(req({ path: "/dashboard.json", headers: withSession(d) }), d);
    expect(out.status).toBe(200);
    expect(out.body).toBe(body);
  });

  it("must never be cached — a console showing yesterday's runs is the one failure it cannot have", () => {
    const d = deps();
    expect(route(req({ path: "/dashboard.json", headers: withSession(d) }), d).headers["cache-control"]).toBe("no-store");
  });

  it("says no dashboard has been BUILT, rather than 404ing like a missing file", () => {
    // Different problems, different fixes: "you have not run `dashboard build`" is a thing
    // the reader can do something about; a bare 404 reads as a broken install.
    const d = deps({ dashboard: () => null });
    const out = route(req({ path: "/dashboard.json", headers: withSession(d) }), d);
    expect(out.status).toBe(404);
    expect(JSON.parse(asText(out.body)).error).toContain("dashboard build");
  });
});

describe("rebuilding the dashboard from the console", () => {
  it("needs a session, like everything else that touches evidence", () => {
    expect(route(req({ path: "/api/dashboard/rebuild", method: "POST" }), deps()).status).toBe(401);
  });

  it("REFUSES a GET, so nothing can trigger it by following a link", () => {
    // It writes a file. A rebuild reachable by typing a URL is one a link preview, a
    // prefetching browser or a crawler can start without anybody asking.
    const d = deps();
    const out = route(req({ path: "/api/dashboard/rebuild", headers: withSession(d) }), d);
    expect(out.status).toBe(404);
  });

  it("returns what the dashboard NOW says, not just that it worked", () => {
    // The caller is a console about to re-read the file. Handing back the new timestamp and
    // count lets it say what changed rather than "done" — and a rebuild that reports success
    // while producing an empty dashboard is exactly the case worth showing.
    const d = deps();
    const out = route(req({ path: "/api/dashboard/rebuild", method: "POST", headers: withSession(d) }), d);
    expect(out.status).toBe(200);
    expect(JSON.parse(asText(out.body))).toEqual({ generatedAt: "2026-08-14T10:00:00.000Z", total: 3, warnings: [] });
  });

  it("passes the builder's warnings through rather than swallowing them", () => {
    // A stale index is the reason a rebuild produces fewer runs than the evidence holds, and
    // it is the one thing the reader must see to know the number is not the whole story.
    const d = deps({ rebuild: () => ({ generatedAt: "2026-08-14T10:00:00.000Z", total: 0, warnings: ["4 unparseable index line(s) skipped"] }) });
    const out = route(req({ path: "/api/dashboard/rebuild", method: "POST", headers: withSession(d) }), d);
    expect(JSON.parse(asText(out.body)).warnings).toEqual(["4 unparseable index line(s) skipped"]);
  });
});

describe("default deny", () => {
  it("REFUSES every API route without a session", () => {
    const d = deps();
    for (const path of ["/api/settings", "/api/whoami", "/api/watch", "/api/live", "/api/run", "/api/evidence/run_1", "/api/anything"]) {
      const out = route(req({ path }), d);
      expect(out.status, path).toBe(401);
    }
  });

  it("serves an API route WITH a session", () => {
    const d = deps();
    const out = route(req({ path: "/api/settings", headers: withSession(d) }), d);
    expect(out.status).toBe(200);
    expect(JSON.parse(asText(out.body))).toEqual({ tenants: [] });
  });

  it("404s an unknown API route rather than falling through to a file", () => {
    // Without this an unmatched /api/ path would be served by the static handler, and a 404
    // page returned to a fetch() is a parse error somewhere far from the cause.
    const d = deps();
    const out = route(req({ path: "/api/nope", headers: withSession(d) }), d);
    expect(out.status).toBe(404);
    expect(out.headers["content-type"]).toContain("application/json");
  });

  it("SERVES the app shell without a session, because the login form is inside it", () => {
    // This replaces a test that asserted the opposite. Redirecting a document request to
    // /login looked right and was circular: /login serves the same shell, the shell asks for
    // its bundle, and the bundle was behind the session the form exists to obtain. The
    // console was a blank white page through `geoqa server` while every router test passed.
    for (const path of ["/", "/runs", "/login", "/settings"]) {
      const out = route(req({ path }), deps());
      expect(out.status, path).toBe(200);
      expect(asText(out.body), path).toContain("app");
    }
  });

  it("SERVES the bundle without a session — the specific thing that was broken", () => {
    const d = deps({ readAsset: (p) => (p.startsWith("/assets/") ? { body: "export{}", type: "text/javascript" } : null) });
    const js = route(req({ path: "/assets/index-abc123.js" }), d);
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
  });

  it("serves /health without a session", () => {
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
    expect(asText(out.body)).toContain("app");
  });

  it("404s a missing file instead of throwing", () => {
    const d = deps({ readAsset: () => null });
    expect(route(req({ path: "/missing.css", headers: withSession(d) }), d).status).toBe(404);
  });

  it("passes a PNG through as bytes, not as utf-8 text", () => {
    // A favicon decoded as utf-8 is how a tab icon becomes noise while the SVG next to it
    // looks fine. The reader hands back a Buffer; this route must not stringify it.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const d = deps({ readAsset: (p) => (p === "/favicon.png" ? { body: png, type: "image/png" } : null) });
    const out = route(req({ path: "/favicon.png" }), d);
    expect(out.status).toBe(200);
    expect(out.headers["content-type"]).toBe("image/png");
    expect(Buffer.isBuffer(out.body)).toBe(true);
    expect(out.body).toEqual(png);
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
    const csp = out.headers["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Frames load as data URLs (the session cookie is on the JSON fetch, not
    // on <img src>). default-src 'self' alone blocks those, so the visit page
    // showed a broken icon next to a complete step log.
    expect(csp).toContain("img-src 'self' data:");
    // The shell loads Familjen Grotesk and IBM Plex Mono from Google Fonts.
    // A policy that names only 'self' blocked the stylesheet and the typefaces
    // fell back to Avenir / system mono — the page looked unsigned-in even
    // after a successful login.
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
    // Theme boot is a file, not an inline tag. default-src 'self' already
    // covers /theme-boot.js; naming script-src keeps a future inline from
    // silently shipping.
    expect(csp).toContain("script-src 'self'");
    expect(out.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("watch and live, behind the same session as every other reading", () => {
  it("404s with a reason when the console has no control plane", () => {
    const d = deps();
    const out = route(req({ path: "/api/watch", headers: withSession(d) }), d);
    expect(out.status).toBe(404);
    expect(JSON.parse(asText(out.body)).error).toContain("geoqa server");
  });

  it("serves the watch when a control plane is wired", () => {
    const d = deps({
      control: {
        watch: () => ({ enabled: true }),
        saveWatch: () => ({ ok: true, value: { enabled: true } }),
        addTarget: () => ({ ok: true, value: {} }),
        removeTarget: () => ({ ok: true, value: {} }),
        startNow: () => ({ ok: true, value: { started: true } }),
        live: () => ({ sessions: [] }),
        liveFrame: () => null,
        liveSession: () => null,
        runNow: () => ({ ok: true, value: { started: true } }),
        runStatus: () => ({ inFlight: 0, events: [] }),
      },
    });
    const out = route(req({ path: "/api/watch", headers: withSession(d) }), d);
    expect(out.status).toBe(200);
    expect(JSON.parse(asText(out.body))).toEqual({ enabled: true });
    const run = route(req({ path: "/api/run", headers: withSession(d) }), d);
    expect(run.status).toBe(200);
  });

  it("accepts a bearer token when one is configured, so a machine client does not need a cookie", () => {
    const token = "t".repeat(32);
    const d = deps({
      auth: { passwordHash: hashPassword(PASSWORD), secret: SECRET, apiToken: token },
      control: {
        watch: () => ({ enabled: false }),
        saveWatch: () => ({ ok: true, value: {} }),
        addTarget: () => ({ ok: true, value: {} }),
        removeTarget: () => ({ ok: true, value: {} }),
        startNow: () => ({ ok: true, value: {} }),
        live: () => ({ sessions: [] }),
        liveFrame: () => null,
        liveSession: () => null,
        runNow: () => ({ ok: true, value: { started: true } }),
        runStatus: () => ({ inFlight: 0, events: [] }),
      },
    });
    const out = route(req({ path: "/api/run", headers: { authorization: `Bearer ${token}` } }), d);
    expect(out.status).toBe(200);
    expect(route(req({ path: "/api/run", headers: { authorization: "Bearer wrong-token-is-not-long-enough" } }), d).status).toBe(401);
  });
});

describe("evidence for one run", () => {
  it("404s with a reason when nothing can read the evidence tree", () => {
    const d = deps();
    const out = route(req({ path: "/api/evidence/run_1_bergen-mobile", headers: withSession(d) }), d);
    expect(out.status).toBe(404);
    expect(JSON.parse(asText(out.body)).error).toContain("not available on this console");
  });

  it("serves the step log for a run, and a screenshot as bytes", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const d = deps({
      evidence: (runId) =>
        runId === "run_1_bergen-mobile"
          ? { ok: true, value: { runId, steps: [{ action: "click", detail: "click #go ok" }], screenshots: [{ label: "landing", present: true }] } }
          : { ok: false, error: "no evidence package for this run" },
      evidenceShot: (runId, label) => (runId === "run_1_bergen-mobile" && label === "landing" ? { body: png, type: "image/png" } : null),
    });
    const pack = route(req({ path: "/api/evidence/run_1_bergen-mobile", headers: withSession(d) }), d);
    expect(pack.status).toBe(200);
    expect(JSON.parse(asText(pack.body)).steps[0].detail).toBe("click #go ok");

    const missing = route(req({ path: "/api/evidence/run_nope", headers: withSession(d) }), d);
    expect(missing.status).toBe(404);

    const shot = route(req({ path: "/api/evidence/run_1_bergen-mobile/shot/landing", headers: withSession(d) }), d);
    expect(shot.status).toBe(200);
    expect(JSON.parse(asText(shot.body))).toEqual({ mime: "image/png", data: png.toString("base64") });

    const noShot = route(req({ path: "/api/evidence/run_1_bergen-mobile/shot/secret", headers: withSession(d) }), d);
    expect(noShot.status).toBe(404);
  });
});

describe("whoami", () => {
  it("reports the signed-in user and when the session ends", () => {
    const d = deps();
    const out = route(req({ path: "/api/whoami", headers: withSession(d, "ada") }), d);
    expect(JSON.parse(asText(out.body))).toMatchObject({ user: "ada" });
  });
});
