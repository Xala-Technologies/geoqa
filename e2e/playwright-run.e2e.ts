/**
 * End-to-end: a real Chromium, driven by the real `executeRun`, against a real
 * HTTP server, writing real evidence to a real directory.
 *
 * What this suite is FOR, and why the unit tests do not make it redundant: every
 * unit test in this repo injects a fake runtime, which proves the judgement is
 * right about a reading it was handed. It cannot prove the reading is real. This
 * suite is the only thing that exercises `playwright-launch.ts` — the layer that
 * maps Playwright's API onto the structural interfaces — and the only place the
 * claims about a Playwright CONTEXT are actually tested rather than asserted:
 * that `locale` moves `navigator.language`, that `timezoneId` moves `Intl`, that
 * the viewport is what the page renders at, and that the geolocation permission
 * is GRANTED rather than denied.
 *
 * Deliberately offline. The verify endpoint points at a fixture route, so
 * nothing here depends on ipinfo.io being up or on where this machine sits —
 * both of which would make a failure ambiguous.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServer } from "../src/fixtures/server.js";
import { directProvider } from "../src/network/provider.js";
import { executeRun } from "../src/run/execute.js";
import { traceArtifactFormat } from "../src/run/stages.js";
import type { RunSpec } from "../src/run/context.js";
import type { GeoQaRunResult } from "../src/findings/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profilesDir = path.join(repoRoot, "profiles");
const journeysDir = path.join(repoRoot, "journeys");

let fixtures: FixtureServer;
let evidenceRoot: string;

beforeAll(async () => {
  fixtures = await startFixtureServer();
  evidenceRoot = mkdtempSync(path.join(tmpdir(), "geoqa-e2e-"));
});

afterAll(async () => {
  await fixtures.close();
  rmSync(evidenceRoot, { recursive: true, force: true });
});

const spec = (over: Partial<RunSpec> & { runId: string; target: string }): RunSpec => ({
  engine: "playwright",
  // Fixed, so a run that pauses or takes an optional step does the same thing on
  // every CI machine. That reproducibility is the whole point of seeding.
  seed: 20_260_812,
  profilePath: path.join(profilesDir, "oslo-mobile.yaml"),
  journeyPath: path.join(journeysDir, "landing-page.yaml"),
  evidenceRoot,
  proxyUrl: null,
  proxyBypass: null,
  // Playwright takes locale and coordinates as context options, so the init
  // script agent-browser needed is not used on this engine.
  initScriptPath: null,
  vars: {},
  headed: false,
  verifyEndpoint: `${fixtures.origin}/ipinfo`,
  ...over,
});

const run = (over: Partial<RunSpec> & { runId: string; target: string }): Promise<GeoQaRunResult> =>
  executeRun({ spec: spec(over), provider: directProvider() });

const evidenceFile = (runId: string, file: string): string => path.join(evidenceRoot, runId, file);

describe("a healthy page, end to end", () => {
  let result: GeoQaRunResult;

  beforeAll(async () => {
    result = await run({ runId: "e2e_healthy", target: `${fixtures.origin}/healthy` });
  });

  it("passes the journey", () => {
    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
  });

  it("reports NO instrumentation findings — a real browser answered every read", () => {
    // The distinction the whole engine rests on: if any of these appear, the
    // adapter failed to read something, and no site claim in this run is safe.
    expect(result.findings.filter((f) => f.category === "instrumentation")).toEqual([]);
  });

  it("proves the CONTEXT carries the profile's locale, clock and viewport", () => {
    const browser = result.geo.browser;
    expect(browser.observed.language).toBe("nb-NO");
    expect(browser.observed.timezone).toBe("Europe/Oslo");
    expect(browser.observed.viewport).toEqual({ width: 390, height: 844 });
    expect(browser.language.verdict).toBe("match");
    expect(browser.timezone.verdict).toBe("match");
    expect(browser.viewport.verdict).toBe("match");
  });

  it("GRANTS the geolocation permission instead of stubbing it", () => {
    // Under agent-browser this was always "denied", so `localeInitScript` had to
    // overwrite navigator.geolocation. A Playwright context grants it, which is
    // why a site localising off the real API can now be tested through the real
    // path rather than against a fake.
    expect(result.geo.browser.observed.geolocation).toEqual({
      latitude: 59.9139,
      longitude: 10.7522,
    });
  });

  it("reads the egress identity through the browser and confirms it held", () => {
    expect(result.geo.network.observed.country).toBe("NO");
    expect(result.geo.network.observed.ip).toBe("213.52.15.251");
    expect(result.geo.network.country.verdict).toBe("match");
    // Opening and closing reads agree, so one journey was one network session.
    expect(result.geo.network.egressHeld.verdict).toBe("match");
  });

  it("measures Core Web Vitals from the page's own timeline", () => {
    // Playwright has no `vitals` command; these come from the injected
    // PerformanceObserver read. A real number here is the proof it works.
    const vitals = JSON.parse(readFileSync(evidenceFile("e2e_healthy", "vitals.json"), "utf8")) as {
      lcp: number | null;
      cls: number | null;
      ttfb: number | null;
    };
    expect(vitals.lcp).toBeGreaterThan(0);
    expect(vitals.ttfb).toBeGreaterThanOrEqual(0);
    expect(vitals.cls).not.toBeNull();
  });

  it("writes a complete evidence package for the pass tier", () => {
    for (const file of ["run.json", "manifest.json", "hero.png", "mid-page.png", "vitals.json"]) {
      expect(existsSync(evidenceFile("e2e_healthy", file)), file).toBe(true);
      expect(statSync(evidenceFile("e2e_healthy", file)).size, file).toBeGreaterThan(0);
    }
    expect(result.confidence.evidence).toBe(100);
  });
});

describe("an injected defect, end to end", () => {
  let result: GeoQaRunResult;

  beforeAll(async () => {
    // /missing-cta has no <h1> at all, which the landing-page journey asserts on
    // at critical severity.
    result = await run({ runId: "e2e_missing_cta", target: `${fixtures.origin}/missing-cta` });
  });

  it("files the missing heading as a SITE defect, not as our own blindness", () => {
    expect(result.verdict).toBe("FAIL");
    const finding = result.findings.find((f) => f.stepLabel === "has a primary heading");
    expect(finding).toBeDefined();
    expect(finding?.category).toBe("functional");
    expect(finding?.severity).toBe("critical");
    // A check that read the page and found it wrong is near-certain.
    expect(finding?.confidence).toBeGreaterThanOrEqual(90);
  });

  it("confirms absence rather than reporting the first miss", () => {
    // The retry exists because an element mid-animation also reads false. Here
    // the element is genuinely absent, so the confirm must still say so.
    expect(result.findings.some((f) => f.category === "instrumentation")).toBe(false);
  });

  it("KEEPS A TRACE, because the fail tier is the one a human opens", () => {
    // Nothing used to start tracing, so every fail-tier trace.json landed at
    // zero bytes and the manifest honestly reported 88% completeness.
    // Derived, not hardcoded: the two engines write different formats to the
    // `trace` artifact kind — agent-browser a Chrome JSON trace, Playwright a
    // zip — and a literal filename here drifted the moment that was fixed.
    const trace = evidenceFile("e2e_missing_cta", traceArtifactFormat("playwright").file);
    expect(existsSync(trace)).toBe(true);
    expect(statSync(trace).size).toBeGreaterThan(0);
  });

  it("records what it could NOT collect rather than looking complete", () => {
    const manifest = JSON.parse(readFileSync(evidenceFile("e2e_missing_cta", "manifest.json"), "utf8")) as {
      tier: string;
      missing: string[];
      completeness: number;
    };
    expect(manifest.tier).toBe("fail");
    // HAR is a context-creation option in Playwright and is refused mid-session,
    // so it must show up as genuinely missing — not as a file that exists and
    // contains nothing.
    expect(manifest.missing).toContain("har");
    expect(manifest.completeness).toBeLessThan(100);
  });
});

describe("a contact form, filled and submitted for real", () => {
  let result: GeoQaRunResult;

  beforeAll(async () => {
    result = await run({
      runId: "e2e_contact",
      target: `${fixtures.origin}/contact`,
      journeyPath: path.join(journeysDir, "contact-form.yaml"),
      vars: { name: "QA Runner", email: "qa@example.test", message: "Hei, dette er en test." },
    });
  });

  it("fills every control, submits, and reads the confirmation a visitor would see", () => {
    // The whole input half of the DSL, proven against a real browser: fill,
    // select, check, and a submit that the server actually answers.
    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
  });

  it("NEVER writes what was typed into the evidence package", () => {
    // The rule that makes the same DSL safe for registration and login. The
    // values came in through --var; nothing may carry them to disk.
    const runJson = readFileSync(evidenceFile("e2e_contact", "run.json"), "utf8");
    expect(runJson).not.toContain("QA Runner");
    expect(runJson).not.toContain("Hei, dette er en test.");
    // The email would also be caught by redaction, but it must never get there.
    expect(runJson).not.toContain("qa@example.test");
    // What IS recorded is which field was filled.
    expect(runJson).toContain("value not recorded");
  });

  it("records that the run changed state, and flags its screenshots for review", () => {
    const manifest = JSON.parse(readFileSync(evidenceFile("e2e_contact", "manifest.json"), "utf8")) as {
      privacyNote: string | null;
      artifacts: { kind: string; risk?: string }[];
    };
    const journey = (
      JSON.parse(readFileSync(evidenceFile("e2e_contact", "run.json"), "utf8")) as {
        journey: { writes: boolean; touchedForm: boolean; seed: number };
      }
    ).journey;
    expect(journey.writes).toBe(true);
    expect(journey.touchedForm).toBe(true);
    // The seed is what makes this exact run — pauses and optional steps —
    // replayable from its own evidence.
    expect(typeof journey.seed).toBe("number");
    // A frame taken mid-form plausibly holds someone's name and email, and no
    // redaction pass can find that in an image. Flagging it is all we can do.
    expect(manifest.artifacts.filter((a) => a.kind === "screenshot").every((a) => a.risk === "review")).toBe(true);
    expect(manifest.privacyNote).toContain("review before sharing");
  });
});

describe("human pacing, end to end", () => {
  it("spends real time reading, and reports the seed that decided how long", async () => {
    const started = Date.now();
    const result = await run({
      runId: "e2e_reader",
      target: `${fixtures.origin}/healthy`,
      journeyPath: path.join(journeysDir, "reader.yaml"),
      // Pauses total at least ~5.4s at the low end of the declared ranges.
      seed: 4,
    });
    const elapsed = Date.now() - started;
    expect(result.verdict).toBe("PASS");
    expect(elapsed).toBeGreaterThan(5_000);

    const journey = (
      JSON.parse(readFileSync(evidenceFile("e2e_reader", "run.json"), "utf8")) as {
        journey: { seed: number; steps: { action: string; outcome: string }[] };
      }
    ).journey;
    expect(journey.seed).toBe(4);
    // Optional steps are RECORDED as skipped, never dropped: the step list is
    // the same length whichever way the draws went.
    expect(journey.steps).toHaveLength(20);
    expect(journey.steps.some((s) => s.action === "pause" && s.outcome === "passed")).toBe(true);
  });
});

describe("a heading that arrives late", () => {
  it("WAITS for it instead of inventing a missing-heading defect", async () => {
    // The regression this exists for: under load, `selector-visible` reported a
    // missing h1 on six digilist.no pages whose HTML demonstrably contained one,
    // and all six passed when re-run alone. The engine was manufacturing site
    // defects out of its own slowness. /slow-heading injects the h1 after 900ms,
    // which exceeds the old 600ms settle — so this fails against poll-and-settle
    // and passes against auto-waiting.
    const result = await run({ runId: "e2e_slow_heading", target: `${fixtures.origin}/slow-heading` });
    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
  });
});

describe("one browser, two network identities", () => {
  /**
   * The claim that justified choosing Playwright: a proxy per CONTEXT, so market
   * coverage does not cost one browser process each.
   *
   * Proven without a vendor by pointing one context at a dead proxy. If the
   * context proxy is honoured, that navigation fails with a PROXY error — and if
   * per-context isolation is real, a second context in the SAME browser reaches
   * the page anyway. It also pins the launcher against the regression this suite
   * already caught once: a launch-level `per-context` placeholder broke every
   * navigation, in both contexts.
   */
  it("applies a proxy to one context without touching the other", async () => {
    const { launchBrowser, openContext } = await import("../src/browser/playwright-launch.js");
    const browser = await launchBrowser(false);
    const base = {
      proxyBypass: null,
      locale: "nb-NO",
      timezoneId: "Europe/Oslo",
      coordinates: { latitude: 59.9139, longitude: 10.7522 },
      viewport: { width: 390, height: 844 },
      userAgent: null,
      deviceName: null,
      headed: false,
    };
    try {
      // Nothing is listening on port 1, so a honoured proxy must fail here.
      const proxied = await openContext(browser, {
        ...base,
        proxyUrl: "http://127.0.0.1:1",
        identity: "ctx-proxied",
      });
      await expect(proxied.page.goto(`${fixtures.origin}/healthy`)).rejects.toThrow(/PROXY|proxy/);

      const direct = await openContext(browser, { ...base, proxyUrl: null, identity: "ctx-direct" });
      await direct.page.goto(`${fixtures.origin}/healthy`);
      expect(await direct.page.title()).toBe("Healthy");
    } finally {
      await browser.close();
    }
  });
});

describe("a page that logs a console error, end to end", () => {
  it("catches it through the context listener registered before first load", async () => {
    // The listener has to be attached at context creation: an error thrown during
    // initial load is exactly what a journey asserts on, and attaching afterwards
    // would miss it while still reporting "no console errors".
    const result = await run({ runId: "e2e_console", target: `${fixtures.origin}/console-error` });
    const finding = result.findings.find((f) => f.stepLabel === "no-console-errors");
    expect(finding).toBeDefined();
    expect(finding?.category).toBe("javascript");
    expect(finding?.observed).toContain("fixture: console");
  });
});
