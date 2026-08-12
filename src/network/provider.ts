/**
 * Egress providers.
 *
 * Two ship in Phase 0:
 *   - `direct`      no proxy. Egresses from wherever this machine sits. The
 *                   only honest option until a vendor is procured, and the
 *                   baseline every other provider is measured against.
 *   - `http-proxy`  a generic authenticated HTTP proxy, one URL per market,
 *                   resolved from ENV only. Credentials never touch the config
 *                   file or an evidence manifest.
 *
 * A third — "the egress is the browser host", i.e. a cloud-browser region such
 * as Browserbase or Kernel, which agent-browser supports natively via
 * `-p <provider>` — is a deliberate hole in this file rather than an oversight.
 * It needs no proxy URL at all, so it will implement `GeoNetworkProvider` with
 * `proxyUrl: null` and carry its region in the session instead. Adding it does
 * not change this interface, which is the point of having one.
 */
import net from "node:net";
import type { Market } from "../geo/types.js";
import { coolingDown, loadCooldowns, recordCooldown } from "./cooldown.js";
import type { GeoNetworkProvider, GeoNetworkSession, ProviderHealth, SessionResult } from "./types.js";

export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** Injectable TCP reachability probe, so tests never open a socket. */
export type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

/**
 * Does something accept a TCP connection at host:port?
 *
 * This is a genuine probe, not a config check — but it is deliberately modest
 * about what it proves. It proves the endpoint is reachable. It does NOT prove
 * the account has credit, which no vendor reports until you spend some. The
 * authoritative signal is `noteProviderOutcome`, recorded after a run's egress
 * is actually verified.
 */
export const tcpProbe: TcpProbe = (host, port, timeoutMs) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });

/** Host and port from a proxy URL, or null when it is not a usable URL. */
export function parseProxyEndpoint(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return null;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

/**
 * Strip credentials from a proxy URL for logging.
 *
 * Every place a proxy URL could reach a human — a log line, a run summary, an
 * evidence manifest — goes through this. A residential vendor's password in a
 * committed experiment summary is a credential leak with a long half-life.
 */
export function redactProxyUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    // The scheme check is the load-bearing part. `new URL("user:pass@gw")`
    // PARSES — it reads "user:" as the scheme and "pass@gw" as the path — so a
    // malformed proxy string has no username or password as far as URL is
    // concerned, and an unguarded version returns it verbatim with the password
    // still in it. Anything that is not a recognised proxy scheme is masked
    // whole rather than trusted.
    if (!PROXY_SCHEMES.has(parsed.protocol)) return "***";
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "***";
    parsed.password = "***";
    return parsed.toString();
  } catch {
    return "***";
  }
}

const PROXY_SCHEMES = new Set(["http:", "https:", "socks:", "socks4:", "socks5:", "socks5h:"]);

/**
 * Resolve a market's proxy URL from the environment, most specific first:
 *   1. `GEOQA_PROXY_<MARKET_ID>`   e.g. GEOQA_PROXY_OSLO
 *   2. `GEOQA_PROXY_<COUNTRY>`     e.g. GEOQA_PROXY_NO
 *   3. `GEOQA_PROXY_TEMPLATE`      with {market}, {country}, {countryLower},
 *                                  {city}, {cityLower} substituted — the shape
 *                                  most residential vendors use, where the
 *                                  target country is encoded in the username.
 */
export function resolveProxyUrl(market: Market, env: NodeJS.ProcessEnv): string | null {
  const byMarket = env[`GEOQA_PROXY_${market.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (byMarket) return byMarket;
  const byCountry = env[`GEOQA_PROXY_${market.country.toUpperCase()}`];
  if (byCountry) return byCountry;
  const template = env.GEOQA_PROXY_TEMPLATE;
  if (!template) return null;
  return template
    .replaceAll("{market}", market.id)
    .replaceAll("{country}", market.country.toUpperCase())
    .replaceAll("{countryLower}", market.country.toLowerCase())
    .replaceAll("{city}", market.city)
    .replaceAll("{cityLower}", market.city.toLowerCase());
}

export interface ProviderOptions {
  env?: NodeJS.ProcessEnv;
  /** Cooldown store path. Omit to disable persistence entirely. */
  cooldownPath?: string;
  cooldownMs?: number;
  probe?: TcpProbe;
  probeTimeoutMs?: number;
  /** Hosts the proxy should not be used for (a local fixture server). */
  proxyBypass?: string;
  /** Injectable id generator so sessions are deterministic in tests. */
  newSessionId?: (market: Market, nowMs: number) => string;
}

const defaultSessionId = (market: Market, nowMs: number): string => `${market.id}-${nowMs}`;

/** Egress straight from this machine. Always usable; never geographic. */
export function directProvider(options: ProviderOptions = {}): GeoNetworkProvider {
  const newId = options.newSessionId ?? defaultSessionId;
  return {
    name: "direct",
    health: () =>
      Promise.resolve({
        state: "usable",
        detail: "no proxy — egress is this machine's own network",
        cooldownUntil: null,
      }),
    createSession: (market, nowMs) =>
      Promise.resolve({
        ok: true,
        session: {
          id: newId(market, nowMs),
          marketId: market.id,
          providerName: "direct",
          proxyUrl: null,
          proxyBypass: options.proxyBypass ?? null,
          openedAt: nowMs,
        },
      }),
    close: () => Promise.resolve(),
  };
}

/** A generic authenticated HTTP proxy, one URL per market, resolved from env. */
export function httpProxyProvider(options: ProviderOptions = {}): GeoNetworkProvider {
  const env = options.env ?? process.env;
  const probe = options.probe ?? tcpProbe;
  const probeTimeout = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const newId = options.newSessionId ?? defaultSessionId;
  const name = "http-proxy";

  const cooldownUntil = (nowMs: number): number | null => {
    if (!options.cooldownPath) return null;
    const cools = loadCooldowns(options.cooldownPath);
    return coolingDown(cools, name, nowMs) ? (cools[name] ?? null) : null;
  };

  /** Any configured market URL — health is about the vendor, not one market. */
  const anyConfiguredUrl = (): string | null => {
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith("GEOQA_PROXY_") && key !== "GEOQA_PROXY_TEMPLATE" && value) return value;
    }
    return env.GEOQA_PROXY_TEMPLATE ?? null;
  };

  return {
    name,
    async health(nowMs) {
      const configured = anyConfiguredUrl();
      if (!configured) {
        return {
          state: "unconfigured",
          detail: "no GEOQA_PROXY_* or GEOQA_PROXY_TEMPLATE in the environment",
          cooldownUntil: null,
        } satisfies ProviderHealth;
      }
      const until = cooldownUntil(nowMs);
      if (until !== null) {
        return {
          state: "unusable",
          detail: `cooling down until ${new Date(until).toISOString()}`,
          cooldownUntil: until,
        };
      }
      // A template has placeholders, not a real host, so it cannot be probed
      // as-is. Say so rather than reporting a reachability we did not test.
      const endpoint = configured.includes("{") ? null : parseProxyEndpoint(configured);
      if (!endpoint) {
        return {
          state: "unconfigured",
          detail: "proxy is a template or not a parseable URL — not probed",
          cooldownUntil: null,
        };
      }
      const reachable = await probe(endpoint.host, endpoint.port, probeTimeout);
      return reachable
        ? { state: "usable", detail: `${endpoint.host}:${endpoint.port} accepted a connection`, cooldownUntil: null }
        : { state: "unusable", detail: `${endpoint.host}:${endpoint.port} refused a connection`, cooldownUntil: null };
    },

    createSession(market, nowMs): Promise<SessionResult> {
      const url = resolveProxyUrl(market, env);
      if (!url) {
        return Promise.resolve({ ok: false, reason: `no proxy configured for market "${market.id}"` });
      }
      if (!parseProxyEndpoint(url)) {
        return Promise.resolve({
          ok: false,
          reason: `proxy for market "${market.id}" is not a parseable URL`,
        });
      }
      return Promise.resolve({
        ok: true,
        session: {
          id: newId(market, nowMs),
          marketId: market.id,
          providerName: name,
          proxyUrl: url,
          proxyBypass: options.proxyBypass ?? null,
          openedAt: nowMs,
        },
      });
    },

    close: () => Promise.resolve(),
  };
}

/**
 * Record what actually happened after a run verified (or failed to verify) its
 * egress.
 *
 * Rule 2 of the cooldown contract, made concrete: **a success clears.**
 * Omitting the clear is how agent-fleet froze every LLM agent for a day on a
 * subscription that had already recovered. Topping up a proxy account is the
 * whole recovery; the next successful run must be able to prove it.
 */
export function noteProviderOutcome(
  providerName: string,
  succeeded: boolean,
  nowMs: number,
  options: { cooldownPath?: string; cooldownMs?: number } = {},
): void {
  if (!options.cooldownPath) return;
  const until = succeeded ? null : nowMs + (options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  recordCooldown(options.cooldownPath, providerName, until, nowMs);
}

export type ProviderName = "direct" | "http-proxy";

/** Build the configured provider. Unknown names fall back to `direct` loudly. */
export function selectProvider(
  name: string,
  options: ProviderOptions = {},
): { provider: GeoNetworkProvider; warning: string | null } {
  if (name === "http-proxy") return { provider: httpProxyProvider(options), warning: null };
  if (name === "direct") return { provider: directProvider(options), warning: null };
  return {
    provider: directProvider(options),
    warning: `unknown network provider "${name}" — falling back to direct egress, which is NOT geographic`,
  };
}
