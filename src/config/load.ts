/**
 * Reading `geoqa.config.json` off disk.
 *
 * Three outcomes, and keeping them three is the whole point:
 *
 *   - **absent** → the defaults, reported as defaults. A missing config file is
 *     not an error; making it one would turn an optional file into a mandatory
 *     one for every existing checkout, including CI.
 *   - **present and valid** → the file's values, reported as coming from a file.
 *   - **present and wrong** → a named error. Falling back to defaults on a
 *     malformed file would recreate B-1 exactly: the user edited a setting, the
 *     run ignored it, and nothing said so.
 *
 * The distinction between "absent" and "unreadable" is deliberate too. A
 * directory or a permission-denied file at that path is NOT the same as no file:
 * treating it as absent would let a broken deployment run happily on defaults
 * while its config sat there unread.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ParseResult } from "../geo/profile.js";
import { defaultConfig, parseConfig, type GeoQaConfig } from "./schema.js";

/** The one filename the loader looks for. Gitignored; local to a checkout. */
export const CONFIG_FILENAME = "geoqa.config.json";

export function configPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_FILENAME);
}

export type ConfigSource =
  | { kind: "absent" }
  | { kind: "found"; text: string }
  | { kind: "unreadable"; detail: string };

/** Injectable so the unit suite never touches a real config file. */
export type ConfigReader = (filePath: string) => ConfigSource;

/**
 * The real reader. Only ENOENT means "no config" — every other errno is a file
 * we were meant to read and could not, which is a fact the run must state
 * instead of quietly proceeding as if the file did not exist.
 */
export const readConfigFile: ConfigReader = (filePath) => {
  try {
    return { kind: "found", text: readFileSync(filePath, "utf8") };
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    if (error.code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", detail: error.message };
  }
};

export interface LoadedConfig {
  config: GeoQaConfig;
  /**
   * Where the values came from.
   *
   * Carried so the CLI can say which it used. A run on defaults because the
   * config file is one directory up looks identical to a run that honoured it,
   * and that ambiguity is the entire defect this module closes.
   */
  source: "defaults" | "file";
  /** The path consulted — printable whether or not anything was there. */
  path: string;
}

/**
 * Load and validate the config at `filePath`, or return the defaults if there is
 * nothing there.
 *
 * Errors are prefixed with the path, matching `loadGeoProfile`: an error about a
 * file names the file, because the reader's next action is to open it.
 */
export function loadConfig(filePath: string, read: ConfigReader = readConfigFile): ParseResult<LoadedConfig> {
  const source = read(filePath);
  if (source.kind === "absent") {
    return { ok: true, value: { config: defaultConfig(), source: "defaults", path: filePath } };
  }
  if (source.kind === "unreadable") {
    return { ok: false, errors: [`${filePath}: could not be read — ${source.detail}`] };
  }

  let document: unknown;
  try {
    document = JSON.parse(source.text);
  } catch (e) {
    // Named specifically. "Unexpected token } in JSON at position 412" is the
    // one message that gets a trailing comma fixed in seconds.
    return { ok: false, errors: [`${filePath}: not valid JSON — ${(e as Error).message}`] };
  }

  const parsed = parseConfig(document);
  return parsed.ok
    ? { ok: true, value: { config: parsed.value, source: "file", path: filePath } }
    : { ok: false, errors: parsed.errors.map((e) => `${filePath}: ${e}`) };
}
