import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Market } from "../../geo/types.js";
import { loadCooldowns, saveCooldowns } from "../cooldown.js";
import { DEFAULT_COOLDOWN_MS, directProvider, httpProxyProvider, noteProviderOutcome, parseProxyEndpoint, redactProxyUrl, resolveProxyPool, resolveProxyUrl, selectFromPool, selectProvider, tcpProbe } from "../provider.js";

const OSLO: Market = {
  id: "oslo",
  country: "NO",
  city: "Oslo",
  language: "nb-NO",
  timezone: "Europe/Oslo",
  currency: "NOK",
  coordinates: [59.9139, 10.7522],
};

let dir: string;
let store: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "geoqa-provider-"));
  store = path.join(dir, "cooldowns.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseProxyEndpoint", () => {
  it("reads host and explicit port", () => {
    expect(parseProxyEndpoint("http://user:pass@gw.vendor.io:7777")).toEqual({ host: "gw.vendor.io", port: 7777 });
  });

  it("defaults the port by scheme", () => {
    expect(parseProxyEndpoint("http://gw.io")).toEqual({ host: "gw.io", port: 80 });
    expect(parseProxyEndpoint("https://gw.io")).toEqual({ host: "gw.io", port: 443 });
  });

  it("rejects garbage, empty hosts and impossible ports", () => {
    expect(parseProxyEndpoint("not a url")).toBeNull();
    expect(parseProxyEndpoint("http://gw.io:0")).toBeNull();
    expect(parseProxyEndpoint("http://gw.io:99999")).toBeNull();
    expect(parseProxyEndpoint("file:///tmp/x")).toBeNull();
  });
});

describe("redactProxyUrl", () => {
  it("masks credentials but keeps the endpoint legible", () => {
    expect(redactProxyUrl("http://user:s3cret@gw.io:7777")).toBe("http://***:***@gw.io:7777/");
  });

  it("passes through a credential-free URL and null", () => {
    expect(redactProxyUrl("http://gw.io:7777/")).toBe("http://gw.io:7777/");
    expect(redactProxyUrl(null)).toBeNull();
  });

  it("fails closed on a string that PARSES but is not a proxy scheme", () => {
    // `new URL("user:pass@garbage")` succeeds — it reads "user:" as the scheme
    // — so without the scheme guard this returns the password verbatim.
    expect(redactProxyUrl("user:pass@garbage")).toBe("***");
  });

  it("masks a username carrying a sticky session key, because the password shares that field", () => {
    // A session key is not itself a secret, but it lives in the username right
    // next to a password that is, so the whole userinfo component goes. The
    // session id is recoverable from `session.id` in run.json; the password is
    // recoverable from nowhere, which is the point.
    expect(redactProxyUrl("http://u-sessid-abc123:s3cret@gw.io:7777")).toBe("http://***:***@gw.io:7777/");
  });

  it("fails closed when the URL constructor actually throws", () => {
    expect(redactProxyUrl("http://[::1")).toBe("***");
    expect(redactProxyUrl("")).toBe("***");
  });
});

describe("resolveProxyUrl", () => {
  it("prefers a market-specific variable", () => {
    expect(resolveProxyUrl(OSLO, { GEOQA_PROXY_OSLO: "http://a", GEOQA_PROXY_NO: "http://b" }, "s1")).toBe("http://a");
  });

  it("falls back to the country variable", () => {
    expect(resolveProxyUrl(OSLO, { GEOQA_PROXY_NO: "http://b" }, "s1")).toBe("http://b");
  });

  it("substitutes every placeholder in a template", () => {
    const url = resolveProxyUrl(
      OSLO,
      { GEOQA_PROXY_TEMPLATE: "http://u-{countryLower}-{cityLower}-{market}:p@gw:1?c={country}&city={city}" },
      "s1",
    );
    expect(url).toBe("http://u-no-oslo-oslo:p@gw:1?c=NO&city=Oslo");
  });

  it("substitutes {session} into a template, which is how a residential vendor is told to be sticky", () => {
    const url = resolveProxyUrl(
      OSLO,
      { GEOQA_PROXY_TEMPLATE: "http://u-cc-{countryLower}-sessid-{session}-sesstime-15:pw@gw.vendor.net:7777" },
      "abc123",
    );
    expect(url).toBe("http://u-cc-no-sessid-abc123-sesstime-15:pw@gw.vendor.net:7777");
  });

  it("substitutes placeholders in a PER-MARKET url too, not only in the template", () => {
    // The per-market form used to be returned verbatim, which made a sticky
    // session key impossible for exactly the market you cared enough to pin.
    const url = resolveProxyUrl(
      OSLO,
      { GEOQA_PROXY_OSLO: "http://u-{country}-sessid-{session}:pw@gw:1", GEOQA_PROXY_TEMPLATE: "http://ignored" },
      "abc123",
    );
    expect(url).toBe("http://u-NO-sessid-abc123:pw@gw:1");
  });

  it("substitutes placeholders in a PER-COUNTRY url too", () => {
    expect(resolveProxyUrl(OSLO, { GEOQA_PROXY_NO: "http://u-{city}-{session}:pw@gw:1" }, "abc123")).toBe(
      "http://u-Oslo-abc123:pw@gw:1",
    );
  });

  it("leaves an unknown placeholder verbatim rather than blanking part of a username", () => {
    expect(resolveProxyUrl(OSLO, { GEOQA_PROXY_NO: "http://u-{vendorSpecific}-{session}:pw@gw:1" }, "abc")).toBe(
      "http://u-{vendorSpecific}-abc:pw@gw:1",
    );
  });

  it("returns a url with no placeholders unchanged", () => {
    expect(resolveProxyUrl(OSLO, { GEOQA_PROXY_NO: "http://u:p@gw.io:7777" }, "abc123")).toBe("http://u:p@gw.io:7777");
  });

  it("sanitises a market id with punctuation into a legal variable name", () => {
    const market = { ...OSLO, id: "oslo-mobile" };
    expect(resolveProxyUrl(market, { GEOQA_PROXY_OSLO_MOBILE: "http://x" }, "s1")).toBe("http://x");
  });

  it("returns null when nothing is configured", () => {
    expect(resolveProxyUrl(OSLO, {}, "s1")).toBeNull();
  });
});

describe("directProvider", () => {
  it("is always usable and says plainly that it is not geographic", async () => {
    const health = await directProvider().health(0);
    expect(health.state).toBe("usable");
    expect(health.detail).toContain("this machine");
  });

  it("creates a session with no proxy", async () => {
    const out = await directProvider({ proxyBypass: "localhost" }).createSession(OSLO, 1_000);
    expect(out).toMatchObject({
      ok: true,
      session: {
        marketId: "oslo",
        providerName: "direct",
        proxyUrl: null,
        proxyBypass: "localhost",
        openedAt: 1_000,
      },
    });
    // The id carries a per-process sequence number, so it is matched by SHAPE rather
    // than by value — see the next test for why the sequence has to be there.
    if (!out.ok) throw new Error("expected a session");
    expect(out.session.id).toMatch(/^oslo-1000-\d+$/);
  });

  it("gives two sessions in the SAME market and millisecond DIFFERENT ids", async () => {
    // Invariant 16 is ONE JOURNEY = ONE NETWORK SESSION, and the id is what the
    // `{session}` placeholder puts in a residential vendor's username to pin a sticky
    // exit. When the id was `<market>-<epochMs>`, two concurrent runs in one market
    // started in the same millisecond shared a sticky key — so they shared an egress IP
    // while each reported `egressHeld: match`, because holding an IP you share with
    // somebody else still looks like holding it.
    //
    // Found live: EXP-007 through Decodo at concurrency 3 put two Oslo profiles on
    // 193.69.169.75 and the third market on a different address.
    const provider = directProvider();
    const first = await provider.createSession(OSLO, 1_000);
    const second = await provider.createSession(OSLO, 1_000);
    if (!first.ok || !second.ok) throw new Error("expected two sessions");
    expect(first.session.id).not.toBe(second.session.id);
  });

  it("uses an injected id generator and defaults proxyBypass to null", async () => {
    const out = await directProvider({ newSessionId: () => "fixed" }).createSession(OSLO, 1);
    if (!out.ok) throw new Error("expected ok");
    expect(out.session.id).toBe("fixed");
    expect(out.session.proxyBypass).toBeNull();
    await directProvider().close(out.session);
  });
});

describe("httpProxyProvider health", () => {
  it("reports unconfigured when no proxy variables exist at all", async () => {
    const health = await httpProxyProvider({ env: {} }).health(0);
    expect(health).toMatchObject({ state: "unconfigured", cooldownUntil: null });
  });

  it("probes a concrete URL and reports usable when the endpoint answers", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const health = await httpProxyProvider({ env: { GEOQA_PROXY_NO: "http://gw.io:7777" }, probe }).health(0);
    expect(probe).toHaveBeenCalledWith("gw.io", 7777, 5_000);
    expect(health).toMatchObject({ state: "usable" });
  });

  it("reports unusable when the endpoint refuses", async () => {
    const health = await httpProxyProvider({
      env: { GEOQA_PROXY_NO: "http://gw.io:7777" },
      probe: () => Promise.resolve(false),
      probeTimeoutMs: 10,
    }).health(0);
    expect(health).toMatchObject({ state: "unusable" });
    expect(health.detail).toContain("refused");
  });

  it("PROBES a template, because its host is literal even when its username is not", async () => {
    // This used to refuse any URL containing a placeholder and report
    // `unconfigured`. That reasoning was wrong where it counts: a vendor's
    // placeholders live in the USERNAME while the gateway host and port are
    // literal, so the only thing a reachability probe needs was always present.
    // And `prepareRun` treats `unconfigured` as a hard refusal for a non-direct
    // provider — so a template, the normal way to configure a residential vendor,
    // could never start a run at all. Found against a real gateway.
    const probe = vi.fn(() => Promise.resolve(true));
    const health = await httpProxyProvider({
      env: { GEOQA_PROXY_TEMPLATE: "http://u-{country}-session-{session}:p@gate.vendor.net:7000" },
      probe,
    }).health(0);
    expect(probe).toHaveBeenCalledWith("gate.vendor.net", 7000, expect.any(Number));
    expect(health.state).toBe("usable");
  });

  it("reports unconfigured only when the URL cannot parse even with placeholders resolved", async () => {
    const probe = vi.fn();
    const health = await httpProxyProvider({ env: { GEOQA_PROXY_TEMPLATE: "not-a-url-at-all" }, probe }).health(0);
    expect(probe).not.toHaveBeenCalled();
    expect(health.state).toBe("unconfigured");
    // The detail is redacted: an unparseable proxy string may still hold a password.
    expect(health.detail).toContain("***");
  });

  it("probes the gateway of a per-market URL that carries a session placeholder", async () => {
    // health() answers "is the vendor reachable", which is a question about the
    // gateway. It has no session id to substitute and does not need one: the
    // placeholder is replaced with an inert token purely so the string parses.
    const probe = vi.fn(() => Promise.resolve(true));
    const health = await httpProxyProvider({
      env: { GEOQA_PROXY_NO: "http://u-sessid-{session}:pw@gw.vendor.net:7777" },
      probe,
    }).health(0);
    expect(probe).toHaveBeenCalledWith("gw.vendor.net", 7777, expect.any(Number));
    expect(health.state).toBe("usable");
  });

  it("probes the FIRST exit of a pool, not the whole comma-separated string", async () => {
    // Treating the pool as one URL made `parseProxyEndpoint` refuse it, so a
    // perfectly good multi-exit market reported the vendor as unconfigured.
    const probe = vi.fn(() => Promise.resolve(true));
    const health = await httpProxyProvider({
      env: { GEOQA_PROXY_NO: "http://a.vendor.net:8881,http://b.vendor.net:8882" },
      probe,
    }).health(0);
    expect(probe).toHaveBeenCalledWith("a.vendor.net", 8881, expect.any(Number));
    expect(health.state).toBe("usable");
  });

  it("reports unconfigured for a configured-but-unparseable URL", async () => {
    const health = await httpProxyProvider({ env: { GEOQA_PROXY_NO: "garbage" } }).health(0);
    expect(health.state).toBe("unconfigured");
  });

  it("skips the probe entirely while cooling down", async () => {
    saveCooldowns(store, { "http-proxy": 10_000 });
    const probe = vi.fn();
    const health = await httpProxyProvider({
      env: { GEOQA_PROXY_NO: "http://gw.io:7777" },
      cooldownPath: store,
      probe,
    }).health(1_000);
    expect(probe).not.toHaveBeenCalled();
    expect(health).toMatchObject({ state: "unusable", cooldownUntil: 10_000 });
  });

  it("probes again once the cooldown has elapsed", async () => {
    saveCooldowns(store, { "http-proxy": 500 });
    const probe = vi.fn().mockResolvedValue(true);
    const health = await httpProxyProvider({
      env: { GEOQA_PROXY_NO: "http://gw.io:7777" },
      cooldownPath: store,
      probe,
    }).health(1_000);
    expect(health.state).toBe("usable");
  });
});

describe("httpProxyProvider sessions", () => {
  it("creates a session carrying the resolved proxy URL", async () => {
    const out = await httpProxyProvider({ env: { GEOQA_PROXY_NO: "http://u:p@gw.io:7777" } }).createSession(OSLO, 5);
    if (!out.ok) throw new Error("expected ok");
    expect(out.session).toMatchObject({ providerName: "http-proxy", proxyUrl: "http://u:p@gw.io:7777" });
  });

  it("carries THIS run's session id inside the proxy URL, not a later one", async () => {
    const out = await httpProxyProvider({
      env: { GEOQA_PROXY_TEMPLATE: "http://u-cc-{countryLower}-sessid-{session}:pw@gw.vendor.net:7777" },
      newSessionId: () => "abc123",
    }).createSession(OSLO, 5);
    if (!out.ok) throw new Error("expected ok");
    expect(out.session.proxyUrl).toBe("http://u-cc-no-sessid-abc123:pw@gw.vendor.net:7777");
    // The id on the session and the id in the URL are the SAME string: the run
    // can only be attributed to a vendor session if we asked for the one we report.
    expect(out.session.id).toBe("abc123");
  });

  it("substitutes {session} in a per-market vendor URL as well as in the template", async () => {
    const out = await httpProxyProvider({
      env: { GEOQA_PROXY_OSLO: "http://u-sessid-{session}:pw@gw.vendor.net:7777" },
      newSessionId: () => "oslo-session-9",
    }).createSession(OSLO, 5);
    if (!out.ok) throw new Error("expected ok");
    expect(out.session.proxyUrl).toBe("http://u-sessid-oslo-session-9:pw@gw.vendor.net:7777");
  });

  it("gives two sessions for the SAME market different session keys, so neither pins the other's exit IP", async () => {
    const ids = ["first", "second"];
    let n = 0;
    const provider = httpProxyProvider({
      env: { GEOQA_PROXY_NO: "http://u-sessid-{session}:pw@gw.vendor.net:7777" },
      newSessionId: () => ids[n++] ?? "exhausted",
    });
    const a = await provider.createSession(OSLO, 5);
    const b = await provider.createSession(OSLO, 5);
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.session.proxyUrl).toBe("http://u-sessid-first:pw@gw.vendor.net:7777");
    expect(b.session.proxyUrl).toBe("http://u-sessid-second:pw@gw.vendor.net:7777");
    expect(a.session.proxyUrl).not.toBe(b.session.proxyUrl);
  });

  it("validates the SUBSTITUTED url, so a per-session gateway port is accepted rather than refused", async () => {
    // Port-per-session is a real vendor shape, and `http://u:pw@gw.io:{session}`
    // is not a parseable URL until the placeholder is gone. Validating the raw
    // value would refuse a configuration that works.
    const out = await httpProxyProvider({
      env: { GEOQA_PROXY_NO: "http://u:pw@gw.io:{session}" },
      newSessionId: () => "10007",
    }).createSession(OSLO, 5);
    if (!out.ok) throw new Error("expected ok");
    expect(out.session.proxyUrl).toBe("http://u:pw@gw.io:10007");
  });

  it("refuses a market with no proxy rather than falling back to direct egress", async () => {
    const out = await httpProxyProvider({ env: {} }).createSession(OSLO, 5);
    expect(out).toEqual({ ok: false, reason: 'no proxy configured for market "oslo"' });
  });

  it("refuses an unparseable proxy URL", async () => {
    const out = await httpProxyProvider({ env: { GEOQA_PROXY_NO: "nonsense" } }).createSession(OSLO, 5);
    expect(out).toMatchObject({ ok: false });
    if (out.ok) throw new Error("expected failure");
    expect(out.reason).toContain("not a parseable URL");
  });

  it("closes without error", async () => {
    const provider = httpProxyProvider({ env: { GEOQA_PROXY_NO: "http://gw.io:1" } });
    const out = await provider.createSession(OSLO, 1);
    if (!out.ok) throw new Error("expected ok");
    await expect(provider.close(out.session)).resolves.toBeUndefined();
  });

  it("defaults env to process.env when none is injected", async () => {
    const health = await httpProxyProvider().health(0);
    expect(["unconfigured", "usable", "unusable"]).toContain(health.state);
  });
});

describe("noteProviderOutcome", () => {
  it("cools the provider down on failure", () => {
    noteProviderOutcome("http-proxy", false, 1_000, { cooldownPath: store });
    expect(loadCooldowns(store)).toEqual({ "http-proxy": 1_000 + DEFAULT_COOLDOWN_MS });
  });

  it("CLEARS on success, so topping up an account is the whole recovery", () => {
    saveCooldowns(store, { "http-proxy": 9_999_999 });
    noteProviderOutcome("http-proxy", true, 1_000, { cooldownPath: store });
    expect(loadCooldowns(store)).toEqual({});
  });

  it("honours a custom window and is a no-op without a store path", () => {
    noteProviderOutcome("http-proxy", false, 1_000, { cooldownPath: store, cooldownMs: 60 });
    expect(loadCooldowns(store)).toEqual({ "http-proxy": 1_060 });
    expect(() => noteProviderOutcome("http-proxy", false, 1_000)).not.toThrow();
  });
});

describe("selectProvider", () => {
  it("builds the named providers without a warning", () => {
    expect(selectProvider("direct").provider.name).toBe("direct");
    expect(selectProvider("http-proxy").provider.name).toBe("http-proxy");
    expect(selectProvider("direct").warning).toBeNull();
  });

  it("falls back to direct LOUDLY for an unknown name", () => {
    const { provider, warning } = selectProvider("residential-magic");
    expect(provider.name).toBe("direct");
    expect(warning).toContain("NOT geographic");
  });
});

describe("tcpProbe", () => {
  it("returns true for a listening socket and false for a closed port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await expect(tcpProbe("127.0.0.1", port, 1_000)).resolves.toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(tcpProbe("127.0.0.1", port, 1_000)).resolves.toBe(false);
  });

  it("returns false when the connection times out", async () => {
    // 203.0.113.0/24 is TEST-NET-3: reserved, routable nowhere, so the
    // connection hangs until our own timeout fires.
    await expect(tcpProbe("203.0.113.1", 9, 150)).resolves.toBe(false);
  });
});

describe("exit pools", () => {
  const de: Market = {
    id: "berlin", country: "DE", city: "Berlin", language: "de-DE",
    timezone: "Europe/Berlin", currency: "EUR", coordinates: [52.52, 13.405],
  };
  const POOL = "http://u:p@gw:8881,http://u:p@gw:8882,http://u:p@gw:8883";

  it("reads every comma-separated exit a market declares", () => {
    expect(resolveProxyPool(de, { GEOQA_PROXY_DE: POOL }, "s1")).toEqual([
      "http://u:p@gw:8881",
      "http://u:p@gw:8882",
      "http://u:p@gw:8883",
    ]);
  });

  it("tolerates whitespace and DROPS blanks rather than inventing direct egress", () => {
    // A trailing comma must not produce an unrouted run wearing a proxy's name.
    const pool = resolveProxyPool(de, { GEOQA_PROXY_DE: " http://a:1 , , http://b:2 ," }, "s1");
    expect(pool).toEqual(["http://a:1", "http://b:2"]);
  });

  it("is empty when nothing is configured", () => {
    expect(resolveProxyPool(de, {}, "s1")).toEqual([]);
  });

  it("substitutes placeholders in every member of the pool", () => {
    const pool = resolveProxyPool(
      de,
      { GEOQA_PROXY_TEMPLATE: "http://u-{countryLower}-{session}:p@a:1,http://u-{countryLower}-{session}:p@b:2" },
      "sess-9",
    );
    expect(pool).toEqual(["http://u-de-sess-9:p@a:1", "http://u-de-sess-9:p@b:2"]);
  });

  it("picks the SAME exit for the same session id — a run must be replayable", () => {
    const pool = ["a", "b", "c", "d", "e"];
    expect(selectFromPool(pool, "berlin-1700000000000")).toBe(selectFromPool(pool, "berlin-1700000000000"));
  });

  it("spreads different sessions across the pool rather than favouring one", () => {
    const pool = ["a", "b", "c", "d"];
    const seen = new Set(Array.from({ length: 200 }, (_, i) => selectFromPool(pool, `berlin-${i}`)));
    expect(seen.size).toBe(pool.length);
  });

  it("returns the only member of a single-exit pool, and null for an empty one", () => {
    expect(selectFromPool(["only"], "s")).toBe("only");
    expect(selectFromPool([], "s")).toBeNull();
  });

  it("gives two sessions of one market different exits, so a market is sampled not a single IP", () => {
    const env = { GEOQA_PROXY_DE: POOL };
    const chosen = new Set(["a", "b", "c", "d", "e", "f"].map((s) => resolveProxyUrl(de, env, `berlin-${s}`)));
    expect(chosen.size).toBeGreaterThan(1);
  });

  it("still returns a single configured exit unchanged", () => {
    expect(resolveProxyUrl(de, { GEOQA_PROXY_DE: "http://u:p@only:8888" }, "s")).toBe("http://u:p@only:8888");
  });
});

describe("health authentication probe", () => {
  const env = { GEOQA_PROXY_TEMPLATE: "http://u-{countryLower}:pw@gate.vendor.net:7000" };

  it("stays USABLE when no auth probe is supplied — reachability only, as before", async () => {
    const health = await httpProxyProvider({ env, probe: () => Promise.resolve(true) }).health(0);
    expect(health.state).toBe("usable");
  });

  it("is UNUSABLE when the gateway answers but refuses our credentials", async () => {
    // A TCP connect proves the gateway is listening and nothing else. Reporting
    // `usable` there let a run start that could never egress — the zero-balance
    // failure this file warns about for DataForSEO, reproduced against a real
    // residential vendor.
    const health = await httpProxyProvider({
      env,
      probe: () => Promise.resolve(true),
      auth: () =>
        Promise.resolve({
          ok: false,
          status: 407,
          detail: "Access denied. We couldn't log you in with the details provided.",
        }),
    }).health(0);
    expect(health.state).toBe("unusable");
    expect(health.detail).toContain("407");
    expect(health.detail).toContain("couldn't log you in");
  });

  it("SURFACES the vendor's own words, because the two refusals need different actions", async () => {
    // "wrong password" means fix a typo. "traffic limit" means top up an account.
    // An opaque 407 for both is the same mistake as reporting an unread console
    // as clean — and it cost an hour of guessing at usernames.
    const health = await httpProxyProvider({
      env,
      probe: () => Promise.resolve(true),
      auth: () =>
        Promise.resolve({ ok: false, status: 407, detail: "Access denied. You've reached your current traffic limit." }),
    }).health(0);
    expect(health.detail).toContain("traffic limit");
  });

  it("is usable when the CONNECT is accepted", async () => {
    const health = await httpProxyProvider({
      env,
      probe: () => Promise.resolve(true),
      auth: () => Promise.resolve({ ok: true, status: 200, detail: null }),
    }).health(0);
    expect(health.state).toBe("usable");
  });

  it("does not probe auth at all when the gateway is unreachable", async () => {
    const auth = vi.fn();
    const health = await httpProxyProvider({ env, probe: () => Promise.resolve(false), auth }).health(0);
    expect(auth).not.toHaveBeenCalled();
    expect(health.state).toBe("unusable");
    expect(health.detail).toContain("refused a connection");
  });

  it("reports a refusal with no vendor message without inventing one", async () => {
    const health = await httpProxyProvider({
      env,
      probe: () => Promise.resolve(true),
      auth: () => Promise.resolve({ ok: false, status: null, detail: null }),
    }).health(0);
    expect(health.state).toBe("unusable");
    expect(health.detail).toContain("refused authentication");
  });
});
