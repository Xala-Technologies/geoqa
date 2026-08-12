import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGeoProfile } from "../../geo/profile.js";
import type { GeoProfile } from "../../geo/types.js";
import { buildRuntime, newEvidenceId, newRunId, runEvidenceDir, writeInitScript, type RunSpec } from "../context.js";

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
