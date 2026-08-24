/**
 * The review gate, adversarially.
 *
 * The claim this file has to earn is the one the whole design rests on: the
 * review can REJECT, the rejection stops the item BEFORE anything reaches
 * origin, and nothing anywhere can weaken the target repository's own checks to
 * turn a failure into a pass. A review that only ever approves would be worse
 * than no review — it manufactures confidence that a diff nobody read is a diff
 * somebody read — so every test below is a case where the answer must be no.
 *
 * Both claude seams are injected functions, never `vi.mock("...")`: a mocked
 * specifier that stops resolving does not error, it silently stops mocking, and
 * a suite that quietly stopped faking `claude` would spend a Max subscription in
 * CI and clone a customer repository to do it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REVIEW_POLICY,
  makeReviewGate,
  mechanicalReview,
  parseNumstat,
  parseVerdict,
  type ReviewGatePorts,
} from "../review.js";
import {
  DIFF_TRUNCATED,
  MAX_REVIEW_DIFF_BYTES,
  REVIEW_APPROVE_LINE,
  buildReviewPrompt,
  truncateDiff,
} from "../review-prompt.js";
import {
  PACKAGE_MANAGERS,
  VERIFY_PLAN_FILE,
  VERIFY_SCRIPTS,
  nodeVerifyPlan,
  parseVerifyPlan,
  readScripts,
  type VerifyContext,
  type VerifyReport,
} from "../verify.js";
import type { RepairExecResult, RepairJob } from "../../assist/repair.js";
import type { AssistOutcome } from "../../assist/types.js";
import { ok } from "./fixtures.js";

const job = (over: Partial<RepairJob> = {}): RepairJob => ({
  key: "issue:343",
  title: "Meta description is 187 characters",
  body: "## Impact\nSERP truncation",
  issueNumber: 343,
  issueUrl: "https://github.com/Xala-Technologies/booking-brilliance/issues/343",
  issueRepo: "Xala-Technologies/booking-brilliance",
  codeRepo: "Xala-Technologies/booking-brilliance",
  base: "main",
  site: "digilist.no",
  urgent: false,
  branch: "geoqa/issue-343",
  ...over,
});

const exit = (over: Partial<RepairExecResult> = {}): RepairExecResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  ...over,
});

/**
 * An exec fake keyed by argv substring, plus the log of everything it was
 * asked to run. The log is the assertion that matters most here: after a
 * rejection it must contain no `git push`.
 */
function gateExec(replies: Record<string, Partial<RepairExecResult>>): {
  exec: (argv: string[], timeoutMs: number) => Promise<RepairExecResult>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    exec: async (argv) => {
      const key = argv.join(" ");
      calls.push(key);
      const hit = Object.entries(replies).find(([pattern]) => key.includes(pattern));
      return exit(hit?.[1] ?? {});
    },
  };
}

const gatePorts = (over: Partial<ReviewGatePorts> = {}): ReviewGatePorts => ({
  claude: async () => ok(REVIEW_APPROVE_LINE),
  policy: DEFAULT_REVIEW_POLICY,
  verify: async () => ({ state: "passed", steps: [] }),
  readFile: () => null,
  exists: () => false,
  now: () => 0,
  ...over,
});

const NUMSTAT_ONE_FILE = "3\t1\tsrc/pages/index.astro\n";

describe("parseNumstat", () => {
  it("counts files and lines, tolerates binary rows, and ignores noise", () => {
    const stat = parseNumstat("3\t1\tsrc/a.ts\n-\t-\tpublic/logo.png\n\nnot a row\n10\t2\tsrc/b.ts\n");
    expect(stat.files).toEqual(["src/a.ts", "public/logo.png", "src/b.ts"]);
    expect(stat.insertions).toBe(13);
    expect(stat.deletions).toBe(3);
  });

  it("keeps a path that itself contains a tab rather than truncating it", () => {
    expect(parseNumstat("1\t0\tsrc/we\tird.ts\n").files).toEqual(["src/we\tird.ts"]);
  });

  it("reads an empty diff as no files, which mechanicalReview rejects", () => {
    expect(parseNumstat("").files).toEqual([]);
  });
});

describe("mechanicalReview", () => {
  it("rejects an empty diff — a fix that changed nothing is not a fix", () => {
    expect(mechanicalReview({ files: [], insertions: 0, deletions: 0 }, DEFAULT_REVIEW_POLICY)).toEqual({
      verdict: "reject",
      reason: "the diff against the base branch is empty",
    });
  });

  it("rejects a diff over the file cap", () => {
    const files = Array.from({ length: DEFAULT_REVIEW_POLICY.maxFiles + 1 }, (_, i) => `src/f${i}.ts`);
    expect(mechanicalReview({ files, insertions: 1, deletions: 0 }, DEFAULT_REVIEW_POLICY).verdict).toBe("reject");
  });

  it("rejects a diff over the line cap", () => {
    const verdict = mechanicalReview(
      { files: ["src/a.ts"], insertions: DEFAULT_REVIEW_POLICY.maxLines, deletions: 1 },
      DEFAULT_REVIEW_POLICY,
    );
    expect(verdict).toEqual({
      verdict: "reject",
      reason: `${DEFAULT_REVIEW_POLICY.maxLines + 1} lines changed, over the ${DEFAULT_REVIEW_POLICY.maxLines} a single finding may touch`,
    });
  });

  it("rejects every denied path, and each one is a blast radius the issue never asked for", () => {
    for (const file of [
      ".github/workflows/ci.yml",
      "infra/geoqa.service",
      ".env",
      "Dockerfile",
      "docker-compose.yml",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lockb",
    ]) {
      expect(mechanicalReview({ files: [file], insertions: 1, deletions: 0 }, DEFAULT_REVIEW_POLICY)).toEqual({
        verdict: "reject",
        reason: `${file} is outside what an unattended fix may change`,
      });
    }
  });

  it("refuses a diff that would author its own verification", () => {
    // The hole this closes, demonstrated before it was closed: `verify.ts`
    // reads `.geoqa-verify` and `package.json` out of the clone AS THE REPAIR
    // MODEL LEFT IT. A two-line `.geoqa-verify` saying `true` made verify
    // report `passed` having run exactly `true`, and a `"test": "echo ok"`
    // does the same thing through package.json. Both were mechanically
    // APPROVED. An unattended fixer does not get to decide what proves it.
    for (const file of [".geoqa-verify", "package.json", "apps/web/package.json"]) {
      expect(mechanicalReview({ files: [file], insertions: 1, deletions: 1 }, DEFAULT_REVIEW_POLICY)).toEqual({
        verdict: "reject",
        reason: `${file} is outside what an unattended fix may change`,
      });
    }
  });

  it("approves a small in-bounds diff — the reject path is not unconditional", () => {
    expect(mechanicalReview({ files: ["src/pages/index.astro"], insertions: 3, deletions: 1 }, DEFAULT_REVIEW_POLICY)).toEqual({
      verdict: "approve",
    });
  });
});

describe("parseVerdict", () => {
  it("approves only on the exact line, as the last non-empty line", () => {
    expect(parseVerdict(ok(`I read it.\n\n${REVIEW_APPROVE_LINE}\n\n`))).toEqual({ verdict: "approve" });
  });

  it("rejects when the reviewer never answered at all — a review that did not happen is not an approval", () => {
    expect(parseVerdict({ ok: false, failure: { kind: "timeout", detail: "claude exceeded 600s" } }).verdict).toBe("reject");
  });

  it("rejects an empty reply", () => {
    expect(parseVerdict(ok("\n  \n"))).toEqual({ verdict: "reject", reason: "the reviewer printed nothing" });
  });

  it("rejects prose that never reaches a verdict line", () => {
    const verdict = parseVerdict(ok("This looks fine to me, ship it."));
    expect(verdict.verdict).toBe("reject");
  });

  it("rejects an approval that is only mentioned, not stated last", () => {
    expect(parseVerdict(ok(`${REVIEW_APPROVE_LINE}\nbut actually I am not sure`)).verdict).toBe("reject");
  });

  it("rejects when both verdicts appear — a reviewer that could not decide did not approve", () => {
    expect(parseVerdict(ok(`VERDICT: REJECT — it deletes a test\n${REVIEW_APPROVE_LINE}`))).toEqual({
      verdict: "reject",
      reason: "the reviewer printed both an approval and a rejection",
    });
  });

  it("carries the reviewer's reason through, and supplies one when it gave none", () => {
    expect(parseVerdict(ok("VERDICT: REJECT — it deletes tests/meta.spec.ts"))).toEqual({
      verdict: "reject",
      reason: "it deletes tests/meta.spec.ts",
    });
    expect(parseVerdict(ok("VERDICT: REJECT"))).toEqual({ verdict: "reject", reason: "the reviewer rejected without a reason" });
  });
});

describe("buildReviewPrompt", () => {
  it("enumerates the ways a check gets weakened, because an unlisted criterion never fires", () => {
    const prompt = buildReviewPrompt({ title: "t", issueBody: "b", issueNumber: 343, codeRepo: "o/n", diff: "d" });
    for (const phrase of ["deleted or skipped test", "loosened threshold", "@ts-ignore", "eslint-disable", "--force"]) {
      expect(prompt).toContain(phrase);
    }
    expect(prompt.endsWith("<one line saying which question failed and why>")).toBe(true);
  });

  it("truncates an oversized diff and says the truncation is itself a reason to reject", () => {
    const huge = "x".repeat(MAX_REVIEW_DIFF_BYTES + 10);
    expect(truncateDiff(huge)).toBe(`${"x".repeat(MAX_REVIEW_DIFF_BYTES)}${DIFF_TRUNCATED}`);
    expect(truncateDiff("small")).toBe("small");
  });
});

describe("makeReviewGate — the veto", () => {
  it("REJECTS a diff that deletes the test the issue was about, and never pushes", async () => {
    // The diff a lazy fixer writes: the meta-description test is gone, so the
    // suite is green and the finding is untouched.
    const diff = [
      "diff --git a/tests/meta.spec.ts b/tests/meta.spec.ts",
      "deleted file mode 100644",
      "--- a/tests/meta.spec.ts",
      "+++ /dev/null",
      "-test('description is under 155 chars', () => { expect(len).toBeLessThan(155); });",
    ].join("\n");
    const { exec, calls } = gateExec({
      "git diff --numstat": { stdout: "0\t1\ttests/meta.spec.ts\n" },
      "git diff origin": { stdout: diff },
      "git rev-parse": { stdout: "abc123" },
    });
    const seen: string[] = [];
    const reviewed: { key: string; verdict: string }[] = [];
    const verify = vi.fn(async (): Promise<VerifyReport> => ({ state: "passed", steps: [] }));
    const gate = makeReviewGate(
      gatePorts({
        claude: async (prompt) => {
          seen.push(prompt);
          return ok("Question 3 fails.\nVERDICT: REJECT — the diff deletes tests/meta.spec.ts instead of shortening the description");
        },
        verify,
        onReview: (key, verdict) => reviewed.push({ key, verdict: verdict.verdict }),
      }),
    );

    const result = await gate({ job: job(), workdir: "/w", exec });

    expect(result).toEqual({
      ok: false,
      status: "rejected",
      detail: "the diff deletes tests/meta.spec.ts instead of shortening the description",
    });
    expect(reviewed).toEqual([{ key: "issue:343", verdict: "reject" }]);
    // The reviewer actually saw the deletion — this is not a rejection for an
    // unrelated reason that would also fire on a good diff.
    expect(seen[0]).toContain("deleted file mode");
    // A rejected diff costs nothing further: verify never ran, and above all
    // NOTHING reached origin.
    expect(verify).not.toHaveBeenCalled();
    expect(calls.some((call) => call.startsWith("git push"))).toBe(false);
    expect(calls.some((call) => call.startsWith("gh pr create"))).toBe(false);
  });

  it("REJECTS a diff that loosens a threshold to make the check pass", async () => {
    const { exec } = gateExec({
      "git diff --numstat": { stdout: "1\t1\tvitest.config.ts\n" },
      "git diff origin": { stdout: "-thresholds: { lines: 100 }\n+thresholds: { lines: 60 }" },
    });
    const gate = makeReviewGate(
      gatePorts({ claude: async () => ok("VERDICT: REJECT — lowers the coverage threshold from 100 to 60") }),
    );
    expect(await gate({ job: job(), workdir: "/w", exec })).toEqual({
      ok: false,
      status: "rejected",
      detail: "lowers the coverage threshold from 100 to 60",
    });
  });

  it("rejects mechanically WITHOUT spending a model call when the diff is out of bounds", async () => {
    const claude = vi.fn(async (): Promise<AssistOutcome> => ok(REVIEW_APPROVE_LINE));
    const { exec } = gateExec({ "git diff --numstat": { stdout: "5\t0\t.github/workflows/ci.yml\n" } });
    const gate = makeReviewGate(gatePorts({ claude }));
    expect(await gate({ job: job(), workdir: "/w", exec })).toEqual({
      ok: false,
      status: "rejected",
      detail: ".github/workflows/ci.yml is outside what an unattended fix may change",
    });
    expect(claude).not.toHaveBeenCalled();
  });

  it("rejects when git itself could not produce a diff — an unreadable diff is not a reviewed one", async () => {
    const { exec } = gateExec({ "git diff --numstat": { exitCode: 128, stderr: "fatal: bad revision" } });
    const gate = makeReviewGate(gatePorts());
    expect(await gate({ job: job(), workdir: "/w", exec })).toEqual({
      ok: false,
      status: "rejected",
      detail: "fatal: bad revision",
    });
  });

  it("prefers the exec error over stderr when git could not run at all", async () => {
    const { exec } = gateExec({ "git diff --numstat": { exitCode: 1, error: "spawn ENOENT" } });
    const gate = makeReviewGate(gatePorts());
    expect((await gate({ job: job(), workdir: "/w", exec })) as { detail: string }).toMatchObject({ detail: "spawn ENOENT" });
  });

  it("falls back to a default detail when git failed silently", async () => {
    const { exec } = gateExec({ "git diff --numstat": { exitCode: 1 } });
    const gate = makeReviewGate(gatePorts());
    expect((await gate({ job: job(), workdir: "/w", exec })) as { detail: string }).toMatchObject({
      detail: "git diff --numstat failed",
    });
  });

  it("rejects a reviewer that EDITED the checkout it was told only to read", async () => {
    let head = "abc123";
    const calls: string[] = [];
    const exec = async (argv: string[]): Promise<RepairExecResult> => {
      const key = argv.join(" ");
      calls.push(key);
      if (key.includes("git diff --numstat")) return exit({ stdout: NUMSTAT_ONE_FILE });
      if (key.includes("git rev-parse")) return exit({ stdout: head });
      return exit();
    };
    const gate = makeReviewGate(
      gatePorts({
        claude: async () => {
          // The reviewer committed something. Read-only-ness is a mechanical
          // check here, not a promise in a prompt.
          head = "def456";
          return ok(REVIEW_APPROVE_LINE);
        },
      }),
    );
    expect(await gate({ job: job(), workdir: "/w", exec })).toEqual({
      ok: false,
      status: "rejected",
      detail: "review-tampered: the reviewer changed the checkout it was reading",
    });
    expect(calls.some((call) => call.startsWith("git push"))).toBe(false);
  });

  it("rejects a reviewer that left the worktree dirty", async () => {
    let porcelain = "";
    const exec = async (argv: string[]): Promise<RepairExecResult> => {
      const key = argv.join(" ");
      if (key.includes("git diff --numstat")) return exit({ stdout: NUMSTAT_ONE_FILE });
      if (key.includes("git status --porcelain")) return exit({ stdout: porcelain });
      return exit({ stdout: "abc123" });
    };
    const gate = makeReviewGate(
      gatePorts({
        claude: async () => {
          porcelain = " M src/pages/index.astro";
          return ok(REVIEW_APPROVE_LINE);
        },
      }),
    );
    expect((await gate({ job: job(), workdir: "/w", exec })) as { status: string }).toMatchObject({ status: "rejected" });
  });

  it("stops at verify-failed when the target repo's OWN checks fail on an approved diff", async () => {
    const { exec, calls } = gateExec({ "git diff --numstat": { stdout: NUMSTAT_ONE_FILE } });
    const verified: VerifyReport[] = [];
    const gate = makeReviewGate(
      gatePorts({
        verify: async () => ({ state: "failed", steps: [{ name: "test", argv: ["npm", "run", "test"], exitCode: 1, ms: 12 }], detail: "test exited 1" }),
        onVerify: (_key, report) => verified.push(report),
      }),
    );
    expect(await gate({ job: job(), workdir: "/w", exec })).toEqual({
      ok: false,
      status: "verify-failed",
      detail: "test exited 1",
    });
    expect(verified[0]?.state).toBe("failed");
    expect(calls.some((call) => call.startsWith("git push"))).toBe(false);
  });

  it("names the repository's verdict when the failing report carried no detail", async () => {
    const { exec } = gateExec({ "git diff --numstat": { stdout: NUMSTAT_ONE_FILE } });
    const gate = makeReviewGate(gatePorts({ verify: async () => ({ state: "failed", steps: [] }) }));
    expect((await gate({ job: job(), workdir: "/w", exec })) as { detail: string }).toMatchObject({
      detail: "this repository's own checks failed on the fix",
    });
  });

  it("APPROVES a small correct diff whose checks pass — the gate is a filter, not a wall", async () => {
    const { exec } = gateExec({ "git diff --numstat": { stdout: NUMSTAT_ONE_FILE } });
    const gate = makeReviewGate(
      gatePorts({
        verify: async () => ({
          state: "passed",
          steps: [
            { name: "install", argv: ["npm", "ci"], exitCode: 0, ms: 90 },
            { name: "test", argv: ["npm", "run", "test"], exitCode: 0, ms: 40 },
          ],
        }),
      }),
    );
    expect(await gate({ job: job(), workdir: "/w", exec })).toEqual({
      ok: true,
      note: {
        verdict: "approve",
        verifyState: "passed",
        steps: [
          { name: "install", exitCode: 0 },
          { name: "test", exitCode: 0 },
        ],
      },
    });
  });

  it("passes a SKIPPED verify — a repo that declares no checks is not a rejected fix", async () => {
    const { exec } = gateExec({ "git diff --numstat": { stdout: NUMSTAT_ONE_FILE } });
    const gate = makeReviewGate(
      gatePorts({ verify: async () => ({ state: "skipped", steps: [], detail: "no package.json" }) }),
    );
    expect((await gate({ job: job(), workdir: "/w", exec })) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it("hands verify a reader scoped to the clone, not to this process's cwd", async () => {
    const { exec } = gateExec({ "git diff --numstat": { stdout: NUMSTAT_ONE_FILE } });
    const seen: { readFile: string | null; exists: boolean; workdir: string }[] = [];
    const gate = makeReviewGate(
      gatePorts({
        readFile: (workdir, rel) => `${workdir}::${rel}`,
        exists: (workdir, rel) => `${workdir}${rel}` !== "",
        verify: async (ctx) => {
          seen.push({ readFile: ctx.readFile("package.json"), exists: ctx.exists("pnpm-lock.yaml"), workdir: ctx.workdir });
          return { state: "passed", steps: [] };
        },
      }),
    );
    await gate({ job: job(), workdir: "/w", exec });
    expect(seen).toEqual([{ readFile: "/w::package.json", exists: true, workdir: "/w" }]);
  });
});

describe("verify — the target repository's own checks", () => {
  const ctxOf = (over: Partial<VerifyContext> & { runs?: string[][] } = {}): VerifyContext & { runs: string[][] } => {
    const runs: string[][] = over.runs ?? [];
    return {
      runs,
      workdir: "/w",
      exec: async (argv) => {
        runs.push(argv);
        return exit();
      },
      readFile: () => null,
      exists: () => false,
      now: () => 0,
      ...over,
    };
  };

  it("skips when the repository declares nothing this agent can run", async () => {
    expect(await nodeVerifyPlan(ctxOf())).toMatchObject({ state: "skipped" });
  });

  it("refuses to guess a package manager when no lockfile is present", async () => {
    const report = await nodeVerifyPlan(ctxOf({ readFile: (rel) => (rel === "package.json" ? `{"scripts":{"test":"vitest"}}` : null) }));
    expect(report).toMatchObject({ state: "skipped", detail: "package.json with no recognised lockfile — refusing to guess a package manager" });
  });

  it("skips a package.json that defines none of the scripts it knows how to run", async () => {
    const report = await nodeVerifyPlan(
      ctxOf({
        readFile: (rel) => (rel === "package.json" ? `{"scripts":{"dev":"vite"}}` : null),
        exists: (rel) => rel === "pnpm-lock.yaml",
      }),
    );
    expect(report.state).toBe("skipped");
    expect(report.detail).toContain(VERIFY_SCRIPTS.join(", "));
  });

  it("installs with the lockfile's own manager and runs typecheck, lint, test, build in order", async () => {
    const runs: string[][] = [];
    const report = await nodeVerifyPlan(
      ctxOf({
        runs,
        readFile: (rel) => (rel === "package.json" ? `{"scripts":{"build":"x","test":"y","typecheck":"z","lint":"w","dev":"v"}}` : null),
        exists: (rel) => rel === "package-lock.json",
      }),
    );
    expect(report.state).toBe("passed");
    expect(runs).toEqual([
      ["npm", "ci"],
      ["npm", "run", "typecheck"],
      ["npm", "run", "lint"],
      ["npm", "run", "test"],
      ["npm", "run", "build"],
    ]);
  });

  it("runs a pnpm repository through its own frozen install and scripts", async () => {
    const runs: string[][] = [];
    const report = await nodeVerifyPlan(
      ctxOf({
        runs,
        readFile: (rel) => (rel === "package.json" ? `{"scripts":{"lint":"l","test":"t"}}` : null),
        exists: (rel) => rel === "pnpm-lock.yaml",
      }),
    );
    expect(report.state).toBe("passed");
    expect(runs).toEqual([
      ["pnpm", "install", "--frozen-lockfile"],
      ["pnpm", "run", "lint"],
      ["pnpm", "run", "test"],
    ]);
  });

  it("FAILS when the install fails, and never reaches a script", async () => {
    const runs: string[][] = [];
    const report = await nodeVerifyPlan(
      ctxOf({
        runs,
        exec: async (argv) => {
          runs.push(argv);
          return exit({ exitCode: 1 });
        },
        readFile: (rel) => (rel === "package.json" ? `{"scripts":{"test":"vitest"}}` : null),
        exists: (rel) => rel === "pnpm-lock.yaml",
      }),
    );
    expect(report).toMatchObject({ state: "failed", detail: "pnpm install --frozen-lockfile exited 1" });
    expect(runs).toEqual([["pnpm", "install", "--frozen-lockfile"]]);
  });

  it("FAILS on the first failing script and stops the plan there", async () => {
    const runs: string[][] = [];
    const report = await nodeVerifyPlan(
      ctxOf({
        runs,
        exec: async (argv) => {
          runs.push(argv);
          return exit({ exitCode: argv.includes("test") ? 1 : 0 });
        },
        readFile: (rel) => (rel === "package.json" ? `{"scripts":{"typecheck":"t","test":"v","build":"b"}}` : null),
        exists: (rel) => rel === "yarn.lock",
      }),
    );
    expect(report).toMatchObject({ state: "failed", detail: "test exited 1" });
    expect(report.steps.map((step) => step.name)).toEqual(["install", "typecheck", "test"]);
    expect(runs.some((argv) => argv.includes("build"))).toBe(false);
  });

  it("times every step against the injected clock", async () => {
    let clock = 0;
    const report = await nodeVerifyPlan(
      ctxOf({
        now: () => (clock += 10),
        readFile: (rel) => (rel === "package.json" ? `{"scripts":{"test":"v"}}` : null),
        exists: (rel) => rel === "bun.lockb",
      }),
    );
    expect(report.steps.every((step) => step.ms === 10)).toBe(true);
  });

  it("runs a repository's own .geoqa-verify plan instead of guessing, and never installs behind its back", async () => {
    const runs: string[][] = [];
    const report = await nodeVerifyPlan(
      ctxOf({
        runs,
        readFile: (rel) => (rel === VERIFY_PLAN_FILE ? "# the checks that matter\nmake check\nmake test\n" : null),
      }),
    );
    expect(report.state).toBe("passed");
    expect(runs).toEqual([
      ["make", "check"],
      ["make", "test"],
    ]);
  });

  it("skips a .geoqa-verify that names no commands rather than treating it as a pass to celebrate", async () => {
    expect(await nodeVerifyPlan(ctxOf({ readFile: (rel) => (rel === VERIFY_PLAN_FILE ? "# nothing\n\n" : null) }))).toMatchObject({
      state: "skipped",
      detail: `${VERIFY_PLAN_FILE} named no commands`,
    });
  });

  it("names an unnamed plan step by its index rather than throwing", () => {
    expect(parseVerifyPlan("make check\n#comment\n\n  npm  run  test  ")).toEqual([
      ["make", "check"],
      ["npm", "run", "test"],
    ]);
  });

  it("reads scripts defensively — malformed package.json is no scripts, not a crash", () => {
    expect(readScripts(`{"scripts":{"test":"x"}}`)).toEqual(["test"]);
    expect(readScripts("not json")).toEqual([]);
    expect(readScripts("null")).toEqual([]);
    expect(readScripts(`{"scripts":null}`)).toEqual([]);
    expect(readScripts(`{}`)).toEqual([]);
  });

  it("knows one install command per lockfile and no others", () => {
    expect(PACKAGE_MANAGERS.map((entry) => entry.lockfile)).toEqual([
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "bun.lockb",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Auth must come from config, never from the machine
// ---------------------------------------------------------------------------

describe("gh invocations carry an explicit GH_TOKEN", () => {
  it("ghPrOpen passes GEOQA_GITHUB_TOKEN through as GH_TOKEN", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "..", "cli", "commands.ts"), "utf8");
    const fn = src.slice(src.indexOf("const ghPrOpen"), src.indexOf("const ghPrOpen") + 1400);

    // The failure this pins: `env: input.env` lets gh fall back to
    // ~/.config/gh/hosts.yml. A stale token there once made every `gh pr list`
    // throw, and because an unanswerable "does a PR exist?" is read as YES, the
    // run skipped all 54 items and opened nothing while reporting success.
    expect(fn).toContain("gh");
    expect(fn).toMatch(/env:\s*ghEnv\(/);
    expect(fn).not.toMatch(/env:\s*input\.env\s*,/);
  });

  it("ghEnv actually sets GH_TOKEN", async () => {
    const { ghEnv } = await import("../../assist/repair.js");
    const out = ghEnv("tok-123", { PATH: "/usr/bin" } as NodeJS.ProcessEnv);
    expect(out.GH_TOKEN).toBe("tok-123");
    expect(out.PATH).toBe("/usr/bin");
  });
});
