/**
 * The pipeline, end to end, against injected ports.
 *
 * Four claims are load-bearing and each one is asserted against the exec log
 * rather than against a status string, because a status is what the code says
 * happened and the exec log is what it actually did:
 *
 *   1. A REJECTED fix never reaches origin. No `git push`, no `gh pr create`.
 *   2. The budget caps a real night. Today's growth run produced 341 findings;
 *      an unbounded run would clone 341 times.
 *   3. A second run over the same findings redoes nothing and opens no twin.
 *   4. A throw anywhere becomes a value. One poisoned item is one `failed`
 *      outcome, one dead source still leaves the other two, and the clone root
 *      is swept either way.
 *
 * Every port is injected. There is no `vi.mock` of `claude`, `gh`, `git` or
 * `pg` anywhere in this suite: a mocked specifier that stops resolving does not
 * error, it silently stops mocking, and the first sign would be a real pull
 * request on a customer repository.
 */
import { describe, expect, it, vi } from "vitest";
import { fixRun, FIX_WORK_DIR, type FixPorts, type FixRunOptions } from "../run.js";
import { FIX_ATTEMPTS_FILE, fixAttemptsPath, ledgerOf, loadAttempts, recordAttempt, saveAttempts } from "../attempts.js";
import { acquireLock, fixLockPath, LOCK_STALE_GRACE_MS, releaseLock } from "../lock.js";
import { DEFAULT_SELECT_POLICY, ineligibleReason, select, WORST_CASE_ITEM_MS } from "../select.js";
import { assertUniqueIssues, fixabilityOf, reachWeight, score, triage } from "../triage.js";
import { CHANGES_REQUESTED_LABEL, REVIEWED_LABEL } from "../intake-github.js";
import { REPAIRED_ISSUES_FILE, repairedIssuesPath } from "../../assist/repair-store.js";
import { FILED_ISSUES_FILE } from "../../findings/github.js";
import type { GrowthDb, GrowthFindingRow } from "../growth-db.js";
import type { WorkItem } from "../types.js";
import type { RepairGate } from "../../assist/repair.js";
import { memoryStore, ok, REPO_KEYS, row, scripted, SITES, type ScriptedExec } from "./fixtures.js";

const EVIDENCE = "/ev";
const REPO = "Xala-Technologies/geoqa";
const CODE_REPO = "Xala-Technologies/booking-brilliance";
const PR_URL = `https://github.com/${CODE_REPO}/pull/900`;

/** Replies that carry `repairOne` all the way to an open pull request. */
const HAPPY_EXEC = {
  "gh pr create": { stdout: `${PR_URL}\n` },
  "git status --porcelain": { stdout: " M src/pages/index.astro\n" },
  "git log --oneline": { stdout: "abc123 Fix #343\n" },
};

const growthRows = (count: number): GrowthFindingRow[] =>
  Array.from({ length: count }, (_, i) =>
    row({
      id: i + 1,
      findingKey: `digilist.no/p${i}:description.long`,
      // A distinct issue per row, so nothing collapses and the budget is the
      // only thing standing between this and `count` clones.
      githubIssue: String(343 + i),
    }),
  );

interface Harness {
  ports: FixPorts;
  exec: ScriptedExec;
  store: ReturnType<typeof memoryStore>;
  logs: string[];
  labelled: { repo: string; number: number; labels: string[] }[];
  comments: { repo: string; number: number; body: string }[];
  filedBack: { agent: string; findingKeys: string[]; githubIssue: string }[];
  removed: string[];
  reviewPrompts: string[];
  repairPrompts: string[];
}

/**
 * A gate factory built from a plain verdict, so a test can say "the review
 * rejects" without restating `makeReviewGate`'s internals. `gate.test.ts`
 * covers the real gate; this file covers what the pipeline does with its answer.
 */
const gateOf = (
  answer: (key: string) => Awaited<ReturnType<RepairGate>>,
  onVerifyState: "passed" | "failed" | "skipped" | null = "passed",
): FixPorts["gate"] =>
  (record) =>
    async ({ job }) => {
      const verdict = answer(job.key);
      record.onReview(job.key, verdict.ok ? { verdict: "approve" } : { verdict: "reject", reason: verdict.detail });
      if (onVerifyState !== null) record.onVerify(job.key, { state: onVerifyState, steps: [] });
      return verdict;
    };

function harness(over: Partial<FixPorts> = {}, execReplies: Record<string, { stdout?: string; exitCode?: number; stderr?: string }> = HAPPY_EXEC): Harness {
  const exec = scripted(execReplies);
  const store = (over.store as ReturnType<typeof memoryStore> | undefined) ?? memoryStore();
  const logs: string[] = [];
  const labelled: Harness["labelled"] = [];
  const comments: Harness["comments"] = [];
  const filedBack: Harness["filedBack"] = [];
  const removed: string[] = [];
  const reviewPrompts: string[] = [];
  const repairPrompts: string[] = [];

  const db: GrowthDb = {
    openFindings: async () => growthRows(1),
    markFiled: async (input) => {
      filedBack.push(input);
      return input.findingKeys;
    },
    openRun: async () => 77,
    closeRun: async () => undefined,
    close: async () => undefined,
  };

  const ports: FixPorts = {
    evidenceRoot: EVIDENCE,
    env: {},
    now: () => 1_000,
    log: (line) => logs.push(line),
    store,
    exec,
    claude: {
      repair: async (prompt) => {
        repairPrompts.push(prompt);
        return ok("done");
      },
      review: async (prompt) => {
        reviewPrompts.push(prompt);
        return ok("VERDICT: APPROVE");
      },
    },
    gate: gateOf(() => ({ ok: true })),
    token: "t",
    fallbackRepo: REPO,
    sites: SITES,
    repoKeys: REPO_KEYS,
    agents: [],
    growth: async () => db,
    drafts: () => [],
    filed: () => [],
    listIssues: async () => [],
    addLabels: async (input) => {
      labelled.push(input);
    },
    comment: async (input) => {
      comments.push(input);
    },
    prOpen: async () => false,
    rm: (p) => {
      removed.push(p);
      // The real `rm` deletes. A fake that only records would leave the lock
      // file behind and quietly make every second-run test a locked run.
      store.files.delete(p);
    },
    pid: 4242,
    ...over,
  };
  return { ports, exec, store, logs, labelled, comments, filedBack, removed, reviewPrompts, repairPrompts };
}

const argvLog = (exec: ScriptedExec): string[] => exec.argv.map((argv) => argv.join(" "));
const pushed = (exec: ScriptedExec): boolean => argvLog(exec).some((call) => call.startsWith("git push"));
const prCreated = (exec: ScriptedExec): boolean => argvLog(exec).some((call) => call.startsWith("gh pr create"));

describe("fixRun — preflight", () => {
  it("does nothing at all without a token or a repo", async () => {
    for (const over of [{ token: "" }, { fallbackRepo: "" }]) {
      const { ports, exec } = harness(over);
      const result = await fixRun(ports);
      expect(result.skipped).toBe("unconfigured");
      expect(exec.argv).toEqual([]);
    }
  });

  it("SKIPS the whole run when a store is unreadable — not knowing what we tried is when retrying is dearest", async () => {
    const store = memoryStore({ [fixAttemptsPath(EVIDENCE)]: "{ not json" });
    const { ports, exec } = harness({ store });
    expect((await fixRun(ports)).skipped).toBe("store-unreadable");
    expect(exec.argv).toEqual([]);
  });

  it("refuses to start behind a live lock, and says whose", async () => {
    const store = memoryStore({
      [fixLockPath(EVIDENCE)]: JSON.stringify({ pid: 9, startedAt: "2026-08-24T09:00:00.000Z", startedMs: 900 }),
    });
    const { ports, exec, logs } = harness({ store, now: () => 1_000 });
    expect((await fixRun(ports)).skipped).toBe("locked");
    expect(logs[0]).toContain("pid 9");
    expect(exec.argv).toEqual([]);
  });

  it("takes a STALE lock — a run whose process died has already failed, and this run is the recovery", async () => {
    const stale = JSON.stringify({ pid: 9, startedAt: "2026-08-20T09:00:00.000Z", startedMs: 0 });
    const store = memoryStore({ [fixLockPath(EVIDENCE)]: stale });
    const { ports } = harness({
      store,
      now: () => DEFAULT_SELECT_POLICY.budgetMs + LOCK_STALE_GRACE_MS + 1,
      growth: null,
    });
    expect((await fixRun(ports)).skipped).not.toBe("locked");
  });

  it("releases the lock and sweeps the clone root even when a step throws", async () => {
    const { ports, removed } = harness({
      growth: null,
      filed: () => {
        throw new Error("boom");
      },
      listIssues: async () => {
        throw new Error("boom");
      },
    });
    const result = await fixRun(ports);
    // growth is OFF here, not unavailable, so this is not `no-sources` — but
    // both readable sources threw and the run still tore itself down cleanly.
    expect(result.sources.geoqa.state).toBe("unavailable");
    expect(result.sources.github.state).toBe("unavailable");
    expect(removed).toContain(`${EVIDENCE}/${FIX_WORK_DIR}`);
    expect(removed).toContain(fixLockPath(EVIDENCE));
  });

  it("logs a sweep that itself failed rather than letting it replace the run's own error", async () => {
    const { ports, logs } = harness({
      growth: null,
      rm: (p) => {
        if (p.endsWith(FIX_WORK_DIR)) throw new Error("EBUSY");
      },
    });
    await fixRun(ports);
    expect(logs.some((line) => line.includes("could not sweep"))).toBe(true);
  });
});

describe("fixRun — intake", () => {
  it("reports growth OFF when this host is not pointed at the database", async () => {
    const { ports } = harness({ growth: null });
    const result = await fixRun(ports);
    expect(result.sources.growth).toMatchObject({ state: "off" });
    expect(result.sources.growth.detail).toContain("POSTGRES_PASSWORD");
  });

  it("keeps the other two sources when one is unreachable — one dead source is not a dead run", async () => {
    const { ports } = harness({
      growth: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const result = await fixRun(ports);
    expect(result.sources.growth).toMatchObject({ state: "unavailable" });
    expect(result.sources.growth.detail).toContain("ECONNREFUSED");
    expect(result.sources.geoqa.state).toBe("ok");
    expect(result.sources.github.state).toBe("ok");
    expect(result.skipped).not.toBe("no-sources");
  });

  it("reads an unreadable filed-issues.json as unavailable, never as no issues", async () => {
    const { ports } = harness({ growth: null, filed: () => null });
    const result = await fixRun(ports);
    expect(result.sources.geoqa).toMatchObject({ state: "unavailable", detail: "filed-issues.json is unreadable" });
  });

  it("stops when EVERY source was unreachable — nothing was read, so nothing is known", async () => {
    const { ports } = harness({
      growth: async () => {
        throw new Error("down");
      },
      filed: () => null,
      listIssues: async () => {
        throw new Error("403");
      },
    });
    const result = await fixRun(ports);
    expect(result.skipped).toBe("no-sources");
    expect(result.sources.github.detail).toContain("403");
  });

  it("honours --source growth and --source github", async () => {
    const growthOnly = harness({}, HAPPY_EXEC);
    const a = await fixRun(growthOnly.ports, { source: "growth", dryRun: true });
    expect(a.sources.github).toMatchObject({ state: "off", detail: "--source growth" });

    const githubOnly = harness({}, HAPPY_EXEC);
    const b = await fixRun(githubOnly.ports, { source: "github", dryRun: true });
    expect(b.sources.growth).toMatchObject({ state: "off", detail: "--source github" });
  });
});

describe("fixRun — the review veto", () => {
  const rejecting = (detail = "the diff deletes tests/meta.spec.ts"): Partial<FixPorts> => ({
    gate: gateOf(() => ({ ok: false, status: "rejected", detail }), null),
  });

  it("a REJECTED fix never reaches origin, and is not remembered as a repair", async () => {
    const { ports, exec, comments, labelled, store } = harness(rejecting());
    const result = await fixRun(ports);

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({ status: "rejected", reviewVerdict: "reject" });
    // The claim that matters, asserted against what actually ran.
    expect(pushed(exec)).toBe(false);
    expect(prCreated(exec)).toBe(false);
    expect(argvLog(exec).some((call) => call.startsWith("gh pr merge"))).toBe(false);

    // The human hears about it, and the issue is parked until they clear it.
    expect(comments[0]?.body).toContain("stopped before opening a pull request");
    expect(comments[0]?.body).toContain("A second model reviewed the diff and rejected it.");
    expect(comments[0]?.body).toContain("nothing was pushed");
    expect(labelled).toEqual([{ repo: CODE_REPO, number: 343, labels: [CHANGES_REQUESTED_LABEL] }]);
    expect(labelled.some((entry) => entry.labels.includes(REVIEWED_LABEL))).toBe(false);

    // A rejection is an ATTEMPT, not a repair: it goes in the ledger a retry cap
    // can see, and never into repaired-issues.json, whose enum is strict.
    expect(store.files.get(`${EVIDENCE}/${REPAIRED_ISSUES_FILE}`)).toBeUndefined();
    expect(store.files.get(fixAttemptsPath(EVIDENCE))).toContain("rejected");
  });

  it("a VERIFY-FAILED fix never reaches origin, and says whose checks failed", async () => {
    const { ports, exec, comments } = harness({
      gate: gateOf(() => ({ ok: false, status: "verify-failed", detail: "test exited 1" }), "failed"),
    });
    const result = await fixRun(ports);
    expect(result.outcomes[0]).toMatchObject({ status: "verify-failed", verify: { state: "failed" } });
    expect(pushed(exec)).toBe(false);
    expect(comments[0]?.body).toContain(`\`${CODE_REPO}\`'s own checks`);
    expect(comments[0]?.body).toContain("nothing weakened them to make it pass");
  });

  it("does not turn a failed comment into a failed run", async () => {
    const { ports, logs } = harness({
      ...rejecting(),
      comment: async () => {
        throw new Error("422 label does not exist");
      },
    });
    const result = await fixRun(ports);
    expect(result.outcomes[0]?.status).toBe("rejected");
    expect(logs.some((line) => line.includes("422"))).toBe(true);
  });

  it("APPROVED and verified: a pull request, the reviewed label, and the write-back", async () => {
    const { ports, exec, labelled, filedBack } = harness();
    const result = await fixRun(ports);

    expect(result.outcomes[0]).toMatchObject({
      status: "opened",
      prUrl: PR_URL,
      reviewVerdict: "approve",
      verify: { state: "passed" },
    });
    expect(pushed(exec)).toBe(true);
    expect(prCreated(exec)).toBe(true);
    expect(labelled).toEqual([{ repo: CODE_REPO, number: 343, labels: [REVIEWED_LABEL] }]);
    // The agent READS `agent: approved` and never writes it. An agent that can
    // grant itself permission has none.
    expect(labelled.some((entry) => entry.labels.includes("agent: approved"))).toBe(false);
    expect(filedBack).toEqual([{ agent: "seo", findingKeys: ["digilist.no/p0:description.long"], githubIssue: "343" }]);
  });

  it("does NOT ask GitHub to auto-merge unless the caller asked", async () => {
    const withoutMerge = harness();
    await fixRun(withoutMerge.ports);
    expect(argvLog(withoutMerge.exec).some((call) => call.startsWith("gh pr merge"))).toBe(false);
    expect(withoutMerge.ports).toBeDefined();

    const withMerge = harness();
    await fixRun(withMerge.ports, { merge: true });
    expect(argvLog(withMerge.exec).some((call) => call.startsWith("gh pr merge --auto --squash"))).toBe(true);
  });

  it("hands the gate an exec bound to the CLONE, and does not let a failed label undo the PR", async () => {
    // Two things at once, because they share a run: the gate's `exec` really is
    // wired through to the clone (a gate that could not run git could not check
    // anything), and a labelling failure after the PR exists is logged, not
    // escalated — the issue's `Fixes` link is the durable record and closing a
    // good pull request to tidy GitHub is the wrong trade.
    const inGate: string[][] = [];
    const { ports, logs, exec } = harness({
      gate: (record) => async ({ job, exec: gitExec }) => {
        const result = await gitExec(["git", "rev-parse", "HEAD"], 15_000);
        inGate.push(["git", "rev-parse", "HEAD", `exit=${result.exitCode}`]);
        record.onReview(job.key, { verdict: "approve" });
        record.onVerify(job.key, { state: "skipped", steps: [] });
        return { ok: true };
      },
      addLabels: async () => {
        throw new Error("422 Validation Failed");
      },
    });
    const result = await fixRun(ports);
    expect(inGate).toEqual([["git", "rev-parse", "HEAD", "exit=0"]]);
    expect(argvLog(exec)).toContain("git rev-parse HEAD");
    expect(result.outcomes[0]).toMatchObject({ status: "opened", prUrl: PR_URL, verify: { state: "skipped" } });
    expect(logs.some((line) => line.includes("422"))).toBe(true);
  });

  it("records a write-back that failed on the outcome and does NOT undo the pull request", async () => {
    const db: GrowthDb = {
      openFindings: async () => growthRows(1),
      markFiled: async () => {
        throw new Error("deadlock detected");
      },
      openRun: async () => 77,
      closeRun: async () => undefined,
      close: async () => undefined,
    };
    const { ports } = harness({ growth: async () => db });
    const result = await fixRun(ports);
    expect(result.outcomes[0]?.status).toBe("opened");
    expect(result.outcomes[0]?.prUrl).toBe(PR_URL);
    expect(result.outcomes[0]?.detail).toContain("writeback-failed");
  });

  it("turns a thrown item into ONE failed outcome and keeps going", async () => {
    // The second item's clone throws rather than returning a non-zero exit —
    // the shape a spawn or a full disk actually produces. `guard` is the one
    // place that becomes a value, and the first item must still get its PR.
    const base = scripted(HAPPY_EXEC);
    const exec: ScriptedExec = {
      ...base,
      run: async (input) => {
        if (input.argv.join(" ").includes("-344")) throw new Error("ENOSPC: no space left on device");
        return base.run(input);
      },
    };
    const { ports } = harness({
      exec,
      growth: async () => ({
        openFindings: async () => growthRows(2),
        markFiled: async () => [],
        openRun: async () => 77,
        closeRun: async () => undefined,
        close: async () => undefined,
      }),
    });
    const result = await fixRun(ports);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.map((outcome) => outcome.status).sort()).toEqual(["failed", "opened"]);
    expect(result.outcomes.find((outcome) => outcome.status === "failed")?.detail).toContain("ENOSPC");
  });
});

describe("fixRun — the budget", () => {
  /**
   * The number that makes this real: the growth fleet's run on 2026-08-24
   * produced 341 open findings. Without a cap that is 341 clones, 341 repair
   * models and 341 pull requests in one night.
   */
  it("attempts at most maxItems out of 341 findings, and clones only that many repositories", async () => {
    const db: GrowthDb = {
      openFindings: async () => growthRows(341),
      markFiled: async () => [],
      openRun: async () => 77,
      closeRun: async () => undefined,
      close: async () => undefined,
    };
    const { ports, exec } = harness({ growth: async () => db, filed: () => [], listIssues: async () => [] });
    const result = await fixRun(ports);

    // Two, not three: `maxItems` is 3, but the 240-minute budget affords only
    // two 97-minute worst-case items, and the smaller of the two caps wins.
    const affordable = Math.min(DEFAULT_SELECT_POLICY.maxItems, Math.floor(DEFAULT_SELECT_POLICY.budgetMs / WORST_CASE_ITEM_MS));
    expect(affordable).toBe(2);
    expect(result.intake).toBe(341);
    expect(result.eligible).toBe(affordable);
    expect(result.outcomes).toHaveLength(affordable);
    expect(argvLog(exec).filter((call) => call.startsWith("gh repo clone"))).toHaveLength(affordable);
    // The 339 findings this run did not reach are visible as the gap between
    // `intake` and `eligible` — nothing was silently dropped.
    expect(result.intake - result.eligible).toBe(339);
    expect(result.budget.stoppedOnBudget).toBe(true);
  });

  it("stops before STARTING an item once the wall clock is spent, and never mid-item", async () => {
    // Three eligible items, each costing 130 minutes of a 240-minute budget.
    // The third must not be started; the second must not be interrupted.
    let clock = 0;
    const db: GrowthDb = {
      openFindings: async () => growthRows(3),
      markFiled: async () => [],
      openRun: async () => 77,
      closeRun: async () => undefined,
      close: async () => undefined,
    };
    const { ports, logs, exec } = harness({
      growth: async () => db,
      now: () => clock,
      gate: () => async () => {
        clock += 130 * 60_000;
        return { ok: true };
      },
    });
    // A budget that affords two worst-case items on paper, so two are selected.
    // The first costs 130 real minutes, leaving 64 — less than one worst case —
    // so the second is refused BEFORE it starts rather than run past the end.
    const budgetMs = 2 * WORST_CASE_ITEM_MS;
    const result = await fixRun(ports, { policy: { budgetMs } });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.status).toBe("opened");
    expect(result.budget.stoppedOnBudget).toBe(true);
    expect(argvLog(exec).filter((call) => call.startsWith("gh repo clone"))).toHaveLength(1);
    expect(logs.some((line) => line.includes("stopping before"))).toBe(true);
    // The run ended inside its budget, which is the whole point: the systemd
    // unit's TimeoutStartSec must never be what stops an item.
    expect(result.budget.usedMs).toBeLessThan(budgetMs);
  });

  it("refuses to start even one item when the budget cannot afford one", async () => {
    const { ports, exec } = harness();
    const result = await fixRun(ports, { policy: { budgetMs: 60_000 } });
    expect(result.skipped).toBe("nothing-eligible");
    expect(exec.argv.some((argv) => argv[0] === "gh" && argv[1] === "repo")).toBe(false);
  });
});

describe("fixRun — idempotency", () => {
  it("a second run finds the pull request already open and does not clone again", async () => {
    const first = harness();
    const a = await fixRun(first.ports);
    expect(a.outcomes[0]?.status).toBe("opened");

    // Night two: the same 341-row table, the same finding, the same branch.
    const second = harness({ store: first.store, prOpen: async () => true });
    const b = await fixRun(second.ports);
    expect(b.skipped).toBe("nothing-eligible");
    expect(b.ineligible).toEqual([{ key: "issue:343", reason: "pr-open" }]);
    expect(second.exec.argv.some((argv) => argv[0] === "gh" && argv[1] === "repo")).toBe(false);
    expect(second.comments).toEqual([]);
  });

  it("treats an unanswerable `gh pr list` as ALREADY OPEN — a duplicate PR is worse than a night skipped", async () => {
    const { ports, logs } = harness({
      prOpen: async () => {
        throw new Error("gh: API rate limit exceeded");
      },
    });
    const result = await fixRun(ports);
    expect(result.ineligible).toEqual([{ key: "issue:343", reason: "pr-open" }]);
    expect(logs.some((line) => line.includes("treating"))).toBe(true);
  });

  it("carries the attempt ledger across runs and stops after maxAttempts", async () => {
    const store = memoryStore();
    const rejecting = { gate: gateOf(() => ({ ok: false, status: "rejected" as const, detail: "no" }), null) };

    const one = harness({ store, ...rejecting });
    expect((await fixRun(one.ports)).outcomes[0]?.status).toBe("rejected");
    const two = harness({ store, ...rejecting });
    expect((await fixRun(two.ports)).outcomes[0]?.status).toBe("rejected");

    const three = harness({ store, ...rejecting });
    const third = await fixRun(three.ports);
    expect(third.skipped).toBe("nothing-eligible");
    expect(third.ineligible).toEqual([{ key: "issue:343", reason: "attempts-exhausted" }]);
    expect(three.exec.argv).toEqual([]);
  });

  it("remembers a geoqa repair in repaired-issues.json and skips it next time; a growth key never goes there", async () => {
    const drafts = [
      {
        key: "site:digilist.no:meta",
        title: "Meta description missing",
        body: "## Impact\nnone",
        labels: ["findings"],
        urgent: false,
        runIds: ["r1"],
        site: "digilist.no",
        hosts: ["digilist.no"],
      },
    ];
    const filed = [{ key: "site:digilist.no:meta", number: 500, url: "https://github.com/x/y/issues/500", at: "2026-08-24" }];

    const store = memoryStore();
    const one = harness({ store, growth: null, drafts: () => drafts, filed: () => filed });
    const a = await fixRun(one.ports);
    expect(a.outcomes[0]).toMatchObject({ key: "site:digilist.no:meta", status: "opened" });
    const remembered = store.files.get(`${EVIDENCE}/${REPAIRED_ISSUES_FILE}`) ?? "";
    expect(remembered).toContain("site:digilist.no:meta");
    // Only geoqa keys belong in geoqa's store.
    expect(remembered).not.toContain("issue:343");

    const two = harness({ store, growth: null, drafts: () => drafts, filed: () => filed });
    const b = await fixRun(two.ports);
    expect(b.ineligible).toEqual([{ key: "site:digilist.no:meta", reason: "already-repaired" }]);
    expect(two.exec.argv).toEqual([]);
  });

  it("writes back ONCE PER AGENT — `(agent, finding_key)` is the table's identity, the issue is ours", async () => {
    // Two agents, one issue. `growthGroupKey` buckets by `issue:343` first, so
    // this is one work item spanning two agents — and sending every key under
    // the first agent's name matched only its rows, leaving trustops's row at
    // `github_issue = ''` for the next night to pick up again.
    const captured: { agent: string; findingKeys: string[]; githubIssue: string }[] = [];
    const { ports } = harness({
      growth: async () => ({
        openFindings: async () => [
          row({ id: 1, agent: "seo", findingKey: "a" }),
          row({ id: 2, agent: "seo", findingKey: "b" }),
          row({ id: 3, agent: "trustops", findingKey: "c" }),
        ],
        markFiled: async (input) => {
          captured.push(input);
          return input.findingKeys;
        },
        openRun: async () => 77,
        closeRun: async () => undefined,
        close: async () => undefined,
      }),
    });
    await fixRun(ports);
    expect(captured).toEqual([
      { agent: "seo", findingKeys: ["a", "b"], githubIssue: "343" },
      { agent: "trustops", findingKeys: ["c"], githubIssue: "343" },
    ]);
  });
});

describe("fixRun — dry run and reporting", () => {
  it("a dry run reads everything, decides everything, and touches nothing", async () => {
    const { ports, exec, comments, labelled, filedBack, store } = harness();
    const result = await fixRun(ports, { dryRun: true });
    expect(result.skipped).toBe("dry-run");
    expect(result.wouldFix.map((item) => item.key)).toEqual(["issue:343"]);
    expect(exec.argv).toEqual([]);
    expect(comments).toEqual([]);
    expect(labelled).toEqual([]);
    expect(filedBack).toEqual([]);
    expect(store.files.has(fixAttemptsPath(EVIDENCE))).toBe(false);
  });

  it("--only narrows to the named keys", async () => {
    const { ports } = harness();
    const result = await fixRun(ports, { dryRun: true, only: ["nothing-matches-this"] });
    expect(result.intake).toBe(0);
  });

  it("closes the growth run row with what happened, and closes the pool", async () => {
    const closed: unknown[] = [];
    let poolClosed = false;
    const { ports } = harness({
      growth: async () => ({
        openFindings: async () => growthRows(1),
        markFiled: async () => [],
        openRun: async () => 77,
        closeRun: async (input) => {
          closed.push(input);
        },
        close: async () => {
          poolClosed = true;
        },
      }),
    });
    const result = await fixRun(ports);
    expect(result.runId).toBe(77);
    expect(closed).toEqual([{ runId: 77, status: "success", itemsFiled: 1, apiCalls: 2 }]);
    expect(poolClosed).toBe(true);
  });

  it("does not let a failing closeRun replace the run's own result", async () => {
    const { ports, logs } = harness({
      growth: async () => ({
        openFindings: async () => growthRows(1),
        markFiled: async () => [],
        openRun: async () => 77,
        closeRun: async () => {
          throw new Error("connection terminated");
        },
        close: async () => undefined,
      }),
    });
    const result = await fixRun(ports);
    expect(result.outcomes[0]?.status).toBe("opened");
    expect(logs.some((line) => line.includes("connection terminated"))).toBe(true);
  });
});

describe("select", () => {
  const item = (over: Partial<WorkItem> = {}): WorkItem => ({
    key: "k",
    source: "growth",
    title: "t",
    body: "b",
    labels: [],
    urgent: false,
    severityRank: 3,
    reach: 1,
    fixability: 0.9,
    daysOpen: 0,
    category: "seo",
    rule: "description.long",
    issue: { repo: CODE_REPO, number: 343, url: "u" },
    route: { codeRepo: CODE_REPO, base: "main", site: "digilist.no", reason: "target-repo" },
    members: [],
    ...over,
  });

  const input = (over: Partial<Parameters<typeof select>[0]> = {}): Parameters<typeof select>[0] => ({
    items: [item()],
    ledger: ledgerOf([]),
    repaired: new Set<string>(),
    issueLabels: new Map(),
    prOpen: new Set<string>(),
    policy: DEFAULT_SELECT_POLICY,
    ...over,
  });

  it("gives the first reason, cheapest truth first", () => {
    expect(ineligibleReason(item({ route: null }), input())).toBe("unroutable");
    expect(ineligibleReason(item({ issue: null }), input())).toBe("no-issue");
    expect(ineligibleReason(item({ severityRank: 1 }), input())).toBe("below-severity");
    expect(ineligibleReason(item({ category: "security" }), input())).toBe("category-not-allowed");
    expect(ineligibleReason(item(), input({ repaired: new Set(["k"]) }))).toBe("already-repaired");
    expect(ineligibleReason(item(), input({ prOpen: new Set([`${CODE_REPO}#343`]) }))).toBe("pr-open");
    expect(ineligibleReason(item(), input())).toBeNull();
  });

  it("refuses a security finding by default — a wrongly 'fixed' auth check is worse than an open one", () => {
    expect(ineligibleReason(item({ category: "security" }), input())).toBe("category-not-allowed");
    expect(ineligibleReason(item({ category: "compliance" }), input())).toBe("category-not-allowed");
  });

  it("lets a HUMAN override severity and category with agent: approved, and never the agent itself", () => {
    const labels = new Map([[`${CODE_REPO}#343`, ["agent: approved"]]]);
    expect(ineligibleReason(item({ category: "security", severityRank: 0 }), input({ issueLabels: labels }))).toBeNull();
  });

  it("treats agent: changes-requested as absolute — a human said no and the agent does not argue", () => {
    const labels = new Map([[`${CODE_REPO}#343`, ["agent: approved", "agent: changes-requested"]]]);
    expect(ineligibleReason(item(), input({ issueLabels: labels }))).toBe("changes-requested");
  });

  it("stops at maxAttempts", () => {
    const ledger = ledgerOf([{ key: "k", attempts: 2, lastAt: "x", lastStatus: "rejected" }]);
    expect(ineligibleReason(item(), input({ ledger }))).toBe("attempts-exhausted");
  });

  it("caps by BOTH maxItems and what the budget can afford one worst-case item at a time", () => {
    const many = Array.from({ length: 10 }, (_, i) => item({ key: `k${i}` }));
    // maxItems 3, but only two worst-case items fit in 240 minutes.
    expect(select(input({ items: many })).chosen).toHaveLength(2);
    expect(select(input({ items: many, policy: { ...DEFAULT_SELECT_POLICY, budgetMs: 3 * WORST_CASE_ITEM_MS } })).chosen).toHaveLength(3);
    expect(select(input({ items: many, policy: { ...DEFAULT_SELECT_POLICY, budgetMs: WORST_CASE_ITEM_MS } })).chosen).toHaveLength(1);
    const none = select(input({ items: many, policy: { ...DEFAULT_SELECT_POLICY, budgetMs: 0 } }));
    expect(none.chosen).toEqual([]);
    expect(none.stoppedOnBudget).toBe(true);
  });

  it("ranks by score, then days open, then key — so a re-run picks the same items", () => {
    const items = [
      item({ key: "small", reach: 1 }),
      item({ key: "wide", reach: 339 }),
      item({ key: "old", reach: 1, daysOpen: 90 }),
    ];
    const roomy = { ...DEFAULT_SELECT_POLICY, budgetMs: 3 * WORST_CASE_ITEM_MS };
    expect(select(input({ items, policy: roomy })).chosen.map((chosen) => chosen.key)).toEqual(["wide", "old", "small"]);
  });
});

describe("triage", () => {
  const item = (over: Partial<WorkItem>): WorkItem => ({
    key: "k",
    source: "growth",
    title: "t",
    body: "b",
    labels: [],
    urgent: false,
    severityRank: 3,
    reach: 1,
    fixability: 0,
    daysOpen: 0,
    category: "seo",
    rule: "",
    issue: null,
    route: null,
    members: [],
    ...over,
  });

  const issue = (number: number): WorkItem["issue"] => ({ repo: CODE_REPO, number, url: "u" });

  it("collapses two sources onto one issue into ONE item — two would clone into the same directory", () => {
    const result = triage([
      item({ key: "growth:a", issue: issue(343), reach: 339, labels: ["seo"], members: [{ source: "growth" }] }),
      item({ key: "geoqa:b", issue: issue(343), reach: 1, severityRank: 4, urgent: true, daysOpen: 12, labels: ["site"], members: [{ source: "geoqa" }] }),
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.merged).toBe(1);
    expect(result.clashes).toEqual([]);
    expect(result.items[0]).toMatchObject({ key: "growth:a", reach: 340, severityRank: 4, daysOpen: 12, urgent: true });
    expect(result.items[0]?.labels).toEqual(["seo", "site"]);
    expect(result.items[0]?.members).toHaveLength(2);
  });

  it("keeps items with no issue apart rather than collapsing them together", () => {
    const result = triage([item({ key: "a" }), item({ key: "b" })]);
    expect(result.items).toHaveLength(2);
    expect(result.merged).toBe(0);
  });

  it("weights reach logarithmically — 339 pages outrank 1 page about fourfold, not 339-fold", () => {
    expect(reachWeight(0)).toBe(1);
    expect(reachWeight(339) / reachWeight(1)).toBeGreaterThan(3);
    expect(reachWeight(339) / reachWeight(1)).toBeLessThan(6);
    expect(reachWeight(-5)).toBe(1);
  });

  it("scores the checkable rules above everything else, and defaults the rest", () => {
    expect(fixabilityOf("description.long")).toBe(0.9);
    expect(fixabilityOf("anything-else")).toBe(0.4);
    expect(score(item({ severityRank: 3, reach: 1, fixability: 0.9 }))).toBeCloseTo(5.4);
  });

  it("names a clash instead of throwing, so a bad plan does not kill a good one", () => {
    const clashing = [item({ key: "a", issue: issue(7) }), item({ key: "b", issue: issue(7) })];
    expect(assertUniqueIssues(clashing)).toEqual([`${CODE_REPO}#7`]);
  });
});

describe("attempts", () => {
  it("reads a missing file as an empty ledger and a corrupt one as unreadable", () => {
    expect(loadAttempts(EVIDENCE, memoryStore())).toEqual({ ok: true, items: [] });
    expect(loadAttempts(EVIDENCE, memoryStore({ [fixAttemptsPath(EVIDENCE)]: "{" }))).toEqual({ ok: false });
    // `.strict()`: an unknown key is a file we do not understand, not one we guess at.
    expect(loadAttempts(EVIDENCE, memoryStore({ [fixAttemptsPath(EVIDENCE)]: `{"items":[{"key":"k","attempts":1,"lastAt":"x","lastStatus":"opened","surprise":1}]}` }))).toEqual({
      ok: false,
    });
    expect(loadAttempts(EVIDENCE, memoryStore({ [fixAttemptsPath(EVIDENCE)]: `{"items":[{"key":"k","attempts":1,"lastAt":"x","lastStatus":"nonsense"}]}` }))).toEqual({
      ok: false,
    });
  });

  it("round-trips every optional field", () => {
    const store = memoryStore();
    const items = recordAttempt([], { key: "k", status: "opened", detail: "d", prUrl: "u", ms: 12 }, 0);
    saveAttempts(EVIDENCE, items, store);
    expect(loadAttempts(EVIDENCE, store)).toEqual({ ok: true, items });
    expect(fixAttemptsPath(EVIDENCE)).toBe(`${EVIDENCE}/${FIX_ATTEMPTS_FILE}`);
  });

  it("counts attempts per key and keeps the ledger sorted", () => {
    let items = recordAttempt([], { key: "b", status: "rejected", ms: 1 }, 0);
    items = recordAttempt(items, { key: "a", status: "failed", ms: 1 }, 0);
    items = recordAttempt(items, { key: "b", status: "rejected", ms: 1 }, 0);
    expect(items.map((item) => item.key)).toEqual(["a", "b"]);
    expect(ledgerOf(items).attempts("b")).toBe(2);
    expect(ledgerOf(items).attempts("never-seen")).toBe(0);
    expect(ledgerOf(items).last("a")?.lastStatus).toBe("failed");
  });
});

describe("lock", () => {
  const store = () => memoryStore();

  it("takes a free lock and writes who holds it", () => {
    const files = store();
    expect(acquireLock(EVIDENCE, files, { pid: 7, nowMs: 1_000, budgetMs: 100 })).toEqual({ ok: true });
    expect(files.files.get(fixLockPath(EVIDENCE))).toContain(`"pid": 7`);
  });

  it("refuses a live lock and reports its holder", () => {
    const files = store();
    acquireLock(EVIDENCE, files, { pid: 7, nowMs: 1_000, budgetMs: 100 });
    const second = acquireLock(EVIDENCE, files, { pid: 8, nowMs: 1_100, budgetMs: 100 });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.held?.pid).toBe(7);
  });

  it("takes a stale lock, and an unparseable one, rather than wedging the timer forever", () => {
    const files = store();
    acquireLock(EVIDENCE, files, { pid: 7, nowMs: 0, budgetMs: 100 });
    expect(acquireLock(EVIDENCE, files, { pid: 8, nowMs: 100 + LOCK_STALE_GRACE_MS + 1, budgetMs: 100 })).toEqual({ ok: true });

    const corrupt = memoryStore({ [fixLockPath(EVIDENCE)]: "not json" });
    expect(acquireLock(EVIDENCE, corrupt, { pid: 8, nowMs: 0, budgetMs: 100 })).toEqual({ ok: true });
    const wrongShape = memoryStore({ [fixLockPath(EVIDENCE)]: `{"pid":"seven"}` });
    expect(acquireLock(EVIDENCE, wrongShape, { pid: 8, nowMs: 0, budgetMs: 100 })).toEqual({ ok: true });
  });

  it("releases best-effort and never throws out of a finally", () => {
    const files = store();
    acquireLock(EVIDENCE, files, { pid: 7, nowMs: 0, budgetMs: 100 });
    const removed: string[] = [];
    releaseLock(EVIDENCE, files, (p) => removed.push(p));
    expect(removed).toEqual([fixLockPath(EVIDENCE)]);

    releaseLock(EVIDENCE, files, () => undefined);
    expect(() =>
      releaseLock(EVIDENCE, memoryStore({ [fixLockPath(EVIDENCE)]: "x" }), () => {
        throw new Error("EPERM");
      }),
    ).not.toThrow();
  });
});

describe("the suite's own contract", () => {
  it("names the files it must never touch for real", () => {
    // A cheap tripwire on the three constants a real run writes through. If one
    // of these ever changes, the fakes above stop shadowing the real paths and
    // this suite starts writing into an evidence tree.
    expect([FILED_ISSUES_FILE, REPAIRED_ISSUES_FILE, FIX_ATTEMPTS_FILE]).toEqual(["filed-issues.json", "repaired-issues.json", "fix-attempts.json"]);
  });

  it("spawns nothing: every claude and every exec in this file is an injected function", () => {
    const { ports } = harness();
    expect(typeof ports.claude.repair).toBe("function");
    expect(typeof ports.claude.review).toBe("function");
    expect(vi.isMockFunction(ports.exec.run)).toBe(false);
  });
});

// Kept so an unused-import lint cannot quietly drop the type the harness is built from.
export type { FixRunOptions };
