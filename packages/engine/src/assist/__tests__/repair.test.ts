import { describe, expect, it } from "vitest";
import { defaultRepairClaude, jobsFromFiled, readPrUrl, repairOne, type RepairExec, type RepairJob } from "../repair.js";
import { buildRepairPrompt } from "../repair-prompt.js";
import type { TicketDraft } from "../../findings/tickets.js";

const draft = (over: Partial<TicketDraft> = {}): TicketDraft => ({
  key: "site:has a search box:xala.no",
  title: "has a search box on xala.no",
  body: "failed on the page",
  labels: ["findings", "bug", "site:xala.no"],
  urgent: false,
  runIds: ["run_1"],
  site: "xala.no",
  hosts: ["xala.no"],
  ...over,
});

const job = (over: Partial<RepairJob> = {}): RepairJob => ({
  key: "site:has a search box:xala.no",
  title: "has a search box on xala.no",
  body: "failed on the page",
  issueNumber: 48,
  issueUrl: "https://github.com/xalatechnologies/xala-web-cloner/issues/48",
  issueRepo: "xalatechnologies/xala-web-cloner",
  codeRepo: "xalatechnologies/xala-web-cloner",
  base: "main",
  site: "xala.no",
  urgent: false,
  ...over,
});

const scripted = (
  replies: Record<string, { stdout?: string; stderr?: string; exitCode?: number; error?: string }>,
): RepairExec & { argv: string[][]; envs: NodeJS.ProcessEnv[] } => {
  const argv: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const files = new Set<string>();
  return {
    argv,
    envs,
    mkdir: () => undefined,
    exists: (p) => files.has(p),
    rm: (p) => {
      files.delete(p);
    },
    run: async (input) => {
      argv.push(input.argv);
      envs.push(input.env);
      const key = input.argv.join(" ");
      const hit = Object.entries(replies).find(([pattern]) => key.includes(pattern));
      const reply = hit?.[1] ?? { exitCode: 0, stdout: "" };
      return {
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
        exitCode: reply.exitCode ?? 0,
        ...(reply.error !== undefined ? { error: reply.error } : {}),
      };
    },
  };
};

describe("buildRepairPrompt", () => {
  it("embeds the issue and forbids inventing a reading, and tells the model not to push", () => {
    const prompt = buildRepairPrompt(job({ urgent: true, site: "geoqa" }));
    expect(prompt).toContain("has a search box on xala.no");
    expect(prompt).toContain("failed on the page");
    expect(prompt).toContain("Do not invent");
    expect(prompt).toContain("CANNOT_FIX");
    expect(prompt).toContain("Do not push");
    expect(prompt).toContain("instrumentation");
    expect(buildRepairPrompt(job())).toContain("site finding");
  });
});

describe("jobsFromFiled", () => {
  it("pairs a draft with its filed issue and routes the PR to the site repo", () => {
    const jobs = jobsFromFiled(
      [draft(), draft({ key: "orphan" })],
      [{ key: draft().key, number: 48, url: "https://github.com/x/y/issues/48", at: "t", repo: "xalatechnologies/xala-web-cloner" }],
      [{ host: "xala.no", repo: "xalatechnologies/xala-web-cloner", base: "main" }],
      "Xala-Technologies/geoqa",
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.codeRepo).toBe("xalatechnologies/xala-web-cloner");
    expect(jobs[0]?.issueNumber).toBe(48);
    expect(jobs[0]?.base).toBe("main");
  });

  it("an urgent draft PRs geoqa/main even when the filed issue omitted its repo", () => {
    const jobs = jobsFromFiled(
      [draft({ key: "urgent:geo-mismatch", urgent: true, site: "geoqa", hosts: ["digilist.no"], title: "URGENT: miss" })],
      [{ key: "urgent:geo-mismatch", number: 52, url: "https://github.com/Xala-Technologies/geoqa/issues/52", at: "t" }],
      [{ host: "digilist.no", repo: "Xala-Technologies/booking-brilliance", base: "main" }],
      "Xala-Technologies/geoqa",
    );
    expect(jobs[0]?.codeRepo).toBe("Xala-Technologies/geoqa");
    expect(jobs[0]?.issueRepo).toBe("Xala-Technologies/geoqa");
    expect(jobs[0]?.base).toBe("main");
  });
});

describe("defaultRepairClaude", () => {
  it("runs claude -p in the checkout with the unattended flag, billing Max", async () => {
    let cwd = "";
    let args: string[] = [];
    let env: NodeJS.ProcessEnv = {};
    const fn = defaultRepairClaude({ ANTHROPIC_API_KEY: "sk", PATH: "/bin" }, async (passed, opts) => {
      args = passed;
      cwd = opts.cwd ?? "";
      env = opts.env;
      return { stdout: "fixed", stderr: "", exitCode: 0 };
    });
    const out = await fn("ISSUE", "/tmp/site");
    expect(out).toEqual({ ok: true, text: "fixed" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(cwd).toBe("/tmp/site");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.IS_SANDBOX).toBe("1");
    expect(typeof defaultRepairClaude({ PATH: "/bin" })).toBe("function");
  });
});

describe("readPrUrl", () => {
  it("takes the pull URL and ignores everything else", () => {
    expect(readPrUrl("https://github.com/acme/site/pull/12\n")).toBe("https://github.com/acme/site/pull/12");
    expect(readPrUrl("opened")).toBeNull();
  });
});

describe("repairOne", () => {
  const workRoot = "/tmp/geoqa-repair";
  const token = "t";
  const env = { PATH: "/bin" };

  it("opens a PR and asks GitHub to auto-merge when Claude changed files", async () => {
    const exec = scripted({
      "git status": { stdout: " M src/app.tsx\n" },
      "git log": { stdout: "" },
      "gh pr create": { stdout: "https://github.com/xalatechnologies/xala-web-cloner/pull/3\n" },
      "gh pr merge": { exitCode: 0 },
    });
    const out = await repairOne(job(), {
      exec,
      claude: async () => ({ ok: true, text: "fixed the search form" }),
      workRoot,
      token,
      env,
    });
    expect(out.status).toBe("opened");
    expect(out.prUrl).toBe("https://github.com/xalatechnologies/xala-web-cloner/pull/3");
    expect(out.autoMerge).toBe(true);
    expect(exec.argv.some((a) => a.includes("clone") && a.includes("xalatechnologies/xala-web-cloner"))).toBe(true);
    expect(exec.argv.some((a) => a.includes("fetch") && a.includes("origin") && a.includes("main"))).toBe(true);
    expect(exec.argv.some((a) => a.includes("checkout") && a.includes("geoqa/issue-48") && a.includes("origin/main"))).toBe(true);
    expect(exec.argv.some((a) => a.includes("rebase") && a.includes("origin/main"))).toBe(true);
    expect(exec.argv.some((a) => a.includes("pr") && a.includes("create") && a.includes("main"))).toBe(true);
    expect(exec.argv.some((a) => a.includes("--auto") && a.includes("--squash"))).toBe(true);
    expect(exec.envs.some((e) => e.GIT_CONFIG_VALUE_1 === "!gh auth git-credential")).toBe(true);
    expect(exec.argv.flat().includes("t")).toBe(false);
  });

  it("still reports the PR when auto-merge is off, and skips commit when Claude already committed", async () => {
    const exec = scripted({
      "git status": { stdout: "" },
      "git log": { stdout: "abc Fix #48\n" },
      "gh pr create": { stdout: "https://github.com/acme/site/pull/9\n" },
      "gh pr merge": { exitCode: 1, stderr: "auto merge is not enabled" },
    });
    const out = await repairOne(job({ codeRepo: "acme/site" }), {
      exec,
      claude: async () => ({ ok: true, text: "committed" }),
      workRoot,
      token,
      env,
    });
    expect(out.status).toBe("opened");
    expect(out.autoMerge).toBe(false);
    expect(out.detail).toContain("auto merge");
    expect(exec.argv.some((a) => a.includes("commit"))).toBe(false);
  });

  it("does not open a PR when Claude cannot fix or changed nothing", async () => {
    const none = scripted({ "git status": { stdout: "" }, "git log": { stdout: "" } });
    const cannot = await repairOne(job(), {
      exec: none,
      claude: async () => ({ ok: true, text: "CANNOT_FIX: vendor city miss\n" }),
      workRoot,
      token,
      env,
    });
    expect(cannot.status).toBe("cannot-fix");
    expect(cannot.detail).toContain("CANNOT_FIX");
    const clean = await repairOne(job(), {
      exec: scripted({ "git status": { stdout: "" }, "git log": { stdout: "" } }),
      claude: async () => ({ ok: true, text: "looked, nothing to change" }),
      workRoot,
      token,
      env,
    });
    expect(clean.status).toBe("no-changes");
  });

  it("names every failure the porter can hit", async () => {
    const refuse = await repairOne(job({ codeRepo: "../x" }), {
      exec: scripted({}),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(refuse.status).toBe("failed");
    expect(refuse.detail).toContain("cross-tenant");

    const badRepo = await repairOne(job({ codeRepo: "nope" }), {
      exec: scripted({}),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(badRepo.detail).toContain("owner/name");

    const clone = await repairOne(job(), {
      exec: scripted({ "repo clone": { exitCode: 1, stderr: "403" } }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(clone.detail).toContain("403");

    const fetch = await repairOne(job(), {
      exec: scripted({ "git fetch": { exitCode: 1, stderr: "could not read Username" } }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(fetch.detail).toContain("could not read Username");

    const checkout = await repairOne(job(), {
      exec: scripted({ "git checkout": { exitCode: 1, error: "checkout died" } }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(checkout.detail).toContain("checkout died");

    const model = await repairOne(job(), {
      exec: scripted({}),
      claude: async () => ({ ok: false, failure: { kind: "spawn", detail: "claude CLI not found" } }),
      workRoot,
      token,
      env,
    });
    expect(model.detail).toContain("claude CLI not found");

    const add = await repairOne(job(), {
      exec: scripted({ "git status": { stdout: " M a\n" }, "git log": { stdout: "" }, "git add": { exitCode: 1, stderr: "add failed" } }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(add.detail).toContain("add failed");

    const commit = await repairOne(job(), {
      exec: scripted({ "git status": { stdout: " M a\n" }, "git log": { stdout: "" }, "git add": { exitCode: 0 }, commit: { exitCode: 1, stderr: "" } }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(commit.detail).toBe("git commit failed");

    const rebase = await repairOne(job(), {
      exec: scripted({
        "git status": { stdout: " M a\n" },
        "git log": { stdout: "" },
        "git add": { exitCode: 0 },
        commit: { exitCode: 0 },
        "git rebase": { exitCode: 1, stderr: "conflict on src/app.tsx" },
      }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(rebase.detail).toContain("conflict on src/app.tsx");

    const push = await repairOne(job(), {
      exec: scripted({
        "git status": { stdout: " M a\n" },
        "git log": { stdout: "" },
        "git add": { exitCode: 0 },
        commit: { exitCode: 0 },
        "git push": { exitCode: 1, error: "push denied" },
      }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(push.detail).toContain("push denied");

    const pr = await repairOne(job(), {
      exec: scripted({
        "git status": { stdout: " M a\n" },
        "git log": { stdout: "" },
        "git add": { exitCode: 0 },
        commit: { exitCode: 0 },
        "git push": { exitCode: 0 },
        "pr create": { exitCode: 1, stderr: "" },
      }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(pr.detail).toBe("gh pr create failed");

    const noUrl = await repairOne(job(), {
      exec: scripted({
        "git status": { stdout: " M a\n" },
        "git log": { stdout: "" },
        "git add": { exitCode: 0 },
        commit: { exitCode: 0 },
        "git push": { exitCode: 0 },
        "pr create": { stdout: "opened" },
      }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(noUrl.detail).toContain("no pull request URL");
  });

  it("removes a leftover workdir so a second attempt is a fresh clone", async () => {
    const files = new Set<string>(["/tmp/geoqa-repair/xalatechnologies/xala-web-cloner-48"]);
    const exec: RepairExec = {
      mkdir: () => undefined,
      exists: (p) => files.has(p),
      rm: (p) => {
        files.delete(p);
      },
      run: async (input) => {
        if (input.argv.includes("clone")) return { stdout: "", stderr: "nope", exitCode: 1 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const out = await repairOne(job(), {
      exec,
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(out.status).toBe("failed");
    expect(files.has("/tmp/geoqa-repair/xalatechnologies/xala-web-cloner-48")).toBe(false);
  });

  it("uses the clone / checkout / add / create fallbacks when stderr is empty", async () => {
    const clone = await repairOne(job(), {
      exec: scripted({ "repo clone": { exitCode: 1 } }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(clone.detail).toContain("gh repo clone exited");

    const fetch = await repairOne(job(), {
      exec: scripted({ "git fetch": { exitCode: 1 } }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(fetch.detail).toBe("git fetch failed");

    const checkout = await repairOne(job(), {
      exec: scripted({ "git checkout": { exitCode: 1 } }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(checkout.detail).toBe("git checkout failed");

    const add = await repairOne(job(), {
      exec: scripted({ "git status": { stdout: " M a\n" }, "git log": { stdout: "" }, "git add": { exitCode: 1 } }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(add.detail).toBe("git add failed");

    let fetches = 0;
    const fetchLater = scripted({
      "git status": { stdout: " M a\n" },
      "git log": { stdout: "" },
      "git add": { exitCode: 0 },
      commit: { exitCode: 0 },
    });
    const fetchRun = fetchLater.run.bind(fetchLater);
    fetchLater.run = async (input) => {
      if (input.argv.includes("fetch")) {
        fetches += 1;
        if (fetches === 2) return { stdout: "", stderr: "", exitCode: 1 };
      }
      return fetchRun(input);
    };
    const lateFetch = await repairOne(job(), {
      exec: fetchLater,
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(lateFetch.detail).toBe("git fetch failed");

    const rebase = await repairOne(job(), {
      exec: scripted({
        "git status": { stdout: " M a\n" },
        "git log": { stdout: "" },
        "git add": { exitCode: 0 },
        commit: { exitCode: 0 },
        "git rebase": { exitCode: 1 },
      }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(rebase.detail).toBe("git rebase failed");

    const push = await repairOne(job(), {
      exec: scripted({
        "git status": { stdout: " M a\n" },
        "git log": { stdout: "" },
        "git add": { exitCode: 0 },
        commit: { exitCode: 0 },
        "git push": { exitCode: 1 },
      }),
      claude: async () => ({ ok: true, text: "x" }),
      workRoot,
      token,
      env,
    });
    expect(push.detail).toBe("git push failed");
  });
});
