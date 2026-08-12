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

  it("serves an egress identity so an end-to-end run needs no internet", () => {
    // Not a defect, so deliberately absent from DEFECTS. A constant IP is what
    // lets `egressHeld` see the same identity at both ends of a healthy run.
    const fixture = fixtureBody("/ipinfo");
    expect(fixture?.status).toBe(200);
    expect(JSON.parse(fixture?.html ?? "null")).toMatchObject({
      ip: "213.52.15.251",
      country: "NO",
      city: "Lysaker",
    });
    expect(DEFECTS.some((d) => d.path === "/ipinfo")).toBe(false);
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

  it("serves the contact form with every control a journey needs", async () => {
    const server = await startFixtureServer();
    try {
      const body = await (await fetch(`${server.origin}/contact`)).text();
      for (const control of ['id="name"', 'id="email"', 'id="topic"', 'id="consent"', 'id="message"', 'id="send"']) {
        expect(body).toContain(control);
      }
    } finally {
      await server.close();
    }
  });

  it("answers a SUBMITTED form with its confirmation", async () => {
    // So a journey can prove the write landed, rather than only that the button
    // was clickable.
    const server = await startFixtureServer();
    try {
      const response = await fetch(`${server.origin}/contact`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "name=QA&email=qa%40example.test&message=hei",
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('id="confirmation"');
      // The fixture never echoes what was typed: that would make it the one
      // place in this repo that writes form input into a response.
      expect(body).not.toContain("qa@example.test");
    } finally {
      await server.close();
    }
  });

  it("serves a heading that arrives AFTER the old settle window", () => {
    // The regression fixture. `selector-visible` reported a missing h1 on six
    // digilist.no pages that demonstrably had one, because a single sample plus a
    // 600ms settle is not enough under load. 900ms here fails a poll-and-settle
    // implementation and passes one that auto-waits.
    const fixture = fixtureBody("/slow-heading");
    expect(fixture?.status).toBe(200);
    expect(fixture?.html).toContain("setTimeout");
    expect(fixture?.html).toContain("900");
    // The h1 must NOT be in the initial HTML, or the fixture proves nothing.
    expect(fixture?.html).not.toContain("<h1");
    expect(DEFECTS.some((d) => d.path === "/slow-heading")).toBe(false);
  });

  it("serves the egress identity over HTTP as parseable JSON", async () => {
    const server = await startFixtureServer();
    try {
      const body = await (await fetch(`${server.origin}/ipinfo`)).text();
      expect(JSON.parse(body).country).toBe("NO");
    } finally {
      await server.close();
    }
  });
});
