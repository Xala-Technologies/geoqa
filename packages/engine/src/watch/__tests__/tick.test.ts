import { describe, expect, it } from "vitest";
import { decideTick, planExtras, planSweep, type TickInput } from "../tick.js";
import type { WatchSpec } from "../spec.js";
import type { Tenant } from "../../tenant/types.js";

const spec = (over: Partial<WatchSpec> = {}): WatchSpec => ({
  tenantId: "digilist",
  enabled: true,
  mode: "periodic",
  everyMinutes: 30,
  restSeconds: 15,
  markets: ["oslo"],
  devices: ["mobile"],
  journeys: ["landing-page"],
  targets: ["https://digilist.no"],
  maxConcurrent: 2,
  allowWrites: false,
  journeyPick: "all",
  extras: [],
  ...over,
});

const input = (over: Partial<TickInput> = {}): TickInput => ({
  spec: spec(),
  nowMs: 1_800_000,
  lastStartedMs: null,
  lastFinishedMs: null,
  inFlight: 0,
  ...over,
});

describe("decideTick", () => {
  it("waits when the watch is paused, and names that — not a missing target", () => {
    const out = decideTick(input({ spec: spec({ enabled: false }) }));
    expect(out.action).toBe("wait");
    expect(out.reason).toContain("paused");
    expect(out.nextMs).toBeNull();
  });

  it("waits when there is nothing to visit", () => {
    expect(decideTick(input({ spec: spec({ targets: [] }) })).reason).toContain("no targets");
    expect(decideTick(input({ spec: spec({ markets: [] }) })).reason).toContain("no markets");
    expect(decideTick(input({ spec: spec({ journeys: [] }) })).reason).toContain("no journeys");
  });

  it("never starts a second sweep while one is in flight", () => {
    const out = decideTick(input({ inFlight: 1, lastStartedMs: 0 }));
    expect(out.action).toBe("wait");
    expect(out.reason).toContain("in flight");
  });

  it("starts immediately when the operator forces a run, even if the watch is paused", () => {
    const out = decideTick(input({ spec: spec({ enabled: false }), force: true }));
    expect(out.action).toBe("start");
    expect(out.reason).toContain("console");
  });

  it("starts the first sweep the moment the watch is armed", () => {
    const out = decideTick(input());
    expect(out).toEqual({ action: "start", reason: "first sweep", nextMs: 1_800_000 });
  });

  it("starts a periodic sweep only after the interval since the last START", () => {
    const lastStartedMs = 1_800_000 - 30 * 60_000;
    expect(decideTick(input({ lastStartedMs, lastFinishedMs: lastStartedMs + 1 })).action).toBe("start");
    const early = decideTick(input({ lastStartedMs: 1_800_000 - 29 * 60_000, lastFinishedMs: 0 }));
    expect(early.action).toBe("wait");
    expect(early.nextMs).toBe(1_800_000 - 29 * 60_000 + 30 * 60_000);
  });

  it("starts a continuous sweep after the rest since the last FINISH, not the last start", () => {
    // A 40-minute sweep on a 30-minute periodic clock would pile up. Continuous
    // means "when the last one ended", so the rest is measured from finish.
    const continuous = spec({ mode: "continuous", restSeconds: 15 });
    const ready = decideTick(
      input({ spec: continuous, lastStartedMs: 0, lastFinishedMs: 1_800_000 - 15_000 }),
    );
    expect(ready.action).toBe("start");
    const unfinished = decideTick(input({ spec: continuous, lastStartedMs: 0, lastFinishedMs: null }));
    expect(unfinished.action).toBe("start");
    const resting = decideTick(
      input({ spec: continuous, lastStartedMs: 0, lastFinishedMs: 1_800_000 - 5_000 }),
    );
    expect(resting.action).toBe("wait");
    expect(resting.nextMs).toBe(1_800_000 - 5_000 + 15_000);
  });
});

describe("planSweep", () => {
  const tenant: Tenant = {
    id: "digilist",
    name: "Digilist AS",
    markets: ["oslo", "bergen"],
    targets: ["https://digilist.no"],
    proxyCredentials: null,
    proxySubUser: null,
    quota: { trafficMb: 100, runsPerDay: 10 },
    retentionDays: 30,
  };

  it("expands the axes the matrix will run, including watch-only targets the tenant file does not list", () => {
    const out = planSweep(
      spec({ targets: ["https://digilist.no", "https://app.digilist.no"], markets: ["oslo"] }),
      tenant,
      [{ id: "landing-page", writes: false }],
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.axes.targets).toEqual(["https://digilist.no", "https://app.digilist.no"]);
    expect(out.axes.markets).toEqual(["oslo"]);
  });

  it("DROPS a writes journey unless the watch explicitly allows writes", () => {
    const blocked = planSweep(spec({ journeys: ["contact-form"] }), tenant, [{ id: "contact-form", writes: true }]);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected refusal");
    expect(blocked.error).toContain("writes");

    const allowed = planSweep(spec({ journeys: ["contact-form"], allowWrites: true }), tenant, [
      { id: "contact-form", writes: true },
    ]);
    if (!allowed.ok) throw new Error(allowed.error);
    expect(allowed.axes.journeys).toEqual(["contact-form"]);
  });

  it("refuses a market the tenant never asked about — a typo is a bill", () => {
    const out = planSweep(spec({ markets: ["berlin"] }), tenant, [{ id: "landing-page", writes: false }]);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    expect(out.error).toContain("berlin");
  });

  it("refuses a watch that named no journeys, rather than expanding an empty matrix", () => {
    const out = planSweep(spec({ journeys: [] }), tenant, [{ id: "landing-page", writes: false }]);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    expect(out.error).toContain("no journeys");
  });

  it("refuses a journey that is not on disk", () => {
    const out = planSweep(spec({ journeys: ["no-such-journey"] }), tenant, [{ id: "landing-page", writes: false }]);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    expect(out.error).toContain("no-such-journey");
  });
});

describe("planExtras", () => {
  const tenant: Tenant = {
    id: "digilist",
    name: "Digilist AS",
    markets: ["oslo", "bergen"],
    targets: ["https://digilist.no"],
    proxyCredentials: null,
    proxySubUser: null,
    quota: { trafficMb: 100, runsPerDay: 10 },
    retentionDays: 30,
  };

  it("returns sidecar cells and may write without flipping allowWrites on the pulse", () => {
    const out = planExtras(
      spec({
        extras: [{ market: "oslo", device: "desktop", journey: "login", url: "https://dashboard.digilist.no/login" }],
      }),
      tenant,
      [
        { id: "landing-page", writes: false },
        { id: "login", writes: true },
      ],
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.writes).toBe(true);
    expect(out.cells).toEqual([
      { market: "oslo", device: "desktop", journey: "login", target: "https://dashboard.digilist.no/login" },
    ]);
  });

  it("refuses an extra market or journey the tenant cannot serve", () => {
    const missingMarket = planExtras(
      spec({ extras: [{ market: "berlin", device: "desktop", journey: "login", url: "https://dashboard.digilist.no/login" }] }),
      tenant,
      [{ id: "login", writes: true }],
    );
    expect(missingMarket.ok).toBe(false);
    const missingJourney = planExtras(
      spec({ extras: [{ market: "oslo", device: "desktop", journey: "login", url: "https://dashboard.digilist.no/login" }] }),
      tenant,
      [{ id: "landing-page", writes: false }],
    );
    expect(missingJourney.ok).toBe(false);
  });
});
