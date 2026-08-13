import { describe, expect, it } from "vitest";
import { checkQuota, estimateTrafficMb, MB_PER_GB, parseSubUsers, runsStartedToday, usageFor, type SubUserUsage, type TenantUsage } from "../quota.js";
import type { Tenant } from "../types.js";

const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  id: "acme",
  name: "Acme AS",
  markets: ["oslo"],
  targets: ["https://acme.example"],
  proxyCredentials: null,
  proxySubUser: null,
  quota: { trafficMb: 1000, runsPerDay: 10 },
  retentionDays: 30,
  ...over,
});

const usage = (over: Partial<TenantUsage> = {}): TenantUsage => ({
  trafficMb: 0,
  vendorLimitMb: null,
  runsToday: 0,
  unreadable: null,
  ...over,
});

describe("parseSubUsers", () => {
  /**
   * The real payload shape, captured live — with the username replaced.
   *
   * The FIELDS and their units are what this fixture is for; the account identifier is
   * not, and it identifies a billable account at a vendor. Same rule as
   * `tenant/types.ts` storing a variable name rather than a value: a test fixture is a
   * checked-in file like any other.
   */
  const live = [
    {
      username: "sub-account-1",
      traffic: 0.67,
      traffic_limit: null,
      traffic_count_from: "2026-08-12 23:21:56",
      status: "active",
      auto_disable: false,
      service_type: "residential_proxies",
    },
  ];

  it("converts the vendor's GIGABYTES into the megabytes a tenant declares", () => {
    // A unit mix-up in a quota check fails by a factor of 1024, in whichever
    // direction is worse.
    const [user] = parseSubUsers(live);
    expect(user?.trafficMb).toBeCloseTo(0.67 * MB_PER_GB, 5);
    expect(user?.username).toBe("sub-account-1");
    expect(user?.status).toBe("active");
  });

  it("keeps a null vendor limit as NULL — it was the live state and it matters", () => {
    // The only sub-user had no cap, so it could spend the whole account. Reading that
    // as "no limit needed" rather than "no limit set" is how vendor-side isolation
    // silently is not in force.
    expect(parseSubUsers(live)[0]?.trafficLimitMb).toBeNull();
  });

  it("converts a vendor limit when one IS set", () => {
    const capped = parseSubUsers([{ ...live[0], traffic_limit: 20 }]);
    expect(capped[0]?.trafficLimitMb).toBeCloseTo(20 * MB_PER_GB, 5);
  });

  it("SKIPS a record whose traffic is missing rather than reading it as zero", () => {
    // Skipping makes the tenant unreadable, which warns. Zero would authorise a sweep
    // against an account that may be exhausted.
    expect(parseSubUsers([{ username: "a" }])).toEqual([]);
    expect(parseSubUsers([{ username: "a", traffic: "0.5" }])).toEqual([]);
    expect(parseSubUsers([{ username: "a", traffic: Number.NaN }])).toEqual([]);
  });

  it("skips a record with no username, and survives a shape it did not expect", () => {
    expect(parseSubUsers([{ traffic: 1 }])).toEqual([]);
    expect(parseSubUsers([null, 42, "x"])).toEqual([]);
    expect(parseSubUsers({ not: "an array" })).toEqual([]);
    expect(parseSubUsers(null)).toEqual([]);
  });
});

describe("usageFor", () => {
  const users: SubUserUsage[] = [
    { username: "acme-sub", trafficMb: 400, trafficLimitMb: null, status: "active" },
    { username: "other-sub", trafficMb: 9000, trafficLimitMb: null, status: "active" },
  ];

  it("attributes only the tenant's own sub-account", () => {
    const result = usageFor(tenant(), users, "acme-sub", 3);
    expect(result.trafficMb).toBe(400);
    expect(result.runsToday).toBe(3);
    expect(result.unreadable).toBeNull();
  });

  it("is UNREADABLE, not unlimited, when the vendor could not be reached", () => {
    const result = usageFor(tenant(), null, "acme-sub", 0);
    expect(result.trafficMb).toBeNull();
    expect(result.unreadable).toContain("could not be read");
  });

  it("is UNREADABLE when the tenant names no sub-account, because the figure is everybody's", () => {
    // A tenant on the shared account cannot be attributed a share of it, and inventing
    // one would be a fabrication.
    const result = usageFor(tenant(), users, null, 0);
    expect(result.trafficMb).toBeNull();
    expect(result.unreadable).toContain("shares the default one");
  });

  it("is UNREADABLE when the named sub-account does not exist at the vendor", () => {
    // Either it was never provisioned or the name is wrong. Both are worse than an
    // unread figure, so neither may read as zero spent.
    const result = usageFor(tenant(), users, "typo-sub", 0);
    expect(result.trafficMb).toBeNull();
    expect(result.unreadable).toContain("does not list");
  });

  it("keeps the run count even when traffic is unreadable — that number is ours", () => {
    expect(usageFor(tenant(), null, "acme-sub", 7).runsToday).toBe(7);
  });
});

describe("estimateTrafficMb", () => {
  it("scales with page loads and never goes negative", () => {
    expect(estimateTrafficMb(430)).toBe(430);
    expect(estimateTrafficMb(0)).toBe(0);
    expect(estimateTrafficMb(-5)).toBe(0);
  });
});

describe("checkQuota", () => {
  it("allows a run that fits", () => {
    const decision = checkQuota(tenant(), usage({ trafficMb: 100 }), 50);
    expect(decision.state).toBe("within");
    expect(decision.errors).toEqual([]);
  });

  it("REFUSES a sweep that would not fit, before anything launches", () => {
    // The case that earns the file: 430 pages against a tenant with 100 MB left,
    // refused before the browser starts instead of dying at page 90 with a 407 and
    // leaving 340 pages unmeasured.
    const decision = checkQuota(tenant(), usage({ trafficMb: 900, vendorLimitMb: null }), estimateTrafficMb(430));
    expect(decision.state).toBe("refused");
    expect(decision.errors[0]).toContain("430 MB");
    expect(decision.errors[0]).toContain("100 MB left");
  });

  it("refuses when the budget is already spent, and says why the failure would be confusing", () => {
    const decision = checkQuota(tenant(), usage({ trafficMb: 1000 }), 1);
    expect(decision.state).toBe("refused");
    expect(decision.errors[0]).toContain("407");
  });

  it("refuses on the run-count ceiling independently of traffic", () => {
    const decision = checkQuota(tenant(), usage({ trafficMb: 0, runsToday: 10 }), 1);
    expect(decision.state).toBe("refused");
    expect(decision.errors[0]).toContain("ceiling");
  });

  it("takes the LOWER of the tenant budget and the vendor's own cap", () => {
    // A tenant budget above the vendor's limit is a budget that cannot be spent, and
    // pretending otherwise refuses late instead of early.
    const tight = checkQuota(tenant({ quota: { trafficMb: 5000, runsPerDay: 10 } }), usage({ trafficMb: 900, vendorLimitMb: 1000 }), 200);
    expect(tight.state).toBe("refused");
    expect(tight.errors[0]).toContain("1000 MB");
  });

  it("WARNS when the vendor enforces no cap, because then this check is the only guard", () => {
    // The live state when this was written. A cap geoqa enforces can be bypassed by a
    // bug in geoqa; one the vendor enforces cannot.
    const decision = checkQuota(tenant(), usage({ trafficMb: 10, vendorLimitMb: null }), 1);
    expect(decision.state).toBe("within");
    expect(decision.warnings[0]).toContain("ONLY thing standing between");
  });

  it("says nothing extra when the vendor DOES enforce a cap", () => {
    const decision = checkQuota(tenant(), usage({ trafficMb: 10, vendorLimitMb: 900 }), 1);
    expect(decision.warnings).toEqual([]);
  });

  it("proceeds on an unreadable figure but says the guard is not in force", () => {
    // Deliberate trade: with a vendor-enforced cap per sub-account, exhaustion is
    // isolated to the tenant that caused it, so blocking every tenant because a usage
    // API is down would cause more harm than it prevents.
    const decision = checkQuota(tenant(), usage({ trafficMb: null, unreadable: "API timed out" }), 500);
    expect(decision.state).toBe("unknown");
    expect(decision.errors).toEqual([]);
    expect(decision.warnings[0]).toContain("NOT being enforced");
    expect(decision.warnings[0]).toContain("API timed out");
  });

  it("STILL applies the run ceiling when traffic is unreadable, because that number is ours", () => {
    const decision = checkQuota(tenant(), usage({ trafficMb: null, unreadable: "down", runsToday: 10 }), 1);
    expect(decision.state).toBe("refused");
    expect(decision.errors[0]).toContain("ceiling");
  });

  it("records the estimate whatever the outcome, so a refusal is auditable", () => {
    expect(checkQuota(tenant(), usage({ trafficMb: 0 }), 42).estimateMb).toBe(42);
    expect(checkQuota(tenant(), usage({ trafficMb: null, unreadable: "x" }), 42).estimateMb).toBe(42);
  });
});

describe("runsStartedToday", () => {
  // 2026-08-13T12:00:00 local, and a run six hours earlier the same day.
  const noon = new Date(2026, 7, 13, 12, 0, 0).getTime();
  const sixAm = new Date(2026, 7, 13, 6, 0, 0).getTime();
  const yesterday = new Date(2026, 7, 12, 23, 0, 0).getTime();

  it("counts today's runs from the run id, needing no ledger", () => {
    // A counter file drifts: deleted, written twice, or left behind by a crash — and
    // every one of those makes the ceiling wrong in the direction that lets work
    // through. Counting the runs that exist is self-correcting.
    const ids = [`run_${sixAm}_oslo-desktop`, `run_${noon}_bergen-mobile`, `run_${yesterday}_oslo-desktop`];
    expect(runsStartedToday(ids, noon)).toBe(2);
  });

  it("ignores a directory that is not a run id", () => {
    expect(runsStartedToday(["visitors", "verify-sessions", "notes.txt", `run_${noon}_x`], noon)).toBe(1);
  });

  it("ignores a run stamped in the future rather than counting it", () => {
    // A clock skew that let future runs count would silently lower the ceiling.
    const tomorrow = new Date(2026, 7, 14, 1, 0, 0).getTime();
    expect(runsStartedToday([`run_${tomorrow}_x`], noon)).toBe(0);
  });

  it("counts from local midnight, which is the day an operator means", () => {
    const justAfterMidnight = new Date(2026, 7, 13, 0, 0, 1).getTime();
    const justBefore = new Date(2026, 7, 12, 23, 59, 59).getTime();
    expect(runsStartedToday([`run_${justAfterMidnight}_x`, `run_${justBefore}_x`], noon)).toBe(1);
  });
});
