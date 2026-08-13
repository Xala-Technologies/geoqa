import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGeoProfile } from "../../geo/profile.js";
import type { GeoProfile } from "../../geo/types.js";
import { AgentBrowserRuntime } from "../../browser/agent-browser.js";
import { PlaywrightRuntime } from "../../browser/playwright.js";
import {
  VISITOR_STATE_DIR,
  buildRuntime,
  newEvidenceId,
  newRunId,
  playwrightContextOptions,
  resolveVisitorState,
  runEvidenceDir,
  writeInitScript,
  type RunSpec,
} from "../context.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "geoqa-context-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const profile = (): GeoProfile => {
  const out = loadGeoProfile(path.join(repoRoot, "profiles", "oslo-mobile.yaml"));
  if (!out.ok) throw new Error(out.errors.join());
  return out.value;
};

const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  runId: "run_1",
  engine: "agent-browser",
  seed: 7,
  corroborateGeo: false,
  target: "https://digilist.no",
  profilePath: path.join(repoRoot, "profiles", "oslo-mobile.yaml"),
  journeyPath: path.join(repoRoot, "journeys", "landing-page.yaml"),
  evidenceRoot: root,
  proxyUrl: null,
  proxyBypass: null,
  initScriptPath: null,
  vars: {},
  headed: false,
  verifyEndpoint: "https://ipinfo.io/json",
  ...over,
});

describe("ids and paths", () => {
  it("builds a sortable run id that names its profile", () => {
    expect(newRunId("oslo-mobile", 1_700_000_000_000)).toBe("run_1700000000000_oslo-mobile");
  });

  it("derives the evidence id from the run id", () => {
    expect(newEvidenceId("run_123_oslo")).toBe("ev_123_oslo");
  });

  it("puts a run's evidence in its own directory", () => {
    expect(runEvidenceDir({ evidenceRoot: "/e", runId: "run_1" })).toBe(path.join("/e", "run_1"));
  });
});

describe("writeInitScript", () => {
  it("writes the locale override to the run's evidence directory", () => {
    const file = writeInitScript({ evidenceRoot: root, runId: "run_1" }, profile());
    expect(file).toBe(path.join(root, "run_1", "init-locale.js"));
    const body = readFileSync(file, "utf8");
    expect(body).toContain("nb-NO");
    expect(body).toContain("getCurrentPosition");
  });

  it("is idempotent", () => {
    const a = writeInitScript({ evidenceRoot: root, runId: "run_1" }, profile());
    const b = writeInitScript({ evidenceRoot: root, runId: "run_1" }, profile());
    expect(a).toBe(b);
  });
});

describe("buildRuntime", () => {
  it("uses the run id as the session id, so two runs cannot collide", () => {
    expect(buildRuntime(spec(), profile()).sessionId).toBe("run_1");
  });

  it("survives a round trip through JSON — the property Temporal depends on", () => {
    // An Activity receives its RunSpec as deserialised JSON, so anything that
    // did not survive would silently change the browser's launch identity and
    // route commands to a different browser.
    const original = spec({ proxyUrl: "http://u:p@gw:1", initScriptPath: "/tmp/i.js", vars: { a: "b" } });
    const revived = JSON.parse(JSON.stringify(original)) as RunSpec;
    expect(revived).toEqual(original);
    expect(buildRuntime(revived, profile()).sessionId).toBe(original.runId);
  });
});

describe("playwrightContextOptions", () => {
  it("maps every axis of the profile onto a context option", () => {
    // This mapping is where a wrong axis would silently produce a run that
    // claims Oslo and renders Frankfurt, so each one is pinned.
    const options = playwrightContextOptions(
      spec({ engine: "playwright", proxyUrl: "http://u:p@gw:7777", proxyBypass: "127.0.0.1", headed: true }),
      profile(),
    );
    expect(options).toEqual({
      proxyUrl: "http://u:p@gw:7777",
      proxyBypass: "127.0.0.1",
      locale: "nb-NO",
      timezoneId: "Europe/Oslo",
      coordinates: { latitude: 59.9139, longitude: 10.7522 },
      viewport: { width: 390, height: 844 },
      userAgent: null,
      // No device descriptor: `isMobile` emulation makes the rendered viewport a
      // property of the PAGE, and the viewport axis is read on the probe page.
      deviceName: null,
      headed: true,
      identity: "run_1",
      // Armed at creation for EVERY run: the retention tier is not known until
      // the journey has finished, and a HAR cannot be started retroactively.
      harPath: path.join(root, "run_1", "network.har"),
      // oslo-mobile is anonymous, so there is no session to load and none to keep.
      restoreStatePath: null,
      saveStatePath: null,
    });
  });

  it("gives a returning profile a session to restore ONLY when one is really there", () => {
    const returning = { ...profile(), visitorType: "returning" as const };
    const stateFile = path.join(root, VISITOR_STATE_DIR, `${returning.id}.json`);

    const first = playwrightContextOptions(spec({ engine: "playwright" }), returning);
    // Nothing saved yet: restoring a path Playwright cannot find would fail the
    // launch, so the run proceeds as the first-time visitor it actually is…
    expect(first.restoreStatePath).toBeNull();
    // …and still saves, because otherwise no run ever gets to be a returning one.
    expect(first.saveStatePath).toBe(stateFile);

    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ cookies: [], origins: [] }));
    const second = playwrightContextOptions(spec({ engine: "playwright" }), returning);
    expect(second.restoreStatePath).toBe(stateFile);
    expect(second.saveStatePath).toBe(stateFile);
  });

  it("passes a device and user agent through when the profile declares them", () => {
    const withDevice = { ...profile(), device: { ...profile().device, emulate: "Pixel 5", userAgent: "UA/1" } };
    const options = playwrightContextOptions(spec({ engine: "playwright" }), withDevice);
    expect(options.deviceName).toBe("Pixel 5");
    expect(options.userAgent).toBe("UA/1");
  });
});

describe("resolveVisitorState", () => {
  const returning = (): GeoProfile => ({ ...profile(), visitorType: "returning" });
  const never = (): boolean => false;
  const always = (): boolean => true;

  it("keeps an anonymous visitor anonymous in BOTH directions", () => {
    // Nothing restored, and — the half that is easy to miss — nothing saved: a
    // state file written here would make the NEXT run of this profile a returning
    // visitor nobody asked for.
    expect(resolveVisitorState(spec({ engine: "playwright" }), profile(), always)).toEqual({
      path: null,
      restored: false,
      unmet: null,
    });
  });

  it("restores a returning visitor when a saved session exists", () => {
    const state = resolveVisitorState(spec({ engine: "playwright" }), returning(), always);
    expect(state).toEqual({
      path: path.join(root, VISITOR_STATE_DIR, "oslo-mobile.json"),
      restored: true,
      unmet: null,
    });
  });

  it("says PLAINLY that a returning profile with no saved session tested a first-time visitor", () => {
    // The lie this exists to prevent: run.json records `visitorType: returning`
    // from the profile whatever happened, so without this the two runs are
    // indistinguishable in the evidence.
    const state = resolveVisitorState(spec({ engine: "playwright" }), returning(), never);
    expect(state.restored).toBe(false);
    expect(state.path).toBe(path.join(root, VISITOR_STATE_DIR, "oslo-mobile.json"));
    expect(state.unmet).toContain("FIRST-TIME visitor");
    expect(state.unmet).toContain("oslo-mobile");
  });

  it("REFUSES to imply a returning visitor on an engine that cannot restore one", () => {
    // agent-browser isolates cookies per --session and the session name is the
    // run id, so every run there arrives fresh however the profile is labelled.
    const state = resolveVisitorState(spec({ engine: "agent-browser" }), returning(), always);
    expect(state).toEqual({
      path: null,
      restored: false,
      unmet: expect.stringContaining("agent-browser") as unknown as string,
    });
    expect(state.unmet).toContain("--engine playwright");
  });

  it("looks at the real filesystem when nothing is injected", () => {
    // The default argument is what production uses; an injected fake would leave
    // it unexercised.
    const state = resolveVisitorState(spec({ engine: "playwright" }), returning());
    expect(state.restored).toBe(false);
    mkdirSync(path.join(root, VISITOR_STATE_DIR), { recursive: true });
    writeFileSync(path.join(root, VISITOR_STATE_DIR, "oslo-mobile.json"), "{}");
    expect(resolveVisitorState(spec({ engine: "playwright" }), returning()).restored).toBe(true);
  });
});

describe("buildRuntime engine selection", () => {
  it("builds a Playwright runtime WITHOUT launching a browser", () => {
    // Construction must stay cheap and synchronous: every Temporal Activity
    // rebuilds its runtime from the spec, and a launch per construction would
    // make that seam async and start a browser nothing ever uses.
    const runtime = buildRuntime(spec({ engine: "playwright" }), profile());
    expect(runtime).toBeInstanceOf(PlaywrightRuntime);
    expect(runtime.sessionId).toBe("run_1");
  });

  it("still builds the agent-browser runtime by default", () => {
    expect(buildRuntime(spec(), profile())).toBeInstanceOf(AgentBrowserRuntime);
  });

  it("carries the engine through a JSON round trip", () => {
    const revived = JSON.parse(JSON.stringify(spec({ engine: "playwright" }))) as RunSpec;
    expect(buildRuntime(revived, profile())).toBeInstanceOf(PlaywrightRuntime);
  });
});
