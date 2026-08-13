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
import { authProbe } from "./auth-probe.js";
import type { AuthProbe, GeoNetworkProvider, GeoNetworkSession, ProviderHealth, ProxyAuthResult, SessionResult } from "./types.js";
export type { AuthProbe, ProxyAuthResult };
export { authProbe };

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
 * Substitute the market and session placeholders into a proxy URL.
 *
 * `{session}` exists because residential vendors have no API for stickiness —
 * they encode the sticky session in the proxy USERNAME, e.g.
 * `http://user-cc-de-sessid-abc123-sesstime-15:pw@gw.vendor.net:7777`. Without a
 * placeholder for it, every connection the browser opens can be handed a
 * different exit IP, which breaks invariant 16 (ONE JOURNEY = ONE NETWORK
 * SESSION) and makes EXP-002 meaningless: the experiment would be measuring the
 * vendor's rotation policy rather than our ability to hold a session.
 *
 * An unknown placeholder is left verbatim rather than blanked. A vendor's own
 * syntax may legitimately contain braces, and silently emptying part of a
 * username produces a URL that authenticates as somebody else instead of
 * failing. Anything we do mangle is caught downstream, because `createSession`
 * validates the SUBSTITUTED url — so a session id that cannot live inside a URL
 * refuses the run rather than quietly egressing from the wrong place.
 */
function substituteProxyPlaceholders(url: string, market: Market, sessionId: string): string {
  return url
    .replaceAll("{market}", market.id)
    .replaceAll("{country}", market.country.toUpperCase())
    .replaceAll("{countryLower}", market.country.toLowerCase())
    .replaceAll("{city}", market.city)
    .replaceAll("{cityLower}", market.city.toLowerCase())
    .replaceAll("{session}", sessionId);
}

/**
 * Resolve a market's proxy URL from the environment, most specific first:
 *   1. `GEOQA_PROXY_<MARKET_ID>`   e.g. GEOQA_PROXY_OSLO
 *   2. `GEOQA_PROXY_<COUNTRY>`     e.g. GEOQA_PROXY_NO
 *   3. `GEOQA_PROXY_TEMPLATE`      the shape most residential vendors use, where
 *                                  the target country is encoded in the username.
 *
 * Substitution then applies UNIFORMLY to whichever source won. It used to run on
 * the template only, which quietly made `{session}` — and geo targeting — a
 * privilege of the least specific variable: pinning one market to its own vendor
 * URL was exactly the case where you most wanted a sticky session key, and that
 * URL was the one form returned verbatim.
 */
/**
 * Every exit configured for a market, in declaration order.
 *
 * A market may name SEVERAL exits, comma-separated, and one is picked per
 * session:
 *
 *   GEOQA_PROXY_DE="http://u:p@gw:8881,http://u:p@gw:8882,http://u:p@gw:8883"
 *
 * Why a pool at all, given that one journey must hold ONE identity: rotation
 * belongs BETWEEN runs, never inside one. A single fixed exit makes every result
 * for that market inherit whatever is peculiar about that one address — an odd
 * CDN edge, a badly classified range, a rate limit it has personally earned —
 * and nothing in the data reveals that the market's verdict is really one IP's
 * verdict. Rotating between runs samples the market instead of sampling one
 * address, while `verifyEgressHeld` still holds each individual run to one exit.
 *
 * Blank entries are dropped rather than treated as "direct": a trailing comma in
 * an env var must not silently produce an unrouted run wearing a proxy's name.
 */
export function resolveProxyPool(market: Market, env: NodeJS.ProcessEnv, sessionId: string): string[] {
  const byMarket = env[`GEOQA_PROXY_${market.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  const byCountry = env[`GEOQA_PROXY_${market.country.toUpperCase()}`];
  const configured = byMarket || byCountry || env.GEOQA_PROXY_TEMPLATE;
  if (!configured) return [];
  return configured
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => substituteProxyPlaceholders(entry, market, sessionId));
}

/**
 * Which exit this session gets, chosen from the pool by hashing the session id.
 *
 * Hashed rather than random, and rather than a counter, for the same reason the
 * journey's pacing is seeded: a run has to be replayable. Given the same session
 * id the same exit is chosen, so re-running a finding reaches the same address —
 * and a counter would make the choice depend on how many sessions this process
 * happened to open first, which is not a property of the run.
 */
export function selectFromPool(pool: string[], sessionId: string): string | null {
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0] ?? null;
  let hash = 2_166_136_261;
  for (let index = 0; index < sessionId.length; index++) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return pool[(hash >>> 0) % pool.length] ?? null;
}

export function resolveProxyUrl(market: Market, env: NodeJS.ProcessEnv, sessionId: string): string | null {
  return selectFromPool(resolveProxyPool(market, env, sessionId), sessionId);
}

export interface ProviderOptions {
  env?: NodeJS.ProcessEnv;
  /** Cooldown store path. Omit to disable persistence entirely. */
  cooldownPath?: string;
  cooldownMs?: number;
  probe?: TcpProbe;
  /**
   * Attempts a real CONNECT and reports the vendor's refusal. Omitted means
   * reachability only — a caller that has not opted in keeps the old behaviour
   * rather than silently gaining a network call.
   */
  auth?: AuthProbe;
  probeTimeoutMs?: number;
  /** Hosts the proxy should not be used for (a local fixture server). */
  proxyBypass?: string;
  /** Injectable id generator so sessions are deterministic in tests. */
  newSessionId?: (market: Market, nowMs: number) => string;
}

/**
 * A monotonic counter, so two sessions minted in the same millisecond cannot collide.
 *
 * Deliberately a counter and not randomness: it is deterministic within a process, needs
 * no seeding, and keeps a session id readable in a log. Tests inject `newSessionId`
 * anyway, so this never makes a test unpredictable.
 */
let sessionSequence = 0;

/**
 * `<market>-<epochMs>-<n>`, and the `<n>` is load-bearing.
 *
 * Without it the id was `<market>-<epochMs>`, so **two concurrent runs in the same market
 * started in the same millisecond got the same id** — and the id is what the `{session}`
 * placeholder puts in a residential vendor's username to pin a sticky exit. Two journeys
 * would therefore share one egress IP while each reported `egressHeld: match`, because
 * holding an IP you share with somebody else still looks like holding it.
 *
 * That is invariant 16 — ONE JOURNEY = ONE NETWORK SESSION — failing silently, and nothing
 * in the run would contradict it. Found while running EXP-007 through Decodo at
 * concurrency 3: two Oslo profiles came back on 193.69.169.75 and the third market on a
 * different IP, which is the signature of a shared sticky key rather than of a vendor
 * choosing to reuse an exit.
 */
const defaultSessionId = (market: Market, nowMs: number): string => `${market.id}-${nowMs}-${++sessionSequence}`;

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
  const tryAuth = options.auth ?? ((): Promise<null> => Promise.resolve(null));
  const probeTimeout = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const newId = options.newSessionId ?? defaultSessionId;
  const name = "http-proxy";

  const cooldownUntil = (nowMs: number): number | null => {
    if (!options.cooldownPath) return null;
    const cools = loadCooldowns(options.cooldownPath);
    return coolingDown(cools, name, nowMs) ? (cools[name] ?? null) : null;
  };

  /**
   * Any configured exit — health is about the vendor, not one market.
   *
   * The FIRST member of a pool, not the raw env value. A market may list several
   * comma-separated exits, and probing the whole string treats
   * `http://a:1,http://b:2` as one hostname, which `parseProxyEndpoint` rightly
   * refuses — so a perfectly good pool reported the vendor as "not configured"
   * and refused to run. Found by pointing the provider at two local proxies.
   *
   * One member is the right granularity: `health()` answers "is the vendor
   * reachable at all", and per-exit health belongs to the run that used it, which
   * is what `noteProviderOutcome` records after verifying egress.
   */
  const anyConfiguredUrl = (): string | null => {
    const firstOf = (value: string): string | null =>
      value.split(",").map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? null;
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith("GEOQA_PROXY_") && key !== "GEOQA_PROXY_TEMPLATE" && value) return firstOf(value);
    }
    return env.GEOQA_PROXY_TEMPLATE ? firstOf(env.GEOQA_PROXY_TEMPLATE) : null;
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
      /**
       * Probe the gateway, substituting placeholders first.
       *
       * This used to refuse any URL containing a placeholder and report
       * `unconfigured`, on the reasoning that a template has no real host. That
       * was wrong in the way that matters: a residential vendor's placeholders
       * live in the USERNAME (`user-x-country-{countryLower}-session-{session}`)
       * while the host and port are literal (`gate.decodo.com:7000`), so the one
       * thing a reachability probe cares about was always there. And because
       * `prepareRun` treats `unconfigured` as a hard refusal for any non-direct
       * provider, a template — the normal way to configure a vendor — could never
       * start a run at all.
       *
       * The placeholders are replaced with an inert token purely so the string
       * parses; nothing authenticates here. Credit and credentials are still not
       * proven by a TCP connect, which is what `noteProviderOutcome` is for.
       */
      const probeable = configured.replace(/\{[A-Za-z]+\}/g, "probe");
      const endpoint = parseProxyEndpoint(probeable);
      if (!endpoint) {
        return {
          state: "unconfigured",
          detail: `proxy is not a parseable URL: ${redactProxyUrl(probeable)}`,
          cooldownUntil: null,
        };
      }
      const reachable = await probe(endpoint.host, endpoint.port, probeTimeout);
      if (!reachable) {
        return { state: "unusable", detail: `${endpoint.host}:${endpoint.port} refused a connection`, cooldownUntil: null };
      }
      // Reachable is not usable. A gateway that is listening but rejecting our
      // credentials, or out of traffic, would otherwise report `usable` and let a
      // run start that cannot possibly egress.
      const auth = await tryAuth(probeable, probeTimeout);
      if (auth === null || auth.ok) {
        return { state: "usable", detail: `${endpoint.host}:${endpoint.port} accepted a connection`, cooldownUntil: null };
      }
      return {
        state: "unusable",
        detail: `${endpoint.host}:${endpoint.port} refused authentication${auth.status ? ` (${auth.status})` : ""}${
          auth.detail ? `: ${auth.detail}` : ""
        }`,
        cooldownUntil: null,
      };
    },

    createSession(market, nowMs): Promise<SessionResult> {
      // Mint the id BEFORE resolving the URL, because the URL may embed it via
      // {session}. Doing it the other way round would put one session key in the
      // proxy username and a different one on the session we report — the run
      // would claim a stickiness it never asked the vendor for, and the closing
      // egress re-read (invariant 16) would be diagnosing the wrong thing.
      const id = newId(market, nowMs);
      const url = resolveProxyUrl(market, env, id);
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
          id,
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
