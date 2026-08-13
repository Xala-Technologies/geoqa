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
import { loadJourney } from "../src/journeys/spec.js";
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
  // Off, so the e2e never reaches a third-party endpoint: it drives the local
  // fixture server, and a corroborating lookup would make every run depend on a
  // third party being up.
  corroborateGeo: false,
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

/**
 * The per-step record, read back off disk.
 *
 * `GeoQaRunResult` carries findings, and a step that PASSED produces none — so
 * the only way to assert that a step ran, and ran in the right order, is the
 * evidence. Which is the right place for it: if the evidence cannot answer "did
 * this step happen", neither can anybody reading it later.
 */
const journeySteps = (runId: string): { action: string; label: string; outcome: string }[] =>
  (
    JSON.parse(readFileSync(evidenceFile(runId, "run.json"), "utf8")) as {
      journey: { steps: { action: string; label: string; outcome: string }[] };
    }
  ).journey.steps;

/** How many steps a journey file declares, so no test hardcodes a count. */
const declaredStepCount = (file: string): number => {
  const loaded = loadJourney(path.join(journeysDir, file), (p) => readFileSync(p, "utf8"));
  if (!loaded.ok) throw new Error(loaded.errors.join("\n"));
  return loaded.value.steps.length;
};

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

  it("leaves NO network.har behind, though one was recorded the whole time", () => {
    // The retention hole this test exists for. `harPath` is armed on every run — a HAR cannot
    // be started retroactively for the run that turns out to need one — and Playwright flushes
    // it at close whether anything asked or not. So a passing run, whose whole point is to keep
    // almost nothing, used to leave a full network recording on disk that no manifest listed.
    // Nothing would ever have removed it either: pruning walks the manifest.
    //
    // "Never call stop" was enough for the trace. The HAR's flush is not ours to skip, so the
    // pass tier deletes it after the close instead.
    expect(existsSync(evidenceFile("e2e_healthy", "network.har"))).toBe(false);
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

  it("KEEPS A HAR, and the manifest no longer reports one it is about to have", () => {
    // This assertion is the inverse of what it used to be, and the change is the whole point of
    // the fix. HAR is a context-creation option in Playwright, flushed only when the context
    // CLOSES — so evidence collected before the close described a file that did not exist yet,
    // `missing` listed `har`, and fail-tier completeness sat at 88% for a recording that landed
    // on disk seconds later when the run's `finally` closed the same context.
    //
    // `harStop` now closes the context, because on this engine that IS the flush. Collected
    // last, after every live read, for the same reason.
    const har = evidenceFile("e2e_missing_cta", "network.har");
    expect(existsSync(har)).toBe(true);
    expect(statSync(har).size).toBeGreaterThan(0);

    const manifest = JSON.parse(readFileSync(evidenceFile("e2e_missing_cta", "manifest.json"), "utf8")) as {
      tier: string;
      missing: string[];
      completeness: number;
    };
    expect(manifest.tier).toBe("fail");
    expect(manifest.missing).not.toContain("har");
    expect(manifest.completeness).toBe(100);
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
    // Optional steps are RECORDED as skipped, never dropped: the executed list is
    // exactly as long as the file declares, whichever way the draws went. Derived
    // from the journey rather than hardcoded — a literal count here broke the suite
    // for a correct change to the journey, and a test that fails when the thing it
    // guards is working gets ignored.
    expect(journey.steps).toHaveLength(declaredStepCount("reader.yaml"));
    expect(journey.steps.some((s) => s.action === "pause" && s.outcome === "passed")).toBe(true);
    expect(journey.steps.some((s) => s.outcome === "skipped")).toBe(true);
  });
});

describe("a client-rendered page whose body is EMPTY at load", () => {
  it("does not report a text check against the pre-hydration shell", async () => {
    // Found by pointing the engine at a second real site. `getText` is `innerText`, and
    // Playwright auto-waits only for the element to be ATTACHED — so on a client-rendered site
    // the read returns zero characters before hydration, every text check compares against an
    // empty string, and the result is filed as a SITE finding.
    //
    // Measured on xala.no: 0 characters at `load`, 6,077 one second later. The engine reported
    // "page carries the market's language marker — 0 chars read" against a page whose
    // `<html lang>` is `nb-NO` and entirely correct. `/hydrates-late` reproduces it at 300ms.
    const result = await run({
      runId: "e2e_hydrates_late",
      target: `${fixtures.origin}/hydrates-late`,
      journeyPath: path.join(journeysDir, "localization.yaml"),
      // The language marker is the DOCUMENT's declaration; the copy marker is the prose. They
      // were one variable while the check read `innerText` and looked for an attribute in it.
      vars: { expectLanguageMarker: "nb", expectCopyMarker: "saksbehandlingssystemer", forbiddenCurrency: "USD" },
    });
    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
  });

  it("REFUSES the check rather than blaming the page when nothing renders at all", async () => {
    // A settle is not a guarantee, and the engine does not pretend it is. `/no-links` renders a
    // page with no body text, and "the page rendered nothing" is indistinguishable from "we
    // looked too early" — so it is OUR defect, not a site failure. An ERROR still blocks the
    // publish gate: a different sentence, the same outcome.
    const result = await run({
      runId: "e2e_no_text",
      target: `${fixtures.origin}/empty-body`,
      journeyPath: path.join(journeysDir, "localization.yaml"),
      // The attribute check PASSES here — the shell carries `lang="nb-NO"` whether or not the
      // body rendered — so only the copy check is unreadable, which is exactly the split being
      // asserted: a page that rendered nothing is our defect on the reads that need text and
      // nobody's defect on the read that does not.
      vars: { expectLanguageMarker: "nb", expectCopyMarker: "kr", forbiddenCurrency: "USD" },
    });
    expect(result.verdict).toBe("ERROR");
    // Filed against US, never against the page — and this assertion caught a second defect
    // when it was first written. `localization.yaml` declares `category: localization` on both
    // text steps, and `categoryFor` read the declaration BEFORE the errored check, so an
    // unreadable step was filed as a localization defect titled "Could not verify: …".
    expect(result.findings.every((f) => f.category === "instrumentation")).toBe(true);
    expect(result.findings.every((f) => f.title.startsWith("Could not verify"))).toBe(true);
  });
});

describe("a localization failure, in each of its two halves", () => {
  /**
   * The check the `localization` journey is named for could not detect the thing it was named
   * for. It read `innerText` and looked for a marker living in `<html lang>` — and `innerText`
   * never returns attributes, so it could not pass on ANY site, correctly localised or not.
   *
   * Both halves are exercised because a journey asserting only one passes a site that got the
   * other wrong, and both failures are real: `lang="en"` over Norwegian prose is digilist.no,
   * and `lang="nb-NO"` over English prose is a half-finished translation.
   */
  const localizationRun = (runId: string, page: string): Promise<GeoQaRunResult> =>
    run({
      runId,
      target: `${fixtures.origin}${page}`,
      journeyPath: path.join(journeysDir, "localization.yaml"),
      vars: { expectLanguageMarker: "nb", expectCopyMarker: "kr", forbiddenCurrency: "USD" },
    });

  it("catches a page that DECLARES the wrong language, however Norwegian its prose", async () => {
    const result = await localizationRun("e2e_wrong_lang_attr", "/wrong-lang-attr");
    expect(result.verdict).toBe("FAIL");
    const finding = result.findings.find((f) => f.title === "page declares the market's language");
    expect(finding?.observed).toBe('"en"');
    // A real site finding, not our defect — the engine read the page correctly and the page is
    // wrong. That distinction is the one this whole system is built on.
    expect(finding?.category).toBe("localization");
    // And the copy check passes on the same page, which is what makes the pair necessary: the
    // old single check read this prose, found Norwegian, and reported nothing.
    const steps = journeySteps("e2e_wrong_lang_attr");
    expect(steps.find((s) => s.label === "the copy is in the market's language")?.outcome).toBe("passed");
  });

  it("catches a page that declares Norwegian and serves English COPY", async () => {
    // Declaring a language is not writing it. The attribute check alone would call this correct.
    const result = await localizationRun("e2e_wrong_copy", "/wrong-copy");
    expect(result.verdict).toBe("FAIL");
    const steps = journeySteps("e2e_wrong_copy");
    expect(steps.find((s) => s.label === "page declares the market's language")?.outcome).toBe("passed");
    expect(steps.find((s) => s.label === "the copy is in the market's language")?.outcome).toBe("failed");
    // The forbidden-currency check earns its place here too: this page prices in USD.
    expect(steps.find((s) => s.label === "no foreign currency leaked in")?.outcome).toBe("failed");
  });

  it("passes a page that gets BOTH right", async () => {
    // The control. Without it, a journey that failed everything would look like it worked.
    const result = await localizationRun("e2e_localized_ok", "/hydrates-late");
    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
  });
});

describe("a returning visitor, across TWO runs", () => {
  /**
   * The only case in this suite that needs more than one run, and the reason B-7 stayed open
   * with its mechanism finished.
   *
   * `storageState` is written when the context CLOSES, so "the session survived" is not a claim
   * a single run can make about itself. Every other case here is one run; this one seeds a
   * session and then proves the next run inherited it.
   *
   * Both runs happen in `beforeAll` rather than one per `it`, so the second assertion does not
   * silently depend on the first having executed. That coupling would have held today —
   * `fileParallelism: false` and vitest runs `it`s in order — and it would have made
   * `-t "is RECOGNISED"` fail on its own, which is the kind of test nobody trusts twice.
   */
  let first: GeoQaRunResult;
  let second: GeoQaRunResult;

  const visitorRun = (runId: string): Promise<GeoQaRunResult> =>
    run({
      runId,
      target: `${fixtures.origin}/returning`,
      profilePath: path.join(profilesDir, "oslo-desktop-returning.yaml"),
      journeyPath: path.join(journeysDir, "returning-visitor.yaml"),
    });

  const visitorRecord = (runId: string): { declared: string; restored: boolean; unmet: string | null } =>
    (
      JSON.parse(readFileSync(evidenceFile(runId, "run.json"), "utf8")) as {
        visitor: { declared: string; restored: boolean; unmet: string | null };
      }
    ).visitor;

  const stateFile = (): string => path.join(evidenceRoot, "visitors", "oslo-desktop-returning.json");

  beforeAll(async () => {
    first = await visitorRun("e2e_visitor_first");
    second = await visitorRun("e2e_visitor_second");
  });

  it("tests a FIRST-TIME visitor on the first run, and says so rather than claiming otherwise", () => {
    // The honest half. A profile declaring `returning` cannot be one until some run has seeded
    // the session, and the evidence records what was actually tested — not what the profile
    // asked for. A run that recorded `visitorType: returning` either way would make a
    // first-time visit and a returning one indistinguishable, which is the same class of lie as
    // an unmeasured metric reported as fine.
    expect(first.verdict).toBe("FAIL");

    const visitor = visitorRecord("e2e_visitor_first");
    expect(visitor.declared).toBe("returning");
    expect(visitor.restored).toBe(false);
    expect(visitor.unmet).toContain("tested a FIRST-TIME visitor");

    // And the session is saved anyway, or no run would ever get to be a returning one.
    expect(existsSync(stateFile())).toBe(true);
  });

  it("is RECOGNISED on the second run, which is the whole claim", () => {
    // The proof. Same profile, same page, same journey — and the only thing that changed is a
    // cookie restored from the file the previous run wrote. The fixture's two branches are
    // otherwise identical (200, a heading, links), so nothing else in the journey can account
    // for the difference.
    expect(second.verdict).toBe("PASS");
    expect(second.findings).toEqual([]);

    const visitor = visitorRecord("e2e_visitor_second");
    expect(visitor.restored).toBe(true);
    expect(visitor.unmet).toBeNull();

    // The step that carries the claim actually ran and passed, rather than being skipped by an
    // earlier halt — a PASS with the load-bearing step missing would prove nothing.
    const step = journeySteps("e2e_visitor_second").find((s) => s.label === "the site recognises this browser");
    expect(step?.outcome).toBe("passed");
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

describe("the search journey, end to end — the first journey that CLICKS", () => {
  /**
   * The capability this proves, and why a unit test could not.
   *
   * No journey in this repo clicked anything: `browse.yaml` has zero click steps,
   * so `runtime.click` was exercised only by adapter-level tests against a fake.
   * A fake click always "succeeds" — it cannot tell you whether the browser
   * followed a link, whether the next page loaded, or whether the step ordering
   * lets a check run against the page it was written for. Three real navigations
   * here: land, submit a search, open a result.
   */
  let result: GeoQaRunResult;

  beforeAll(async () => {
    result = await run({
      runId: "e2e_search",
      target: `${fixtures.origin}/search`,
      journeyPath: path.join(journeysDir, "search.yaml"),
      // The term is a variable because an empty result set is a CORRECT answer to a
      // query, so the count check is only honest when the caller knows the term
      // matches. The fixture returns three results for anything.
      vars: { query: "booking" },
    });
  });

  it("passes, having typed, submitted and clicked through to a result", () => {
    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
  });

  it("reports NO instrumentation findings — a real browser answered every read", () => {
    // If the click could not be performed at all, THIS is where it shows up, and
    // it would be our defect rather than the site's.
    expect(result.findings.filter((f) => f.category === "instrumentation")).toEqual([]);
  });

  it("left the search page, clicked a result, and verified the page it landed on", () => {
    // The failure this journey exists to catch renders perfectly: the box accepts
    // input, the button submits, and the visitor is still where they started.
    // Everything after the click describes the RESULT page — step ordering through a
    // real navigation is precisely what a fake click cannot verify.
    const steps = journeySteps("e2e_search");
    const outcome = (label: string): string | undefined => steps.find((step) => step.label === label)?.outcome;
    expect(outcome("went to a results page")).toBe("passed");
    expect(outcome("open the first result")).toBe("passed");
    expect(outcome("the result page has a heading")).toBe("passed");
    expect(outcome("the result is not a dead link")).toBe("passed");
    // One click step, and it really is a click.
    expect(steps.filter((step) => step.action === "click")).toHaveLength(1);
  });

  it("captured a screenshot of the RESULT page, which only exists past the click", () => {
    // A passing step leaves no trace in `GeoQaRunResult` — only failures become
    // findings. The screenshots are the artifact that proves the ordering: three
    // labels, taken before the search, on the results page, and on the page reached
    // by clicking. The last one cannot be written unless the click's downstream
    // steps ran.
    for (const file of ["before-search.png", "results.png", "result-page.png"]) {
      expect(existsSync(evidenceFile("e2e_search", file)), file).toBe(true);
      expect(statSync(evidenceFile("e2e_search", file)).size, file).toBeGreaterThan(0);
    }
  });

  it("holds one egress identity across all three navigations", () => {
    // A journey with more navigations has more chances to rotate, so this is a
    // stronger reading of `egressHeld` than the single-page journeys give.
    expect(result.geo.network.egressHeld.verdict).toBe("match");
  });
});

describe("a results page whose links are dead", () => {
  it("reports the dead result — the only positive proof the click NAVIGATED", async () => {
    // `no-http-4xx` here sits on a step that runs AFTER the click, so this finding
    // cannot appear unless the browser really followed the link. A fake click always
    // succeeds and would report nothing. It is also a defect worth catching on a
    // real site: a results page that renders perfectly and offers three 404s.
    const dead = await run({
      runId: "e2e_search_dead",
      target: `${fixtures.origin}/search-dead`,
      journeyPath: path.join(journeysDir, "search.yaml"),
      vars: { query: "booking" },
    });
    expect(dead.verdict).toBe("FAIL");
    const finding = dead.findings.find((f) => f.stepLabel === "the result is not a dead link");
    expect(finding).toBeDefined();
    expect(finding?.category).toBe("http");
    // OUR defect would be an instrumentation category. This is the site's.
    expect(dead.findings.filter((f) => f.category === "instrumentation")).toEqual([]);
  });
});

describe("a search that legitimately found nothing", () => {
  it("is NOT reported as a defect by the checks that do not count results", () => {
    // An empty result set is a correct answer to a query. The engine must be able
    // to visit that page and say nothing is wrong with it — otherwise every search
    // for an absent term becomes a false finding, which is the exact class of
    // failure that made six good digilist.no pages look broken.
    return run({ runId: "e2e_search_empty", target: `${fixtures.origin}/search-empty` }).then((empty) => {
      expect(empty.verdict).toBe("PASS");
      expect(empty.findings).toEqual([]);
    });
  });
});

describe("a manual language override", () => {
  /**
   * The vars every run needs, and the markers are the point.
   *
   * Both are in the nav of every page of their language and of no page of the
   * other. "Velkommen" was the first choice and it is on the homepage only, which
   * made the persistence check vacuous one click later — the broken-override run
   * reported PASS. A marker has to live in the site chrome.
   */
  const vars = { leavingMarker: "Om oss", arrivingMarker: "About us", overrideUrlPattern: "/en/" };

  it("PASSES when the visitor's choice survives the next navigation", async () => {
    const result = await run({
      runId: "e2e_lang_ok",
      target: `${fixtures.origin}/lang`,
      journeyPath: path.join(journeysDir, "language-override.yaml"),
      vars,
    });
    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
    const steps = journeySteps("e2e_lang_ok");
    const outcome = (label: string): string | undefined => steps.find((step) => step.label === label)?.outcome;
    expect(outcome("the site chose the local language")).toBe("passed");
    expect(outcome("the switch navigated")).toBe("passed");
    expect(outcome("the chosen language SURVIVED the next navigation")).toBe("passed");
    // Two clicks: the switcher and the onward link. Both real navigations.
    expect(steps.filter((step) => step.action === "click")).toHaveLength(2);
  });

  it("FAILS when a geo-redirect silently undoes the choice on the next click", async () => {
    // Without this the journey asserts nothing. The switch works, and then
    // `/en/lang-ignored` sets no cookie and links onward unprefixed, so the visitor
    // is returned to Norwegian — the exact bug, and invisible to every other check:
    // 200, a heading, and the wrong language.
    const result = await run({
      runId: "e2e_lang_lost",
      target: `${fixtures.origin}/lang-broken`,
      journeyPath: path.join(journeysDir, "language-override.yaml"),
      vars,
    });
    expect(result.verdict).toBe("FAIL");
    const finding = result.findings.find((f) => f.stepLabel === "the chosen language SURVIVED the next navigation");
    expect(finding).toBeDefined();
    expect(finding?.category).toBe("localization");
    expect(finding?.severity).toBe("critical");
    // The site's defect, not ours.
    expect(result.findings.filter((f) => f.category === "instrumentation")).toEqual([]);
  });

  it("carries the choice on a COOKIE too, so an unprefixed page answers in English", async () => {
    // The returning-visitor half, demonstrated inside one run and with no
    // storageState: `/lang-deeper` has no `/en/` prefix, so it can only answer in
    // English by reading the cookie the switch set.
    const cookieJourney = journeySteps("e2e_lang_ok");
    expect(cookieJourney.find((step) => step.label === "navigate onward")?.outcome).toBe("passed");
    const page = await fetch(`${fixtures.origin}/lang-deeper`, { headers: { cookie: "lang=en" } });
    expect(await page.text()).toContain("en-GB");
    const withoutCookie = await fetch(`${fixtures.origin}/lang-deeper`);
    expect(await withoutCookie.text()).toContain("nb-NO");
  });
});

describe("inp-below, against a page that is actually slow to respond", () => {
  /**
   * The only honest way to prove this check.
   *
   * A fake runtime returning a number proves the comparison and never that an
   * interaction was timed. And every other fixture produces `inp: null` even after a
   * real click, because Chromium reports event-timing entries only above a threshold
   * — a page with no expensive handler responds too fast to generate one. So the
   * proof needs a page that genuinely blocks, and `/slow-interaction` blocks ~120ms.
   */
  const journeyPath = path.join(journeysDir, "..", "e2e", "fixtures", "inp.yaml");

  it("MEASURES a real INP and compares it against the budget", async () => {
    const result = await run({ runId: "e2e_inp", target: `${fixtures.origin}/slow-interaction`, journeyPath });
    const inp = journeySteps("e2e_inp").find((step) => step.label === "responds within 200ms");
    expect(inp?.outcome).toBe("passed");
    // A real number, not an absence read as a pass.
    const vitals = JSON.parse(readFileSync(evidenceFile("e2e_inp", "vitals.json"), "utf8")) as { inp: number | null };
    expect(vitals.inp).not.toBeNull();
    expect(vitals.inp).toBeGreaterThan(16);
  });

  it("produces a FINDING on the same page at a budget it genuinely misses", async () => {
    // Without this the pass above could be a check that always passes.
    //
    // The verdict is PASS_WITH_WARNINGS rather than FAIL, and that is the severity
    // model working: severity is declared per step, and this step declares `medium`.
    // A responsiveness budget is a signal, not a gate — one interaction is a thin
    // sample. Asserting FAIL here would have been asserting a severity the journey
    // never asked for.
    const strict = path.join(journeysDir, "..", "e2e", "fixtures", "inp-strict.yaml");
    const result = await run({ runId: "e2e_inp_strict", target: `${fixtures.origin}/slow-interaction`, journeyPath: strict });
    expect(result.verdict).toBe("PASS_WITH_WARNINGS");
    const finding = result.findings.find((f) => f.stepLabel === "responds within 20ms");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("medium");
    // The site's slowness, not our failure to read it — an unread INP would have
    // been `instrumentation` and would have made the whole run ERROR.
    expect(finding?.category).not.toBe("instrumentation");
    expect(finding?.observed).toMatch(/^\d+ms$/);
  });
});
