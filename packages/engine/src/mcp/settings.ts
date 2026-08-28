/**
 * Operator settings from disk — same view `GET /api/settings` serves when the
 * console is running, without needing the HTTP server up.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { journeyList, tenantPath, type CommandDeps } from "../cli/commands.js";
import { configPath, loadConfig } from "../config/load.js";
import { profilesRoot, tenantsRoot } from "../repo.js";
import { buildSettings, type SettingsView } from "../server/settings.js";
import { loadTenant } from "../tenant/registry.js";

export function settingsView(deps: CommandDeps): { ok: true; value: SettingsView } | { ok: false; error: string } {
  const loaded = loadConfig(configPath(deps.repoRoot));
  if (!loaded.ok) return { ok: false, error: loaded.errors.join("\n") };

  const tenants = tenantsOnDisk(deps.repoRoot);
  const markets = marketsOnDisk(deps.repoRoot);
  const journeys = journeyList(deps).journeys.filter((j) => !j.title.startsWith("INVALID:"));

  return {
    ok: true,
    value: buildSettings({
      tenants,
      markets,
      journeys,
      config: loaded.value.config,
      configSource: loaded.value.source === "defaults" ? "built-in defaults" : loaded.value.path,
      evidenceRoot: deps.evidenceRoot,
      env: deps.env,
    }),
  };
}

function tenantsOnDisk(repoRoot: string) {
  const dir = tenantsRoot(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .flatMap((f) => {
      const loaded = loadTenant(path.join(dir, f));
      return loaded.ok ? [loaded.value] : [];
    });
}

function marketsOnDisk(repoRoot: string): string[] {
  const dir = profilesRoot(repoRoot);
  if (!existsSync(dir)) return [];
  return [
    ...new Set(
      readdirSync(dir)
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => f.replace(/-(mobile|desktop).*\.yaml$/, "")),
    ),
  ].sort();
}
