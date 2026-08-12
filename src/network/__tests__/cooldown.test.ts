import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  coolingDown,
  loadCooldowns,
  pruneCooldowns,
  recordCooldown,
  saveCooldowns,
  withCooldown,
  withoutCooldown,
} from "../cooldown.js";

let dir: string;
let store: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "geoqa-cooldown-"));
  store = path.join(dir, "nested", "cooldowns.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pure operations", () => {
  it("reports a live cooldown and ignores an elapsed or absent one", () => {
    expect(coolingDown({ a: 200 }, "a", 100)).toBe(true);
    expect(coolingDown({ a: 100 }, "a", 200)).toBe(false);
    expect(coolingDown({}, "a", 100)).toBe(false);
    expect(coolingDown({ a: "soon" } as unknown as Record<string, number>, "a", 1)).toBe(false);
  });

  it("adds and clears without mutating the input", () => {
    const base = { a: 1 };
    expect(withCooldown(base, "b", 2)).toEqual({ a: 1, b: 2 });
    expect(base).toEqual({ a: 1 });
    expect(withoutCooldown({ a: 1, b: 2 }, "b")).toEqual({ a: 1 });
  });

  it("returns the same object when clearing a key that is not there", () => {
    const base = { a: 1 };
    expect(withoutCooldown(base, "b")).toBe(base);
  });

  it("prunes elapsed entries so the store cannot grow without bound", () => {
    expect(pruneCooldowns({ old: 50, live: 500 }, 100)).toEqual({ live: 500 });
  });
});

describe("persistence", () => {
  it("round-trips through disk, creating parent directories", () => {
    saveCooldowns(store, { vendor: 1234 });
    expect(loadCooldowns(store)).toEqual({ vendor: 1234 });
  });

  it("treats a missing file as an empty map", () => {
    expect(loadCooldowns(path.join(dir, "nope.json"))).toEqual({});
  });

  it("treats corrupt JSON as an empty map — a broken store never silences a caller", () => {
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "{{{not json");
    expect(loadCooldowns(bad)).toEqual({});
  });

  it("treats a non-object document as an empty map", () => {
    const arr = path.join(dir, "arr.json");
    writeFileSync(arr, "[1,2]");
    expect(loadCooldowns(arr)).toEqual({});
    const nul = path.join(dir, "null.json");
    writeFileSync(nul, "null");
    expect(loadCooldowns(nul)).toEqual({});
  });

  it("drops non-numeric and non-finite values rather than trusting them", () => {
    const mixed = path.join(dir, "mixed.json");
    writeFileSync(mixed, JSON.stringify({ good: 5, bad: "later", worse: null }));
    expect(loadCooldowns(mixed)).toEqual({ good: 5 });
  });

  it("swallows a write failure — a cooldown is an optimisation, not correctness", () => {
    // A directory where the file should be makes the write fail.
    const asDir = path.join(dir, "adir");
    saveCooldowns(path.join(asDir, "x.json"), { a: 1 });
    expect(() => saveCooldowns(asDir, { a: 1 })).not.toThrow();
  });
});

describe("recordCooldown", () => {
  it("cools a key down and prunes elapsed ones in the same pass", () => {
    saveCooldowns(store, { stale: 10 });
    expect(recordCooldown(store, "vendor", 5_000, 1_000)).toEqual({ vendor: 5_000 });
  });

  it("CLEARS on success — the rule that stops a recovered vendor staying frozen", () => {
    saveCooldowns(store, { vendor: 9_999 });
    expect(recordCooldown(store, "vendor", null, 1_000)).toEqual({});
    expect(loadCooldowns(store)).toEqual({});
  });
});
