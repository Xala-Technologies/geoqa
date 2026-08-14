/**
 * The `geoqa server` entrypoint: wiring, and one refusal.
 *
 * Coverage-excluded along with `listen.ts` — it reads the filesystem, binds a port and prints.
 * The decisions it makes are `readAuthConfig`'s, which is pure and fully covered.
 *
 * **It refuses to start without a configured password**, and says how to make one. A server that
 * generated a default nobody saw would be a server nobody can log into; one that used a KNOWN
 * default is how every exposed dashboard is exposed. Neither happens if it does not start.
 */
import path from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hashPassword, readAuthConfig } from "./auth.js";
import { assetReader, createGeoqaServer } from "./listen.js";
import { buildSettings } from "./settings.js";
import { loadTenant } from "../tenant/registry.js";
import { loadJourney } from "../journeys/spec.js";
import { loadConfig, configPath } from "../config/load.js";
import { dashboardBuild } from "../cli/commands.js";
import { nodeHistoryFs } from "../history/store.js";

export interface StartOptions {
  repoRoot: string;
  evidenceRoot: string;
  /** Where the built UI lives. Served as the app's document root. */
  uiRoot: string;
  port: number;
  env: NodeJS.ProcessEnv;
  /** True behind TLS or a terminating proxy — decides the `Secure` cookie attribute. */
  secure: boolean;
  log: (line: string) => void;
}

/** Every journey on disk, with what a caller must supply to run it. */
function journeys(repoRoot: string): { id: string; title: string; writes: boolean; requiredVars: string[] }[] {
  const dir = path.join(repoRoot, "journeys");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => {
      const loaded = loadJourney(path.join(dir, f), (p) => readFileSync(p, "utf8"));
      if (!loaded.ok) return null;
      const raw = readFileSync(path.join(dir, f), "utf8");
      // The variables a run must supply, read from the file rather than the parsed journey:
      // `resolveSteps` leaves an unfilled placeholder intact, so the placeholders ARE the
      // contract, and `{target}` is supplied by every run.
      const vars = [...new Set([...raw.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? ""))].filter((v) => v !== "target" && v !== "");
      return { id: loaded.value.id, title: loaded.value.title, writes: loaded.value.writes === true, requiredVars: vars };
    })
    .filter((j): j is { id: string; title: string; writes: boolean; requiredVars: string[] } => j !== null);
}

export function startServer(options: StartOptions): { ok: true; close: () => void } | { ok: false; error: string } {
  const auth = readAuthConfig(options.env);
  if (!auth.ok) return { ok: false, error: auth.error };

  const configFile = configPath(options.repoRoot);
  const loaded = loadConfig(configFile);
  if (!loaded.ok) return { ok: false, error: loaded.errors.join("\n") };

  const markets = marketsOnDisk(options.repoRoot);
  const server = createGeoqaServer({
    auth: auth.config,
    now: Date.now,
    secure: options.secure,
    readAsset: assetReader(options.uiRoot),
    // Read per request, not once at boot: `geoqa dashboard build` writes this file while the
    // server is running, and a console showing yesterday's runs while claiming to be live is
    // the one failure a monitoring tool cannot have. Returns null rather than throwing when
    // it does not exist — "no dashboard built yet" is a state to report, not a crash.
    dashboard: () => {
      const file = path.join(options.evidenceRoot, "dashboard.json");
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    },
    // The composition root wires the same function `geoqa dashboard build` runs. Not a second
    // implementation: two dashboard builders would be two answers to "what does the console
    // show", and the one nobody ran would be the one that was wrong.
    rebuild: () => {
      const { view } = dashboardBuild({ evidenceRoot: options.evidenceRoot, historyFs: nodeHistoryFs, now: Date.now });
      return { generatedAt: view.generatedAt, total: view.summary.total, warnings: view.warnings };
    },
    settings: () =>
      buildSettings({
        tenants: tenantsOnDisk(options.repoRoot),
        markets,
        journeys: journeys(options.repoRoot),
        config: loaded.value.config,
        // Which file is in force, said out loud. A run on defaults because the file sits one
        // directory up otherwise looks identical to a run that honoured it.
        configSource: loaded.value.source === "defaults" ? "built-in defaults" : loaded.value.path,
        evidenceRoot: options.evidenceRoot,
        env: options.env,
      }),
  });

  server.listen(options.port, () => {
    options.log(`geoqa server on http://127.0.0.1:${options.port}`);
    options.log(`  serving ${options.uiRoot}`);
    options.log(`  evidence ${options.evidenceRoot}`);
  });
  return { ok: true, close: () => server.close() };
}

/**
 * Every tenant file that parses.
 *
 * A tenant whose file is malformed is SKIPPED rather than crashing the server, and that is the
 * right way round: one bad file must not make the console unavailable for every other tenant.
 * It shows as an absent tenant, which is visible, rather than as a 500, which is not.
 */
function tenantsOnDisk(repoRoot: string): NonNullable<ReturnType<typeof parsedTenant>>[] {
  const dir = path.join(repoRoot, "tenants");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => parsedTenant(path.join(dir, f)))
    .filter((t): t is NonNullable<typeof t> => t !== null);
}

const parsedTenant = (file: string): import("../tenant/types.js").Tenant | null => {
  const loaded = loadTenant(file);
  return loaded.ok ? loaded.value : null;
};

/** Market ids with a profile on disk — what a run may actually ask for. */
function marketsOnDisk(repoRoot: string): string[] {
  const dir = path.join(repoRoot, "profiles");
  if (!existsSync(dir)) return [];
  return [
    ...new Set(
      readdirSync(dir)
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => f.replace(/-(mobile|desktop).*\.yaml$/, "")),
    ),
  ].sort();
}

/** `geoqa server hash <password>` — so a hash can be produced without a scratch script. */
export function renderHash(password: string): string {
  return [
    "Add this to your environment — never to a file that is committed:",
    "",
    `  export GEOQA_ADMIN_PASSWORD_HASH='${hashPassword(password)}'`,
    "",
    "And a signing secret for session cookies:",
    "",
    `  export GEOQA_SESSION_SECRET='${randomSecret()}'`,
  ].join("\n");
}

/** 32 bytes of entropy, hex. `readAuthConfig` refuses anything shorter than 32 characters. */
const randomSecret = (): string => randomBytes(32).toString("hex");
