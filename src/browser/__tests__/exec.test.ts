import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  EXEC_FAILED_MARKER,
  describeExecFailure,
  execAgentBrowser,
  parseEnvelope,
  type ExecFailure,
  type SpawnFn,
} from "../exec.js";

/**
 * A fake child process. Mirrors the shape agent-fleet's claude-agent tests use:
 * hand-rolled emitters, no real binary, so the watchdogs and the parser are
 * exercised deterministically.
 */
interface FakeOpts {
  stdout?: string[];
  stderr?: string[];
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  /** Emit nothing and never close — lets a watchdog fire. */
  hang?: boolean;
}

function makeSpawn(opts: FakeOpts): { spawnFn: SpawnFn; killed: string[] } {
  const killed: string[] = [];
  const spawnFn = ((_bin: string, _args: string[], _o: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (sig: string) => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (sig: string): void => {
      killed.push(sig);
      // A real SIGKILL is followed by `close`; the fake must do the same or the
      // watchdog path would never settle.
      setImmediate(() => child.emit("close", null, "SIGKILL"));
    };
    setImmediate(() => {
      if (opts.error) {
        child.emit("error", opts.error);
        return;
      }
      for (const chunk of opts.stdout ?? []) child.stdout.emit("data", Buffer.from(chunk));
      for (const chunk of opts.stderr ?? []) child.stderr.emit("data", chunk);
      if (!opts.hang) child.emit("close", opts.code ?? 0, opts.signal ?? null);
    });
    return child;
  }) as unknown as SpawnFn;
  return { spawnFn, killed };
}

const run = (opts: FakeOpts, extra: Partial<Parameters<typeof execAgentBrowser>[0]> = {}) =>
  execAgentBrowser({
    args: ["open", "https://example.com", "--json"],
    bin: "/fake/agent-browser",
    env: { PATH: "/usr/bin" },
    spawnFn: makeSpawn(opts).spawnFn,
    ...extra,
  });

describe("parseEnvelope", () => {
  it("reads a well-formed envelope", () => {
    expect(parseEnvelope('{"success":true,"data":{"url":"u"},"error":null}')).toEqual({
      success: true,
      data: { url: "u" },
      error: null,
    });
  });

  it("takes the LAST envelope when daemon chatter precedes it", () => {
    const raw = ['{"success":true,"data":{"n":1},"error":null}', '{"success":true,"data":{"n":2},"error":null}'].join(
      "\n",
    );
    expect(parseEnvelope(raw)).toMatchObject({ data: { n: 2 } });
  });

  it("skips non-JSON lines, unparseable JSON, non-objects, and objects without `success`", () => {
    const raw = ["Installing Chrome...", "{not json", "{}", '{"success":"yes"}', "[1,2]"].join("\n");
    expect(parseEnvelope(raw)).toBeNull();
  });

  it("normalises a missing data field to null and a non-string error to null", () => {
    expect(parseEnvelope('{"success":false,"error":{"x":1}}')).toEqual({
      success: false,
      data: null,
      error: null,
    });
  });

  it("returns null for empty stdout — never an empty success", () => {
    expect(parseEnvelope("")).toBeNull();
  });
});

describe("describeExecFailure", () => {
  const base: ExecFailure = { kind: "idle", detail: "stalled", exitCode: null, signal: null };

  it("always carries the marker so a failure cannot read as output", () => {
    expect(describeExecFailure(base)).toBe(`${EXEC_FAILED_MARKER}[idle] · stalled`);
  });

  it("appends exit code and signal when present", () => {
    expect(describeExecFailure({ ...base, kind: "exit", exitCode: 2, signal: "SIGKILL" })).toBe(
      `${EXEC_FAILED_MARKER}[exit] · stalled · exit=2 · signal=SIGKILL`,
    );
  });
});

describe("execAgentBrowser", () => {
  it("returns typed data on a successful envelope", async () => {
    const out = await run({ stdout: ['{"success":true,"data":{"title":"Example"},"error":null}'] });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.data).toEqual({ title: "Example" });
    expect(out.command).toBe("/fake/agent-browser open https://example.com --json");
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a spawn error as kind=spawn", async () => {
    const out = await run({ error: new Error("spawn ENOENT") });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.failure).toMatchObject({ kind: "spawn", detail: "spawn ENOENT" });
  });

  it("reports a non-zero exit with no envelope as kind=exit, preferring stderr", async () => {
    const out = await run({ stderr: ["boom\n"], code: 3 });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.failure).toMatchObject({ kind: "exit", detail: "boom", exitCode: 3 });
  });

  it("falls back to a generic detail when a non-zero exit produced no stderr", async () => {
    const out = await run({ code: 1 });
    if (out.ok) throw new Error("expected failure");
    expect(out.failure.detail).toBe("non-zero exit with no JSON envelope");
  });

  it("reports a clean exit with unusable stdout as kind=unparseable", async () => {
    const out = await run({ stdout: ["not json at all\n"], code: 0 });
    if (out.ok) throw new Error("expected failure");
    expect(out.failure.kind).toBe("unparseable");
  });

  it("reports success:false as kind=reported and surfaces the error text", async () => {
    const out = await run({ stdout: ['{"success":false,"data":null,"error":"tab_gone"}'] });
    if (out.ok) throw new Error("expected failure");
    expect(out.failure).toMatchObject({ kind: "reported", detail: "tab_gone" });
  });

  it("substitutes a detail when success:false carries no error text", async () => {
    const out = await run({ stdout: ['{"success":false,"data":null,"error":null}'] });
    if (out.ok) throw new Error("expected failure");
    expect(out.failure.detail).toContain("no error");
  });

  it("kills and reports kind=idle when no output arrives", async () => {
    vi.useFakeTimers();
    try {
      const p = run({ hang: true }, { idleMs: 1_000, timeoutMs: 0 });
      await vi.advanceTimersByTimeAsync(1_100);
      const out = await p;
      if (out.ok) throw new Error("expected failure");
      expect(out.failure).toMatchObject({ kind: "idle", signal: "SIGKILL" });
      expect(out.failure.detail).toContain("1000ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills and reports kind=timeout at the absolute cap even while output flows", async () => {
    vi.useFakeTimers();
    try {
      const p = run({ stdout: ["chatter\n"], hang: true }, { idleMs: 0, timeoutMs: 2_000 });
      await vi.advanceTimersByTimeAsync(2_100);
      const out = await p;
      if (out.ok) throw new Error("expected failure");
      expect(out.failure.kind).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the idle watchdog on every chunk, so a slow-but-alive command survives", async () => {
    vi.useFakeTimers();
    const { spawnFn } = makeSpawn({ hang: true });
    let child: EventEmitter & { stdout: EventEmitter } = null as never;
    const capturing = ((bin: string, args: string[], o: unknown) => {
      child = (spawnFn as unknown as (...a: unknown[]) => never)(bin, args, o);
      return child;
    }) as unknown as SpawnFn;
    try {
      const p = execAgentBrowser({
        args: ["read"],
        bin: "/fake/agent-browser",
        env: {},
        spawnFn: capturing,
        idleMs: 1_000,
        timeoutMs: 0,
      });
      await vi.advanceTimersByTimeAsync(800);
      child.stdout.emit("data", "still working\n");
      await vi.advanceTimersByTimeAsync(800);
      child.emit("close", 0, null); // would already be dead if the reset failed
      const out = await p;
      if (out.ok) throw new Error("expected failure");
      expect(out.failure.kind).toBe("unparseable"); // reached close, not killed
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults bin, env, cwd, timers and clock when only args are given", async () => {
    const { spawnFn } = makeSpawn({ stdout: ['{"success":true,"data":1,"error":null}'] });
    const out = await execAgentBrowser({ args: ["--version"], spawnFn });
    expect(out.ok).toBe(true);
  });

  it("ignores a second settle attempt", async () => {
    // A process that emits `error` and then `close` must resolve once.
    const spawnFn = ((_b: string, _a: string[], _o: unknown) => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (): void => {};
      setImmediate(() => {
        child.emit("error", new Error("first"));
        child.emit("close", 1, null);
      });
      return child;
    }) as unknown as SpawnFn;
    const out = await execAgentBrowser({ args: ["x"], bin: "/fake/ab", env: {}, spawnFn });
    if (out.ok) throw new Error("expected failure");
    expect(out.failure.kind).toBe("spawn");
  });
});
