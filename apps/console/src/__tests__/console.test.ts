import { describe, expect, it, vi } from "vitest";
import { PASSWORD_ENV, SECRET_ENV } from "@geoqa/engine/server/auth.js";
import {
  DEV_API_PORT,
  mergeEnv,
  parseDotenv,
  planDev,
  startDev,
  type DevChild,
  type DevSpawn,
} from "../console.js";

describe("parseDotenv", () => {
  it("reads KEY=value, skips comments and blanks, and accepts export", () => {
    const parsed = parseDotenv(`
# a comment
not-a-binding
=no-key
${PASSWORD_ENV}=hash-from-file
export ${SECRET_ENV}=secret-from-file-that-is-long-enough
EMPTY=
QUOTED="hello there"
`);
    expect(parsed[PASSWORD_ENV]).toBe("hash-from-file");
    expect(parsed[SECRET_ENV]).toBe("secret-from-file-that-is-long-enough");
    expect(parsed.EMPTY).toBe("");
    expect(parsed.QUOTED).toBe("hello there");
    expect(parseDotenv(`SINGLE='also fine'`).SINGLE).toBe("also fine");
  });
});

describe("mergeEnv", () => {
  it("lets an already-set variable win, so a shell export is not overwritten", () => {
    const merged = mergeEnv(
      { [PASSWORD_ENV]: "from-shell", PATH: "/bin" },
      { [PASSWORD_ENV]: "from-file", [SECRET_ENV]: "from-file-secret-that-is-long-enough" },
    );
    expect(merged[PASSWORD_ENV]).toBe("from-shell");
    expect(merged[SECRET_ENV]).toBe("from-file-secret-that-is-long-enough");
    expect(merged.PATH).toBe("/bin");
  });
});

describe("planDev", () => {
  it("starts the API and the Vite UI, not one or the other", () => {
    const plan = planDev("/repo");
    expect(plan.children.map((c) => c.name)).toEqual(["api", "ui"]);
    expect(plan.children[0]?.args).toContain(String(DEV_API_PORT));
    expect(plan.children[1]?.args).toContain("geoqa-ui");
    expect(plan.urls.ui).toContain("5173");
    expect(plan.urls.api).toContain("4180");
  });
});

describe("startDev", () => {
  const auth = {
    [PASSWORD_ENV]: "hash",
    [SECRET_ENV]: "s".repeat(32),
  };

  const child = (): DevChild & { killed: string[]; fire: (code: number | null) => void } => {
    const exit: Array<(code: number | null) => void> = [];
    const killed: string[] = [];
    return {
      killed,
      onExit: (fn) => {
        exit.push(fn);
      },
      kill: (signal) => {
        killed.push(signal ?? "SIGTERM");
      },
      fire: (code) => {
        for (const fn of exit) fn(code);
      },
    };
  };

  it("refuses to start when auth env is missing, and does not spawn", async () => {
    const spawn = vi.fn<DevSpawn>();
    const out = startDev({
      repoRoot: "/repo",
      env: {},
      exists: () => false,
      read: () => "",
      spawn,
      log: () => {},
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain(PASSWORD_ENV);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("loads .env when present, then spawns both children", () => {
    const kids = [child(), child()];
    let i = 0;
    const spawn: DevSpawn = () => kids[i++] as DevChild;
    const out = startDev({
      repoRoot: "/repo",
      env: {},
      exists: (p) => p.endsWith(".env"),
      read: () => `${PASSWORD_ENV}=hash\n${SECRET_ENV}=${"s".repeat(32)}\n`,
      spawn,
      log: () => {},
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(kids[0]?.killed).toEqual([]);
    out.stop();
    out.stop();
    expect(kids[0]?.killed.length).toBe(1);
    expect(kids[1]?.killed.length).toBe(1);
    kids[0]?.fire(0);
  });

  it("kills the other child when one exits", () => {
    const kids = [child(), child()];
    let i = 0;
    const out = startDev({
      repoRoot: "/repo",
      env: auth,
      exists: () => false,
      read: () => "",
      spawn: () => kids[i++] as DevChild,
      log: () => {},
    });
    expect(out.ok).toBe(true);
    kids[0]?.fire(1);
    expect(kids[1]?.killed.length).toBe(1);
  });
});
