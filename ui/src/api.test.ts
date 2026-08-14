import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson, signIn, signOut } from "./api.ts";

/** A `Response` with only the parts this module touches. */
const response = (init: { status: number; body?: unknown; text?: string }): Response =>
  ({
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    json: () =>
      init.text !== undefined
        ? Promise.reject(new SyntaxError("Unexpected token < in JSON at position 0"))
        : Promise.resolve(init.body),
  }) as unknown as Response;

const stubFetch = (impl: (input: string, init?: RequestInit) => Promise<Response>): void => {
  vi.stubGlobal("fetch", vi.fn(impl as unknown as typeof fetch));
};

afterEach(() => vi.unstubAllGlobals());

describe("getJson — three answers, never two collapsed into one", () => {
  it("returns the value on success", async () => {
    stubFetch(() => Promise.resolve(response({ status: 200, body: { total: 3 } })));
    const result = await getJson<{ total: number }>("/dashboard.json");
    expect(result).toEqual({ ok: true, value: { total: 3 } });
  });

  it("reports 401 as SIGNED OUT, which is not an error", async () => {
    // The distinction the whole module exists for. Rendering "not signed in" as a failure
    // would tell a reader who has simply just opened the page that something is broken.
    stubFetch(() => Promise.resolve(response({ status: 401, body: { error: "not signed in" } })));
    const result = await getJson("/dashboard.json");
    expect(result).toEqual({ ok: false, signedOut: true });
  });

  it("carries the server's OWN words for a real failure", async () => {
    // Better than "the server answered 404": the server knows that no dashboard has been
    // built and can say so, and that message names something the reader can act on.
    stubFetch(() => Promise.resolve(response({ status: 404, body: { error: "no dashboard has been built yet" } })));
    const result = await getJson("/dashboard.json");
    expect(result).toEqual({ ok: false, signedOut: false, error: "no dashboard has been built yet" });
  });

  it("falls back to the status when the error body is not JSON", async () => {
    stubFetch(() => Promise.resolve(response({ status: 500, text: "<html>oops</html>" })));
    const result = await getJson("/dashboard.json");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.signedOut === false && result.error).toContain("500");
  });

  it("falls back to the status when the error body has no `error` field", async () => {
    stubFetch(() => Promise.resolve(response({ status: 503, body: { detail: "elsewhere" } })));
    const result = await getJson("/x");
    expect(result.ok === false && result.signedOut === false && result.error).toContain("503");
  });

  it("names a 200 that is not JSON, rather than throwing several frames away", async () => {
    // THE bug this module was written after. A request answered with the app's own HTML
    // reports 200, and `.json()` then throws inside a promise chain far from the cause. The
    // console rendered a blank white page and said nothing about why.
    stubFetch(() => Promise.resolve(response({ status: 200, text: "<!doctype html>" })));
    const result = await getJson("/dashboard.json");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.signedOut === false && result.error).toContain("not JSON");
  });

  it("reports a transport failure distinctly from an HTTP one", async () => {
    // The server is not running. Different problem, different fix, different sentence.
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const result = await getJson("/dashboard.json");
    expect(result.ok === false && result.signedOut === false && result.error).toContain("could not reach the server");
  });

  it("sends the cookie, which is the whole point of the request", async () => {
    // `credentials` defaults to same-origin in current browsers, so omitting it would pass
    // every test and still be the line that decides whether sessions work.
    const calls: RequestInit[] = [];
    stubFetch((_input, init) => {
      calls.push(init ?? {});
      return Promise.resolve(response({ status: 200, body: {} }));
    });
    await getJson("/dashboard.json");
    expect(calls[0]?.credentials).toBe("same-origin");
    expect(calls[0]?.cache).toBe("no-store");
  });
});

describe("signIn", () => {
  it("returns the session on success", async () => {
    stubFetch(() => Promise.resolve(response({ status: 200, body: { user: "admin", expiresAt: 99 } })));
    expect(await signIn("admin", "pw")).toEqual({ ok: true, value: { user: "admin", expiresAt: 99 } });
  });

  it("POSTs the credentials as JSON to the session endpoint", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(response({ status: 200, body: {} }));
    });
    await signIn("admin", "pw");
    expect(calls[0]?.url).toBe("/api/session");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ user: "admin", password: "pw" });
  });

  it("reports a rejected password as a MESSAGE, not as signed-out", async () => {
    // The caller is already on the sign-in screen. Returning `signedOut` would bounce it back
    // to itself and lose the reason it was rejected.
    stubFetch(() => Promise.resolve(response({ status: 401, body: { error: "sign-in failed" } })));
    const result = await signIn("admin", "wrong");
    expect(result).toEqual({ ok: false, signedOut: false, error: "sign-in failed" });
  });

  it("reports an unreachable server distinctly from a rejected password", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const result = await signIn("admin", "pw");
    expect(result.ok === false && result.signedOut === false && result.error).toContain("could not reach the server");
  });
});

describe("signOut", () => {
  it("DELETEs the session", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(response({ status: 204, body: null }));
    });
    await signOut();
    expect(calls[0]?.url).toBe("/api/session");
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  it("never rejects, even when the request fails", async () => {
    // The caller is going back to the sign-in screen either way, and an error box about
    // signing out helps nobody. An unhandled rejection here would be a console error on the
    // one action that is supposed to be the calm one.
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(signOut()).resolves.toBeUndefined();
  });
});
