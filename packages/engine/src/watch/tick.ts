/**
 * Whether a watch should start a sweep right now, and what that sweep is.
 *
 * Pure. The server holds the clock, the in-flight count and the last
 * timestamps; this file only answers the question. That is what makes the
 * scheduler testable without opening a browser, and what stops a "just start
 * it" shortcut from living in `start.ts` where coverage cannot see it.
 *
 * Two modes, one refusal in common: never start while a sweep is in flight.
 * Periodic measures from the last START (a wall-clock cadence). Continuous
 * measures from the last FINISH (as soon as the last one ended, plus a rest).
 * Collapsing those two clocks is how a 40-minute sweep on a 30-minute timer
 * piles a second matrix onto a machine that is still running the first.
 */
import type { Tenant } from "../tenant/types.js";
import type { WatchE2eJourney, WatchSpec } from "./spec.js";

export interface TickInput {
  spec: WatchSpec;
  nowMs: number;
  lastStartedMs: number | null;
  lastFinishedMs: number | null;
  lastE2eStartedMs: number | null;
  inFlight: number;
  /** Operator clicked Run now — skip the pause and the interval, not the safety checks. */
  force?: boolean;
}

export type TickDecision =
  | { action: "start"; reason: string; nextMs: number; pulse: boolean; e2e: boolean }
  | { action: "wait"; reason: string; nextMs: number | null };

const pulseReady = (spec: WatchSpec): boolean =>
  spec.targets.length > 0 && spec.markets.length > 0 && spec.journeys.length > 0;

const e2eReady = (spec: WatchSpec): boolean => spec.e2e.journeys.length > 0;

const pulseDueAt = (input: TickInput): number | null => {
  if (!pulseReady(input.spec)) return null;
  if (input.lastStartedMs === null) return input.nowMs;
  if (input.spec.mode === "periodic") return input.lastStartedMs + input.spec.everyMinutes * 60_000;
  const finished = input.lastFinishedMs ?? input.lastStartedMs;
  return finished + input.spec.restSeconds * 1_000;
};

const e2eDueAt = (input: TickInput): number | null => {
  if (!e2eReady(input.spec)) return null;
  if (input.lastE2eStartedMs === null) return input.nowMs;
  return input.lastE2eStartedMs + input.spec.e2e.everyMinutes * 60_000;
};

/** Each clock, so the console can show two next-due times instead of one. */
export function dueTimes(input: TickInput): { pulseMs: number | null; e2eMs: number | null } {
  return { pulseMs: pulseDueAt(input), e2eMs: e2eDueAt(input) };
}

export interface SweepAxes {
  markets: string[];
  devices: string[];
  journeys: string[];
  targets: string[];
}

export function decideTick(input: TickInput): TickDecision {
  const { spec, nowMs, inFlight } = input;
  if (inFlight > 0) return { action: "wait", reason: "a sweep is already in flight", nextMs: null };

  const canPulse = pulseReady(spec);
  const canE2e = e2eReady(spec);
  if (!canPulse && !canE2e) {
    if (spec.targets.length === 0) return { action: "wait", reason: "no targets to visit", nextMs: null };
    if (spec.markets.length === 0) return { action: "wait", reason: "no markets selected", nextMs: null };
    return { action: "wait", reason: "no journeys selected", nextMs: null };
  }

  if (input.force === true) {
    return { action: "start", reason: "started from the console", nextMs: nowMs, pulse: canPulse, e2e: canE2e };
  }
  if (!spec.enabled) return { action: "wait", reason: "watch is paused", nextMs: null };

  const pulseAt = pulseDueAt(input);
  const e2eAt = e2eDueAt(input);
  const pulse = pulseAt !== null && nowMs >= pulseAt;
  const e2e = e2eAt !== null && nowMs >= e2eAt;
  const upcoming = [pulseAt, e2eAt].filter((at): at is number => at !== null);
  const nextMs = upcoming.length === 0 ? nowMs : Math.min(...upcoming);

  if (!pulse && !e2e) {
    return {
      action: "wait",
      reason: spec.mode === "continuous" && canPulse ? "resting after the last sweep" : "interval has not elapsed",
      nextMs,
    };
  }

  const reason =
    pulse && input.lastStartedMs === null
      ? "first sweep"
      : e2e && !pulse && input.lastE2eStartedMs === null
        ? "first e2e"
        : e2e && !pulse
          ? "e2e interval elapsed"
          : spec.mode === "continuous" && pulse
            ? "previous sweep finished"
            : "interval elapsed";
  return { action: "start", reason, nextMs: nowMs, pulse, e2e };
}

/**
 * The axes a matrix will run, or a named refusal.
 *
 * Watch targets extend the tenant allowlist: an origin added in the console is
 * one the operator pointed at deliberately, which is the whole point of the
 * allowlist. A market the tenant never listed is still a bill, and a writes
 * journey without `allowWrites` is still a form submitted to production.
 */
export function planSweep(
  spec: WatchSpec,
  tenant: Tenant,
  availableJourneys: { id: string; writes: boolean }[],
): { ok: true; axes: SweepAxes } | { ok: false; error: string } {
  const unknownMarkets = spec.markets.filter((m) => !tenant.markets.includes(m));
  if (unknownMarkets.length > 0) {
    return { ok: false, error: `market(s) this tenant never asked about: ${unknownMarkets.join(", ")}` };
  }

  const byId = new Map(availableJourneys.map((j) => [j.id, j]));
  const journeys: string[] = [];
  for (const id of spec.journeys) {
    const found = byId.get(id);
    if (found === undefined) return { ok: false, error: `no such journey: ${id}` };
    if (found.writes && !spec.allowWrites) {
      return {
        ok: false,
        error: `journey "${id}" declares writes:true — turn on allowWrites, or pick a read-only journey`,
      };
    }
    journeys.push(id);
  }
  if (journeys.length === 0) return { ok: false, error: "no journeys left to run" };

  for (const [url, pool] of Object.entries(spec.targetJourneys)) {
    if (!spec.targets.includes(url)) {
      return { ok: false, error: `targetJourneys names a URL that is not a watch target: ${url}` };
    }
    for (const id of pool) {
      const found = byId.get(id);
      if (found === undefined) return { ok: false, error: `no such target journey: ${id}` };
      if (found.writes && !spec.allowWrites) {
        return {
          ok: false,
          error: `target journey "${id}" declares writes:true — turn on allowWrites, or keep the write on e2e`,
        };
      }
    }
  }

  return {
    ok: true,
    axes: {
      markets: spec.markets,
      devices: [...spec.devices],
      journeys,
      targets: spec.targets,
    },
  };
}

export interface E2eCell {
  market: string;
  device: WatchE2eJourney["device"];
  journey: string;
  target: string;
}

/**
 * E2E cells. Not in the cartesian product, and a writes e2e journey does
 * not require `allowWrites` on the pulse — that flag is what would let
 * someone tick `contact-form` onto every city.
 */
export function planE2e(
  spec: WatchSpec,
  tenant: Tenant,
  availableJourneys: { id: string; writes: boolean }[],
): { ok: true; cells: E2eCell[]; writes: boolean } | { ok: false; error: string } {
  const byId = new Map(availableJourneys.map((j) => [j.id, j]));
  const cells: E2eCell[] = [];
  let writes = false;
  for (const row of spec.e2e.journeys) {
    if (!tenant.markets.includes(row.market)) {
      return { ok: false, error: `e2e market this tenant never asked about: ${row.market}` };
    }
    const found = byId.get(row.journey);
    if (found === undefined) return { ok: false, error: `no such e2e journey: ${row.journey}` };
    if (found.writes) writes = true;
    cells.push({ market: row.market, device: row.device, journey: row.journey, target: row.url });
  }
  return { ok: true, cells, writes };
}
