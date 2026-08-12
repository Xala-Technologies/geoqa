/**
 * The layer map, as a check instead of a memory.
 *
 * `AGENTS.md` describes a one-way dependency graph and calls the rules that hold
 * it up "load-bearing invariants". Until this file existed, all of them were
 * enforced by a reviewer noticing an import line — and an import line is the
 * least noticeable thing in a diff. Each rule below is one of those invariants,
 * with the failure it prevents named in its `comment`: these are not style
 * preferences, so a violation is an `error` and never a warning.
 *
 * Scope is `src` (see the `boundaries` script). `e2e/` is deliberately outside
 * it: the e2e suite exists precisely to drive the real Chromium through
 * `browser/playwright-launch.ts`, so it is the one caller allowed to name an
 * engine's internals, and cruising it would report that intent as a defect.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "engine-internals-are-private",
      comment:
        "Invariant 1 (the browser seam): `exec.ts`, `args.ts` and " +
        "`playwright-launch.ts` are the parts that know HOW a specific engine is " +
        "driven — a CLI daemon's argv and envelope parsing, or Playwright's real " +
        "API. Nothing above `browser/` may name them. A caller that reaches past " +
        "`BrowserRuntime` into one of these has bound a layer to an engine, and " +
        "the next engine then cannot be added without editing that caller — which " +
        "is the seam's whole purpose. Depend on `browser/types.ts` and get the " +
        "runtime from `run/context.ts`'s `buildRuntime`.",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/browser/" },
      to: { path: "^src/browser/(exec|args|playwright-launch)\\.ts$" },
    },
    {
      name: "engine-packages-stay-in-browser",
      comment:
        "Invariant 1, from the other side: `browser/` is the ONLY layer that " +
        "knows agent-browser or Playwright exist. An import of either package by " +
        "name outside it leaks the engine upward — and it leaks quietly, because " +
        "the code still compiles and the tests still pass while the abstraction " +
        "no longer holds. It also breaks the promise that the unit suite launches " +
        "nothing: these packages are the only ones in the tree that can start a " +
        "browser process.",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/browser/" },
      to: { path: "node_modules/(playwright|playwright-core|@playwright/[^/]+|agent-browser)/" },
    },
    {
      name: "stages-must-not-know-temporal",
      comment:
        "Invariant 12 (two execution modes, one implementation): the CLI calls " +
        "the `run/` stages in sequence and each Temporal Activity calls exactly " +
        "one of them. The dependency therefore points from `temporal/` down, " +
        "never back up. A stage — or the journey engine, or the geo layer — that " +
        "imported `temporal/` would become unrunnable without a Temporal server, " +
        "and `pnpm geoqa journey run` would start needing infrastructure to do a " +
        "single local run. Stages take their dependencies as arguments.",
      severity: "error",
      from: { path: "^src/(run|journeys|geo)/" },
      to: { path: "^src/temporal/" },
    },
    {
      name: "never-import-the-worker",
      comment:
        "Invariant 13: `temporal/worker.ts` has an unguarded top-level `main()`. " +
        "Importing it does not read a value from it — it connects to a Temporal " +
        "server and polls forever. In a test run that is a suite that hangs " +
        "instead of failing; in a CLI process it is a command that never returns. " +
        "Shared constants live in `temporal/constants.ts` for exactly this " +
        "reason, and this rule holds for every file including tests.",
      severity: "error",
      from: {},
      to: { path: "^src/temporal/worker\\.ts$" },
    },
    {
      name: "browser-is-the-bottom-layer",
      comment:
        "The layer map points one way: `browser/` knows how to drive a page and " +
        "nothing about what is being proven with it. An import of `geo/`, `run/`, " +
        "`journeys/` or `evidence/` from here inverts that — the engine would " +
        "start deciding verdicts or writing evidence, which is where invariant 3 " +
        "dies: a tool that both takes the reading and files the finding will file " +
        "its own blindness as a site defect. Readings travel upward as data, " +
        "never as judgement.",
      severity: "error",
      from: { path: "^src/browser/" },
      to: { path: "^src/(geo|run|journeys|evidence)/" },
    },
    {
      name: "no-circular-dependencies",
      comment:
        "A cycle means the layer map has stopped being a map. A value cycle also " +
        "makes module initialisation order load-bearing: one member observes " +
        "another's bindings before they are initialised, which surfaces as an " +
        "`undefined` import at runtime under a suite that compiled and passed. " +
        "Type-only cycles are caught too (see `tsPreCompilationDeps` below) — " +
        "they are runtime-harmless, but they are the usual way a boundary gets " +
        "worked around: re-exporting a private module's type through a public " +
        "one to satisfy a caller that should not have needed it. There is no " +
        "cycle in the tree today; this keeps the first one from arriving " +
        "unnoticed.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // The sources are `.ts` but every relative import carries `.js`
    // (verbatimModuleSyntax + ESM). Without the tsconfig the resolver looks for
    // files that do not exist, resolves nothing, and reports a clean graph with
    // no edges in it — a check that passes because it saw nothing.
    tsConfig: { fileName: "tsconfig.json" },
    // Count `import type` as a dependency. Type-only imports are erased at
    // runtime, so this is not about execution: it is that renaming `import` to
    // `import type` must not be a way to cross a layer boundary unnoticed. A
    // type is knowledge, and these rules are about which layer holds it.
    tsPreCompilationDeps: true,
    // Detect edges into packages, without cruising their transitive graphs —
    // the rules above ask which package a layer names, not what that package
    // is built from.
    doNotFollow: { path: "node_modules" },
    // A note on the `missing-typescript-transpiler` warning this prints: the
    // repo is on typescript@7 and dependency-cruiser 18 supports <7, so it
    // falls back to its own parser and warns that it may have missed sources.
    // That warning is the shape of thing this repo refuses to accept on trust,
    // so it was checked instead of assumed: all 69 files under `src/` appear in
    // the graph, zero dependencies are unresolvable, and a probe tree confirmed
    // that a forbidden edge is still reported when written as `import`,
    // `import type`, `import { type X }`, an inline `import("…").T` and a
    // dynamic `await import()`. Re-verify if the parser fallback changes; a
    // check that silently sees nothing would pass every rule here.
  },
};
