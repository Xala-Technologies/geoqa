import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_STALL_MS, type WatchFinding } from "../health.js";
import {
  KEEP_WATCH_LOG,
  appendWatchEvent,
  eventFromFinding,
  nodeWatchLogFs,
  parseWatchEvent,
  readWatchLog,
  recentWatchEvents,
  watchLogPath,
  type WatchLogEvent,
  type WatchLogFs,
} from "../log.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

const event = (over: Partial<WatchLogEvent> = {}): WatchLogEvent => ({
  at: "2026-08-18T21:00:00.000Z",
  level: "info",
  kind: "sweep-started",
  message: "starting sweep",
  ...over,
});

const memory = (initial: Record<string, string> = {}): WatchLogFs & { files: Record<string, string> } => {
  const files = { ...initial };
  return {
    files,
    exists: (p) => p in files,
    read: (p) => {
      if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[p] ?? "";
    },
    append: (p, text) => {
      files[p] = `${files[p] ?? ""}${text}`;
    },
    write: (p, text) => {
      files[p] = text;
    },
    mkdir: () => undefined,
  };
};

describe("parseWatchEvent", () => {
  it("reads a complete event and refuses an unknown key or kind", () => {
    expect(parseWatchEvent(JSON.stringify(event()))).toEqual(event());
    expect(parseWatchEvent(JSON.stringify({ ...event(), extra: true }))).toBeNull();
    expect(parseWatchEvent(JSON.stringify({ ...event(), kind: "nope" }))).toBeNull();
    expect(parseWatchEvent("{")).toBeNull();
    expect(parseWatchEvent("")).toBeNull();
  });
});

describe("readWatchLog / appendWatchEvent", () => {
  it("a missing file is an empty log, not an error — a first boot has never swept", () => {
    expect(readWatchLog("/tmp/evidence", memory())).toEqual({ events: [], skipped: 0 });
  });

  it("appends a line with a trailing newline and never throws when the disk refuses", () => {
    const fs = memory();
    expect(appendWatchEvent("/tmp/evidence", event(), fs)).toBeNull();
    expect(fs.files[watchLogPath("/tmp/evidence")]).toBe(`${JSON.stringify(event())}\n`);
    const broken: WatchLogFs = {
      exists: () => false,
      read: () => "",
      append: () => {
        throw new Error("disk full");
      },
      write: () => undefined,
      mkdir: () => undefined,
    };
    expect(appendWatchEvent("/tmp/evidence", event(), broken)).toContain("disk full");
  });

  it("skips an unreadable line rather than dropping the rest of the log", () => {
    const file = watchLogPath("/tmp/evidence");
    const fs = memory({
      [file]: `${JSON.stringify(event({ message: "ok" }))}\n{\n${JSON.stringify(event({ message: "after" }))}\n`,
    });
    const read = readWatchLog("/tmp/evidence", fs);
    expect(read.skipped).toBe(1);
    expect(read.events.map((e) => e.message)).toEqual(["ok", "after"]);
  });

  it("keeps only the newest KEEP lines so a hung watch cannot grow the file forever", () => {
    const fs = memory();
    for (let i = 0; i < KEEP_WATCH_LOG + 5; i++) {
      expect(appendWatchEvent("/tmp/evidence", event({ message: `n${i}` }), fs)).toBeNull();
    }
    const read = readWatchLog("/tmp/evidence", fs);
    expect(read.events).toHaveLength(KEEP_WATCH_LOG);
    expect(read.events[0]?.message).toBe("n5");
    expect(read.events[KEEP_WATCH_LOG - 1]?.message).toBe(`n${KEEP_WATCH_LOG + 4}`);
  });

  it("an unreadable existing file is an empty log, not a throw", () => {
    const file = watchLogPath("/tmp/evidence");
    const fs: WatchLogFs = {
      exists: (p) => p === file,
      read: () => {
        throw new Error("EIO");
      },
      append: () => undefined,
      write: () => undefined,
      mkdir: () => undefined,
    };
    expect(readWatchLog("/tmp/evidence", fs)).toEqual({ events: [], skipped: 0 });
  });

  it("reports a trim that could not rewrite, rather than throwing", () => {
    const fs = memory();
    for (let i = 0; i < KEEP_WATCH_LOG; i++) {
      appendWatchEvent("/tmp/evidence", event({ message: `n${i}` }), fs);
    }
    const failing: WatchLogFs = {
      ...fs,
      write: () => {
        throw new Error("EPERM");
      },
    };
    expect(appendWatchEvent("/tmp/evidence", event({ message: "overflow" }), failing)).toContain("EPERM");
  });

  it("round-trips through disk so a restart still has the stall", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "geoqa-watch-log-"));
    temps.push(dir);
    expect(appendWatchEvent(dir, event({ kind: "session-stalled", level: "error", message: "hung" }))).toBeNull();
    nodeWatchLogFs.write(watchLogPath(dir), `${JSON.stringify(event({ message: "rewritten" }))}\n`);
    expect(existsSync(watchLogPath(dir))).toBe(true);
    expect(readFileSync(watchLogPath(dir), "utf8")).toContain("rewritten");
    const read = readWatchLog(dir);
    expect(read.events.map((e) => e.message)).toEqual(["rewritten"]);
  });
});

describe("recentWatchEvents", () => {
  it("returns newest first and never more than the limit", () => {
    const events = [event({ message: "old" }), event({ message: "mid" }), event({ message: "new" })];
    expect(recentWatchEvents(events, 2).map((e) => e.message)).toEqual(["new", "mid"]);
    expect(recentWatchEvents([])).toEqual([]);
  });
});

describe("eventFromFinding", () => {
  it("turns a stall into an error event keyed the same way the health report is", () => {
    const finding: WatchFinding = {
      kind: "session-stalled",
      severity: "high",
      message: "oslo has had no progress for 90s",
      sinceMs: SESSION_STALL_MS,
      sessionId: "run_1",
    };
    expect(eventFromFinding(finding, "2026-08-18T21:02:00.000Z")).toEqual({
      at: "2026-08-18T21:02:00.000Z",
      level: "error",
      kind: "session-stalled",
      message: finding.message,
      sessionId: "run_1",
    });
    expect(
      eventFromFinding(
        { kind: "sweep-hung", severity: "high", message: "nothing appeared", sinceMs: SESSION_STALL_MS },
        "2026-08-18T21:02:00.000Z",
      ).sessionId,
    ).toBeUndefined();
  });
});
