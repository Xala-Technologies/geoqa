import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGeoProfile } from "../../geo/profile.js";
import type { GeoProfile, GeoVerification } from "../../geo/types.js";
import { loadJourney } from "../../journeys/spec.js";
import type { JourneyResult } from "../../journeys/engine.js";
import { buildManifest } from "../../evidence/manifest.js";
import type { RunSpec } from "../context.js";
import {
  StageError,
  assembleResult,
  collectEvidence,
  executeJourney,
  loadInputs,
  verifyEnvironment,
} from "../stages.js";
import { bad, fakeRuntime, ok } from "./fake-runtime.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const profilePath = path.join(repoRoot, "profiles", "oslo-mobile.yaml");
const journeyPath = path.join(repoRoot, "journeys", "landing-page.yaml");

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "geoqa-stages-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const profile = (): GeoProfile => {
  const out = loadGeoProfile(profilePath);
  if (!out.ok) throw new Error(out.errors.join());
  return out.value;
};

const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  runId: "run_1",
  target: "https://digilist.no",
  profilePath,
  journeyPath,
  evidenceRoot: root,
  proxyUrl: null,
  proxyBypass: null,
  initScriptPath: null,
  vars: {},
  headed: false,
  verifyEndpoint: "https://ipinfo.io/json",
  ...over,
});

describe("loadInputs", () => {
  it("loads the shipped profile and journey", () => {
    const { profile: p, journey } = loadInputs(spec());
    expect(p.id).toBe("oslo-mobile");
    expect(journey.ok).toBe(true);
  });

  it("throws a named StageError for a bad profile or journey", () => {
    expect(() => loadInputs(spec({ profilePath: "/nope.yaml" }))).toThrow(StageError);
    try {
      loadInputs(spec({ journeyPath: "/nope.yaml" }));
    } catch (e) {
      expect((e as StageError).stage).toBe("load");
      expect((e as StageError).message).toContain("invalid journey");
    }
  });
});

describe("verifyEnvironment", () => {
  it("reads BOTH axes and reports the real Lysaker/Oslo case as unverified", async () => {
    const geo = await verifyEnvironment(fakeRuntime(), profile(), "https://ipinfo.io/json");
    expect(geo.network.country.verdict).toBe("match");
    expect(geo.network.city.verdict).toBe("unverified");
    expect(geo.browser.language.verdict).toBe("match");
    expect(geo.browser.timezone.verdict).toBe("match");
    expect(geo.trustworthy).toBe(false);
  });

  it("degrades to unverified — never to a pass — when the browser cannot read", async () => {
    const geo = await verifyEnvironment(
      fakeRuntime({ open: () => Promise.resolve(bad()), evaluate: <T,>() => Promise.resolve(bad<T>()) }),
      profile(),
      "https://ipinfo.io/json",
    );
    expect(geo.confidence).toBeLessThan(40);
    expect(geo.trustworthy).toBe(false);
  });
});

describe("executeJourney", () => {
  it("substitutes {target} from the spec", async () => {
    const opened: string[] = [];
    const journey = loadJourney(journeyPath);
    if (!journey.ok) throw new Error("bad journey");
    await executeJourney(
      fakeRuntime({
        open: (url) => {
          opened.push(url);
          return Promise.resolve(ok({ url, title: "T", targetId: "t", launchHash: null, browserLaunched: false }));
        },
      }),
      spec({ target: "https://digilist.no/blogg" }),
      journey.value,
    );
    expect(opened).toEqual(["https://digilist.no/blogg"]);
  });

  it("lets spec vars override and add to the defaults", async () => {
    const journey = loadJourney(path.join(repoRoot, "journeys", "localization.yaml"));
    if (!journey.ok) throw new Error("bad journey");
    const texts: string[] = [];
    const result = await executeJourney(
      fakeRuntime({
        getText: (sel) => {
          texts.push(sel);
          return Promise.resolve(ok('<html lang="nb-NO">500 NOK'));
        },
      }),
      spec({ vars: { expectLanguageMarker: "nb-NO", forbiddenCurrency: "EUR" } }),
      journey.value,
    );
    expect(result.verdict).toBe("PASS");
    expect(texts).toContain("html");
  });

  it("passes a logger through when given", async () => {
    const lines: string[] = [];
    const journey = loadJourney(journeyPath);
    if (!journey.ok) throw new Error("bad journey");
    await executeJourney(fakeRuntime(), spec(), journey.value, (l) => lines.push(l));
    expect(lines.length).toBeGreaterThan(0);
  });
});

const journeyResult = (over: Partial<JourneyResult> = {}): JourneyResult => ({
  journeyId: "landing-page",
  verdict: "PASS",
  steps: [],
  counts: { passed: 1, failed: 0, errored: 0, skipped: 0 },
  screenshots: [],
  durationMs: 10,
  ...over,
});

const geoOf = async (): Promise<GeoVerification> => verifyEnvironment(fakeRuntime(), profile(), "e");

describe("collectEvidence", () => {
  const input = async (journey: JourneyResult) => ({
    spec: spec(),
    profile: profile(),
    geo: await geoOf(),
    journey,
    createdAt: "2026-08-12T00:00:00.000Z",
  });

  it("writes only the PASS tier for a passing run", async () => {
    const manifest = await collectEvidence(fakeRuntime(), await input(journeyResult()));
    const dir = path.join(root, "run_1");
    expect(manifest.tier).toBe("pass");
    expect(existsSync(path.join(dir, "run.json"))).toBe(true);
    expect(existsSync(path.join(dir, "vitals.json"))).toBe(true);
    // A passing run must not pay for a trace and a HAR.
    expect(existsSync(path.join(dir, "trace.json"))).toBe(false);
    expect(existsSync(path.join(dir, "network.har"))).toBe(false);
  });

  it("writes the full investigation tier for an ERROR run", async () => {
    const manifest = await collectEvidence(fakeRuntime(), await input(journeyResult({ verdict: "ERROR" })));
    const dir = path.join(root, "run_1");
    expect(manifest.tier).toBe("investigation");
    for (const file of ["console.json", "network.json", "snapshot.txt", "a11y.json"]) {
      expect(existsSync(path.join(dir, file)), file).toBe(true);
    }
  });

  it("writes the warning and fail tiers in between", async () => {
    const warn = await collectEvidence(fakeRuntime(), await input(journeyResult({ verdict: "PASS_WITH_WARNINGS" })));
    expect(warn.tier).toBe("warning");
    const fail = await collectEvidence(fakeRuntime(), await input(journeyResult({ verdict: "FAIL" })));
    expect(fail.tier).toBe("fail");
  });

  it("records a required artifact that could not be produced as MISSING, not absent", async () => {
    const manifest = await collectEvidence(
      fakeRuntime({ traceStop: () => Promise.resolve(bad()) }),
      await input(journeyResult({ verdict: "FAIL" })),
    );
    expect(manifest.missing).toContain("trace");
    expect(manifest.completeness).toBeLessThan(100);
  });

  it("still writes an artifact when the browser call failed, so the gap is inspectable", async () => {
    await collectEvidence(
      fakeRuntime({ console: () => Promise.resolve(bad()) }),
      await input(journeyResult({ verdict: "PASS_WITH_WARNINGS" })),
    );
    expect(readFileSync(path.join(root, "run_1", "console.json"), "utf8")).toBe("null");
  });

  it("describes screenshots the journey wrote and flags their risk", async () => {
    const manifest = await collectEvidence(fakeRuntime(), await input(journeyResult({ screenshots: ["hero"] })));
    const shot = manifest.artifacts.find((a) => a.kind === "screenshot");
    expect(shot).toMatchObject({ label: "hero", path: "hero.png", risk: "low" });
  });

  it("REDACTS the run metadata on the way to disk", async () => {
    await collectEvidence(fakeRuntime(), {
      ...(await input(journeyResult())),
      spec: spec({ proxyUrl: "http://user:s3cret@gw:7777" }),
    });
    expect(readFileSync(path.join(root, "run_1", "run.json"), "utf8")).not.toContain("s3cret");
  });
});

describe("assembleResult", () => {
  it("combines every stage into the result an agent consumes", async () => {
    const manifest = buildManifest({
      evidenceId: "ev_1", runId: "run_1", createdAt: "t", verdict: "PASS", artifacts: [],
    });
    const result = assembleResult({
      spec: spec(),
      profile: profile(),
      geo: await geoOf(),
      journey: journeyResult(),
      manifest,
      startedAt: "2026-08-12T00:00:00.000Z",
      durationMs: 1234,
    });
    expect(result).toMatchObject({
      runId: "run_1",
      target: "https://digilist.no",
      profileId: "oslo-mobile",
      journeyId: "landing-page",
      verdict: "PASS",
      evidenceId: "ev_1",
      durationMs: 1234,
    });
    expect(result.findings).toEqual([]);
    expect(result.confidence.searchObservation).toBeNull();
  });

  it("ranks findings and attaches the evidence manifest to each", async () => {
    const manifest = buildManifest({
      evidenceId: "ev_1", runId: "run_1", createdAt: "t", verdict: "FAIL",
      artifacts: [{ kind: "screenshot", label: "hero", path: "hero.png", bytes: 5, mime: "image/png" }],
    });
    const result = assembleResult({
      spec: spec(),
      profile: profile(),
      geo: await geoOf(),
      journey: journeyResult({
        verdict: "FAIL",
        counts: { passed: 0, failed: 2, errored: 0, skipped: 0 },
        steps: [
          { index: 0, action: "assert", label: "low one", outcome: "failed", severity: "low", category: null, check: "cls-below", detail: "d", expected: "e", observed: "o", durationMs: 1 },
          { index: 1, action: "assert", label: "critical one", outcome: "failed", severity: "critical", category: null, check: "title-exists", detail: "d", expected: "e", observed: "o", durationMs: 1 },
        ],
      }),
      manifest,
      startedAt: "2026-08-12T00:00:00.000Z",
      durationMs: 1,
    });
    expect(result.findings.map((f) => f.severity)).toEqual(["critical", "low"]);
    expect(result.findings[0]?.evidence).toEqual([{ label: "hero", path: "hero.png", mime: "image/png" }]);
  });

  it("reports a null evidence id and empty evidence when nothing was captured", async () => {
    const result = assembleResult({
      spec: spec(),
      profile: profile(),
      geo: await geoOf(),
      journey: journeyResult(),
      manifest: null,
      startedAt: "t",
      durationMs: 1,
    });
    expect(result.evidenceId).toBeNull();
    expect(result.confidence.evidence).toBe(0);
  });
});
