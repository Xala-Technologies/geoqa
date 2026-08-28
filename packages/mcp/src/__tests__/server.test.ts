import { describe, expect, it } from "vitest";
import { createMcpConfig } from "../deps.js";
import { findRepoRoot, profileList } from "@geoqa/engine/mcp.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

describe("createMcpConfig", () => {
  it("resolves repo root and evidence from GEOQA_REPO_ROOT", () => {
    const config = createMcpConfig({ GEOQA_REPO_ROOT: repoRoot });
    expect(config.repoRoot).toBe(repoRoot);
    expect(config.evidenceRoot).toContain("var/evidence");
  });

  it("reads profiles through the same deps the MCP tools use", () => {
    const config = createMcpConfig({ GEOQA_REPO_ROOT: repoRoot });
    const result = profileList(config.deps);
    expect(result.profiles.length).toBeGreaterThan(0);
  });
});
