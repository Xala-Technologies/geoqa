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
import type { WatchSpec } from "./spec.js";

export interface TickInput {
  spec: WatchSpec;
  nowMs: number;
  lastStartedMs: number | null;
  lastFinishedMs: number | null;
  inFlight: number;
  /** Operator clicked Run now — skip the pause and the interval, not the safety checks. */
  force?: boolean;
}

export type TickDecision =
  | { action: "start"; reason: string; nextMs: number }
  | { action: "wait"; reason: string; nextMs: number | null };

export interface SweepAxes {
  markets: string[];
  devices: string[];
  journeys: string[];
  targets: string[];
}

export function decideTick(input: TickInput): TickDecision {
  const { spec, nowMs, lastStartedMs, lastFinishedMs, inFlight } = input;
  if (spec.targets.length === 0) return { action: "wait", reason: "no targets to visit", nextMs: null };
  if (spec.markets.length === 0) return { action: "wait", reason: "no markets selected", nextMs: null };
  if (spec.journeys.length === 0) return { action: "wait", reason: "no journeys selected", nextMs: null };
  if (inFlight > 0) return { action: "wait", reason: "a sweep is already in flight", nextMs: null };
  if (input.force === true) return { action: "start", reason: "started from the console", nextMs: nowMs };
  if (!spec.enabled) return { action: "wait", reason: "watch is paused", nextMs: null };

  if (lastStartedMs === null) return { action: "start", reason: "first sweep", nextMs: nowMs };

  if (spec.mode === "periodic") {
    const due = lastStartedMs + spec.everyMinutes * 60_000;
    if (nowMs >= due) return { action: "start", reason: "interval elapsed", nextMs: nowMs };
    return { action: "wait", reason: "interval has not elapsed", nextMs: due };
  }

  const finished = lastFinishedMs ?? lastStartedMs;
  const due = finished + spec.restSeconds * 1_000;
  if (nowMs >= due) return { action: "start", reason: "previous sweep finished", nextMs: nowMs };
  return { action: "wait", reason: "resting after the last sweep", nextMs: due };
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
