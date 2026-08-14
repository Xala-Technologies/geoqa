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
       * The number here is a RATCHET, not a target. It is set just below the current figure so
       * the gate fails the moment branch coverage drops, and it is raised as the remaining sites
       * are closed — many of which are defensive `??` fallbacks that this codebase's own doctrine
       * says should be deleted rather than tested, because a guard with no reachable failure is
       * a claim that the invariant above it might not hold.
       *
       * A threshold set AT the current value would fail on the first honest refactor that
       * removes a tested branch. One set below it fails only on regression, which is what a
       * ratchet is for.
       */
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 96.6 },
    },
    testTimeout: 15_000,
  },
});
