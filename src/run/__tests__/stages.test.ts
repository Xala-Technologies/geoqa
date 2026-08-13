import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGeoProfile } from "../../geo/profile.js";
import type { GeoProfile, GeoVerification } from "../../geo/types.js";
import { loadJourney } from "../../journeys/spec.js";
import type { JourneyResult } from "../../journeys/engine.js";
import { GEOQA_SCHEMA_VERSION, buildManifest } from "../../evidence/manifest.js";
import type { RunSpec } from "../context.js";
import {
  EGRESS_HELD_CHECK,
  StageError,
  applyDeviceProfile,
  assembleResult,
  collectEvidence,
  executeJourney,
  loadInputs,
  traceArtifactFormat,
  verifyEgressHeld,
  verifyEnvironment,
} from "../stages.js";
import { bad, fakeRuntime, ok, BROWSER_ENV_OSLO, IPINFO_OSLO } from "./fake-runtime.js";
import type { BrowserRuntime } from "../../browser/types.js";

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
  engine: "agent-browser",
  seed: 7,
  corroborateGeo: false,
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
  writes: false,
  seed: 1,
  touchedForm: false,
  ...over,
});

const geoOf = async (): Promise<GeoVerification> => verifyEnvironment(fakeRuntime(), profile(), "e");

describe("assembleResult reproducibility", () => {
  const failedStep = {
    index: 0,
    action: "assert" as const,
    label: "has a primary heading",
    outcome: "failed" as const,
    severity: "critical",
    category: null,
    check: "selector-visible",
    detail: "not visible",
    expected: "visible",
    observed: "false",
    durationMs: 1,
  };

  const assemble = async (over: { attempts?: number; occurrences?: Record<string, number> }) =>
    assembleResult({
      spec: spec(),
      profile: profile(),
      geo: await geoOf(),
      journey: journeyResult({ verdict: "FAIL", steps: [failedStep] }),
      manifest: null,
      startedAt: "t",
      durationMs: 1,
      ...over,
    });

  it("treats a lone run as one observation", async () => {
    const result = await assemble({});
    expect(result.findings[0]).toMatchObject({
      status: "observed",
      reproducibility: { attempts: 1, occurrences: 1 },
    });
  });

  it("marks a step that failed in EVERY attempt as reproduced, at high confidence", async () => {
    const result = await assemble({ attempts: 3, occurrences: { "0:has a primary heading": 3 } });
    expect(result.findings[0]?.status).toBe("reproduced");
    expect(result.findings[0]?.confidence).toBeGreaterThan(95);
  });

  it("pulls a one-in-three failure DOWN rather than reporting it as certain", async () => {
    // The whole point of repeating on purpose: an intermittent failure is real
    // news, but "we saw it once" is a weaker claim than "it failed every time".
    const once = await assemble({ attempts: 3, occurrences: { "0:has a primary heading": 1 } });
    const always = await assemble({ attempts: 3, occurrences: { "0:has a primary heading": 3 } });
    expect(once.findings[0]?.status).toBe("observed");
    expect(once.findings[0]?.confidence).toBeLessThan(always.findings[0]?.confidence ?? 0);
  });
});

describe("executeJourney seed override", () => {
  it("lets one attempt pace differently from another, from the same base seed", async () => {
    const journey = loadJourney(path.join(repoRoot, "journeys", "reader.yaml"));
    if (!journey.ok) throw new Error("bad journey");
    const pauses = async (seed?: number): Promise<string[]> => {
      const waits: string[] = [];
      const runtime = fakeRuntime({
        waitFor: (t) => {
          waits.push(t);
          return Promise.resolve(ok(null));
        },
      });
      await executeJourney(runtime, spec({ seed: 100 }), journey.value, undefined, seed);
      return waits;
    };
    // No override: the spec's own seed.
    expect(await pauses()).toEqual(await pauses(100));
    // An overridden attempt makes different choices.
    expect(await pauses(101)).not.toEqual(await pauses(100));
  });
});

describe("verifyEgressHeld", () => {
  /** A runtime whose in-page fetch reports `ip`. */
  const withEgress = (ip: string | null) =>
    fakeRuntime({ evaluate: <T,>() => Promise.resolve(ok(JSON.stringify({ ip }) as unknown as T)) });

  it("confirms one identity across the run and produces no step", async () => {
    const out = await verifyEgressHeld(withEgress("1.1.1.1"), "https://ipinfo.io/json", "1.1.1.1", 12);
    expect(out.axis.verdict).toBe("match");
    expect(out.step).toBeNull();
  });

  it("reads the egress WITHOUT navigating, so the page under test survives", async () => {
    // The whole reason this uses `evaluate` and not `observeNetwork`: evidence
    // collection reads vitals, console and the a11y tree after this runs, and a
    // navigation to the identity endpoint would make all of them describe
    // ipinfo.io instead of the site.
    const opened: string[] = [];
    const runtime = fakeRuntime({
      open: (url) => {
        opened.push(url);
        return Promise.resolve(ok({ url, title: "T", targetId: "t", launchHash: null, browserLaunched: false }));
      },
      evaluate: <T,>() => Promise.resolve(ok(JSON.stringify({ ip: "1.1.1.1" }) as unknown as T)),
    });
    await verifyEgressHeld(runtime, "https://ipinfo.io/json", "1.1.1.1", 0);
    expect(opened).toEqual([]);
  });

  it("files a proven rotation as OUR defect, at critical severity", async () => {
    const out = await verifyEgressHeld(withEgress("9.9.9.9"), "https://ipinfo.io/json", "1.1.1.1", 12, () => 5_000);
    expect(out.axis.verdict).toBe("mismatch");
    expect(out.step).toMatchObject({
      index: 12,
      outcome: "errored",
      severity: "critical",
      category: "instrumentation",
      check: EGRESS_HELD_CHECK,
      expected: "egress stays 1.1.1.1",
      observed: "9.9.9.9",
    });
    expect(out.step?.detail).toContain("rotated mid-run");
  });

  it("produces no step when the closing read failed — an unreadable probe must not discard a good run", async () => {
    const runtime = fakeRuntime({ evaluate: <T,>() => Promise.resolve(bad<T>()) });
    const out = await verifyEgressHeld(runtime, "https://ipinfo.io/json", "1.1.1.1", 3);
    expect(out.axis.verdict).toBe("unverified");
    expect(out.step).toBeNull();
  });

  it("produces no step when there was no opening reading to compare against", async () => {
    const out = await verifyEgressHeld(withEgress("1.1.1.1"), "https://ipinfo.io/json", null, 3);
    expect(out.axis.verdict).toBe("unverified");
    expect(out.step).toBeNull();
  });
});

describe("collectEvidence", () => {
  const input = async (journey: JourneyResult) => ({
    spec: spec(),
    profile: profile(),
    geo: await geoOf(),
    journey,
    createdAt: "2026-08-12T00:00:00.000Z",
  });

  it("records the attempt count and per-step occurrences, so a finding's claim can be CHECKED", async () => {
    // R-24 makes "can we reproduce this?" a question the package itself must answer. Without
    // this, a `--repeat 3` run emitted findings whose `reproducibility` said 3 while the
    // evidence held no trace of the other two attempts: a number nobody could check against
    // anything, which is the shape of claim this project refuses everywhere else.
    await collectEvidence(fakeRuntime(), {
      ...(await input(journeyResult())),
      reproducibility: { attempts: 3, occurrences: { "0:has a primary heading": 2 } },
    });
    const written = JSON.parse(readFileSync(path.join(root, "run_1", "run.json"), "utf8")) as {
      journey: { reproducibility?: { attempts: number; occurrences: Record<string, number> } };
    };
    expect(written.journey.reproducibility).toEqual({ attempts: 3, occurrences: { "0:has a primary heading": 2 } });
  });

  it("omits the field entirely on a single run, rather than writing a 1", async () => {
    // A `1` reads as a deliberate decision not to repeat. The absence of one is a different
    // fact, and the caller supplies nothing rather than a default that would state the first.
    await collectEvidence(fakeRuntime(), await input(journeyResult()));
    const written = JSON.parse(readFileSync(path.join(root, "run_1", "run.json"), "utf8")) as {
      journey: Record<string, unknown>;
    };
    expect("reproducibility" in written.journey).toBe(false);
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

  /** A runtime whose `traceStop` really writes a file, so the artifact is non-empty. */
  const tracingRuntime = (into: string[]) =>
    fakeRuntime({
      traceStop: (p) => {
        into.push(p);
        writeFileSync(p, "trace bytes");
        return Promise.resolve(ok(null));
      },
    });

  it("writes the Playwright trace to the .zip path it actually produces, and types it as a zip", async () => {
    // `tracing.stop` writes a ZIP. Calling it `trace.json` left a valid file that
    // every ordinary reader choked on, and a manifest that told a consumer
    // `application/json` about a zip archive.
    const written: string[] = [];
    const manifest = await collectEvidence(tracingRuntime(written), {
      ...(await input(journeyResult({ verdict: "FAIL" }))),
      spec: spec({ engine: "playwright" }),
    });
    expect(written).toEqual([path.join(root, "run_1", "trace.zip")]);
    expect(manifest.artifacts.find((a) => a.kind === "trace")).toMatchObject({
      path: "trace.zip",
      mime: "application/zip",
    });
    expect(manifest.missing).not.toContain("trace");
  });

  it("keeps the agent-browser trace as the JSON it really is", async () => {
    const written: string[] = [];
    const manifest = await collectEvidence(tracingRuntime(written), await input(journeyResult({ verdict: "FAIL" })));
    expect(written).toEqual([path.join(root, "run_1", "trace.json")]);
    expect(manifest.artifacts.find((a) => a.kind === "trace")).toMatchObject({
      path: "trace.json",
      mime: "application/json",
    });
  });

  it("REDACTS the run metadata on the way to disk", async () => {
    await collectEvidence(fakeRuntime(), {
      ...(await input(journeyResult())),
      spec: spec({ proxyUrl: "http://user:s3cret@gw:7777" }),
    });
    expect(readFileSync(path.join(root, "run_1", "run.json"), "utf8")).not.toContain("s3cret");
  });
});

describe("traceArtifactFormat", () => {
  it("gives ONE artifact kind two honest container formats rather than one lying extension", () => {
    // The kind stays `trace` on both engines — retention asks whether a trace was
    // kept, not what it was packaged in — so the path and mime are the only place
    // the format can be told truthfully.
    expect(traceArtifactFormat("playwright")).toEqual({ file: "trace.zip", mime: "application/zip" });
    expect(traceArtifactFormat("agent-browser")).toEqual({ file: "trace.json", mime: "application/json" });
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

  it("PINS the wire shape's top-level keys, so adding or removing a field cannot happen silently", async () => {
    // The `--json` shape is the integration contract, and the granularity of this
    // pin is the point: KEYS, not values.
    //
    // Pinning every value would fail on any unrelated change — a new confidence
    // note, a different duration, one more finding — and a test that cries wolf
    // on every commit gets deleted, which is worse than not having it. The keys
    // are what a consumer wrote code against, so a field that appears or
    // disappears must break this test and be re-stated here on purpose, with
    // `GEOQA_SCHEMA_VERSION` bumped if the change breaks an existing reader.
    //
    // This is the assembler's own output. `journeyRun` adds `warnings` on top for
    // the CLI; everything below is common to every path that produces a result.
    const result = assembleResult({
      spec: spec(),
      profile: profile(),
      geo: await geoOf(),
      journey: journeyResult(),
      manifest: null,
      startedAt: "t",
      durationMs: 1,
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        "confidence",
        "durationMs",
        "evidenceId",
        "findings",
        "geo",
        "journeyId",
        "profileId",
        "runId",
        "schemaVersion",
        "startedAt",
        "target",
        "verdict",
      ].sort(),
    );
  });

  it("VERSIONS the result, so a consumer can detect a breaking change instead of crashing on it", async () => {
    const result = assembleResult({
      spec: spec(),
      profile: profile(),
      geo: await geoOf(),
      journey: journeyResult(),
      manifest: null,
      startedAt: "t",
      durationMs: 1,
    });
    // One number for both consumed artifacts: the run result and the manifest it
    // points at are read as one contract.
    expect(result.schemaVersion).toBe(GEOQA_SCHEMA_VERSION);
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

describe("applyDeviceProfile", () => {
  it("sets the viewport from the profile's device", async () => {
    const calls: [number, number][] = [];
    const warnings = await applyDeviceProfile(
      fakeRuntime({
        setViewport: (w, h) => {
          calls.push([w, h]);
          return Promise.resolve(ok(null));
        },
      }),
      profile(),
    );
    expect(calls).toEqual([[390, 844]]);
    expect(warnings).toEqual([]);
  });

  it("emulates a named device first when the profile asks for one", async () => {
    const devices: string[] = [];
    const p = profile();
    await applyDeviceProfile(
      fakeRuntime({
        setDevice: (name) => {
          devices.push(name);
          return Promise.resolve(ok(null));
        },
      }),
      { ...p, device: { ...p.device, emulate: "iPhone 15 Pro" } },
    );
    expect(devices).toEqual(["iPhone 15 Pro"]);
  });

  it("WARNS rather than throwing when the browser refuses — a wrong viewport is a finding, not a crash", async () => {
    const p = profile();
    const warnings = await applyDeviceProfile(
      fakeRuntime({
        setDevice: () => Promise.resolve(bad()),
        setViewport: () => Promise.resolve(bad()),
      }),
      { ...p, device: { ...p.device, emulate: "iPhone 15 Pro" } },
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('could not emulate device "iPhone 15 Pro"');
    expect(warnings[1]).toContain("could not set viewport 390×844");
  });
});

describe("verifyEnvironment corroboration", () => {
  /** ipinfo first, then geojs — the order `verifyEnvironment` reads them in. */
  const twoSources = (second: string): BrowserRuntime => {
    const bodies = [IPINFO_OSLO, second];
    let call = 0;
    return fakeRuntime({ getText: () => Promise.resolve(ok(bodies[call++] ?? "")) });
  };

  it("does NOT read a second source unless asked", async () => {
    // Off by default here: this runs once per RUN, and a 430-page sweep would spend
    // 430 extra probes against a free endpoint's monthly allowance.
    const opened: string[] = [];
    const runtime = fakeRuntime({
      open: (url) => {
        opened.push(url);
        return Promise.resolve(ok({ url, title: "T", targetId: "t", launchHash: "h", browserLaunched: false }));
      },
    });
    const geo = await verifyEnvironment(runtime, profile(), "https://ipinfo.io/json");
    expect(opened).toEqual(["https://ipinfo.io/json"]);
    expect(geo.network.corroborating).toBeNull();
    expect(geo.network.agreement.verdict).toBe("unverified");
  });

  it("reads the second source and reports agreement when asked", async () => {
    const agreeing = JSON.stringify({ ip: "213.52.15.251", country_code: "NO", city: "Oslo" });
    const geo = await verifyEnvironment(twoSources(agreeing), profile(), "https://ipinfo.io/json", true);
    expect(geo.network.agreement.verdict).toBe("match");
    expect(geo.network.corroborating?.country).toBe("NO");
  });

  it("reports a country disagreement, and it costs the run its trustworthiness", async () => {
    const contradicting = JSON.stringify({ ip: "213.52.15.251", country_code: "US", city: "New York" });
    const geo = await verifyEnvironment(twoSources(contradicting), profile(), "https://ipinfo.io/json", true);
    expect(geo.network.agreement.verdict).toBe("mismatch");
    expect(geo.trustworthy).toBe(false);
    // Both readings survive, because "which of these is wrong" is the question the
    // reader is left holding.
    expect(geo.network.observed.country).toBe("NO");
    expect(geo.network.corroborating?.country).toBe("US");
  });

  it("does not manufacture a disagreement out of a second source that could not answer", async () => {
    // The endpoint answers a bad path with openresty HTML. Read as "no country" it
    // would disagree with every primary reading forever.
    const failed = "<html><title>404 Not Found</title></html>";
    const geo = await verifyEnvironment(twoSources(failed), profile(), "https://ipinfo.io/json", true);
    expect(geo.network.agreement.verdict).toBe("unverified");
    expect(geo.network.agreement.reasons[0]).toContain("corroborating source read no country");
  });

  it("is carried on the SPEC, so a durable run and a local run corroborate identically", () => {
    // Same reason `seed` and `engine` are on the spec: a Temporal Activity rebuilds
    // every stage from serialisable arguments.
    expect(spec({ corroborateGeo: true }).corroborateGeo).toBe(true);
    expect(spec().corroborateGeo).toBe(false);
  });
});

describe("content capture", () => {
  const contentJson = JSON.stringify({
    wordCount: 640, shingles: ["a b c d e"], headings: ["Heading"], h1Count: 1, internalLinks: ["/faq"], title: "T",
  });

  /** A runtime that answers the content read as a real browser would. */
  const withContent = (answer: string | null): BrowserRuntime =>
    fakeRuntime({
      evaluate: <T,>(expression: string) =>
        Promise.resolve(
          expression.includes("wordCount")
            ? answer === null
              ? bad<T>()
              : ok(answer as unknown as T)
            : ok(BROWSER_ENV_OSLO as unknown as T),
        ),
    });

  it("writes content.json so the site-wide signals have inputs at all", async () => {
    // Its own artifact rather than a field on run.json, because its value is entirely
    // cross-run: thin pages, orphans and near-duplicates are comparisons BETWEEN pages.
    const manifest = await collectEvidence(withContent(contentJson), {
      spec: spec(),
      profile: profile(),
      geo: await geoOf(),
      journey: journeyResult(),
      createdAt: "2026-08-12T00:00:00.000Z",
    });
    expect(manifest.artifacts.map((a) => a.label)).toContain("content");
    const written = JSON.parse(readFileSync(path.join(root, "run_1", "content.json"), "utf8")) as { wordCount: number };
    expect(written.wordCount).toBe(640);
  });

  it("a failed content read costs the ARTIFACT, never the run", async () => {
    // The content read is a bonus observation. A run that verified geography and executed its
    // journey has not failed because a word count could not be taken.
    const manifest = await collectEvidence(withContent(null), {
      spec: spec(),
      profile: profile(),
      geo: await geoOf(),
      journey: journeyResult(),
      createdAt: "2026-08-12T00:00:00.000Z",
    });
    expect(manifest.artifacts.map((a) => a.label)).not.toContain("content");
    // And the manifest is otherwise complete — the run stands.
    expect(manifest.artifacts.map((a) => a.label)).toContain("run");
  });
})
