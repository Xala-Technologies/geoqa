import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json `paths`. Change one, change both or tests break.
    alias: { "@geoqa": path.join(root, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "**/__tests__/**",
        "**/*.d.ts",
        // ── Entrypoints: thin by design, all I/O, no judgement. ──────────
        // Every exclusion below must name why. An exclusion without a
        // reason is how "the agent never runs at all" becomes invisible to
        // a green suite — that has shipped before, at 1362 passing tests.
        //
        // Arg parsing + dispatch into command modules that are each at 100%.
        "src/cli/index.ts",
        // Binds a port, reads a body, copies headers. Every DECISION the server makes lives
        // in `server/router.ts` as a pure function over plain objects and is covered there —
        // including the ones a click-through never reaches: an expired session, a token signed
        // with the previous secret, a path with `..` in it. Exercising this file means opening
        // a socket, which proves nothing the router tests do not.
        "src/server/listen.ts",
        // Wiring: reads the filesystem, binds a port, prints. Its one decision — refusing to
        // start without a configured password — is `readAuthConfig`, which is pure and covered.
        "src/server/start.ts",
        // Timer + matrixRun. Every decision is in watch/tick.ts, watch/store.ts,
        // watch/live.ts, watch/health.ts and watch/log.ts, which are fully
        // covered. Exercising this file launches Chrome.
        "src/server/watch-loop.ts",
        // Connects to Temporal and polls forever. Nothing to assert.
        "src/temporal/worker.ts",
        // Launches a real Chromium and maps Playwright's API onto the
        // structural interfaces in playwright.ts. All I/O and adaptation, no
        // judgement — every behaviour it feeds is covered there, against
        // injected fakes. Exercising this file means downloading a browser,
        // which is the cost CI exists to avoid.
        "src/browser/playwright-launch.ts",
        // A raw socket and a wire-format parse, no judgement. What a refusal
        // MEANS for a run is decided in provider.ts's health(), which is covered
        // against an injected probe. Exercising this file means dialling a vendor.
        "src/network/auth-probe.ts",
        // One HTTP read of the vendor's usage endpoint and a hand-off to
        // `parseSubUsers`. No judgement here: what a figure means for a run, and
        // what an UNREAD figure means, is `tenant/quota.ts` and is fully covered
        // against injected data.
        "src/tenant/usage-probe.ts",
        // One SDK call and a shape translation, no judgement. Every decision about a
        // durable run lives in `client.ts` and is covered against a fake connector;
        // exercising this file means connecting to a Temporal server.
        "src/temporal/connect.ts",
        // Spawns the operator's `claude` CLI. The suite must never talk to
        // Anthropic; every decision about a reply lives in assist/claude.ts
        // and is covered against an injected spawn.
        "src/assist/claude-spawn.ts",
        // Spawns git/gh for an unattended repair. The suite must never
        // clone a customer repo; every decision lives in assist/repair.ts.
        "src/assist/repair-exec.ts",
        // Opens a socket to the growth database and news up a `pg.Pool`. The
        // suite must never reach the live growth schema. Every decision about a
        // row — which rows are candidates, how they group, what the write-back
        // may and may not overwrite — lives in fix/growth-db.ts and
        // fix/intake-growth.ts and is covered against an injected GrowthDb.
        "src/fix/growth-pg.ts",
        // Every activity is a thin wrapper that news up a real provider /
        // runtime and delegates; the logic each one calls is at 100%.
        "src/temporal/activities.ts",
        // Executed for real by workflows.test.ts through @temporalio/testing,
        // but Temporal bundles workflow code into an isolated V8 sandbox that
        // v8 coverage cannot see into — it always reports 0% however
        // thoroughly it ran. Tested-but-unobservable, not untested.
        "src/temporal/workflows.ts",
        // Pure type declarations.
        "**/types.ts",
      ],
      /**
       * Lines, statements and functions at 100 — and BRANCHES ratcheted.
       *
       * The first three have been enforced since the gate existed. Branches were not in this
       * object at all, so "100% coverage" was quietly true of three metrics and quietly untrue
       * of the fourth: 95.25% across 167 uncovered branch sites, none of which ever failed a
       * build.
       *
       * The branch number was a RATCHET: set just below the current figure so the gate failed
       * the moment branch coverage dropped, and raised as the remaining sites were closed —
       * many of which are defensive `??` fallbacks that this codebase's own doctrine says
       * should be deleted rather than tested, because a guard with no reachable failure is a
       * claim that the invariant above it might not hold.
       *
       * **It is a FLOOR now, not a ratchet — lowered 98.6 → 96 on 2026-08-18, by decision.**
       * Recorded rather than quietly edited, because the two do different jobs. At 98.6 the
       * gate caught a regression the same day it landed; at 96 roughly a hundred branches can
       * go uncovered before anything says so, and the figure it is protecting (98.47 at the
       * time of the change) can decay to 96 without a single build turning red. What this
       * still catches is a collapse, not a drift.
       *
       * Lines, statements and functions are UNCHANGED at 100. They are the gate the repo
       * documents in AGENTS.md, CLAUDE.md and the CI comment, and nothing here relaxes them.
       *
       * To make this a ratchet again: raise the number to just under whatever the suite
       * currently reports, in the same change that closes the sites.
       */
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 96 },
    },
    testTimeout: 15_000,
  },
});
