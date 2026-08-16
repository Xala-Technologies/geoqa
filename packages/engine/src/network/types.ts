/**
 * The network-egress seam.
 *
 * A provider's job is small and precise: given a market, hand back a proxy URL
 * the browser should launch with (or `null` for direct egress), and be honest
 * about whether it can currently do that at all.
 */
import type { Market } from "../geo/types.js";

export interface GeoNetworkSession {
  id: string;
  marketId: string;
  providerName: string;
  /** What to pass to agent-browser `--proxy`. `null` = direct egress. */
  proxyUrl: string | null;
  /** Hosts to bypass, e.g. a local fixture server. */
  proxyBypass: string | null;
  openedAt: number;
}

export type HealthState =
  /** Probed, and it answered. */
  | "usable"
  /** Configured, but the probe failed or the resource is cooling down. */
  | "unusable"
  /** No credentials/config at all — a fact about the setup, not a fault. */
  | "unconfigured";

export interface ProviderHealth {
  state: HealthState;
  detail: string;
  /** Epoch-ms until which this provider is cooling down, when it is. */
  cooldownUntil: number | null;
}

export interface ProviderFailure {
  ok: false;
  reason: string;
}

export type SessionResult = { ok: true; session: GeoNetworkSession } | ProviderFailure;

/**
 * The interface every egress mechanism implements — a residential proxy vendor,
 * a datacentre proxy, a cloud-browser region, or no proxy at all.
 *
 * `health()` is deliberately ASYNC and probe-based. The temptation is a
 * synchronous `available()` that checks whether the credentials env vars are
 * set — agent-fleet shipped exactly that for DataForSEO, and a zero-balance
 * account satisfied it happily for weeks. Empty results read as "we rank
 * nowhere"; here they would read as "the page is fine everywhere". A dead
 * vendor must be strictly worse than an absent one, and only a probe can tell
 * them apart.
 */
export interface GeoNetworkProvider {
  readonly name: string;
  health(nowMs: number): Promise<ProviderHealth>;
  createSession(market: Market, nowMs: number): Promise<SessionResult>;
  close(session: GeoNetworkSession): Promise<void>;
}

/**
 * What a proxy said when we tried to authenticate through it.
 *
 * Lives here rather than beside either implementation because both need it: the
 * socket probe produces it, `httpProxyProvider.health()` interprets it, and a
 * type in one of those files would make them import each other.
 */
export interface ProxyAuthResult {
  ok: boolean;
  status: number | null;
  /** The vendor's own explanation of a refusal, when it left one. */
  detail: string | null;
}

/**
 * Attempts a real CONNECT and reports the refusal. Injectable so tests never
 * dial a vendor.
 *
 * `health()` used to prove only that a gateway was listening, and reported
 * `usable` for a proxy whose credentials were dead and whose traffic was
 * exhausted. Vendors report both on the 407 — see `auth-probe.ts`.
 */
export type AuthProbe = (proxyUrl: string, timeoutMs: number) => Promise<ProxyAuthResult>;
