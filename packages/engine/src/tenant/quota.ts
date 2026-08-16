/**
 * Per-tenant proxy metering: refuse a run that would exceed a budget, rather
 * than discovering it as an opaque 407 halfway through a sweep.
 *
 * This exists because of a measured incident, not a billing requirement. One
 * 430-page sweep consumed an entire proxy allowance, and every run afterwards — of
 * every profile, in every market — returned a bare `407 Proxy Authentication
 * Required`. Nothing in that error says "the account is out of traffic"; it reads
 * exactly like a wrong password, and it cost an hour of looking in the wrong place.
 *
 * Two numbers, two sources, and they are not interchangeable:
 *
 * - **Traffic** comes from the VENDOR. It is the only authoritative figure — bytes
 *   are counted at the proxy, not here, and an estimate that drifted would be worse
 *   than no estimate because it would be trusted.
 * - **Run count** comes from US, by counting run directories. The vendor has no idea
 *   what a "run" is. Derived rather than kept in a ledger on purpose: a counter file
 *   can drift, be deleted, or be written twice, whereas counting the runs that
 *   actually exist is self-correcting and needs no new state to keep honest.
 *
 * The third state is the one that matters. A traffic figure that could not be READ
 * is `null`, never `0`. `network/types.ts` records why in the sibling case: a
 * credentials-present check let a zero-balance DataForSEO account pass for weeks. An
 * unreadable usage figure treated as "nothing spent" authorises exactly the
 * unbounded sweep this file exists to prevent.
 */
import type { Tenant } from "./types.js";

/**
 * Megabytes per page load, and it is a MEASURED figure rather than a guess.
 *
 * A 430-page sweep of digilist.no cost roughly 0.5 GB through the residential
 * proxy, which is ~1.2 MB per page including images, fonts and third-party
 * requests. Rounded to 1 MB deliberately: an estimate used to REFUSE work should
 * under-state rather than over-state, or it starts blocking runs that would have
 * fitted. It is an estimate and is named as one everywhere it surfaces.
 */
export const MB_PER_PAGE_LOAD = 1;

/** The vendor reports gigabytes; a tenant declares megabytes. Converted once, here. */
export const MB_PER_GB = 1024;

/** One sub-account at the vendor, as this module needs it. */
export interface SubUserUsage {
  username: string;
  /** Traffic consumed this billing period, in MB. */
  trafficMb: number;
  /**
   * The vendor's OWN cap for this sub-account, in MB, or null when none is set.
   *
   * Null is the important case and it was the live state when this was written: the
   * only sub-user had no limit, so it could spend the whole account. Vendor-side
   * isolation is the strong half of per-tenant metering — a cap the vendor enforces
   * cannot be bypassed by a bug in this file — and when it is absent, geoqa's own
   * check is the ONLY guard. That is worth saying out loud rather than assuming.
   */
  trafficLimitMb: number | null;
  status: string;
}

/**
 * Parse `/v2/sub-users`. Captured live:
 * `[{"username":"…","traffic":0.67,"traffic_limit":null,
 *    "traffic_count_from":"2026-08-12 23:21:56","status":"active",
 *    "auto_disable":false,"service_type":"residential_proxies"}]`
 *
 * `traffic` and `traffic_limit` are GIGABYTES, converted here so no caller has to
 * remember. A unit mix-up in a quota check fails by a factor of 1024 in whichever
 * direction is worse.
 */
export function parseSubUsers(raw: unknown): SubUserUsage[] {
  if (!Array.isArray(raw)) return [];
  const users: SubUserUsage[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const username = typeof record.username === "string" ? record.username : null;
    if (username === null) continue;
    // A missing or non-numeric `traffic` is NOT zero. Skipping the record makes the
    // tenant's usage unreadable, which refuses; reading it as 0 would authorise a
    // sweep against an account that may be exhausted.
    if (typeof record.traffic !== "number" || !Number.isFinite(record.traffic)) continue;
    const limit = typeof record.traffic_limit === "number" && Number.isFinite(record.traffic_limit) ? record.traffic_limit * MB_PER_GB : null;
    users.push({
      username,
      trafficMb: record.traffic * MB_PER_GB,
      trafficLimitMb: limit,
      status: typeof record.status === "string" ? record.status : "unknown",
    });
  }
  return users;
}

export interface TenantUsage {
  /** MB consumed this period, or null when the vendor could not be read. */
  trafficMb: number | null;
  /** The vendor's own cap for this tenant's sub-account, in MB, or null if unset. */
  vendorLimitMb: number | null;
  /** Runs started today, counted from the evidence tree. Never null — we own it. */
  runsToday: number;
  /** Why traffic is null, when it is. Empty otherwise. */
  unreadable: string | null;
}

/**
 * This tenant's usage, from the vendor's sub-account list plus our own run count.
 *
 * A tenant with no `proxySubUser` is unmeasurable rather than unlimited: it shares
 * the default account, so the figure that comes back describes everybody's traffic
 * and attributing it to one tenant would be a fabrication.
 */
export function usageFor(
  tenant: Tenant,
  subUsers: SubUserUsage[] | null,
  subUserName: string | null,
  runsToday: number,
): TenantUsage {
  const none = (why: string): TenantUsage => ({ trafficMb: null, vendorLimitMb: null, runsToday, unreadable: why });
  if (subUsers === null) return none(`the vendor's usage API could not be read, so tenant "${tenant.id}" has no traffic figure`);
  if (subUserName === null) {
    return none(
      `tenant "${tenant.id}" names no proxy sub-account, so it shares the default one — the vendor's traffic figure describes every tenant on that account and cannot be attributed to this one`,
    );
  }
  const found = subUsers.find((u) => u.username === subUserName);
  if (!found) {
    return none(
      `tenant "${tenant.id}" names sub-account "${subUserName}", which the vendor does not list — either it was never provisioned or the name is wrong, and both are worse than an unread figure`,
    );
  }
  return { trafficMb: found.trafficMb, vendorLimitMb: found.trafficLimitMb, runsToday, unreadable: null };
}

/** What a planned run is expected to cost. `pageLoads` is scenarios × pages. */
export function estimateTrafficMb(pageLoads: number): number {
  return Math.max(0, pageLoads) * MB_PER_PAGE_LOAD;
}

export interface QuotaDecision {
  /** `refused` stops the run. `unknown` proceeds and says why it could not check. */
  state: "within" | "refused" | "unknown";
  /** Why it was refused. Empty unless `refused`. */
  errors: string[];
  /** Said out loud on every state that is not a clean pass. */
  warnings: string[];
  /** What this run was expected to cost, for the record. */
  estimateMb: number;
}

/**
 * Decide whether a planned run may proceed.
 *
 * Refuses on three grounds, and each is a number somebody can act on:
 *
 * 1. The run count for today is already at the ceiling.
 * 2. Traffic already spent exceeds the budget.
 * 3. Traffic spent PLUS this run's estimate would exceed it. This is the one that
 *    earns the file: a 430-page sweep against a tenant with 100 MB left is refused
 *    before the browser starts, instead of dying at page 90 with a 407 and leaving
 *    340 pages unmeasured and an operator debugging a proxy that is fine.
 *
 * An unreadable traffic figure does NOT refuse, and that is a deliberate trade.
 * With a vendor-enforced cap per sub-account, exhaustion is isolated to the tenant
 * that caused it — so blocking every tenant's work because a usage API is down would
 * cause more harm than it prevents. It warns instead, loudly, and the warning says
 * that the guard is not in force. The run-count ceiling still applies, because that
 * number is ours and is always readable.
 *
 * When the vendor has its own cap, the EFFECTIVE ceiling is the lower of the two: a
 * tenant budget above the vendor's limit is a budget that cannot be spent, and
 * pretending otherwise would refuse late instead of early.
 */
export function checkQuota(tenant: Tenant, usage: TenantUsage, estimateMb: number): QuotaDecision {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (usage.runsToday >= tenant.quota.runsPerDay) {
    errors.push(
      `tenant "${tenant.id}" has already started ${usage.runsToday} run(s) today and its ceiling is ${tenant.quota.runsPerDay} — refusing rather than exceeding it`,
    );
  }

  if (usage.trafficMb === null) {
    warnings.push(
      `proxy traffic could not be measured for tenant "${tenant.id}": ${usage.unreadable}. The traffic budget is NOT being enforced for this run — only the vendor's own cap stands between it and the account's allowance.`,
    );
    return { state: errors.length > 0 ? "refused" : "unknown", errors, warnings, estimateMb };
  }

  const ceiling = usage.vendorLimitMb === null ? tenant.quota.trafficMb : Math.min(tenant.quota.trafficMb, usage.vendorLimitMb);
  if (usage.vendorLimitMb === null) {
    warnings.push(
      `the vendor enforces no traffic cap on tenant "${tenant.id}"'s sub-account, so this check is the ONLY thing standing between it and the whole account allowance. Set a per-sub-account limit at the vendor as well: a cap geoqa enforces can be bypassed by a bug in geoqa.`,
    );
  }

  const remaining = ceiling - usage.trafficMb;
  if (remaining <= 0) {
    errors.push(
      `tenant "${tenant.id}" has spent ${Math.round(usage.trafficMb)} MB of its ${Math.round(ceiling)} MB budget — refusing. A run started now would fail partway through with a 407 that looks like a broken proxy.`,
    );
  } else if (estimateMb > remaining) {
    errors.push(
      `this run is estimated at ${Math.round(estimateMb)} MB and tenant "${tenant.id}" has ${Math.round(remaining)} MB left of ${Math.round(ceiling)} MB — refusing before anything launches. The estimate is ${MB_PER_PAGE_LOAD} MB per page load, measured; use --dry-run to see the page count.`,
    );
  }

  return { state: errors.length > 0 ? "refused" : "within", errors, warnings, estimateMb };
}

/**
 * How many runs a tenant started today, counted from its evidence directories.
 *
 * A run id is `run_<epochMs>_<slug>`, so the timestamp is in the name and no ledger
 * is needed. Derived rather than stored because a counter file drifts: it can be
 * deleted, written twice, or left behind by a crash, and every one of those makes the
 * ceiling wrong in the direction that lets work through.
 *
 * The honest caveat: `evidence prune` removes run directories, so a pruned day
 * undercounts. That is the right direction to be wrong in for a rate ceiling —
 * pruning is a deliberate act and the alternative is a stored counter that can be
 * wrong in both directions for no reason at all.
 */
export function runsStartedToday(runIds: string[], nowMs: number): number {
  const startOfDay = new Date(nowMs);
  startOfDay.setHours(0, 0, 0, 0);
  const from = startOfDay.getTime();
  return runIds.filter((id) => {
    const match = /^run_(\d+)_/.exec(id);
    if (!match) return false;
    const started = Number(match[1]);
    return started >= from && started <= nowMs;
  }).length;
}
