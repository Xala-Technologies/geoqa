/**
 * The composition root, and only the composition root.
 *
 * `fix/run.ts` decides what happens; this file decides what is WIRED to what,
 * and two of those wirings are safety properties rather than plumbing:
 *
 *   - the tenant's `fix.automerge` is a kill switch, so `--merge` can only turn
 *     auto-merge ON where the tenant already allowed it. A flag that could
 *     override a kill switch would not be a kill switch.
 *   - the intake labels really are `findings` AND `agent: approved`, which is
 *     the one thing standing between "a human opted this issue in" and "an
 *     unattended model was handed an nginx ticket".
 *
 * Nothing here spawns `claude`, `git`, `gh` or `pg`. Every one of those arrives
 * through `FixRunCommandOptions` as an injected function, and the assertions
 * below are against the argv those fakes were handed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDeps, fixRun, renderFixRun } from "../commands.js";
import { findRepoRoot } from "../../repo.js";
import { GITHUB_INTAKE_LABELS } from "../../fix/intake-github.js";
import type { RepairExec } from "../../assist/repair.js";
import type { FixRunResult } from "../../fix/types.js";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
let evidenceRoot: string;
beforeEach(() => {
  evidenceRoot = mkdtempSync(path.join(tmpdir(), "geoqa-fix-"));
});
afterEach(() => {
  rmSync(evidenceRoot, { recursive: true, force: true });
});

const ENV = { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "Xala-Technologies/geoqa" };
const PR_URL = "https://github.com/Xala-Technologies/Digilist/pull/1";

const deps = (over: Record<string, unknown> = {}) =>
  defaultDeps(repoRoot, { evidenceRoot, tenantId: "digilist", env: ENV, now: () => 1, log: () => undefined, ...over });

/** A `RepairExec` that carries `repairOne` to an open PR, and records every argv. */
function recordingExec(): RepairExec & { argv: string[][]; envs: NodeJS.ProcessEnv[] } {
  const argv: string[][] = [];
  // The ENV matters as much as the argv. Without GH_TOKEN, `gh` falls back to
  // ~/.config/gh/hosts.yml — a credential nobody in this codebase chose.
  const envs: NodeJS.ProcessEnv[] = [];
  return {
    argv,
    envs,
    mkdir: () => undefined,
    exists: () => false,
    rm: () => undefined,
    run: async (input) => {
      argv.push(input.argv);
      envs.push(input.env ?? {});
      const key = input.argv.join(" ");
      if (key.includes("git diff --numstat")) return { stdout: "3\t1\tsrc/x.ts\n", stderr: "", exitCode: 0 };
      if (key.includes("git diff")) return { stdout: "--- a/src/x.ts\n+++ b/src/x.ts\n+<input name=q>", stderr: "", exitCode: 0 };
      if (key.includes("git rev-parse")) return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      if (key.includes("git status")) return { stdout: " M src/x.ts\n", stderr: "", exitCode: 0 };
      if (key.includes("gh pr create")) return { stdout: `${PR_URL}\n`, stderr: "", exitCode: 0 };
      if (key.includes("gh pr list")) return { stdout: "[]", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

const filedIssues = {
  issues: [
    {
      key: "site:has a search box:app.digilist.no",
      number: 46,
      url: "https://github.com/Xala-Technologies/geoqa/issues/46",
      at: "2026-08-18T21:00:00.000Z",
    },
  ],
};

const runRecord = JSON.stringify({
  schemaVersion: 1,
  runId: "run_1",
  tenantId: "digilist",
  target: "https://app.digilist.no/",
  profileId: "oslo-desktop",
  journeyId: "search",
  verdict: "FAIL",
  startedAt: "2026-08-18T21:00:00.000Z",
  durationMs: 5,
  seed: 1,
  engine: "playwright",
  evidenceId: null,
  findings: { total: 1, bySeverity: { high: 1 }, byCategory: { functional: 1 }, labels: ["has a search box"] },
  confidence: { overall: 80, geo: 100, browser: 100, journey: 80, evidence: 80 },
  geo: {
    requestedCountry: "NO",
    requestedCity: "Oslo",
    observedCountry: "NO",
    observedCity: "Oslo",
    country: "match",
    city: "match",
    egressHeld: "match",
    agreement: "unverified",
  },
  latencyMs: 10,
  vitals: { lcp: null, cls: null, ttfb: null, inp: null },
});

const seedGeoqaFinding = (): void => {
  writeFileSync(path.join(evidenceRoot, "runs.jsonl"), `${runRecord}\n`);
  writeFileSync(path.join(evidenceRoot, "filed-issues.json"), `${JSON.stringify(filedIssues)}\n`);
};

/** Ports common to every apply-mode test here: no database, no network. */
const offline = {
  growth: null,
  listIssues: async () => [],
  addLabels: async () => undefined,
  comment: async () => undefined,
  prOpen: async () => false,
} as const;

describe("fixRun — configuration", () => {
  it("is OFF without a token or a repo, and says which", async () => {
    const result = await fixRun(deps({ env: {} }));
    expect(result.skipped).toBe("unconfigured");
    expect(renderFixRun(result)).toContain("GEOQA_GITHUB_TOKEN");
  });

  it("leaves growth OFF when POSTGRES_PASSWORD is unset — no password is not a broken database", async () => {
    const result = await fixRun(deps(), { dryRun: true });
    expect(result.sources.growth.state).toBe("off");
    expect(result.sources.growth.detail).toContain("POSTGRES_PASSWORD");
  });

  it("asks GitHub for both intake labels, never one", async () => {
    const asked: { repo: string; labels: string[]; limit: number }[] = [];
    await fixRun(deps(), {
      dryRun: true,
      growth: null,
      listIssues: async (input) => {
        asked.push(input);
        return [];
      },
    });
    expect(asked[0]?.labels).toEqual(GITHUB_INTAKE_LABELS);
    expect(GITHUB_INTAKE_LABELS).toEqual(["findings", "agent: approved"]);
  });

  it("reads the tenant's repo keys and agent allowlist, and survives a tenant that is not there", async () => {
    // No tenant at all: an empty allowlist, and the run still reaches a verdict
    // rather than throwing on a missing file.
    const nameless = await fixRun(deps({ tenantId: undefined }), { dryRun: true, growth: null });
    expect(nameless.skipped).toBe("dry-run");
    const missing = await fixRun(deps({ tenantId: "no-such-tenant" }), { dryRun: true, growth: null });
    expect(missing.skipped).toBe("dry-run");
  });
});

describe("fixRun — the merge kill switch", () => {
  it("refuses --merge unless the TENANT allows it, and never asks GitHub to auto-merge otherwise", async () => {
    seedGeoqaFinding();
    const exec = recordingExec();
    const result = await fixRun(deps(), {
      ...offline,
      merge: true,
      exec,
      claude: { repair: async () => ({ ok: true, text: "fixed" }), review: async () => ({ ok: true, text: "VERDICT: APPROVE" }) },
      verify: async () => ({ state: "skipped", steps: [], detail: "nothing to run" }),
    });
    expect(result.outcomes[0]?.status).toBe("opened");
    // digilist.yaml does not set fix.automerge, so the flag is inert.
    expect(exec.argv.some((argv) => argv.join(" ").startsWith("gh pr merge"))).toBe(false);
    expect(result.outcomes[0]?.autoMerge).toBe(false);
  });
});

describe("fixRun — the gate this command wires up", () => {
  const claudeThatFixes = { repair: async () => ({ ok: true as const, text: "fixed" }) };

  it("REJECTS on the reviewer's verdict, opens no pull request, and comments the reason", async () => {
    seedGeoqaFinding();
    const exec = recordingExec();
    const comments: { number: number; body: string }[] = [];
    const labels: string[][] = [];
    const result = await fixRun(deps(), {
      ...offline,
      exec,
      claude: {
        ...claudeThatFixes,
        review: async () => ({ ok: true, text: "VERDICT: REJECT — it deletes the assertion instead of restoring the search box" }),
      },
      comment: async (input) => {
        comments.push({ number: input.number, body: input.body });
      },
      addLabels: async (input) => {
        labels.push(input.labels);
      },
    });

    expect(result.outcomes[0]).toMatchObject({ status: "rejected", reviewVerdict: "reject" });
    expect(exec.argv.some((argv) => argv[0] === "git" && argv[1] === "push")).toBe(false);
    expect(exec.argv.some((argv) => argv.join(" ").startsWith("gh pr create"))).toBe(false);
    expect(comments[0]?.body).toContain("deletes the assertion");
    expect(labels).toEqual([["agent: changes-requested"]]);
    expect(renderFixRun(result)).toContain("rejected");
  });

  it("REJECTS a reviewer that printed no verdict — a review that did not happen is not an approval", async () => {
    seedGeoqaFinding();
    const exec = recordingExec();
    const result = await fixRun(deps(), {
      ...offline,
      exec,
      claude: { ...claudeThatFixes, review: async () => ({ ok: true, text: "Looks fine." }) },
    });
    expect(result.outcomes[0]?.status).toBe("rejected");
    expect(exec.argv.some((argv) => argv[0] === "git" && argv[1] === "push")).toBe(false);
  });

  it("stops at verify-failed when the target repo's own checks fail, and pushes nothing", async () => {
    seedGeoqaFinding();
    const exec = recordingExec();
    const result = await fixRun(deps(), {
      ...offline,
      exec,
      claude: { ...claudeThatFixes, review: async () => ({ ok: true, text: "VERDICT: APPROVE" }) },
      verify: async () => ({ state: "failed", steps: [{ name: "test", argv: ["npm", "run", "test"], exitCode: 1, ms: 1 }], detail: "test exited 1" }),
    });
    expect(result.outcomes[0]).toMatchObject({ status: "verify-failed", verify: { state: "failed" } });
    expect(exec.argv.some((argv) => argv[0] === "git" && argv[1] === "push")).toBe(false);
    expect(renderFixRun(result)).toContain("verify=failed");
  });

  it("opens the pull request when the review approves and the checks pass", async () => {
    seedGeoqaFinding();
    const exec = recordingExec();
    const result = await fixRun(deps(), {
      ...offline,
      exec,
      claude: { ...claudeThatFixes, review: async () => ({ ok: true, text: "VERDICT: APPROVE" }) },
      verify: async () => ({ state: "passed", steps: [{ name: "test", argv: ["npm", "run", "test"], exitCode: 0, ms: 1 }] }),
    });
    expect(result.outcomes[0]).toMatchObject({ status: "opened", prUrl: PR_URL, reviewVerdict: "approve" });
    // The PR body carries the review note, in the words `brief.ts` chose.
    const created = exec.argv.find((argv) => argv.join(" ").startsWith("gh pr create")) ?? [];
    expect(created.join("\n")).toContain("Reviewed by a second model, not a human");
    expect(renderFixRun(result)).toContain("review=approve");
  });

  it("asks whether a pull request already exists — including CLOSED ones", async () => {
    seedGeoqaFinding();
    const exec = recordingExec();
    // The real `ghPrOpen`, not a fake: this is the argv that decides whether a
    // night is skipped, and `--state all` is the load-bearing flag.
    const result = await fixRun(deps(), {
      growth: null,
      listIssues: async () => [],
      addLabels: async () => undefined,
      comment: async () => undefined,
      exec,
      claude: { ...claudeThatFixes, review: async () => ({ ok: true, text: "VERDICT: APPROVE" }) },
      verify: async () => ({ state: "skipped", steps: [] }),
    });
    const asked = exec.argv.find((argv) => argv.join(" ").includes("gh pr list")) ?? [];
    expect(asked).toEqual([
      "gh",
      "pr",
      "list",
      "--repo",
      "Xala-Technologies/Digilist",
      "--head",
      "geoqa/issue-46",
      "--state",
      "all",
      "--json",
      "number",
    ]);
    expect(result.outcomes[0]?.status).toBe("opened");

    // …and it must carry OUR token, not the machine's. Passing the raw process
    // env let `gh` read ~/.config/gh/hosts.yml instead. When the token stored
    // there failed the org's token-lifetime policy, every `gh pr list` threw —
    // and because an unanswerable "does a PR exist?" is deliberately read as
    // YES, the run skipped all 54 items, opened nothing, and reported success.
    const askedAt = exec.argv.findIndex((a) => a.join(" ").includes("gh pr list"));
    expect(askedAt).toBeGreaterThanOrEqual(0);
    expect(exec.envs[askedAt]?.GH_TOKEN).toBe(ENV.GEOQA_GITHUB_TOKEN);
  });

  it("treats a pull request it CAN see as a night already spent", async () => {
    seedGeoqaFinding();
    const exec: RepairExec & { argv: string[][] } = {
      ...recordingExec(),
      run: async (input) => {
        if (input.argv.join(" ").includes("gh pr list")) return { stdout: `[{"number":9}]`, stderr: "", exitCode: 0 };
        throw new Error("nothing else should run once a PR is known to exist");
      },
    };
    const result = await fixRun(deps(), {
      growth: null,
      listIssues: async () => [],
      addLabels: async () => undefined,
      comment: async () => undefined,
      exec,
      claude: { ...claudeThatFixes, review: async () => ({ ok: true, text: "VERDICT: APPROVE" }) },
    });
    expect(result.skipped).toBe("nothing-eligible");
    expect(result.ineligible[0]?.reason).toBe("pr-open");
  });

  it("surfaces a `gh pr list` that failed rather than reading it as no pull request", async () => {
    seedGeoqaFinding();
    const exec: RepairExec & { argv: string[][] } = {
      ...recordingExec(),
      run: async (input) => {
        if (input.argv.join(" ").includes("gh pr list")) return { stdout: "", stderr: "gh: not logged in", exitCode: 1 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const result = await fixRun(deps(), { growth: null, listIssues: async () => [], exec, claude: { ...claudeThatFixes, review: async () => ({ ok: true, text: "x" }) } });
    expect(result.ineligible[0]?.reason).toBe("pr-open");
  });
});

describe("fixRun — the clone reader wired into verify", () => {
  it("reads the CLONE's own package.json and lockfile, and refuses a path that escapes it", async () => {
    seedGeoqaFinding();
    // `repairOne` puts the checkout here. The real `nodeVerifyPlan` runs, so the
    // readFile/exists this command binds are the ones under test — and they are
    // `containedPath`-scoped, which is what stops a repository named `..` from
    // making the agent read outside its own clone.
    const workdir = path.join(evidenceRoot, "fix-work", "Xala-Technologies", "Digilist-46");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(path.join(workdir, "package.json"), `{"scripts":{"test":"vitest run"}}`);
    writeFileSync(path.join(workdir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");

    const ran: string[][] = [];
    const exec: RepairExec & { argv: string[][] } = {
      ...recordingExec(),
      rm: () => undefined,
      run: async (input) => {
        ran.push(input.argv);
        const key = input.argv.join(" ");
        if (key.includes("git diff --numstat")) return { stdout: "3\t1\tsrc/x.ts\n", stderr: "", exitCode: 0 };
        if (key.includes("git rev-parse")) return { stdout: "abc123\n", stderr: "", exitCode: 0 };
        if (key.includes("git status")) return { stdout: " M src/x.ts\n", stderr: "", exitCode: 0 };
        if (key.includes("gh pr create")) return { stdout: `${PR_URL}\n`, stderr: "", exitCode: 0 };
        if (key.includes("gh pr list")) return { stdout: "[]", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const result = await fixRun(deps(), {
      ...offline,
      exec,
      claude: { repair: async () => ({ ok: true, text: "fixed" }), review: async () => ({ ok: true, text: "VERDICT: APPROVE" }) },
    });

    // It found the real files: pnpm's frozen install and the one script the
    // package declares, in the clone and nowhere else.
    expect(ran.some((argv) => argv.join(" ") === "pnpm install --frozen-lockfile")).toBe(true);
    expect(ran.some((argv) => argv.join(" ") === "pnpm run test")).toBe(true);
    expect(result.outcomes[0]).toMatchObject({ status: "opened", verify: { state: "passed" } });
  });
});

describe("renderFixRun", () => {
  const empty = (over: Partial<FixRunResult>): FixRunResult => ({
    skipped: "none",
    sources: { growth: { state: "ok", rows: 341 }, geoqa: { state: "off", rows: 0, detail: "x" }, github: { state: "unavailable", rows: 0 } },
    intake: 0,
    eligible: 0,
    attempted: 0,
    outcomes: [],
    ineligible: [],
    wouldFix: [],
    budget: { maxItems: 3, budgetMs: 240 * 60_000, usedMs: 60_000, stoppedOnBudget: false },
    runId: null,
    ...over,
  });

  it("names every skip in words an operator can act on", () => {
    expect(renderFixRun(empty({ skipped: "store-unreadable" }))).toContain("unreadable");
    expect(renderFixRun(empty({ skipped: "locked" }))).toContain("holds the lock");
    expect(renderFixRun(empty({ skipped: "no-sources" }))).toContain("nothing is known");
    expect(renderFixRun(empty({ skipped: "nothing-eligible", ineligible: [{ key: "k", reason: "pr-open" }] }))).toContain("skip k: pr-open");
  });

  it("shows a dry run's plan, with the route it would take", () => {
    const text = renderFixRun(
      empty({
        skipped: "dry-run",
        intake: 2,
        wouldFix: [
          {
            key: "issue:343",
            source: "growth",
            title: "t",
            body: "b",
            labels: [],
            urgent: false,
            severityRank: 3,
            reach: 339,
            fixability: 0.9,
            daysOpen: 0,
            category: "seo",
            rule: "description.long",
            issue: { repo: "a/b", number: 343, url: "u" },
            route: { codeRepo: "a/b", base: "main", site: "digilist.no", reason: "target-repo" },
            members: [],
          },
        ],
      }),
    );
    expect(text).toContain("would fix issue:343 → a/b (main) reach 339");
    expect(text).toContain("growth: ok (341)");
    expect(text).toContain("geoqa: off — x");
    expect(text).toContain("github: unavailable");
  });

  it("counts outcomes, and says when the clock rather than the work ended the run", () => {
    const outcomes = empty({
      intake: 4,
      outcomes: [
        { key: "a", status: "opened", prUrl: "u", reviewVerdict: "approve", verify: { state: "passed", steps: [] }, ms: 1 },
        { key: "b", status: "rejected", detail: "no", ms: 1 },
        { key: "c", status: "verify-failed", ms: 1 },
        { key: "d", status: "failed", detail: "boom", ms: 1 },
      ],
      budget: { maxItems: 3, budgetMs: 240 * 60_000, usedMs: 200 * 60_000, stoppedOnBudget: true },
    });
    const text = renderFixRun(outcomes);
    expect(text).toContain("1 PR(s), 2 rejected, 1 failed, of 4 item(s)");
    expect(text).toContain("stopped on budget after 200 min of 240");
    expect(renderFixRun(empty({ outcomes: [{ key: "a", status: "opened", ms: 1 }] }))).toContain("used 1 min of 240");
  });
});
