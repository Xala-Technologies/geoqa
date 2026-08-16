import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MASK } from "../redact.js";
import { buildManifest } from "../manifest.js";
import {
  MANIFEST_FILE,
  describeExisting,
  ensureRunDirectory,
  readManifest,
  runDirectory,
  writeJsonArtifact,
  writeManifest,
  writeTextArtifact,
} from "../store.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "geoqa-evidence-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const opts = () => ({ root, runId: "run_1" });

describe("run directory", () => {
  it("is root/runId and is created on demand", () => {
    expect(runDirectory(opts())).toBe(path.join(root, "run_1"));
    const dir = ensureRunDirectory(opts());
    expect(ensureRunDirectory(opts())).toBe(dir); // idempotent
  });
});

describe("writeJsonArtifact", () => {
  it("REDACTS on the way to disk, not on export", () => {
    const dir = ensureRunDirectory(opts());
    const artifact = writeJsonArtifact(dir, "metadata", "run", "run.json", {
      proxy: "http://user:s3cret@gw:7777",
      target: "https://digilist.no/?token=abc",
    });
    const written = readFileSync(path.join(dir, "run.json"), "utf8");
    expect(written).not.toContain("s3cret");
    expect(written).not.toContain("abc");
    expect(written).toContain(MASK);
    expect(artifact).toMatchObject({ kind: "metadata", path: "run.json", mime: "application/json" });
    expect(artifact.bytes).toBeGreaterThan(0);
  });

  it("creates nested directories for a nested artifact path", () => {
    const dir = ensureRunDirectory(opts());
    writeJsonArtifact(dir, "console", "console", "logs/console.json", [{ type: "error", text: "boom" }]);
    expect(readFileSync(path.join(dir, "logs", "console.json"), "utf8")).toContain("boom");
  });
});

describe("writeTextArtifact", () => {
  it("writes redacted text and reports its byte length", () => {
    const dir = ensureRunDirectory(opts());
    const artifact = writeTextArtifact(dir, "snapshot", "tree", "tree.txt", "user ola@x.no clicked");
    const written = readFileSync(path.join(dir, "tree.txt"), "utf8");
    expect(written).toBe(`user ${MASK} clicked`);
    expect(artifact.bytes).toBe(Buffer.byteLength(written));
    expect(artifact.mime).toBe("text/plain");
  });
});

describe("describeExisting", () => {
  it("sizes a file another tool wrote", () => {
    const dir = ensureRunDirectory(opts());
    writeFileSync(path.join(dir, "hero.png"), "PNGDATA");
    const artifact = describeExisting(dir, "screenshot", "hero", "hero.png");
    expect(artifact).toMatchObject({ kind: "screenshot", bytes: 7, mime: "image/png" });
  });

  it("records a MISSING file as zero bytes rather than dropping it", () => {
    // Dropping it would make the manifest describe a package that looks
    // complete; zero bytes makes the gap explicit.
    const dir = ensureRunDirectory(opts());
    expect(describeExisting(dir, "trace", "trace", "trace.json").bytes).toBe(0);
  });
});

describe("manifest round-trip", () => {
  it("writes and reads back a manifest", () => {
    const dir = ensureRunDirectory(opts());
    const manifest = buildManifest({
      evidenceId: "ev_1",
      runId: "run_1",
      createdAt: "2026-08-12T00:00:00.000Z",
      verdict: "PASS",
      artifacts: [],
    });
    const written = writeManifest(dir, manifest);
    expect(written).toBe(path.join(dir, MANIFEST_FILE));
    expect(readManifest(dir)).toMatchObject({ evidenceId: "ev_1", tier: "pass" });
  });

  it("returns null for a missing or corrupt manifest instead of throwing", () => {
    const dir = ensureRunDirectory(opts());
    expect(readManifest(dir)).toBeNull();
    writeFileSync(path.join(dir, MANIFEST_FILE), "{{{");
    expect(readManifest(dir)).toBeNull();
  });
});
