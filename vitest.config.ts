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
        // Connects to Temporal and polls forever. Nothing to assert.
        "src/temporal/worker.ts",
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
      thresholds: { lines: 100, statements: 100, functions: 100 },
    },
    testTimeout: 15_000,
  },
});
