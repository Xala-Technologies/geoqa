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

export const EXPERIMENTS: Record<string, ExperimentSpec> = {
  [EXP_000.id]: EXP_000,
  [EXP_001.id]: EXP_001,
  [EXP_002.id]: EXP_002,
  [EXP_003.id]: EXP_003,
  [EXP_004.id]: EXP_004,
  [EXP_005.id]: EXP_005,
  [EXP_006.id]: EXP_006,
};

/** Accepts the full id or the bare number, so `geoqa experiment run 001` works. */
export function findExperiment(query: string): ExperimentSpec | null {
  if (EXPERIMENTS[query]) return EXPERIMENTS[query];
  const normalised = query.toUpperCase().replace(/^EXP-?/, "").padStart(3, "0");
  return Object.values(EXPERIMENTS).find((e) => e.id.startsWith(`EXP-${normalised}-`)) ?? null;
}
