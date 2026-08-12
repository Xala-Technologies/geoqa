import { describe, expect, it } from "vitest";
import { DEFECTS, fixtureBody, startFixtureServer } from "../server.js";

describe("DEFECTS", () => {
  it("includes a healthy CONTROL, so an engine that flags everything cannot score 100%", () => {
    const control = DEFECTS.find((d) => d.path === "/healthy");
    expect(control).toBeDefined();
    expect(control?.expects).toBe("unknown");
  });

  it("gives every defect a distinct path and names the check that should catch it", () => {
    expect(new Set(DEFECTS.map((d) => d.path)).size).toBe(DEFECTS.length);
    for (const defect of DEFECTS) expect(defect.caughtBy.length).toBeGreaterThan(0);
  });
});

describe("fixtureBody", () => {
  it("serves a 204 for favicon.ico", () => {
    // Chrome requests it unprompted; a 404 here puts a spurious http finding on
    // every fixture including the control. That is how the first EXP-006 run
    // reported the healthy page as defective.
    expect(fixtureBody("/favicon.ico")).toEqual({ status: 204, html: "" });
  });

  it("returns the intended status for each status fixture", () => {
    expect(fixtureBody("/healthy")?.status).toBe(200);
    expect(fixtureBody("/status-404")?.status).toBe(404);
    expect(fixtureBody("/status-500")?.status).toBe(500);
  });

  it("breaks exactly one thing per fixture", () => {
    expect(fixtureBody("/missing-cta")?.html).not.toContain("<h1>");
    expect(fixtureBody("/healthy")?.html).toContain("<h1>");
    expect(fixtureBody("/no-links")?.html).not.toContain("<a href");
    expect(fixtureBody("/broken-image")?.html).toContain("/missing.png");
    expect(fixtureBody("/js-error")?.html).toContain("throw new Error");
    expect(fixtureBody("/console-error")?.html).toContain("console.error");
  });

  it("returns null for an unknown path", () => {
    expect(fixtureBody("/nope")).toBeNull();
  });
});

describe("startFixtureServer", () => {
  it("serves every defect over real HTTP on an ephemeral port", async () => {
    const server = await startFixtureServer();
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const healthy = await fetch(`${server.origin}/healthy`);
      expect(healthy.status).toBe(200);
      expect(await healthy.text()).toContain("<h1>");
      expect((await fetch(`${server.origin}/status-404`)).status).toBe(404);
      expect((await fetch(`${server.origin}/status-500`)).status).toBe(500);
      expect((await fetch(`${server.origin}/missing.png`)).status).toBe(404);
      expect((await fetch(`${server.origin}/healthy?x=1`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
