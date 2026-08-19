import { describe, expect, it } from "vitest";
import { navSections, viewMeta } from "./nav.ts";

describe("navSections", () => {
  it("puts every view in one sidebar, grouped, and omits a zero count", () => {
    const sections = navSections("findings", { findings: 4, live: 0, coverage: 2 }, { findings: true });
    expect(sections.map((s) => s.id)).toEqual(["operate", "compare", "setup"]);
    expect(sections.flatMap((s) => s.links.map((l) => l.id))).toEqual([
      "overview",
      "live",
      "runs",
      "findings",
      "geography",
      "coverage",
      "trends",
      "watch",
      "settings",
    ]);
    const findings = sections[0]?.links.find((l) => l.id === "findings");
    expect(findings?.current).toBe(true);
    expect(findings?.count).toBe(4);
    expect(findings?.alert).toBe(true);
    expect(sections[0]?.links.find((l) => l.id === "live")?.count).toBeUndefined();
    expect(sections[1]?.links.find((l) => l.id === "coverage")?.count).toBe(2);
    expect(viewMeta("geography")?.purpose).toContain("cities");
    expect(viewMeta("nope")).toBeUndefined();
  });
});
