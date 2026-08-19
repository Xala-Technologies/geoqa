/**
 * After a finding is filed, clone the destination repo and let claude -p
 * edit it. The porter opens the PR and asks GitHub to auto-merge.
 *
 * Never imported by run/ or journeys/. A model on the measurement path
 * would make a failing run unreproducible. A thrown repair must not fail
 * a sweep — same rule as filing.
 */
import { containedPath } from "../tenant/registry.js";
import type { FiledIssue } from "../findings/github.js";
import { routeTicket, type SiteRepo } from "../findings/repos.js";
import { prBody } from "../findings/brief.js";
import type { TicketDraft } from "../findings/tickets.js";
import { runClaudePrint, type ClaudeSpawn } from "./claude.js";
import { nodeClaudeSpawn } from "./claude-spawn.js";
import type { AssistOutcome } from "./types.js";
import { buildRepairPrompt } from "./repair-prompt.js";

export const REPAIR_DIR = "repair";
export const DEFAULT_REPAIR_TIMEOUT_MS = 1_200_000;
export const REPAIR_CLAUDE_ARGS = ["--dangerously-skip-permissions"];

/** Default claude -p for a repair: Max login, in the checkout, unattended. */
export function defaultRepairClaude(
  env: NodeJS.ProcessEnv,
  spawn: ClaudeSpawn = nodeClaudeSpawn,
): (prompt: string, cwd: string) => Promise<AssistOutcome> {
  return (prompt, cwd) =>
    runClaudePrint(prompt, {
      // Claude Code refuses --dangerously-skip-permissions as root unless it
      // believes it is in a sandbox. The checkout is a disposable clone under
      // the evidence tree, so the repair path opts in here — assist explain
      // does not.
      env: { ...env, IS_SANDBOX: "1" },
      spawn,
      extraArgs: REPAIR_CLAUDE_ARGS,
      cwd,
      timeoutMs: DEFAULT_REPAIR_TIMEOUT_MS,
    });
}

export interface RepairJob {
  key: string;
  title: string;
  body: string;
  issueNumber: number;
  issueUrl: string;
  issueRepo: string;
  codeRepo: string;
  base: string;
  site: string;
  urgent: boolean;
}

export interface RepairExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export interface RepairExec {
  run: (input: {
    cwd: string;
    argv: string[];
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  }) => Promise<RepairExecResult>;
  mkdir: (p: string) => void;
  exists: (p: string) => boolean;
  rm: (p: string) => void;
}

export type RepairStatus = "opened" | "cannot-fix" | "no-changes" | "failed";

export interface RepairOneResult {
  key: string;
  status: RepairStatus;
  prUrl?: string;
  autoMerge?: boolean;
  detail?: string;
}

export function jobsFromFiled(
  drafts: TicketDraft[],
  filed: FiledIssue[],
  sites: readonly SiteRepo[],
  fallbackRepo: string,
): RepairJob[] {
  const byKey = new Map(filed.map((issue) => [issue.key, issue]));
  const jobs: RepairJob[] = [];
  for (const draft of drafts) {
    const issue = byKey.get(draft.key);
    if (issue === undefined) continue;
    const dest = routeTicket(draft, sites, fallbackRepo);
    jobs.push({
      key: draft.key,
      title: draft.title,
      body: draft.body,
      issueNumber: issue.number,
      issueUrl: issue.url,
      issueRepo: issue.repo ?? fallbackRepo,
      codeRepo: dest.repo,
      base: dest.base,
      site: dest.site,
      urgent: draft.urgent,
    });
  }
  return jobs;
}

function workdirFor(workRoot: string, repo: string, issueNumber: number): { ok: true; value: string } | { ok: false; errors: string[] } {
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined || repo.split("/").length !== 2) {
    return { ok: false, errors: ["repo must be owner/name"] };
  }
  const ownerDir = containedPath(workRoot, owner);
  if (!ownerDir.ok) return ownerDir;
  return containedPath(ownerDir.value, `${name}-${issueNumber}`);
}

/**
 * `gh` sees GH_TOKEN; `git fetch` / `git push` do not. The helper is set
 * through GIT_CONFIG_* so the token never appears on argv — a clone that
 * could pull but not push is how four local commits never became PRs.
 */
const gitEnv = (token: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...env,
  GH_TOKEN: token,
  GH_PROMPT_DISABLED: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: "credential.helper",
  GIT_CONFIG_VALUE_1: "!gh auth git-credential",
});

async function exec(
  ports: { exec: RepairExec },
  cwd: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RepairExecResult> {
  return ports.exec.run({ cwd, argv, env, timeoutMs });
}

const failed = (key: string, detail: string): RepairOneResult => ({ key, status: "failed", detail });

const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

export function readPrUrl(text: string): string | null {
  return text.match(PR_URL)?.[0] ?? null;
}

export async function repairOne(
  job: RepairJob,
  ports: {
    exec: RepairExec;
    claude: (prompt: string, cwd: string) => Promise<AssistOutcome>;
    workRoot: string;
    token: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<RepairOneResult> {
  const placed = workdirFor(ports.workRoot, job.codeRepo, job.issueNumber);
  if (!placed.ok) return failed(job.key, placed.errors[0] ?? "repair path refused");
  const workdir = placed.value;
  const env = gitEnv(ports.token, ports.env);
  const parent = ports.workRoot;

  ports.exec.mkdir(parent);
  if (ports.exec.exists(workdir)) ports.exec.rm(workdir);

  const cloned = await exec(ports, parent, ["gh", "repo", "clone", job.codeRepo, workdir, "--", "--branch", job.base], env, 60_000);
  if (cloned.exitCode !== 0) {
      return failed(job.key, cloned.error ?? (cloned.stderr.trim() || `gh repo clone exited ${cloned.exitCode}`));
  }

  const fetched = await exec(ports, workdir, ["git", "fetch", "origin", job.base], env, 60_000);
  if (fetched.exitCode !== 0) {
    return failed(job.key, fetched.error ?? (fetched.stderr.trim() || "git fetch failed"));
  }

  const branched = await exec(
    ports,
    workdir,
    ["git", "checkout", "-B", `geoqa/issue-${job.issueNumber}`, `origin/${job.base}`],
    env,
    15_000,
  );
  if (branched.exitCode !== 0) {
      return failed(job.key, branched.error ?? (branched.stderr.trim() || "git checkout failed"));
  }

  const prompt = buildRepairPrompt(job);
  const reply = await ports.claude(prompt, workdir);
  if (!reply.ok) return failed(job.key, reply.failure.detail);

  const status = await exec(ports, workdir, ["git", "status", "--porcelain"], env, 15_000);
  const ahead = await exec(ports, workdir, ["git", "log", "--oneline", `origin/${job.base}..HEAD`], env, 15_000);
  const dirty = status.stdout.trim() !== "";
  const hasCommit = ahead.stdout.trim() !== "";

  if (!dirty && !hasCommit) {
    return {
      key: job.key,
      status: reply.text.includes("CANNOT_FIX") ? "cannot-fix" : "no-changes",
      ...(reply.text.includes("CANNOT_FIX") ? { detail: reply.text.trim().split("\n")[0] } : {}),
    };
  }

  if (dirty) {
    const add = await exec(ports, workdir, ["git", "add", "-A"], env, 15_000);
    if (add.exitCode !== 0) return failed(job.key, add.stderr.trim() || "git add failed");
    const commit = await exec(
      ports,
      workdir,
      ["git", "-c", "user.name=geoqa", "-c", "user.email=geoqa@users.noreply.github.com", "commit", "-m", `Fix #${job.issueNumber}: ${job.title}`],
      env,
      15_000,
    );
    if (commit.exitCode !== 0) return failed(job.key, commit.stderr.trim() || "git commit failed");
  }

  const latest = await exec(ports, workdir, ["git", "fetch", "origin", job.base], env, 60_000);
  if (latest.exitCode !== 0) {
    return failed(job.key, latest.error ?? (latest.stderr.trim() || "git fetch failed"));
  }
  const rebased = await exec(ports, workdir, ["git", "rebase", `origin/${job.base}`], env, 60_000);
  if (rebased.exitCode !== 0) {
    return failed(job.key, rebased.error ?? (rebased.stderr.trim() || "git rebase failed"));
  }

  const pushed = await exec(ports, workdir, ["git", "push", "-u", "origin", "HEAD"], env, 60_000);
  if (pushed.exitCode !== 0) return failed(job.key, pushed.error ?? (pushed.stderr.trim() || "git push failed"));

  const created = await exec(
    ports,
    workdir,
    [
      "gh",
      "pr",
      "create",
      "--base",
      job.base,
      "--title",
      `Fix #${job.issueNumber}: ${job.title}`,
      "--body",
      prBody(job),
    ],
    env,
    60_000,
  );
  if (created.exitCode !== 0) return failed(job.key, created.error ?? (created.stderr.trim() || "gh pr create failed"));
  const prUrl = readPrUrl(created.stdout);
  if (prUrl === null) return failed(job.key, "gh pr create printed no pull request URL");

  const merged = await exec(ports, workdir, ["gh", "pr", "merge", "--auto", "--squash"], env, 30_000);
  return {
    key: job.key,
    status: "opened",
    prUrl,
    autoMerge: merged.exitCode === 0,
    ...(merged.exitCode === 0 ? {} : { detail: merged.stderr.trim() || "auto-merge was not enabled" }),
  };
}
