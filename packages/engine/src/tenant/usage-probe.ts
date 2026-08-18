/**
 * A real HTTP read of the vendor's sub-account usage.
 *
 * Split out and coverage-excluded for the same reason `network/auth-probe.ts` and
 * `browser/playwright-launch.ts` are: it is one request and a JSON hand-off with no
 * judgement in it. Every judgement — what a figure means for a run, and what an
 * UNREAD figure means — lives in `quota.ts`, fully covered against injected data.
 *
 * The endpoint and its shape were captured live rather than taken from docs:
 *
 *   GET https://api.decodo.com/v2/sub-users
 *   Authorization: <api key>
 *   [{"username":"…","traffic":0.67,"traffic_limit":null,
 *     "traffic_count_from":"2026-08-12 23:21:56","status":"active",
 *     "auto_disable":false,"service_type":"residential_proxies"}]
 *
 * `traffic` is gigabytes. `parseSubUsers` converts; nothing here interprets.
 *
 * Every failure returns `null`, never an empty list. An empty list is a real answer
 * — "this account has no sub-accounts" — and `usageFor` reads it as "the named
 * sub-account does not exist", which refuses. A timeout must not be able to
 * masquerade as that, because the two lead to opposite actions: provision the
 * sub-account, versus wait and retry.
 */
import type { SubUserUsage } from "./quota.js";
import { parseSubUsers } from "./quota.js";
import { decodoHeaders } from "./decodo-headers.js";

export const DECODO_SUB_USERS_URL = "https://api.decodo.com/v2/sub-users";

/** Injectable in `quota.ts`'s callers so the unit suite opens no socket. */
export type UsageProbe = (apiKey: string) => Promise<SubUserUsage[] | null>;

export const decodoUsageProbe: UsageProbe = async (apiKey) => {
  try {
    const response = await fetch(DECODO_SUB_USERS_URL, {
      headers: decodoHeaders(apiKey),
      // A usage check must never be the thing that hangs a run. Ten seconds is
      // generous for one JSON read, and a timeout reads as "unmeasured" rather
      // than as zero spent.
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return parseSubUsers(await response.json());
  } catch {
    return null;
  }
};
