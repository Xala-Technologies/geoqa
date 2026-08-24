/**
 * The ordered pipeline. The only loop, and the only place a throw is caught.
 *
 *   0 PREFLIGHT   token, repo, lock
 *   1 INTAKE      growth Postgres + geoqa filed issues + opt-in GitHub issues
 *   2 TRIAGE      collapse by issue, rank
 *   3 SELECT      eligibility + budget
 *   4-7 per item, in series: clone → repair → REVIEW → VERIFY → push → PR
 *   8 GATE        merge policy (default: a human merges)
 *   9 SWEEP       delete every clone this run made; close the agent_runs row
 *
 * Steps 4 through 7 all happen inside ONE `repairOne` call, and they have to:
 * a rejected fix must never reach `origin`, so the veto cannot sit after the
 * push. That is why `repairOne` grew a gate rather than this file
 * re-implementing the clone-and-commit sequence.
 *
 * ## The invariant this file exists to keep
 *
 * geoqa's rule is that a model on the measurement path makes a failing run
 * unreproducible, and that a thrown repair must never fail a sweep. `fix/` sits
 * above `assist/` and is imported only by `cli/` — `run/`, `journeys/`, `geo/`
 * and `findings/` cannot reach it, and dependency-cruiser enforces that. Inside
 * here, every step returns a discriminated result and `guard` is the one place
 * a throw can surface: one poisoned item becomes a `failed` outcome and the
 * loop continues, one unreachable source becomes `unavailable` and the other
 * two still run.
 *
 * SWEEP is not optional. `evidence/prune.ts` classifies a clone directory as an
 * unreadable run whose bytes still count against the size cap, so clones left
 * behind push real evidence into the doom list. Three clones a night, each with
 * a `node_modules` after VERIFY, is gigabytes a week.
 */
import path from "node:path";
import { describeThrown } from "../errors.js";
import { branchForIssue, repairOne, repairedStatus, type RepairExec, type RepairGate, type RepairJob } from "../assist/repair.js";
import type { AssistOutcome } from "../assist/types.js";
import { loadRepairedItems, saveRepairedItems, type RepairedItem } from "../assist/repair-store.js";
import type { FiledStore, GithubIssueRef } from "../findings/github.js";
import type { SiteRepo } from "../findings/repos.js";
import type { TicketDraft } from "../findings/tickets.js";
import type { FiledIssue } from "../findings/github.js";
import { loadAttempts, ledgerOf, recordAttempt, saveAttempts, type FixAttempt } from "./attempts.js";
import { FIX_AGENT_SLUG, MAX_OPEN_FINDINGS, type GrowthDb } from "./growth-db.js";
import { itemsFromGeoqa } from "./intake-geoqa.js";
import { itemsFromGithub, CHANGES_REQUESTED_LABEL, REVIEWED_LABEL } from "./intake-github.js";
import { itemsFromGrowth } from "./intake-growth.js";
import { acquireLock, releaseLock } from "./lock.js";
import type { GrowthRepoKey } from "./route.js";
import { select, DEFAULT_SELECT_POLICY, WORST_CASE_ITEM_MS, type SelectPolicy } from "./select.js";
import { triage } from "./triage.js";
import type { FixOutcome, FixRunResult, SourceReport, WorkItem } from "./types.js";
import type { VerifyReport } from "./verify.js";

/** `<evidenceRoot>/fix-work` — this agent's own clone root, swept in a `finally`. */
export const FIX_WORK_DIR = "fix-work";

export interface FixPorts {
  evidenceRoot: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  log: (line: string) => void;
  store: FiledStore;
  exec: RepairExec;
  /**
   * TWO claude seams, not one.
   *
   * A single seam cannot express the case this whole design turns on — the
   * repair model produced a diff and the review model rejected it — because a
   * test could not make one fake answer differently to the two prompts without
   * matching on prompt text, which is a test that passes for the wrong reason.
   */
  claude: {
    repair: (prompt: string, cwd: string) => Promise<AssistOutcome>;
    review: (prompt: string, cwd: string) => Promise<AssistOutcome>;
  };
  /**
   * A gate FACTORY, not a gate.
   *
   * The verdict and the verify report have to reach the outcome, and the gate
   * runs deep inside `repairOne` where nothing is returned but a status. The
   * factory takes the recorders, so this file owns the maps and `review.ts`
   * stays a pure function of its ports.
   */
  gate: (record: {
    onReview: (key: string, verdict: { verdict: "approve" } | { verdict: "reject"; reason: string }) => void;
    onVerify: (key: string, report: VerifyReport) => void;
  }) => RepairGate;
  token: string;
  fallbackRepo: string;
  sites: readonly SiteRepo[];
  repoKeys: readonly GrowthRepoKey[];
  agents: readonly string[];
  /** null when this host is not pointed at the growth database. */
  growth: (() => Promise<GrowthDb>) | null;
  drafts: () => TicketDraft[];
  filed: () => FiledIssue[] | null;
  listIssues: (input: { repo: string; labels: string[]; limit: number }) => Promise<GithubIssueRef[]>;
  addLabels: (input: { repo: string; number: number; labels: string[] }) => Promise<void>;
  comment: (input: { repo: string; number: number; body: string }) => Promise<void>;
  prOpen: (input: { repo: string; branch: string; exec: RepairExec; env: NodeJS.ProcessEnv }) => Promise<boolean>;
  rm: (p: string) => void;
  pid: number;
  grafanaUrl?: string;
}

export interface FixRunOptions {
  dryRun?: boolean;
  source?: "both" | "github" | "growth";
  only?: string[];
  merge?: boolean;
  policy?: Partial<SelectPolicy>;
  triggeredBy?: "timer" | "manual";
}

/**
 * The one place a throw becomes a value.
 *
 * `describeThrown` is zero-import by design and already handles a thrown
 * non-Error, which is the shape a driver or a spawn most often throws.
 */
async function guard<T>(label: string, fn: () => Promise<T>, onThrow: (detail: string) => T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    return onThrow(`${label}: ${describeThrown(error)}`);
  }
}

const off = (detail: string): SourceReport => ({ state: "off", rows: 0, detail });
const unavailable = (detail: string): SourceReport => ({ state: "unavailable", rows: 0, detail });

const emptySources = (): FixRunResult["sources"] => ({
  growth: off("not read"),
  geoqa: off("not read"),
  github: off("not read"),
});

const slotOf = (item: WorkItem): string | null =>
  item.issue === null ? null : `${item.route?.codeRepo ?? item.issue.repo}#${item.issue.number}`;

export async function fixRun(ports: FixPorts, options: FixRunOptions = {}): Promise<FixRunResult> {
  const policy: SelectPolicy = { ...DEFAULT_SELECT_POLICY, ...options.policy };
  const startedMs = ports.now();
  const base: FixRunResult = {
    skipped: "none",
    sources: emptySources(),
    intake: 0,
    eligible: 0,
    attempted: 0,
    outcomes: [],
    ineligible: [],
    wouldFix: [],
    budget: { maxItems: policy.maxItems, budgetMs: policy.budgetMs, usedMs: 0, stoppedOnBudget: false },
    runId: null,
  };

  // ── 0 PREFLIGHT ─────────────────────────────────────────────────────
  if (ports.token === "" || ports.fallbackRepo === "") {
    return { ...base, skipped: "unconfigured" };
  }
  const attemptsLoaded = loadAttempts(ports.evidenceRoot, ports.store);
  const repairedLoaded = loadRepairedItems(ports.evidenceRoot, ports.store);
  if (!attemptsLoaded.ok || !repairedLoaded.ok) {
    // Same rule as the two stores it sits beside: a memory we cannot read means
    // we do not know what we already tried, which is exactly when retrying
    // everything is most expensive.
    return { ...base, skipped: "store-unreadable" };
  }
  const lock = acquireLock(ports.evidenceRoot, ports.store, { pid: ports.pid, nowMs: startedMs, budgetMs: policy.budgetMs });
  if (!lock.ok) {
    ports.log(`fix run: a run started at ${lock.held?.startedAt ?? "an unknown time"} (pid ${lock.held?.pid ?? 0}) still holds the lock`);
    return { ...base, skipped: "locked" };
  }

  const workRoot = path.join(ports.evidenceRoot, FIX_WORK_DIR);
  let db: GrowthDb | null = null;
  let runId: number | null = null;
  let apiCalls = 0;
  const outcomes: FixOutcome[] = [];

  try {
    // ── 1 INTAKE ──────────────────────────────────────────────────────
    const sources = emptySources();
    const wantGrowth = options.source !== "github";
    let growthItems: WorkItem[] = [];
    if (!wantGrowth) {
      sources.growth = off("--source github");
    } else if (ports.growth === null) {
      sources.growth = off("POSTGRES_PASSWORD is not set — this host is not pointed at the growth database");
    } else {
      growthItems = await guard(
        "growth",
        async () => {
          db = await (ports.growth as () => Promise<GrowthDb>)();
          runId = await db.openRun({
            runKey: `fix-${new Date(startedMs).toISOString().slice(0, 16).replace(/[:T]/g, "").replace(/(\d{8})(\d{4})/, "$1-$2")}`,
            startedAt: new Date(startedMs).toISOString(),
            hostRepo: "",
            triggeredBy: options.triggeredBy ?? "manual",
            runMode: options.dryRun === true ? "dry-run" : "apply",
            workflow: "fix",
          });
          const rows = await db.openFindings({ limit: MAX_OPEN_FINDINGS });
          sources.growth = { state: "ok", rows: rows.length };
          return itemsFromGrowth(rows, {
            repoKeys: ports.repoKeys,
            sites: ports.sites,
            agents: ports.agents,
            ...(ports.grafanaUrl !== undefined ? { grafanaUrl: ports.grafanaUrl } : {}),
          });
        },
        (detail) => {
          sources.growth = unavailable(detail);
          return [];
        },
      );
    }

    const geoqaItems = await guard(
      "geoqa",
      async () => {
        const filed = ports.filed();
        if (filed === null) {
          sources.geoqa = unavailable("filed-issues.json is unreadable");
          return [];
        }
        const items = itemsFromGeoqa(ports.drafts(), filed, ports.sites, ports.fallbackRepo);
        sources.geoqa = { state: "ok", rows: items.length };
        return items;
      },
      (detail) => {
        sources.geoqa = unavailable(detail);
        return [];
      },
    );

    const claimed = new Set(
      [...growthItems, ...geoqaItems].map(slotOf).filter((slot): slot is string => slot !== null),
    );
    const githubItems = await guard(
      "github",
      async () => {
        if (options.source === "growth") {
          sources.github = off("--source growth");
          return [];
        }
        const issues = await ports.listIssues({ repo: ports.fallbackRepo, labels: ["findings", "agent: approved"], limit: 50 });
        const items = itemsFromGithub(issues, { repo: ports.fallbackRepo, sites: ports.sites, claimed });
        sources.github = { state: "ok", rows: items.length };
        return items;
      },
      (detail) => {
        sources.github = unavailable(detail);
        return [];
      },
    );

    if (sources.growth.state === "unavailable" && sources.geoqa.state === "unavailable" && sources.github.state === "unavailable") {
      return { ...base, skipped: "no-sources", sources };
    }

    // ── 2 TRIAGE ──────────────────────────────────────────────────────
    const all = [...growthItems, ...geoqaItems, ...githubItems].filter(
      (item) => options.only === undefined || options.only.includes(item.key),
    );
    // `triage` collapses by issue slot through a Map keyed on that slot, so its
    // output cannot contain two items sharing one — `assertUniqueIssues` is the
    // invariant made checkable and `triage.test.ts` asserts it there. A second
    // dedup here was a guard with no reachable failure, which this repo treats
    // as a claim that the invariant above it might not hold. It does.
    const items = triage(all).items;

    // ── 3 SELECT ──────────────────────────────────────────────────────
    // Issue labels come from the ONE list call already made; an item whose
    // issue is not in that list is treated as unlabelled, which is the
    // conservative reading — `agent: approved` is an override and an override
    // we could not read is an override that does not apply.
    const issueLabels = new Map<string, readonly string[]>(
      githubItems.map((item) => [slotOf(item) as string, item.labels]),
    );
    const prOpen = new Set<string>();
    if (options.dryRun !== true) {
      for (const item of items) {
        const slot = slotOf(item);
        const route = item.route;
        const issue = item.issue;
        if (slot === null || issue === null || route === null) continue;
        const open = await guard(
          "gh pr list",
          () => ports.prOpen({ repo: route.codeRepo, branch: branchForIssue(issue.number), exec: ports.exec, env: ports.env }),
          (detail) => {
            // Could not tell. Treat as OPEN: a duplicate pull request is worse
            // than a night skipped, and the next run asks again.
            ports.log(`fix run: ${detail} — treating ${slot} as already having a PR`);
            return true;
          },
        );
        if (open) prOpen.add(slot);
      }
    }

    const attempts: FixAttempt[] = [...attemptsLoaded.items];
    const selected = select({
      items,
      ledger: ledgerOf(attempts),
      repaired: new Set(repairedLoaded.items.map((item) => item.key)),
      issueLabels,
      prOpen,
      policy,
    });

    if (options.dryRun === true) {
      return {
        ...base,
        skipped: "dry-run",
        sources,
        intake: items.length,
        eligible: selected.chosen.length,
        wouldFix: selected.chosen,
        ineligible: selected.ineligible,
        budget: { ...base.budget, usedMs: ports.now() - startedMs, stoppedOnBudget: selected.stoppedOnBudget },
        runId,
      };
    }
    if (selected.chosen.length === 0) {
      return {
        ...base,
        skipped: "nothing-eligible",
        sources,
        intake: items.length,
        ineligible: selected.ineligible,
        budget: { ...base.budget, usedMs: ports.now() - startedMs },
        runId,
      };
    }

    // ── 4-8 per item, in series ───────────────────────────────────────
    const repaired: RepairedItem[] = [...repairedLoaded.items];
    let attemptLedger = attempts;
    let stoppedOnBudget = selected.stoppedOnBudget;
    const reviews = new Map<string, "approve" | "reject">();
    const verifies = new Map<string, VerifyReport>();
    const gate = ports.gate({
      onReview: (key, verdict) => reviews.set(key, verdict.verdict),
      onVerify: (key, report) => verifies.set(key, report),
    });

    for (const item of selected.chosen) {
      const usedMs = ports.now() - startedMs;
      // HEADROOM, not "any time left". `usedMs >= budgetMs` let an item start at
      // minute 239 of 240 and run its own timeouts for another 97, finishing at
      // 336 — past `geoqa-fix.service`'s `TimeoutStartSec`, which SIGTERMs the
      // unit and leaves exactly the pushed-branch-with-no-PR the unit file says
      // it exists to prevent. The budget only means anything if it bounds the
      // END of the last item, and an item is never interrupted once started.
      if (usedMs + WORST_CASE_ITEM_MS > policy.budgetMs) {
        stoppedOnBudget = true;
        ports.log(
          `fix run: ${Math.round(usedMs / 60_000)} minutes used of ${Math.round(policy.budgetMs / 60_000)}, and one item can take ${Math.round(WORST_CASE_ITEM_MS / 60_000)} — stopping before ${item.key}`,
        );
        break;
      }
      const itemStarted = ports.now();
      const outcome = await guard(
        `item ${item.key}`,
        () => attemptItem(ports, item, { workRoot, merge: options.merge === true, gate }),
        (detail) => ({ key: item.key, status: "failed" as const, detail, ms: 0 }),
      );
      const finished: FixOutcome = {
        ...outcome,
        ms: ports.now() - itemStarted,
        ...(reviews.has(item.key) ? { reviewVerdict: reviews.get(item.key) as "approve" | "reject" } : {}),
        ...(verifies.has(item.key) ? { verify: verifies.get(item.key) as VerifyReport } : {}),
      };
      outcomes.push(finished);
      apiCalls += finished.status === "failed" ? 1 : 2;

      attemptLedger = recordAttempt(attemptLedger, finished, ports.now());
      saveAttempts(ports.evidenceRoot, attemptLedger, ports.store);

      const remembered = repairedStatus(finished.status);
      if (remembered !== null && item.source === "geoqa") {
        // Only geoqa keys belong in geoqa's store — a growth key there would be
        // a second, wrong answer to "has this ticket been repaired".
        repaired.push({
          key: item.key,
          status: remembered,
          at: new Date(ports.now()).toISOString(),
          ...(finished.prUrl !== undefined ? { prUrl: finished.prUrl } : {}),
        });
        saveRepairedItems(ports.evidenceRoot, repaired, ports.store);
      }

      await afterOutcome(ports, item, finished, db);
    }

    return {
      skipped: "none",
      sources,
      intake: items.length,
      eligible: selected.chosen.length,
      attempted: outcomes.length,
      outcomes,
      ineligible: selected.ineligible,
      wouldFix: [],
      budget: { maxItems: policy.maxItems, budgetMs: policy.budgetMs, usedMs: ports.now() - startedMs, stoppedOnBudget },
      runId,
    };
  } finally {
    // ── 9 SWEEP ───────────────────────────────────────────────────────
    // Always, including after a throw. See the file header.
    try {
      ports.rm(workRoot);
    } catch (error) {
      ports.log(`fix run: could not sweep ${workRoot}: ${describeThrown(error)}`);
    }
    if (db !== null) {
      await guard(
        "closeRun",
        async () => {
          const opened = outcomes.filter((outcome) => outcome.status === "opened").length;
          await (db as GrowthDb).closeRun({
            runId,
            status: outcomes.some((outcome) => outcome.status === "failed") ? "failed" : "success",
            itemsFiled: opened,
            apiCalls,
          });
          await (db as GrowthDb).close();
        },
        (detail) => {
          ports.log(`fix run: ${detail}`);
        },
      );
    }
    releaseLock(ports.evidenceRoot, ports.store, ports.rm);
  }
}

async function attemptItem(
  ports: FixPorts,
  item: WorkItem,
  ctx: { workRoot: string; merge: boolean; gate: RepairGate },
): Promise<FixOutcome> {
  const route = item.route as NonNullable<WorkItem["route"]>;
  const issue = item.issue as NonNullable<WorkItem["issue"]>;
  const job: RepairJob = {
    key: item.key,
    title: item.title,
    body: item.body,
    issueNumber: issue.number,
    issueUrl: issue.url,
    issueRepo: issue.repo,
    codeRepo: route.codeRepo,
    base: route.base,
    site: route.site,
    urgent: item.urgent,
    branch: branchForIssue(issue.number),
  };
  const result = await repairOne(job, {
    exec: ports.exec,
    claude: ports.claude.repair,
    workRoot: ctx.workRoot,
    token: ports.token,
    env: ports.env,
    gate: ctx.gate,
    autoMerge: ctx.merge,
  });
  return {
    key: result.key,
    status: result.status,
    ms: 0,
    ...(result.prUrl !== undefined ? { prUrl: result.prUrl } : {}),
    ...(result.autoMerge !== undefined ? { autoMerge: result.autoMerge } : {}),
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
  };
}

/**
 * Label the issue, say what happened, and write back.
 *
 * `agent: reviewed` is written; `agent: approved` never is. An agent that can
 * grant itself permission has none.
 *
 * A write-back that fails after a pull request already exists is recorded on
 * the outcome and does NOT undo the PR. The issue's `Fixes` link is the durable
 * record, and closing a good pull request to keep a database tidy is the wrong
 * trade.
 */
async function afterOutcome(ports: FixPorts, item: WorkItem, outcome: FixOutcome, db: GrowthDb | null): Promise<void> {
  const issue = item.issue;
  if (issue === null) return;

  if (outcome.status === "opened") {
    await guard(
      "label",
      () => ports.addLabels({ repo: issue.repo, number: issue.number, labels: [REVIEWED_LABEL] }),
      (detail) => {
        ports.log(`fix run: ${detail}`);
      },
    );
    if (db !== null && item.source === "growth") {
      await guard(
        "writeback",
        async () => {
          // One call PER AGENT, because `(agent, finding_key)` is the table's
          // identity and the group's identity is the issue. `growthGroupKey`
          // buckets by `issue:<n>` first, so a single item legitimately spans
          // agents — seo and trustops both linking finding rows to #343 is the
          // normal case, not a corner one. Sending every key under
          // `members[0].agent` matched only that agent's rows and left the rest
          // of the group at `github_issue = ''`, which is precisely the state
          // the next night reads as "not yet filed".
          const byAgent = new Map<string, string[]>();
          for (const member of item.members) {
            const key = member.findingKey ?? "";
            if (key === "") continue;
            const agent = member.agent ?? FIX_AGENT_SLUG;
            byAgent.set(agent, [...(byAgent.get(agent) ?? []), key]);
          }
          for (const [agent, findingKeys] of byAgent) {
            await db.markFiled({ agent, findingKeys, githubIssue: String(issue.number) });
          }
        },
        (detail) => {
          outcome.detail = `writeback-failed: ${detail}`;
        },
      );
    }
    return;
  }

  if (outcome.status === "rejected" || outcome.status === "verify-failed") {
    const why =
      outcome.status === "verify-failed"
        ? `The fix did not pass \`${item.route?.codeRepo ?? "the target repository"}\`'s own checks, and nothing weakened them to make it pass.`
        : "A second model reviewed the diff and rejected it.";
    await guard(
      "comment",
      async () => {
        await ports.comment({
          repo: issue.repo,
          number: issue.number,
          body: [
            `The geoqa fix agent attempted this and stopped before opening a pull request.`,
            "",
            why,
            "",
            `Reason: ${outcome.detail ?? "not recorded"}`,
            `Branch it would have used: \`${branchForIssue(issue.number)}\` in \`${item.route?.codeRepo ?? "?"}\` (nothing was pushed).`,
            "",
            `Remove the \`${CHANGES_REQUESTED_LABEL}\` label to let it try again.`,
          ].join("\n"),
        });
        await ports.addLabels({ repo: issue.repo, number: issue.number, labels: [CHANGES_REQUESTED_LABEL] });
      },
      (detail) => {
        ports.log(`fix run: ${detail}`);
      },
    );
  }
}
