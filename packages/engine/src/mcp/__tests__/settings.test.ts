import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultDeps } from "../../cli/commands.js";
import { findRepoRoot } from "../../repo.js";
import { settingsView } from "../settings.js";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

describe("settingsView", () => {
  it("builds the same operator settings the console serves", () => {
    const deps = defaultDeps(repoRoot);
    const result = settingsView(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.markets.length).toBeGreaterThan(0);
    expect(result.value.journeys.length).toBeGreaterThan(0);
  });
});
