import { describe, expect, it } from "vitest";
import { elementAt } from "../collections.js";

describe("elementAt", () => {
  it("returns the element at an in-range index", () => {
    expect(elementAt(["a", "b", "c"], 1)).toBe("b");
  });

  it("THROWS on an out-of-range index rather than returning a default", () => {
    // The whole point. A default here would be indistinguishable from a real value, and the
    // caller that computed the index would keep running on it.
    expect(() => elementAt(["a"], 3)).toThrow(/out of range for 1 item/);
  });

  it("throws on an empty array, naming the length so the bug is visible", () => {
    expect(() => elementAt([], 0)).toThrow(/0 item/);
  });

  it("still throws for an element that is legitimately undefined", () => {
    // A known limitation, stated rather than discovered: this cannot tell "index out of
    // range" from "the array holds undefined there". It is used on arrays of strings and
    // objects, where the second case does not arise — and a false alarm is the safe
    // direction for a function whose job is to catch a broken bounds check.
    expect(() => elementAt([undefined], 0)).toThrow();
  });
});
