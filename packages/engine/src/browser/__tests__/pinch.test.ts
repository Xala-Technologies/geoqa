import { describe, expect, it } from "vitest";
import { pinchExpression } from "../pinch.js";

describe("pinchExpression", () => {
  it("zooms in with a negative wheel delta and out with a positive one", () => {
    expect(pinchExpression(".map", "in")).toContain("-120");
    expect(pinchExpression(".map", "out")).toContain("120");
    expect(pinchExpression(".map", "out")).not.toContain("-120");
  });

  it("quotes the selector so a crafted value cannot break out of the expression", () => {
    const expr = pinchExpression(`".map", 0); throw "x`, "in");
    expect(expr).toContain(JSON.stringify(`".map", 0); throw "x`));
  });
});
