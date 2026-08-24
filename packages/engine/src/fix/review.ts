/**
 * The gate: mechanical checks, then an adversarial model, then the target
 * repository's own checks — all before anything reaches `origin`.
 *
 * Order is deliberate and the counter-argument is worth stating. Review costs
 * one model call (minutes); verify costs an install and a build in a cold clone
 * (tens of minutes). Rejecting cheap-first saves the expensive step on diffs
 * that were never going to ship. The objection — a reviewer can approve a diff
 * that does not compile, so its approval means nothing until verify runs — is
 * correct and does not change the order: verify still runs, it just runs second.
 *
 * Three properties make the review real rather than ceremonial:
 *
 *   1. The mechanical gate rejects an oversized or out-of-bounds diff WITHOUT
 *      spending a model call. Asking a model whether a 40-file diff is too big
 *      is slower and less reliable than counting the files.
 *   2. HEAD and the worktree are recorded before the reviewer runs and re-read
 *      after. Any change is `rejected` with `review-tampered`. Read-only-ness
 *      is a mechanical check, not a promise in a prompt.
 *   3. `parseVerdict` fails CLOSED. Missing, malformed, both verdicts, or a
 *      claude call that failed at all is a rejection.
 */
import type { AssistOutcome } from "../assist/types.js";
import type { RepairExecResult, RepairGate } from "../assist/repair.js";
import { buildReviewPrompt, REVIEW_APPROVE_LINE, REVIEW_REJECT_PREFIX, truncateDiff } from "./review-prompt.js";
import type { VerifyReport, VerifyRunner } from "./verify.js";

export interface ReviewPolicy {
  maxFiles: number;
  maxLines: number;
  /** Path prefixes and suffixes a fix may not touch without a human. */
  denyPaths: readonly string[];
}

/**
 * The deny list is not about danger in general — it is about blast radius an
 * issue never asked for. A meta-description fix has no business in a workflow
 * file, a Dockerfile, a lockfile or an `.env`, and a diff that reaches one of
 * those is not the diff the issue described.
 *
 * `package.json` and `.geoqa-verify` are on it for a sharper reason than blast
 * radius: they are the two files that DECIDE WHAT VERIFY RUNS. `verify.ts`
 * reads both out of the clone as the repair model left it, so without this
 * entry a fix could author its own verification — a two-line `.geoqa-verify`
 * saying `true`, or a `package.json` whose `test` script became `echo ok` —
 * and `verify` would dutifully report `passed` having proved nothing. That is
 * the single thing this agent must never be able to negotiate, and it cannot
 * be left to the reviewer model: the reviewer is a filter, and a filter is not
 * where an invariant lives. Denying `package.json` also costs nothing real,
 * because every lockfile is already denied and a dependency change without its
 * lockfile fails the frozen install anyway.
 */
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  maxFiles: 20,
  maxLines: 600,
  denyPaths: [
    ".github/",
    "infra/",
    ".env",
    "Dockerfile",
    "docker-compose",
    "-lock.json",
    "lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "package.json",
    ".geoqa-verify",
  ],
};

export type ReviewVerdict = { verdict: "approve" } | { verdict: "reject"; reason: string };

export interface DiffStat {
  files: string[];
  insertions: number;
  deletions: number;
}

/** `git diff --numstat` — `<added>\t<removed>\t<path>` per line. Binary files report `-`. */
export function parseNumstat(stdout: string): DiffStat {
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [added, removed, ...rest] = parts;
    const file = rest.join("\t").trim();
    if (file === "") continue;
    files.push(file);
    insertions += Number(added) || 0;
    deletions += Number(removed) || 0;
  }
  return { files, insertions, deletions };
}

export function mechanicalReview(stat: DiffStat, policy: ReviewPolicy): ReviewVerdict {
  if (stat.files.length === 0) {
    return { verdict: "reject", reason: "the diff against the base branch is empty" };
  }
  if (stat.files.length > policy.maxFiles) {
    return { verdict: "reject", reason: `${stat.files.length} files changed, over the ${policy.maxFiles} a single finding may touch` };
  }
  const lines = stat.insertions + stat.deletions;
  if (lines > policy.maxLines) {
    return { verdict: "reject", reason: `${lines} lines changed, over the ${policy.maxLines} a single finding may touch` };
  }
  const denied = stat.files.find((file) => policy.denyPaths.some((deny) => file.includes(deny)));
  if (denied !== undefined) {
    return { verdict: "reject", reason: `${denied} is outside what an unattended fix may change` };
  }
  return { verdict: "approve" };
}

/**
 * The last non-empty line, and nothing else counts.
 *
 * Every ambiguity resolves to reject: no verdict line, a malformed one, both
 * words present, or a reply that never arrived. An approval has to be stated
 * exactly, because the failure this guards against is a review that silently
 * did not happen being read as a review that passed.
 */
export function parseVerdict(reply: AssistOutcome): ReviewVerdict {
  if (!reply.ok) return { verdict: "reject", reason: `the reviewer did not answer (${reply.failure.kind}: ${reply.failure.detail})` };
  const lines = reply.text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) return { verdict: "reject", reason: "the reviewer printed nothing" };
  if (last === REVIEW_APPROVE_LINE) {
    // Both verdicts present anywhere is a reviewer that could not decide.
    return lines.some((line) => line.startsWith(REVIEW_REJECT_PREFIX))
      ? { verdict: "reject", reason: "the reviewer printed both an approval and a rejection" }
      : { verdict: "approve" };
  }
  if (last.startsWith(REVIEW_REJECT_PREFIX)) {
    const reason = last.slice(REVIEW_REJECT_PREFIX.length).replace(/^[\s—:-]+/, "").trim();
    return { verdict: "reject", reason: reason === "" ? "the reviewer rejected without a reason" : reason };
  }
  return { verdict: "reject", reason: `the reviewer did not end with a verdict line (last line: ${last.slice(0, 120)})` };
}

export interface ReviewGatePorts {
  claude: (prompt: string, cwd: string) => Promise<AssistOutcome>;
  policy: ReviewPolicy;
  verify: VerifyRunner;
  readFile: (workdir: string, rel: string) => string | null;
  exists: (workdir: string, rel: string) => boolean;
  now: () => number;
  onReview?: (key: string, verdict: ReviewVerdict) => void;
  onVerify?: (key: string, report: VerifyReport) => void;
}

const out = (result: RepairExecResult): string => result.stdout.trim();

export function makeReviewGate(ports: ReviewGatePorts): RepairGate {
  return async ({ job, exec, workdir }) => {
    const numstat = await exec(["git", "diff", "--numstat", `origin/${job.base}...HEAD`], 60_000);
    if (numstat.exitCode !== 0) {
      const detail = numstat.error ?? (numstat.stderr.trim() || "git diff --numstat failed");
      ports.onReview?.(job.key, { verdict: "reject", reason: detail });
      return { ok: false, status: "rejected", detail };
    }
    const stat = parseNumstat(numstat.stdout);
    const mechanical = mechanicalReview(stat, ports.policy);
    if (mechanical.verdict === "reject") {
      ports.onReview?.(job.key, mechanical);
      return { ok: false, status: "rejected", detail: mechanical.reason };
    }

    const headBefore = out(await exec(["git", "rev-parse", "HEAD"], 15_000));
    const treeBefore = out(await exec(["git", "status", "--porcelain"], 15_000));

    const diff = await exec(["git", "diff", `origin/${job.base}...HEAD`], 60_000);
    const reply = await ports.claude(
      buildReviewPrompt({
        title: job.title,
        issueBody: job.body,
        issueNumber: job.issueNumber,
        codeRepo: job.codeRepo,
        diff: truncateDiff(diff.stdout),
      }),
      workdir,
    );

    const headAfter = out(await exec(["git", "rev-parse", "HEAD"], 15_000));
    const treeAfter = out(await exec(["git", "status", "--porcelain"], 15_000));
    if (headAfter !== headBefore || treeAfter !== treeBefore) {
      const tampered = { verdict: "reject", reason: "review-tampered: the reviewer changed the checkout it was reading" } as const;
      ports.onReview?.(job.key, tampered);
      return { ok: false, status: "rejected", detail: tampered.reason };
    }

    const verdict = parseVerdict(reply);
    ports.onReview?.(job.key, verdict);
    if (verdict.verdict === "reject") return { ok: false, status: "rejected", detail: verdict.reason };

    const report = await ports.verify({
      workdir,
      exec,
      readFile: (rel) => ports.readFile(workdir, rel),
      exists: (rel) => ports.exists(workdir, rel),
      now: ports.now,
    });
    ports.onVerify?.(job.key, report);
    if (report.state === "failed") {
      return {
        ok: false,
        status: "verify-failed",
        // Named as the repository's verdict, not ours: the fix did not pass the
        // checks that already existed, and weakening them was never on offer.
        detail: report.detail ?? "this repository's own checks failed on the fix",
      };
    }

    return { ok: true, note: { verdict: "approve", verifyState: report.state, steps: report.steps.map((step) => ({ name: step.name, exitCode: step.exitCode })) } };
  };
}
