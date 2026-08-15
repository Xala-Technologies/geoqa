import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyClock, loadWatchClock, parseWatchClock, saveWatchClock, watchClockPath } from "../clock.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

describe("parseWatchClock", () => {
  it("reads both timestamps, and treats a missing file shape as empty rather than zero", () => {
    const parsed = parseWatchClock({ lastStartedMs: 10, lastFinishedMs: 20 });
    if (!parsed.ok) throw new Error(parsed.errors.join());
    expect(parsed.value).toEqual({ lastStartedMs: 10, lastFinishedMs: 20, cursor: 0 });
    const empty = parseWatchClock({ lastStartedMs: null, lastFinishedMs: null });
    if (!empty.ok) throw new Error(empty.errors.join());
    expect(empty.value).toEqual(emptyClock());
  });

  it("REFUSES an unknown key and a negative timestamp — zero is a real instant, a typo is not", () => {
    expect(parseWatchClock({ lastStartedMs: 1, lastFinishedMs: 2, extra: true }).ok).toBe(false);
    expect(parseWatchClock({ lastStartedMs: -1, lastFinishedMs: null }).ok).toBe(false);
  });
});

describe("loadWatchClock / saveWatchClock", () => {
  it("a missing file is an empty clock, not an error — a first boot has never swept", () => {
    const loaded = loadWatchClock("/no/such/clock.json", () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });
    if (!loaded.ok) throw new Error(loaded.errors.join());
    expect(loaded.value).toEqual(emptyClock());
  });

  it("round-trips through disk so a restarted server does not look like a first sweep", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "geoqa-clock-"));
    temps.push(dir);
    const file = watchClockPath(dir);
    saveWatchClock(file, { lastStartedMs: 1_700_000_000_000, lastFinishedMs: 1_700_000_060_000, cursor: 4 });
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("1700000000000");
    const loaded = loadWatchClock(file);
    if (!loaded.ok) throw new Error(loaded.errors.join());
    expect(loaded.value.lastStartedMs).toBe(1_700_000_000_000);
    expect(loaded.value.cursor).toBe(4);
  });

  it("reports a file that is not a clock, rather than treating garbage as never-ran", () => {
    const loaded = loadWatchClock("c.json", () => "{");
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("expected failure");
    expect(loaded.errors[0]).toContain("c.json");
  });

  it("prefixes schema errors with the path, so a bad clock is findable", () => {
    const loaded = loadWatchClock("c.json", () => JSON.stringify({ lastStartedMs: 1, lastFinishedMs: 2, extra: true }));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("expected failure");
    expect(loaded.errors[0]).toContain("c.json");
  });

  it("reports a read that failed for a reason other than absence — that is not a first boot", () => {
    const loaded = loadWatchClock("c.json", () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("expected failure");
    expect(loaded.errors[0]).toContain("c.json");
    expect(loaded.errors[0]).toContain("EACCES");
  });
});
