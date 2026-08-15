import { describe, expect, it } from "vitest";
import type { GeoQaRunResult } from "../../findings/types.js";
import {
  acceptControlFlags,
  assertProfileIdentity,
  eventFromProgress,
  eventsFromResult,
  formatEvent,
  liveDashboardUrl,
} from "../events.js";

const profile = {
  id: "bergen-mobile",
  label: "Bergen, mobile",
  market: {
    id: "bergen",
    country: "NO",
    city: "Bergen",
    language: "nb-NO",
    timezone: "Europe/Oslo",
    currency: "NOK",
    coordinates: [60.3913, 5.3221] as [number, number],
  },
  device: { id: "mobile", kind: "mobile" as const, viewport: { width: 390, height: 844 } },
  visitorType: "anonymous" as const,
};

describe("liveDashboardUrl", () => {
  it("names the agent-browser dashboard, and stays silent on Playwright", () => {
    expect(liveDashboardUrl({}, "agent-browser")).toBe("http://127.0.0.1:4848");
    expect(liveDashboardUrl({}, "playwright")).toBeNull();
  });

  it("honours an override, and an empty override means do not invent a URL", () => {
    expect(liveDashboardUrl({ AGENT_BROWSER_DASHBOARD_URL: "http://127.0.0.1:8080" }, "agent-browser")).toBe(
      "http://127.0.0.1:8080",
    );
    expect(liveDashboardUrl({ AGENT_BROWSER_DASHBOARD_URL: "" }, "agent-browser")).toBeNull();
    expect(liveDashboardUrl({ GEOQA_AGENT_BROWSER_DASHBOARD_URL: "http://dash.test" }, "agent-browser")).toBe(
      "http://dash.test",
    );
  });
});

describe("formatEvent / eventFromProgress", () => {
  it("writes one JSON object per line, which is the control-plane contract", () => {
    const line = formatEvent({ level: "info", message: "Opened listing" });
    expect(line.endsWith("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({ level: "info", message: "Opened listing" });
  });

  it("turns a journey step into an info event, and a failed capture stays a warning", () => {
    expect(eventFromProgress({ phase: "journey", stepLabel: "Opened listing", stepIndex: 2, stepsTotal: 8 })).toEqual({
      level: "info",
      message: "Opened listing",
    });
    expect(eventFromProgress({ phase: "device" }).message).toContain("device");
  });
});

describe("eventsFromResult", () => {
  const result = {
    schemaVersion: 1,
    runId: "run_1",
    target: "https://digilist.no",
    profileId: "bergen-mobile",
    journeyId: "browse",
    verdict: "PASS",
    geo: { network: { observed: { ip: "84.210.1.1" } } },
    confidence: { overall: 96 },
    findings: [],
    evidenceId: "ev_1",
    startedAt: "2026-08-15T12:00:00.000Z",
    durationMs: 12_000,
  } as unknown as GeoQaRunResult;

  it("emits the observed IP and the confidence, never a fabricated live URL on Playwright", () => {
    const events = eventsFromResult(result, { engine: "playwright", env: {} });
    expect(events.some((e) => e.observedIp === "84.210.1.1")).toBe(true);
    const done = events.at(-1);
    expect(done).toMatchObject({ level: "success", confidence: 96, message: "Journey completed" });
    expect(events.some((e) => e.liveUrl !== undefined)).toBe(false);
  });

  it("names the dashboard when the engine is agent-browser", () => {
    const events = eventsFromResult(result, { engine: "agent-browser", env: {} });
    expect(events.some((e) => e.liveUrl === "http://127.0.0.1:4848")).toBe(true);
  });

  it("labels an ERROR as an error event, not a success with a bad verdict", () => {
    const events = eventsFromResult({ ...result, verdict: "ERROR" }, { engine: "playwright", env: {} });
    expect(events.at(-1)?.level).toBe("error");
    expect(eventsFromResult({ ...result, verdict: "FAIL" }, { engine: "playwright", env: {} }).at(-1)?.level).toBe(
      "warning",
    );
    const unread = {
      ...result,
      geo: { network: { observed: { ip: null } } },
    } as unknown as GeoQaRunResult;
    expect(eventsFromResult(unread, { engine: "playwright", env: {}, includeLive: false }).some((e) => e.observedIp)).toBe(
      false,
    );
  });
});

describe("assertProfileIdentity", () => {
  it("accepts a locale and timezone that match the profile, and REFUSES a mismatch", () => {
    expect(assertProfileIdentity(profile, { locale: "nb-NO", timezone: "Europe/Oslo" }).ok).toBe(true);
    expect(assertProfileIdentity(profile, {}).ok).toBe(true);
    const wrong = assertProfileIdentity(profile, { locale: "sv-SE" });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) throw new Error("expected refusal");
    expect(wrong.errors[0]).toContain("nb-NO");
    expect(assertProfileIdentity(profile, { timezone: "Europe/Stockholm" }).ok).toBe(false);
  });
});

describe("acceptControlFlags", () => {
  it("accepts rotate-ip and evidence as the only legal values, because both are already how a run works", () => {
    expect(acceptControlFlags({ rotateIp: true, evidence: true }).ok).toBe(true);
    expect(acceptControlFlags({}).ok).toBe(true);
    expect(acceptControlFlags({ rotateIp: false }).ok).toBe(false);
    expect(acceptControlFlags({ evidence: false }).ok).toBe(false);
  });
});

