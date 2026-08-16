import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_SEGMENTS,
  EXPERIMENTS_SEGMENTS,
  IMPORTS_SEGMENTS,
  JOURNEYS_SEGMENTS,
  PROFILES_SEGMENTS,
  SECRETS_SEGMENTS,
  TENANTS_SEGMENTS,
  UI_DIST_SEGMENTS,
  defaultEvidenceRoot,
  experimentsRoot,
  findRepoRoot,
  importsRoot,
  journeysRoot,
  profilesRoot,
  secretsRoot,
  tenantsRoot,
  uiDistRoot,
} from "../repo.js";

describe("findRepoRoot", () => {
  const root = path.resolve("/repo");
  const nested = path.join(root, "packages", "engine", "src", "cli");
  const present = new Set([
    path.join(root, "pnpm-workspace.yaml"),
    path.join(root, ...PROFILES_SEGMENTS),
    path.join(root, ...JOURNEYS_SEGMENTS),
  ]);
  const exists = (p: string): boolean => present.has(p);

  it("walks up from a nested package until the workspace markers are all present", () => {
    expect(findRepoRoot(nested, exists)).toBe(root);
  });

  it("does not stop at a directory that has only some of the markers", () => {
    const decoy = path.join(root, "packages", "engine");
    present.add(path.join(decoy, ...PROFILES_SEGMENTS));
    expect(findRepoRoot(nested, exists)).toBe(root);
    present.delete(path.join(decoy, ...PROFILES_SEGMENTS));
  });

  it("throws rather than guessing when nothing above looks like this repo", () => {
    expect(() => findRepoRoot("/tmp/elsewhere", () => false)).toThrow(/pnpm-workspace.yaml/);
  });
});

describe("layout roots", () => {
  it("keeps committed inputs under inputs/ and local output under var/", () => {
    expect(profilesRoot("/repo")).toBe(path.join("/repo", "inputs", "profiles"));
    expect(journeysRoot("/repo")).toBe(path.join("/repo", "inputs", "journeys"));
    expect(tenantsRoot("/repo")).toBe(path.join("/repo", "inputs", "tenants"));
    expect(experimentsRoot("/repo")).toBe(path.join("/repo", "inputs", "experiments"));
    expect(importsRoot("/repo")).toBe(path.join("/repo", "inputs", "imports"));
    expect(defaultEvidenceRoot("/repo")).toBe(path.join("/repo", "var", "evidence"));
    expect(secretsRoot("/repo")).toBe(path.join("/repo", "var", "secrets"));
    expect(EVIDENCE_SEGMENTS).toEqual(["var", "evidence"]);
    expect(SECRETS_SEGMENTS).toEqual(["var", "secrets"]);
    expect(TENANTS_SEGMENTS).toEqual(["inputs", "tenants"]);
    expect(EXPERIMENTS_SEGMENTS).toEqual(["inputs", "experiments"]);
    expect(IMPORTS_SEGMENTS).toEqual(["inputs", "imports"]);
  });

  it("points at the console package build, not a root-level ui/", () => {
    expect(UI_DIST_SEGMENTS).toEqual(["apps", "ui", "dist"]);
    expect(uiDistRoot("/repo")).toBe(path.join("/repo", "apps", "ui", "dist"));
  });
});
