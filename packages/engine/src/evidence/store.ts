/**
 * Writing an evidence package to disk.
 *
 * Every JSON artifact goes through `redactDeep` on the way out — at write time,
 * not at export time. The proxy URL alone justifies it: it carries a vendor
 * password, and it is in the session config that the run metadata describes.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactDeep } from "./redact.js";
import type { Artifact, ArtifactKind, EvidenceManifest } from "./manifest.js";

export interface StoreOptions {
  /** Root evidence directory, e.g. `<repo>/evidence`. */
  root: string;
  runId: string;
}

export const MANIFEST_FILE = "manifest.json";

export function runDirectory(options: StoreOptions): string {
  return path.join(options.root, options.runId);
}

/** Create the run's directory. Safe to call repeatedly. */
export function ensureRunDirectory(options: StoreOptions): string {
  const dir = runDirectory(options);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MIME: Record<ArtifactKind, string> = {
  metadata: "application/json",
  screenshot: "image/png",
  snapshot: "text/plain",
  console: "application/json",
  network: "application/json",
  har: "application/json",
  trace: "application/json",
  vitals: "application/json",
  a11y: "application/json",
};

/**
 * Size an artifact that some other tool wrote (a screenshot, a HAR).
 *
 * A file that does not exist is recorded with `bytes: 0` rather than dropped.
 * Dropping it would make the manifest describe a package that looks complete;
 * a zero-byte entry makes the gap explicit, and `missingArtifacts` treats it as
 * absent for completeness purposes.
 */
export function describeExisting(dir: string, kind: ArtifactKind, label: string, file: string): Artifact {
  const full = path.join(dir, file);
  let bytes = 0;
  try {
    bytes = statSync(full).size;
  } catch {
    bytes = 0;
  }
  return { kind, label, path: file, bytes, mime: MIME[kind] };
}

/** Write a JSON artifact, redacted, and describe it. */
export function writeJsonArtifact(
  dir: string,
  kind: ArtifactKind,
  label: string,
  file: string,
  value: unknown,
): Artifact {
  const body = JSON.stringify(redactDeep(value), null, 2);
  const full = path.join(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
  return { kind, label, path: file, bytes: Buffer.byteLength(body), mime: MIME[kind] };
}

/** Write a plain-text artifact, redacted. */
export function writeTextArtifact(
  dir: string,
  kind: ArtifactKind,
  label: string,
  file: string,
  text: string,
): Artifact {
  const body = String(redactDeep(text));
  const full = path.join(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
  return { kind, label, path: file, bytes: Buffer.byteLength(body), mime: MIME[kind] };
}

export function writeManifest(dir: string, manifest: EvidenceManifest): string {
  const full = path.join(dir, MANIFEST_FILE);
  writeFileSync(full, JSON.stringify(redactDeep(manifest), null, 2));
  return full;
}

export function readManifest(dir: string): EvidenceManifest | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), "utf8")) as EvidenceManifest;
  } catch {
    return null;
  }
}
