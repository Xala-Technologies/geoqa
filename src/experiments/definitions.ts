/**
 * The Phase 0 experiments.
 *
 * Thresholds here are OUR acceptance targets, not vendor guarantees. Where a
 * target cannot be evaluated with the infrastructure that exists today it is
 * still declared — declaring it and reporting `unmeasured` is what turns "we
 * have no proxy vendor" from an unstated assumption into a recorded fact with
 * a number attached.
 */
import type { ExperimentSpec } from "./harness.js";

export const EXP_000: ExperimentSpec = {
  id: "EXP-000-agent-browser",
  hypothesis:
    "agent-browser 0.34.0 provides every primitive the engine needs: JSON output, isolated sessions, launch-flag identity, screenshots, console, network, vitals, a11y.",
  metrics: [
    { key: "primitive-success", description: "Share of required primitives that answered", target: 100, unit: "percent", direction: "min" },
    { key: "browser-launch", description: "Share of sessions that launched a browser", target: 98, unit: "percent", direction: "min" },
  ],
};

export const EXP_001: ExperimentSpec = {
  id: "EXP-001-geo-ip",
  hypothesis: "A requested market yields an egress IP in that market's country and city.",
  metrics: [
    { key: "connection-success", description: "Sessions that produced any egress reading", target: 97, unit: "percent", direction: "min" },
    { key: "country-match", description: "Sessions whose egress country matched the request", target: 98, unit: "percent", direction: "min" },
    { key: "city-match", description: "Sessions whose egress city matched the request", target: 90, unit: "percent", direction: "min" },
    { key: "latency", description: "Mean time to first byte from the identity endpoint", target: 3000, unit: "ms", direction: "max" },
  ],
};

export const EXP_002: ExperimentSpec = {
  id: "EXP-002-sticky-session",
  hypothesis: "A single journey keeps one coherent network identity for its whole duration.",
  metrics: [
    { key: "ip-stability", description: "Samples whose IP matched the session's first reading", target: 95, unit: "percent", direction: "min" },
  ],
};

export const EXP_003: ExperimentSpec = {
  id: "EXP-003-session-isolation",
  hypothesis: "Concurrent sessions for different markets share no cookies, storage or history.",
  metrics: [
    { key: "cookie-isolation", description: "Session pairs with no cookie bleed", target: 100, unit: "percent", direction: "min" },
    { key: "storage-isolation", description: "Session pairs with no localStorage bleed", target: 100, unit: "percent", direction: "min" },
  ],
};

export const EXP_004: ExperimentSpec = {
  id: "EXP-004-profile-consistency",
  hypothesis: "A geo profile produces an internally consistent browser environment: locale, clock and viewport all agree with the market.",
  metrics: [
    { key: "language-consistency", description: "Sessions where navigator.language matched the profile", target: 100, unit: "percent", direction: "min" },
    { key: "timezone-consistency", description: "Sessions where the Intl timezone matched the profile", target: 100, unit: "percent", direction: "min" },
    { key: "viewport-consistency", description: "Sessions where the viewport matched the device", target: 100, unit: "percent", direction: "min" },
  ],
};

export const EXP_005: ExperimentSpec = {
  id: "EXP-005-basic-journey",
  hypothesis: "A deterministic journey against a real page completes and produces the same verdict every time.",
  metrics: [
    { key: "journey-completion", description: "Runs that completed without an instrumentation error", target: 95, unit: "percent", direction: "min" },
    { key: "verdict-stability", description: "Runs agreeing with the most common verdict", target: 95, unit: "percent", direction: "min" },
  ],
};

export const EXP_006: ExperimentSpec = {
  id: "EXP-006-evidence-quality",
  hypothesis: "A deliberately broken page produces a finding whose evidence explains what broke, where, and how to reproduce it.",
  metrics: [
    { key: "defect-detection", description: "Injected defects that produced a finding", target: 100, unit: "percent", direction: "min" },
    { key: "evidence-completeness", description: "Mean manifest completeness across failing runs", target: 95, unit: "percent", direction: "min" },
  ],
};

/**
 * Concurrency, finally measurable.
 *
 * `temporal/workflows.ts` justifies its sequential matrix by citing this
 * experiment, and for a while that citation pointed at nothing — the reason the
 * gap list called it out. It is worth writing NOW because the blocker moved:
 * under agent-browser one profile meant one Chrome process, so "N at once" was
 * mostly a question about RAM. The Playwright engine gives each CONTEXT its own
 * proxy, so N markets at once is newly possible at all, and the question turns
 * into whether a concurrent session still measures the same thing a solo one
 * did.
 *
 * `peak-memory-per-session` cannot be evaluated by anything that exists today —
 * the browser is out of process on both engines and nothing samples the process
 * tree — and it is declared anyway. OOM is the specific fear that keeps
 * concurrency at 1; leaving the target out would turn "we have never measured
 * the thing we are afraid of" back into an unstated assumption.
 */
export const EXP_007: ExperimentSpec = {
  id: "EXP-007-concurrency",
  hypothesis:
    "N journeys can run at the same time and each one still measures what it measured alone: no instrumentation errors, the same verdict as a solo run, an egress identity that holds for the whole run, and a per-session cost that stays sub-linear.",
  metrics: [
    { key: "concurrent-completion", description: "Concurrent sessions that completed without an instrumentation error", target: 95, unit: "percent", direction: "min" },
    // 95 and not 100: the same journey run alone is only stable to 95%
    // (EXP-005), so demanding perfect agreement here would file ordinary
    // journey flakiness as a concurrency defect.
    { key: "verdict-agreement", description: "Concurrent sessions whose verdict matched the same journey run solo", target: 95, unit: "percent", direction: "min" },
    // 100, because a swapped exit mid-run does not degrade a measurement, it
    // invalidates it: LCP from one visitor, CLS from another (invariant 16).
    { key: "egress-identity-held", description: "Concurrent sessions whose egress identity was verified to hold for the whole run", target: 100, unit: "percent", direction: "min" },
    { key: "wall-clock-factor", description: "Mean wall clock per concurrent session, as a multiple of the same journey run solo", target: 2, unit: "count", direction: "max" },
    { key: "peak-memory-per-session", description: "Peak resident MB across the browser process tree, per concurrent session", target: 500, unit: "count", direction: "max" },
  ],
};

export const EXPERIMENTS: Record<string, ExperimentSpec> = {
  [EXP_000.id]: EXP_000,
  [EXP_001.id]: EXP_001,
  [EXP_002.id]: EXP_002,
  [EXP_003.id]: EXP_003,
  [EXP_004.id]: EXP_004,
  [EXP_005.id]: EXP_005,
  [EXP_006.id]: EXP_006,
  [EXP_007.id]: EXP_007,
};

/** Accepts the full id or the bare number, so `geoqa experiment run 001` works. */
export function findExperiment(query: string): ExperimentSpec | null {
  if (EXPERIMENTS[query]) return EXPERIMENTS[query];
  const normalised = query.toUpperCase().replace(/^EXP-?/, "").padStart(3, "0");
  return Object.values(EXPERIMENTS).find((e) => e.id.startsWith(`EXP-${normalised}-`)) ?? null;
}
