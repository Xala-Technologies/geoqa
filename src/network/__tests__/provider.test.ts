import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Market } from "../../geo/types.js";
import { loadCooldowns, saveCooldowns } from "../cooldown.js";
import {
  DEFAULT_COOLDOWN_MS,
  directProvider,
  httpProxyProvider,
  noteProviderOutcome,
  parseProxyEndpoint,
  redactProxyUrl,
  resolveProxyUrl,
  selectProvider,
  tcpProbe,
} from "../provider.js";

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

  it("fails closed when the URL constructor actually throws", () => {
    expect(redactProxyUrl("http://[::1")).toBe("***");
    expect(redactProxyUrl("")).toBe("***");
  });
});

describe("resolveProxyUrl", () => {
  it("prefers a market-specific variable", () => {
    expect(resolveProxyUrl(OSLO, { GEOQA_PROXY_OSLO: "http://a", GEOQA_PROXY_NO: "http://b" })).toBe("http://a");
  });

  it("falls back to the country variable", () => {
    expect(resolveProxyUrl(OSLO, { GEOQA_PROXY_NO: "http://b" })).toBe("http://b");
  });

  it("substitutes every placeholder in a template", () => {
    const url = resolveProxyUrl(OSLO, {
      GEOQA_PROXY_TEMPLATE: "http://u-{countryLower}-{cityLower}-{market}:p@gw:1?c={country}&city={city}",
    });
    expect(url).toBe("http://u-no-oslo-oslo:p@gw:1?c=NO&city=Oslo");
  });

  it("sanitises a market id with punctuation into a legal variable name", () => {
    const market = { ...OSLO, id: "oslo-mobile" };
    expect(resolveProxyUrl(market, { GEOQA_PROXY_OSLO_MOBILE: "http://x" })).toBe("http://x");
  });

  it("returns null when nothing is configured", () => {
    expect(resolveProxyUrl(OSLO, {})).toBeNull();
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
    expect(out).toEqual({
      ok: true,
      session: {
        id: "oslo-1000",
        marketId: "oslo",
        providerName: "direct",
        proxyUrl: null,
        proxyBypass: "localhost",
        openedAt: 1_000,
      },
    });
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

  it("does not claim reachability for a template it cannot probe", async () => {
    const probe = vi.fn();
    const health = await httpProxyProvider({
      env: { GEOQA_PROXY_TEMPLATE: "http://u-{country}:p@gw:1" },
      probe,
    }).health(0);
    expect(probe).not.toHaveBeenCalled();
    expect(health).toMatchObject({ state: "unconfigured" });
    expect(health.detail).toContain("not probed");
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
