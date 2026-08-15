/**
 * The control-plane event contract: one JSON object per line.
 *
 * `geoqa journey run --json` stays a single object with schemaVersion — that
 * is the agent-to-agent contract and it does not stream. `geoqa run --json`
 * is the operator-console contract: Electron (and anything else that screens
 * a live session) reads stdout line by line and understands `observedIp`,
 * `liveUrl`, `confidence` and a normal `message`.
 *
 * Two commands, two contracts, one runtime. This file only shapes events;
 * `controlRun` still calls `journeyRun`.
 */
import type { GeoProfile } from "../geo/types.js";
import type { GeoQaRunResult } from "../findings/types.js";
import type { RunEngine } from "../run/context.js";
import type { RunProgress } from "../run/execute.js";

export const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:4848";

export type ControlLevel = "info" | "warning" | "success" | "error";

export interface ControlEvent {
  level: ControlLevel;
  message: string;
  observedIp?: string;
  liveUrl?: string;
  confidence?: number;
  verdict?: GeoQaRunResult["verdict"];
  runId?: string;
  evidenceId?: string | null;
}

export function liveDashboardUrl(env: NodeJS.ProcessEnv, engine: RunEngine): string | null {
  if (engine !== "agent-browser") return null;
  const raw = env.AGENT_BROWSER_DASHBOARD_URL ?? env.GEOQA_AGENT_BROWSER_DASHBOARD_URL;
  if (raw === "") return null;
  return raw ?? DEFAULT_DASHBOARD_URL;
}

export function formatEvent(event: ControlEvent): string {
  return JSON.stringify(event);
}

export function eventFromProgress(event: RunProgress): ControlEvent {
  if (event.phase === "journey" && event.stepLabel !== undefined) {
    return { level: "info", message: event.stepLabel };
  }
  return { level: "info", message: `${event.phase} phase` };
}

export function eventsFromResult(
  result: GeoQaRunResult,
  options: { engine: RunEngine; env: NodeJS.ProcessEnv; includeLive?: boolean },
): ControlEvent[] {
  const events: ControlEvent[] = [];
  if (options.includeLive !== false) {
    const liveUrl = liveDashboardUrl(options.env, options.engine);
    if (liveUrl !== null) events.push({ level: "info", message: "Browser session started", liveUrl });
  }
  const observedIp = result.geo.network.observed.ip;
  if (observedIp !== null) {
    events.push({ level: "info", message: "Network session opened", observedIp });
  }
  events.push(completionEvent(result));
  return events;
}

const completionEvent = (result: GeoQaRunResult): ControlEvent => ({
  level: result.verdict === "ERROR" ? "error" : result.verdict === "FAIL" ? "warning" : "success",
  message: result.verdict === "ERROR" ? "Journey ended without a reading" : "Journey completed",
  confidence: result.confidence.overall,
  verdict: result.verdict,
  runId: result.runId,
  evidenceId: result.evidenceId,
});

export function assertProfileIdentity(
  profile: GeoProfile,
  asked: { locale?: string; timezone?: string },
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (asked.locale !== undefined && asked.locale !== profile.market.language) {
    errors.push(
      `--locale ${asked.locale} does not match profile ${profile.id} (${profile.market.language}) — the profile is the identity, not the flag`,
    );
  }
  if (asked.timezone !== undefined && asked.timezone !== profile.market.timezone) {
    errors.push(
      `--timezone ${asked.timezone} does not match profile ${profile.id} (${profile.market.timezone}) — the profile is the identity, not the flag`,
    );
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function acceptControlFlags(flags: {
  rotateIp?: boolean;
  evidence?: boolean;
}): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (flags.rotateIp === false) {
    errors.push("--rotate-ip cannot be off: a new run always mints a new proxy session, which is the rotation");
  }
  if (flags.evidence === false) {
    errors.push("--evidence cannot be off: a run without an evidence package is not a run this engine will stand behind");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
