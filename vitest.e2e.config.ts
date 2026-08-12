import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * The end-to-end suite: a REAL Chromium, a real HTTP server, real evidence on
 * disk, through the real `executeRun`. No fakes anywhere.
 *
 * Separate from `vitest.config.ts` on purpose. The unit suite is the CI gate and
 * must stay browser-free — downloading Chromium on every push to exercise
 * nothing is pure cost, and a suite that needs a browser is a suite people stop
 * running. This one needs `pnpm playwright:install` and answers the question a
 * fake runtime cannot: does the adapter actually drive a browser?
 *
 * No coverage thresholds here. This suite exists to prove behaviour end to end,
 * and `src/browser/playwright-launch.ts` — excluded from the unit gate because
 * it is pure I/O — is exactly what it covers.
 */
export default defineConfig({
  resolve: {
    alias: { "@geoqa": path.join(root, "src") },
  },
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.ts"],
    // A real browser launch, two page loads, a journey and an evidence write.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // One browser at a time: these assert on wall-clock-sensitive vitals.
    fileParallelism: false,
  },
});
