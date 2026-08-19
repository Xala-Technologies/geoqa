/**
 * Tests for the console's own logic.
 *
 * **Scoped to the modules that make decisions, not to the ones that draw.** `api.ts` decides
 * whether a response means data, a sign-in prompt, or a failure — and getting that wrong is
 * how the console shipped a blank white page that no server test could see. The views are
 * rendering, and a test asserting that a `<td>` contains a string it was handed tells you
 * nothing the type checker did not.
 *
 * So this gate is 100% on the decision-making module and silent about the rest, rather than a
 * coverage percentage over a directory where most of the lines are markup. A number that
 * includes JSX is a number that can be raised by testing nothing.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/api.ts",
        "src/nav.ts",
        "src/views/run-list.ts",
        "src/route.ts",
        "src/views/finding-brief.ts",
        "src/views/geography.ts",
        "src/views/run-flow.ts",
        "src/views/trends.ts",
      ],
      /**
       * 100% across the board, matching the engine's gate.
       *
       * Worth knowing if this ever reads below 100 for no reason you can find: it did once,
       * reporting a phantom uncovered branch on the line `export async function getJson<T>(`
       * — a bare signature with no conditional on it. The cause was `@vitest/coverage-v8`
       * being resolved at a major version behind the `vitest` running it, which prints a
       * quiet "make sure the versions match" line above the report and then miscounts
       * ranges. Matching the versions fixed it. Check that before believing the number, and
       * before lowering a threshold to accommodate it.
       */
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
    },
  },
});
