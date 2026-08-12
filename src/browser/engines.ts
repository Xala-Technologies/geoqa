/**
 * The public way to get a `BrowserRuntime` for a named engine.
 *
 * This module exists because of invariant 1, and the boundary linter caught it
 * being violated: `run/context.ts` was importing `playwrightOpener` straight out
 * of `playwright-launch.ts`, which is engine-internal. That import compiled and
 * worked perfectly — and it also meant the layer above the seam named a specific
 * engine's launcher, so adding a third engine would have required editing
 * `run/` rather than only `browser/`. Which is precisely the coupling the seam
 * exists to prevent.
 *
 * So `browser/` now owns engine construction end to end. Callers above it name an
 * engine and hand over primitives; which file drives that engine is nobody
 * else's business.
 *
 * A factory rather than re-exporting from `playwright.ts`: the launcher already
 * imports types FROM `playwright.ts`, so re-exporting the launcher there would
 * make the two files mutually dependent, and the same linter forbids cycles for
 * good reasons.
 */
import { PlaywrightRuntime, type PlaywrightRuntimeOptions } from "./playwright.js";
import { playwrightOpener, type PlaywrightContextOptions } from "./playwright-launch.js";
import type { BrowserRuntime } from "./types.js";

/** Re-exported so callers can build the options without naming the launcher. */
export type { PlaywrightContextOptions };

/**
 * A Playwright-backed runtime. Launches nothing: the opener is a function the
 * runtime calls on first use, which is what keeps `buildRuntime` synchronous.
 */
export function createPlaywrightRuntime(
  sessionId: string,
  options: PlaywrightContextOptions,
  runtimeOptions: PlaywrightRuntimeOptions = {},
): BrowserRuntime {
  return new PlaywrightRuntime(sessionId, playwrightOpener(options), runtimeOptions);
}
