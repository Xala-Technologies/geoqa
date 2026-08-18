import { describe, expect, it } from "vitest";
import { HISTORY_SCHEMA_VERSION, type RunRecord } from "../../history/records.js";
import { assembleDigest } from "../assemble.js";
import { DEFAULT_DIGEST_TO, parseDigestWindow, resolveDigestTo } from "../window.js";

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  schemaVersion: HISTORY_SCHEMA_VERSION,
  runId: "run_1",
  tenantId: "digilist",
  target: "https://digilist.no/",
  profileId: "oslo-desktop",
  journeyId: "landing-page",
  verdict: "PASS",
  startedAt: "2026-08-18T12:00:00.000Z",
  durationMs: 1000,
  seed: 1,
  engine: "playwright",
  evidenceId: "ev_1",
  findings: { total: 0, bySeverity: {}, byCategory: {}, labels: [] },
  confidence: { overall: 100, geo: 100, browser: 100, journey: 100, evidence: 100 },
  geo: {
    requestedCountry: "NO",
    requestedCity: "Oslo",
    observedCountry: "NO",
    observedCity: "Oslo",
    country: "match",
    city: "match",
    egressHeld: "match",
    agreement: "unverified",
  },
  latencyMs: 80,
  vitals: { lcp: 400, cls: 0, ttfb: 20, inp: null },
  ...over,
});

describe("parseDigestWindow", () => {
  const now = Date.parse("2026-08-19T00:00:00.000Z");

  it("defaults to the last 24 hours and accepts Nh or an ISO instant", () => {
    expect(parseDigestWindow(undefined, now)).toEqual({ ok: true, sinceMs: now - 24 * 60 * 60_000 });
    expect(parseDigestWindow("12h", now)).toEqual({ ok: true, sinceMs: now - 12 * 60 * 60_000 });
    expect(parseDigestWindow("2026-08-18T00:00:00.000Z", now)).toEqual({
      ok: true,
      sinceMs: Date.parse("2026-08-18T00:00:00.000Z"),
    });
  });

  it("REFUSES a window that is not a duration or an instant", () => {
    expect(parseDigestWindow("yesterday", now).ok).toBe(false);
    expect(parseDigestWindow("0h", now).ok).toBe(false);
  });
});

describe("assembleDigest", () => {
  const sinceMs = Date.parse("2026-08-18T00:00:00.000Z");
  const untilMs = Date.parse("2026-08-19T00:00:00.000Z");

  it("counts only runs inside the window and names failures", () => {
    const digest = assembleDigest({
      records: [
        record({ runId: "old", startedAt: "2026-08-17T23:00:00.000Z" }),
        record({ runId: "ok", startedAt: "2026-08-18T10:00:00.000Z" }),
        record({
          runId: "bad",
          startedAt: "2026-08-18T11:00:00.000Z",
          verdict: "FAIL",
          target: "https://app.digilist.no/",
          profileId: "bergen-desktop",
          journeyId: "search",
          findings: { total: 1, bySeverity: { high: 1 }, byCategory: { functional: 1 }, labels: ["search box"] },
        }),
        record({ runId: "broke", startedAt: "2026-08-18T12:00:00.000Z", verdict: "ERROR" }),
      ],
      filed: [],
      repaired: [],
      sinceMs,
      untilMs,
      tenantId: "digilist",
      consoleUrl: "https://geoqa.example",
    });
    expect(digest.runs).toEqual({ total: 3, pass: 1, fail: 1, error: 1, warning: 0 });
    expect(digest.failed.map((f) => f.runId)).toEqual(["bad", "broke"]);
    expect(digest.failed[0]?.href).toBe("https://geoqa.example/#/run/bad");
    expect(digest.mustKnow.some((line) => line.includes("ERROR"))).toBe(true);
  });

  it("keeps filed and repaired issues that landed in the window", () => {
    const digest = assembleDigest({
      records: [record()],
      filed: [
        { key: "old", number: 1, url: "https://github.com/x/y/issues/1", at: "2026-08-17T00:00:00.000Z" },
        { key: "site:app.digilist.no|search box", number: 9, url: "https://github.com/x/y/issues/9", at: "2026-08-18T15:00:00.000Z" },
      ],
      repaired: [
        { key: "site:app.digilist.no|search box", status: "opened", at: "2026-08-18T16:00:00.000Z", prUrl: "https://github.com/x/y/pull/2" },
      ],
      sinceMs,
      untilMs,
      tenantId: "digilist",
      consoleUrl: null,
    });
    expect(digest.filed).toHaveLength(1);
    expect(digest.repaired).toHaveLength(1);
    expect(digest.repaired[0]?.prUrl).toContain("/pull/2");
  });

  it("suggests from the evidence rather than inventing a narrative", () => {
    const empty = assembleDigest({
      records: [],
      filed: [],
      repaired: [],
      sinceMs,
      untilMs,
      tenantId: "digilist",
      consoleUrl: null,
    });
    expect(empty.suggestions[0]?.title).toMatch(/no runs/i);

    const city = assembleDigest({
      records: [
        record({
          verdict: "FAIL",
          geo: {
            requestedCountry: "NO",
            requestedCity: "Oslo",
            observedCountry: "NO",
            observedCity: "Skui",
            country: "match",
            city: "mismatch",
            egressHeld: "match",
            agreement: "unverified",
          },
          findings: { total: 1, bySeverity: { medium: 1 }, byCategory: { geo: 1 }, labels: ["city"] },
        }),
      ],
      filed: [],
      repaired: [],
      sinceMs,
      untilMs,
      tenantId: "digilist",
      consoleUrl: null,
    });
    expect(city.suggestions.some((s) => /city/i.test(s.title))).toBe(true);
  });

  it("counts warnings, refuses an invented host, and suggests from a clean day and an unrepaired filing", () => {
    const warned = assembleDigest({
      records: [
        record({
          verdict: "PASS_WITH_WARNINGS",
          target: "not a url",
          profileId: "oslo-desktop",
        }),
        record({
          runId: "dash",
          target: "https://dashboard.digilist.no/login",
          profileId: "oslo-desktop",
          journeyId: "login-reachable",
        }),
      ],
      filed: [],
      repaired: [],
      sinceMs,
      untilMs,
      tenantId: "digilist",
      consoleUrl: "",
    });
    expect(warned.runs).toEqual({ total: 2, pass: 1, fail: 0, error: 0, warning: 1 });
    expect(warned.mustKnow[0]).toMatch(/pulse held/i);
    expect(warned.suggestions.some((s) => /two clocks/i.test(s.title))).toBe(true);

    const open = assembleDigest({
      records: [
        record({
          verdict: "FAIL",
          target: "https://dashboard.digilist.no/login",
          findings: { total: 1, bySeverity: { high: 1 }, byCategory: { functional: 1 }, labels: ["otp"] },
        }),
      ],
      filed: [{ key: "k", number: 3, url: "https://github.com/x/y/issues/3", at: "2026-08-18T15:00:00.000Z" }],
      repaired: [],
      sinceMs,
      untilMs,
      tenantId: null,
      consoleUrl: "",
    });
    expect(open.failed[0]?.href).toBeNull();
    expect(open.suggestions.some((s) => /none were repaired/i.test(s.title))).toBe(true);

    const quiet = assembleDigest({
      records: [
        record({
          verdict: "FAIL",
          target: "https://dashboard.digilist.no/login",
          findings: { total: 1, bySeverity: { high: 1 }, byCategory: { functional: 1 }, labels: ["otp"] },
        }),
      ],
      filed: [{ key: "k", number: 3, url: "https://github.com/x/y/issues/3", at: "2026-08-18T15:00:00.000Z" }],
      repaired: [{ key: "k", status: "opened", at: "2026-08-18T16:00:00.000Z" }],
      sinceMs,
      untilMs,
      tenantId: null,
      consoleUrl: null,
    });
    expect(quiet.suggestions.some((s) => /nothing extra/i.test(s.title))).toBe(true);
  });
});

describe("resolveDigestTo", () => {
  it("prefers the flag, then GEOQA_DIGEST_TO, then the operator default", () => {
    expect(resolveDigestTo("a@b.no", { GEOQA_DIGEST_TO: "c@d.no" })).toBe("a@b.no");
    expect(resolveDigestTo("", { GEOQA_DIGEST_TO: "c@d.no" })).toBe("c@d.no");
    expect(resolveDigestTo(undefined, {})).toBe(DEFAULT_DIGEST_TO);
  });
});
