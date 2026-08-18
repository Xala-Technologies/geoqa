import { describe, expect, it } from "vitest";
import { bindAssistComplete, envForMaxSubscription, runClaudePrint, type ClaudeSpawn } from "../claude.js";

const spawnOf = (reply: { stdout?: string; stderr?: string; exitCode?: number; error?: NodeJS.ErrnoException }): ClaudeSpawn =>
  async () => ({
    stdout: reply.stdout ?? "",
    stderr: reply.stderr ?? "",
    exitCode: reply.exitCode ?? 0,
    ...(reply.error ? { error: reply.error } : {}),
  });

describe("envForMaxSubscription", () => {
  it("strips API keys so claude -p bills the Max login, not the API", () => {
    const env = envForMaxSubscription({
      ANTHROPIC_API_KEY: "sk-ant-secret",
      ANTHROPIC_AUTH_TOKEN: "tok",
      PATH: "/usr/bin",
      HOME: "/Users/me",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/me");
  });
});

describe("runClaudePrint", () => {
  it("calls claude -p with the prompt on stdin, not on argv", async () => {
    // argv would show the brief in ps and in every ExecMeta.command. stdin is
    // the same prompt and does not leak the package into the process list.
    const seen: { args: string[]; stdin: string }[] = [];
    const out = await runClaudePrint("BRIEF\nFAIL: browse", {
      env: { PATH: "/bin" },
      spawn: async (args, opts) => {
        seen.push({ args, stdin: opts.stdin });
        return { stdout: "Title: listing 500s\n", stderr: "", exitCode: 0 };
      },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.text).toBe("Title: listing 500s");
    expect(seen[0]?.args).toEqual(["-p", "--output-format", "text"]);
    expect(seen[0]?.stdin).toContain("FAIL: browse");
    expect(seen[0]?.args.join(" ")).not.toContain("FAIL");
  });

  it("repairs in the checkout: extra flags and cwd reach the child, the prompt does not", async () => {
    let cwd = "";
    let args: string[] = [];
    await runClaudePrint("ISSUE\nsearch box", {
      env: {},
      extraArgs: ["--dangerously-skip-permissions"],
      cwd: "/tmp/repair/site",
      spawn: async (passed, opts) => {
        args = passed;
        cwd = opts.cwd ?? "";
        return { stdout: "fixed", stderr: "", exitCode: 0 };
      },
    });
    expect(args).toEqual(["-p", "--output-format", "text", "--dangerously-skip-permissions"]);
    expect(cwd).toBe("/tmp/repair/site");
    expect(args.join(" ")).not.toContain("search box");
  });

  it("hands the child an env with API keys removed", async () => {
    let childEnv: NodeJS.ProcessEnv = {};
    await runClaudePrint("x", {
      env: { ANTHROPIC_API_KEY: "sk-ant-secret", PATH: "/bin" },
      spawn: async (_args, opts) => {
        childEnv = opts.env;
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    });
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv.PATH).toBe("/bin");
  });

  it("refuses empty or whitespace stdout rather than returning a blank draft", async () => {
    const empty = await runClaudePrint("x", { env: {}, spawn: spawnOf({ stdout: "   \n" }) });
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error("expected failure");
    expect(empty.failure.kind).toBe("empty");
  });

  it("honours GEOQA_CLAUDE_BIN so a non-default install is reachable", async () => {
    let bin = "";
    await runClaudePrint("x", {
      env: { GEOQA_CLAUDE_BIN: "/opt/claude" },
      spawn: async (_args, opts) => {
        bin = opts.bin;
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    });
    expect(bin).toBe("/opt/claude");
  });

  it("names a hang as timeout", async () => {
    const out = await runClaudePrint("x", {
      env: {},
      spawn: spawnOf({ error: Object.assign(new Error("claude -p timed out"), { code: "ETIMEDOUT" }) }),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.kind).toBe("timeout");
  });

  it("names a missing binary as spawn, and a non-zero exit as exit", async () => {
    const missing = await runClaudePrint("x", {
      env: {},
      spawn: spawnOf({ error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) }),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure.kind).toBe("spawn");

    const exited = await runClaudePrint("x", { env: {}, spawn: spawnOf({ stdout: "nope", exitCode: 1 }) });
    expect(exited.ok).toBe(false);
    if (!exited.ok) expect(exited.failure.kind).toBe("exit");

    const other = await runClaudePrint("x", {
      env: {},
      spawn: spawnOf({ error: Object.assign(new Error("EACCES"), { code: "EACCES" }) }),
    });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.failure.detail).toContain("EACCES");
  });
});

describe("bindAssistComplete", () => {
  it("closes over env and spawn so defaultDeps does not inline a second copy", async () => {
    const fn = bindAssistComplete({ PATH: "/bin" }, async () => ({ stdout: "hi", stderr: "", exitCode: 0 }));
    const out = await fn("brief");
    expect(out).toEqual({ ok: true, text: "hi" });
  });
});
