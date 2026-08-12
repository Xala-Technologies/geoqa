import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RETENTION } from "../../evidence/manifest.js";
import { DEFAULT_VERIFY_ENDPOINT } from "../../geo/observe.js";
import { DEFAULT_COOLDOWN_MS } from "../../network/provider.js";
import { CONFIG_FILENAME, configPath, loadConfig, readConfigFile, type ConfigReader } from "../load.js";
import { DEFAULT_EVIDENCE_DIRNAME, DEFAULT_PROVIDER, defaultConfig } from "../schema.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A reader that serves one document, so no test touches a real config file. */
const serving = (text: string): ConfigReader => () => ({ kind: "found", text });

describe("configPath", () => {
  it("looks for exactly one filename beside the repo root, so there is no search order to be surprised by", () => {
    expect(configPath("/srv/geoqa")).toBe(path.join("/srv/geoqa", CONFIG_FILENAME));
  });
});

describe("a missing config file", () => {
  it("is NOT an error — it means the defaults, because making the file mandatory would break every existing checkout including CI", () => {
    const loaded = loadConfig("/nowhere/geoqa.config.json", () => ({ kind: "absent" }));
    expect(loaded.ok && loaded.value.config).toEqual(defaultConfig());
  });

  it("reports that it used DEFAULTS, so a run on defaults because the file sits one directory up cannot look like a run that honoured it", () => {
    const loaded = loadConfig("/nowhere/geoqa.config.json", () => ({ kind: "absent" }));
    expect(loaded.ok && loaded.value.source).toBe("defaults");
    expect(loaded.ok && loaded.value.path).toBe("/nowhere/geoqa.config.json");
  });
});

describe("a config file that is there", () => {
  it("reports that its values came from a FILE, and returns them", () => {
    const loaded = loadConfig("/srv/geoqa.config.json", serving(JSON.stringify({ evidence: { root: "out" } })));
    expect(loaded.ok && loaded.value.source).toBe("file");
    expect(loaded.ok && loaded.value.config.evidence.root).toBe("out");
  });

  it("is an ERROR when the JSON is malformed — falling back to defaults here would recreate the defect this loader closes", () => {
    const loaded = loadConfig("/srv/geoqa.config.json", serving('{ "evidence": { "root": "out", } }'));
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.errors[0]).toContain("not valid JSON");
  });

  it("is an ERROR when the schema is violated, and names the file so the reader's next action is to open it", () => {
    const loaded = loadConfig("/srv/geoqa.config.json", serving(JSON.stringify({ network: { cooldownMs: -5 } })));
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.errors[0]).toContain("/srv/geoqa.config.json: network.cooldownMs");
  });

  it("is an ERROR when the file exists but cannot be READ — an unreadable config is not an absent one, and a broken deployment must not run happily on defaults", () => {
    const loaded = loadConfig("/srv/geoqa.config.json", () => ({ kind: "unreadable", detail: "EACCES: permission denied" }));
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.errors[0]).toContain("could not be read — EACCES");
  });
});

describe("readConfigFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "geoqa-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a file that is there", () => {
    const file = path.join(dir, CONFIG_FILENAME);
    writeFileSync(file, "{}");
    expect(readConfigFile(file)).toEqual({ kind: "found", text: "{}" });
  });

  it("reports ENOENT as ABSENT, which is the only errno that means 'there is no config'", () => {
    expect(readConfigFile(path.join(dir, "does-not-exist.json"))).toEqual({ kind: "absent" });
  });

  it("reports any OTHER errno as unreadable, so a directory sitting at the config path is not mistaken for no config", () => {
    const source = readConfigFile(dir);
    expect(source.kind).toBe("unreadable");
  });
});

describe("geoqa.config.example.json", () => {
  const example = path.join(repoRoot, "geoqa.config.example.json");

  it("is VALID against the schema — an example that would be rejected is worse documentation than none", () => {
    const loaded = loadConfig(example);
    // Compared as a list so a failure PRINTS the reasons instead of `false`.
    expect(loaded.ok ? [] : loaded.errors).toEqual([]);
  });

  it("documents the REAL defaults, so the example cannot drift away from the constants the code uses", () => {
    const loaded = loadConfig(example);
    if (!loaded.ok) throw new Error(loaded.errors.join("; "));
    expect(loaded.value.config.network.provider).toBe(DEFAULT_PROVIDER);
    expect(loaded.value.config.network.verifyEndpoint).toBe(DEFAULT_VERIFY_ENDPOINT);
    expect(loaded.value.config.network.cooldownMs).toBe(DEFAULT_COOLDOWN_MS);
    expect(loaded.value.config.evidence.root).toBe(DEFAULT_EVIDENCE_DIRNAME);
    expect(loaded.value.config.evidence.retention).toEqual(RETENTION);
  });
});
