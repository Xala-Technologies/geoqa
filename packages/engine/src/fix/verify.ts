/**
 * Run the TARGET repository's own checks against the fix, in the clone.
 *
 * The rule this file encodes is the one thing an unattended fixer must not be
 * allowed to negotiate: **a fix that cannot pass the repository's own checks is
 * rejected.** Not "passed with a note", not "the test was flaky", not "the
 * threshold was unrealistic". Nothing here can edit the repository, so there is
 * no path from a failing check to a passing one except a better diff — which
 * is the point. The prompt tells the model the same thing and the reviewer
 * looks for the diff that broke it; this is the half that cannot be talked out
 * of it.
 *
 * `failed` blocks the pull request. `skipped` does NOT, and the PR body says in
 * words that nothing was verified. Refusing to open a PR because a marketing
 * site defines no test script would block the highest-value repository
 * permanently, which is a worse failure than a pull request that admits a human
 * has to read it.
 */
import type { RepairExecResult } from "../assist/repair.js";

export interface VerifyStep {
  name: string;
  argv: string[];
  exitCode: number;
  ms: number;
}

export interface VerifyReport {
  state: "passed" | "failed" | "skipped";
  steps: VerifyStep[];
  detail?: string;
}

export interface VerifyContext {
  workdir: string;
  exec: (argv: string[], timeoutMs: number) => Promise<RepairExecResult>;
  readFile: (rel: string) => string | null;
  exists: (rel: string) => boolean;
  now: () => number;
}

export type VerifyRunner = (ctx: VerifyContext) => Promise<VerifyReport>;

export const VERIFY_INSTALL_TIMEOUT_MS = 600_000;
export const VERIFY_STEP_TIMEOUT_MS = 600_000;

/**
 * The scripts that are worth running, in the order a failure is cheapest to
 * read. A typecheck failure names a line; a build failure names a bundle.
 */
export const VERIFY_SCRIPTS = ["typecheck", "lint", "test", "build"] as const;

/** Lockfile → package manager, and the install that respects the lockfile. */
export const PACKAGE_MANAGERS: { lockfile: string; install: string[] ; run: (script: string) => string[] }[] = [
  { lockfile: "pnpm-lock.yaml", install: ["pnpm", "install", "--frozen-lockfile"], run: (s) => ["pnpm", "run", s] },
  { lockfile: "package-lock.json", install: ["npm", "ci"], run: (s) => ["npm", "run", s] },
  { lockfile: "yarn.lock", install: ["yarn", "install", "--frozen-lockfile"], run: (s) => ["yarn", "run", s] },
  { lockfile: "bun.lockb", install: ["bun", "install", "--frozen-lockfile"], run: (s) => ["bun", "run", s] },
];

/**
 * A repository's own answer to "what proves this change is safe", one
 * shell-free argv per line.
 *
 * INVENTED, with no users today. It is the escape hatch a repository owner
 * needs when their checks are not npm scripts, and it costs nothing when the
 * file is absent — which it is everywhere right now.
 */
export const VERIFY_PLAN_FILE = ".geoqa-verify";

export function parseVerifyPlan(text: string): string[][] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
}

export function readScripts(packageJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(packageJson);
    if (typeof parsed !== "object" || parsed === null) return [];
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return [];
    return Object.keys(scripts as Record<string, unknown>);
  } catch {
    return [];
  }
}

const stepFrom = async (ctx: VerifyContext, name: string, argv: string[], timeoutMs: number): Promise<VerifyStep> => {
  const started = ctx.now();
  const result = await ctx.exec(argv, timeoutMs);
  return { name, argv, exitCode: result.exitCode, ms: ctx.now() - started };
};

/**
 * Discover and run: `.geoqa-verify` first, then package.json scripts, else skip.
 *
 * A step that fails STOPS the plan. Running `build` after `test` already failed
 * spends ten minutes to learn nothing — the verdict is already decided.
 */
export const nodeVerifyPlan: VerifyRunner = async (ctx) => {
  const planText = ctx.readFile(VERIFY_PLAN_FILE);
  if (planText !== null) {
    const plan = parseVerifyPlan(planText);
    if (plan.length === 0) {
      return { state: "skipped", steps: [], detail: `${VERIFY_PLAN_FILE} named no commands` };
    }
    return runPlan(ctx, plan.map((argv, index) => ({ name: argv[0] ?? `step-${index}`, argv })), VERIFY_STEP_TIMEOUT_MS);
  }

  const pkg = ctx.readFile("package.json");
  if (pkg === null) {
    return { state: "skipped", steps: [], detail: "no package.json and no .geoqa-verify — this repository declares no checks this agent can run" };
  }
  const manager = PACKAGE_MANAGERS.find((entry) => ctx.exists(entry.lockfile));
  if (manager === undefined) {
    return { state: "skipped", steps: [], detail: "package.json with no recognised lockfile — refusing to guess a package manager" };
  }
  // Driven from VERIFY_SCRIPTS, not from package.json's key order. Filtering
  // the package's own list preserved whatever order the repository happened to
  // declare — a package.json starting `"build"` spent ten minutes on a bundle
  // before the typecheck that would have named the broken line in seconds,
  // which is the exact ordering this constant exists to impose.
  const declared = new Set(readScripts(pkg));
  const scripts = VERIFY_SCRIPTS.filter((name) => declared.has(name));
  if (scripts.length === 0) {
    return { state: "skipped", steps: [], detail: `package.json defines none of ${VERIFY_SCRIPTS.join(", ")} — nothing was verified` };
  }

  const install = await stepFrom(ctx, "install", manager.install, VERIFY_INSTALL_TIMEOUT_MS);
  if (install.exitCode !== 0) {
    return { state: "failed", steps: [install], detail: `${manager.install.join(" ")} exited ${install.exitCode}` };
  }
  const report = await runPlan(
    ctx,
    scripts.map((name) => ({ name, argv: manager.run(name) })),
    VERIFY_STEP_TIMEOUT_MS,
  );
  return { ...report, steps: [install, ...report.steps] };
};

async function runPlan(
  ctx: VerifyContext,
  plan: readonly { name: string; argv: string[] }[],
  timeoutMs: number,
): Promise<VerifyReport> {
  const steps: VerifyStep[] = [];
  for (const entry of plan) {
    const step = await stepFrom(ctx, entry.name, entry.argv, timeoutMs);
    steps.push(step);
    if (step.exitCode !== 0) {
      return { state: "failed", steps, detail: `${entry.name} exited ${step.exitCode}` };
    }
  }
  return { state: "passed", steps };
}
