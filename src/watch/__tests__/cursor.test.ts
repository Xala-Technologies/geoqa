import { describe, expect, it } from "vitest";
import { nextSlice } from "../cursor.js";

describe("nextSlice", () => {
  it("takes the next N items and wraps, so a cursor covers the matrix instead of launching it all", () => {
    const items = ["a", "b", "c", "d"];
    const first = nextSlice(items, 0, 2);
    expect(first.slice).toEqual(["a", "b"]);
    expect(first.nextCursor).toBe(2);
    const second = nextSlice(items, first.nextCursor, 2);
    expect(second.slice).toEqual(["c", "d"]);
    expect(second.nextCursor).toBe(0);
    const wrap = nextSlice(items, 3, 2);
    expect(wrap.slice).toEqual(["d", "a"]);
    expect(wrap.nextCursor).toBe(1);
  });

  it("never returns more items than exist — two slots on a one-scenario matrix is one run, not two of the same", () => {
    expect(nextSlice(["only"], 0, 4)).toEqual({ slice: ["only"], nextCursor: 0 });
  });

  it("an empty matrix is an empty slice, not a fabricated first item", () => {
    expect(nextSlice([], 7, 2)).toEqual({ slice: [], nextCursor: 0 });
  });

  it("a negative or oversized cursor still lands on a real index", () => {
    expect(nextSlice(["a", "b", "c"], -1, 1).slice).toEqual(["c"]);
    expect(nextSlice(["a", "b", "c"], 8, 1).slice).toEqual(["c"]);
  });

  it("a zero take is an empty slice that does not advance", () => {
    expect(nextSlice(["a", "b"], 1, 0)).toEqual({ slice: [], nextCursor: 1 });
  });
});
