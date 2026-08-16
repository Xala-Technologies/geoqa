/**
 * The git root, found by markers rather than by counting `..`.
 *
 * A package that lives at `packages/engine/src/cli` is two segments deeper than
 * it used to be. Encoding that depth in every entrypoint is how a run looks
 * for `packages/engine/profiles` and reports every market missing. The root is
 * the directory that has the workspace file AND the two input trees a run
 * actually reads — all three, because a nested package can grow its own
 * `inputs/profiles/` and must not win.
 *
 * Committed inputs live under `inputs/`. Local output (evidence, secrets) lives
 * under `var/`. Neither belongs at the git root, and journeys are not e2e
 * fixtures: e2e/fixtures is the two YAML files that suite needs, not the
 * visitor flows a production run executes.
 */
import { existsSync } from "node:fs";
import path from "node:path";

export const INPUTS_DIR = "inputs";
export const VAR_DIR = "var";

export const PROFILES_SEGMENTS = [INPUTS_DIR, "profiles"] as const;
export const JOURNEYS_SEGMENTS = [INPUTS_DIR, "journeys"] as const;
export const TENANTS_SEGMENTS = [INPUTS_DIR, "tenants"] as const;
export const EXPERIMENTS_SEGMENTS = [INPUTS_DIR, "experiments"] as const;
export const IMPORTS_SEGMENTS = [INPUTS_DIR, "imports"] as const;
export const EVIDENCE_SEGMENTS = [VAR_DIR, "evidence"] as const;
export const SECRETS_SEGMENTS = [VAR_DIR, "secrets"] as const;

/** Where `pnpm ui:build` writes, relative to the git root. */
export const UI_DIST_SEGMENTS = ["apps", "ui", "dist"] as const;

export function profilesRoot(repoRoot: string): string {
  return path.join(repoRoot, ...PROFILES_SEGMENTS);
}

export function journeysRoot(repoRoot: string): string {
  return path.join(repoRoot, ...JOURNEYS_SEGMENTS);
}

export function tenantsRoot(repoRoot: string): string {
  return path.join(repoRoot, ...TENANTS_SEGMENTS);
}

export function experimentsRoot(repoRoot: string): string {
  return path.join(repoRoot, ...EXPERIMENTS_SEGMENTS);
}

export function importsRoot(repoRoot: string): string {
  return path.join(repoRoot, ...IMPORTS_SEGMENTS);
}

export function defaultEvidenceRoot(repoRoot: string): string {
  return path.join(repoRoot, ...EVIDENCE_SEGMENTS);
}

export function secretsRoot(repoRoot: string): string {
  return path.join(repoRoot, ...SECRETS_SEGMENTS);
}

export function findRepoRoot(from: string, exists: (p: string) => boolean = existsSync): string {
  let dir = path.resolve(from);
  for (;;) {
    if (
      exists(path.join(dir, "pnpm-workspace.yaml")) &&
      exists(profilesRoot(dir)) &&
      exists(journeysRoot(dir))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `could not find the geoqa repo root from ${from} — expected pnpm-workspace.yaml, inputs/profiles/ and inputs/journeys/`,
      );
    }
    dir = parent;
  }
}

export function uiDistRoot(repoRoot: string): string {
  return path.join(repoRoot, ...UI_DIST_SEGMENTS);
}
