import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { axisTone, ms, ratio, score, toDashboardView, toRunView, verdictTone } from "../view.js";
import type { RunRecord } from "../../history/records.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  schemaVersion: 1,
  runId: "run_1000_oslo-desktop",
  tenantId: null,
  target: "https://a.test/x",
  profileId: "oslo-desktop",
  journeyId: "landing-page",
  verdict: "PASS",
  startedAt: "2026-08-13T10:00:00.000Z",
  durationMs: 1,
  seed: 7,
  engine: "playwright",
  evidenceId: "ev_1000_oslo-desktop",
  findings: { total: 0, bySeverity: {}, byCategory: {}, labels: [] },
  confidence: { overall: 100, geo: 100, browser: 100, journey: 100, evidence: 100 },
  geo: {
    requestedCountry: "NO", requestedCity: "Oslo", observedCountry: "NO", observedCity: "Lysaker",
    country: "match", city: "unverified", egressHeld: "match", agreement: "unverified",
  },
  latencyMs: 120,
  vitals: { lcp: 421, cls: 0, ttfb: 88, inp: null },
  ...over,
});

describe("Measured — the type that stops a dashboard lying", () => {
  it("renders a real reading with its own text", () => {
    expect(ms(421)).toEqual({ measured: true, value: 421, text: "421ms" });
    expect(score(87)).toEqual({ measured: true, value: 87, text: "87" });
  });

  it("renders an absence as 'not measured', carrying the REASON", () => {
    // The whole point: a renderer writing `{v.text}` cannot produce "0" for a null.
    const absent = ms(null, "no LCP entry was emitted");
    expect(absent.measured).toBe(false);
    expect(absent.text).toBe("not measured");
    if (absent.measured) throw new Error("expected an absence");
    expect(absent.reason).toBe("no LCP entry was emitted");
  });

  it("treats a ZERO as a real reading, because for CLS zero is good news", () => {
    // The one metric where 0 is the best possible answer rather than a missing value. A
    // truthy check instead of a null check would have hidden every perfect CLS.
    const perfect = ratio(0, "no layout-shift entries were observed");
    expect(perfect.measured).toBe(true);
    expect(perfect.text).toBe("0");
    expect(ms(0).measured).toBe(true);
    expect(score(0).measured).toBe(true);
  });

  it("rounds a float to something a human reads", () => {
    // performance.timing arrives as a float: 467.19999998807907ms in a dashboard reads as
    // a report nobody looked at.
    expect(ms(467.19999998807907).text).toBe("467ms");
    expect(ratio(0.02499999, "no layout-shift entries were observed").text).toBe("0.025");
  });
});

describe("toRunView", () => {
  it("carries every axis and formats the measured values", () => {
    const view = toRunView(record());
    expect(view.marketId).toBe("oslo");
    expect(view.vitals.lcp.text).toBe("421ms");
    expect(view.geo.observed).toBe("NO/Lysaker");
    expect(view.geo.city).toBe("unverified");
    // The seed, so a run in the UI can be replayed from it.
    expect(view.seed).toBe(7);
  });

  it("marks INP unmeasured with the reason that explains it, rather than showing 0", () => {
    // Most runs never interact, and a page that responds faster than the browser reports
    // produces no entry at all. A dashboard showing 0ms INP would be claiming instant
    // responsiveness for a page nobody touched.
    const view = toRunView(record());
    expect(view.vitals.inp.measured).toBe(false);
    if (view.vitals.inp.measured) throw new Error("expected an absence");
    expect(view.vitals.inp.reason).toContain("no interaction was timed");
  });

  it("marks the SEARCH axis unmeasured — it is null for almost every run", () => {
    // The case that proves the rule: showing 0 here would tell a reader their site is
    // invisible in search when the truth is that nobody looked.
    const view = toRunView(record());
    expect(view.confidence.search.measured).toBe(false);
    if (view.confidence.search.measured) throw new Error("expected an absence");
    expect(view.confidence.search.reason).toContain("no SERP observation");
  });

  it("shows a missing observed country as ? rather than blank", () => {
    const view = toRunView(record({ geo: { ...record().geo, observedCountry: null, observedCity: null } }));
    expect(view.geo.observed).toBe("?/?");
  });
});

describe("toDashboardView", () => {
  it("orders runs newest first, because a dashboard is read from the top", () => {
    const view = toDashboardView(
      [record({ runId: "old", startedAt: "2026-08-01T00:00:00.000Z" }), record({ runId: "new", startedAt: "2026-08-13T00:00:00.000Z" })],
      "2026-08-13T12:00:00.000Z",
    );
    expect(view.runs.map((r) => r.runId)).toEqual(["new", "old"]);
  });

  it("reports mean confidence as UNMEASURED for an empty history, never 0", () => {
    // "No runs" and "runs that scored zero" are different facts, and only one is bad news.
    const view = toDashboardView([], "2026-08-13T12:00:00.000Z");
    expect(view.summary.total).toBe(0);
    expect(view.summary.meanConfidence.measured).toBe(false);
    expect(view.summary.meanConfidence.text).toBe("not measured");
  });

  it("takes the timestamp from its CALLER rather than the clock", () => {
    // A view model that stamps itself is not reproducible, and its tests would depend on
    // the time of day.
    expect(toDashboardView([], "fixed").generatedAt).toBe("fixed");
  });

  it("carries regressions and the cross-market analysis", () => {
    const good = record({ runId: "a", startedAt: "2026-08-01T00:00:00.000Z" });
    const bad = record({
      runId: "b",
      startedAt: "2026-08-02T00:00:00.000Z",
      verdict: "FAIL",
      findings: { total: 1, bySeverity: { critical: 1 }, byCategory: {}, labels: ["has a primary heading"] },
    });
    const view = toDashboardView([good, bad], "now");
    expect(view.regressions).toHaveLength(1);
    expect(view.site.pages).toBe(1);
  });

  it("passes warnings through and appends the analysis's own", () => {
    const view = toDashboardView([record({ verdict: "ERROR" })], "now", ["a caller warning"]);
    expect(view.warnings[0]).toBe("a caller warning");
    expect(view.warnings.join(" ")).toContain("errored");
  });
});

describe("tones", () => {
  it("gives ERROR its own tone, never the failure tone", () => {
    // An ERROR is our defect. Colouring it like a site failure is the same conflation the
    // verdict model spent so much effort avoiding.
    expect(verdictTone("PASS")).toBe("good");
    expect(verdictTone("PASS_WITH_WARNINGS")).toBe("warn");
    expect(verdictTone("FAIL")).toBe("bad");
    expect(verdictTone("ERROR")).toBe("unknown");
    expect(verdictTone("something new")).toBe("unknown");
  });

  it("gives `unverified` its own tone, never the failure tone", () => {
    // We can prove a city right, never wrong. Styling `unverified` as a failure would put
    // that asymmetry back the way the design removed it.
    expect(axisTone("match")).toBe("good");
    expect(axisTone("mismatch")).toBe("bad");
    expect(axisTone("unverified")).toBe("unknown");
    expect(axisTone("")).toBe("unknown");
  });
});

describe("the UI's mirrored types do not drift", () => {
  /**
   * The UI ships as static files built by its own tsconfig, so it cannot import from `src/`
   * — it mirrors the shape instead. This asserts the mirror still matches, so a rename here
   * fails the engine's suite rather than silently producing a blank panel in a dashboard
   * nobody notices is empty.
   */
  const uiTypes = readFileSync(path.join(repoRoot, "ui", "src", "types.ts"), "utf8");

  it("declares every field the view model actually produces", () => {
    const view = toDashboardView([record()], "now");
    for (const key of Object.keys(view)) expect(uiTypes, `DashboardView.${key}`).toContain(`${key}:`);
    for (const key of Object.keys(view.runs[0] as object)) expect(uiTypes, `RunView.${key}`).toContain(`${key}:`);
    // Every nested key is matched WITH its colon, the same way the two loops above are.
    //
    // The bare-`key` form these used to take matches a substring, so renaming `labels` to
    // `checkLabels` in the mirror kept passing — the new name contains the old one. Verified by
    // mutation, which is the only way that would have surfaced: the assertion was green while
    // the field it guards had been renamed out from under the UI.
    //
    // `findings` is walked for the same reason `vitals` and `confidence` are: a mirror checked
    // one level deep is a mirror for one level, and the Findings page reads `findings.labels`.
    const nested = (key: "vitals" | "confidence" | "findings"): void => {
      for (const field of Object.keys((view.runs[0] as unknown as Record<string, object>)[key] ?? {})) {
        expect(uiTypes, `${key}.${field}`).toContain(`${field}:`);
      }
    };
    nested("vitals");
    nested("confidence");
    nested("findings");
  });

  it("keeps the Measured union, which is the contract that stops a 0 standing in for a null", () => {
    expect(uiTypes).toContain("measured: true");
    expect(uiTypes).toContain("measured: false");
    expect(uiTypes).toContain('text: "not measured"');
  });

  /**
   * Declaring a field is not rendering it, and that gap is what gaps C-19 was.
   *
   * `coverageGaps` was computed correctly, mirrored correctly into `types.ts`, and then read by
   * no component — so the test above passed while the dashboard silently dropped the one field
   * written to stop a report reading as full coverage. Two live sites had never been measured in
   * `porsgrunn` and the dashboard showed a clean bill of health.
   *
   * A behavioural test cannot catch this: every component test asserts what its component does,
   * and a component that does not exist has no test to fail. So this reads the UI SOURCE and
   * requires each field to be named somewhere outside the type mirror. It is a coarse check —
   * naming a field is not the same as displaying it well — but it is exactly as strong as the
   * defect requires, and it fails at the moment a field is added without a home.
   */
  it("RENDERS every field it declares, because computing one nothing reads is theatre", () => {
    const uiDir = path.join(repoRoot, "ui", "src");
    const sources = readdirSync(uiDir, { recursive: true, encoding: "utf8" })
      .filter((f) => (f.endsWith(".tsx") || f.endsWith(".ts")) && !f.endsWith("types.ts"))
      .map((f) => readFileSync(path.join(uiDir, f), "utf8"))
      .join("\n");

    const view = toDashboardView([record()], "now");
    for (const key of Object.keys(view)) {
      expect(sources, `DashboardView.${key} is declared but no component reads it`).toContain(key);
    }
    for (const key of Object.keys(view.site)) {
      expect(sources, `site.${key} is declared but no component reads it`).toContain(key);
    }
  });
});

describe("ratio, where ZERO is a real reading", () => {
  it("renders 0 as a reading, not as an absence", () => {
    // The whole reason `ratio` exists separately from `ms`. A CLS of 0 means nothing moved,
    // which is the best possible answer, and a truthy check instead of a null check would hide
    // every perfect score.
    const out = ratio(0, "no layout-shift entries were observed");
    expect(out.measured).toBe(true);
    expect(out.text).toBe("0");
  });

  it("renders null as an absence carrying the caller's reason", () => {
    // The arm that was untested: every existing test fed it a number. An absence here must say
    // WHY, which is why the reason has no default.
    const out = ratio(null, "no layout-shift entries were observed");
    expect(out.measured).toBe(false);
    expect(out.measured === false && out.reason).toBe("no layout-shift entries were observed");
    expect(out.text).toBe("not measured");
  });

  it("rounds to three places, because a CLS printed to fifteen is noise dressed as rigour", () => {
    expect(ratio(0.0031234, "r").text).toBe("0.003");
  });
});
