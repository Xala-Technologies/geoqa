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

  describe("the language override", () => {
    it("serves the local language by default and the chosen one on a cookie", () => {
      // Path-based and cookie-based, because sites do one or the other and a journey
      // that only knew one would report a working site as broken.
      expect(fixtureBody("/lang")?.html).toContain("nb-NO");
      expect(fixtureBody("/lang", "lang=en")?.html).toContain("en-GB");
      expect(fixtureBody("/en/lang")?.html).toContain("en-GB");
    });

    it("SETS the choice as a cookie, or the next unprefixed page geo-redirects back", () => {
      expect(fixtureBody("/en/lang")?.headers?.["set-cookie"]).toContain("lang=en");
      // And the broken variant deliberately does not.
      expect(fixtureBody("/en/lang-ignored")?.headers).toBeUndefined();
    });

    it("carries the choice onto an UNPREFIXED page — the returning-visitor half", () => {
      expect(fixtureBody("/lang-deeper")?.html).toContain("nb-NO");
      expect(fixtureBody("/lang-deeper", "lang=en")?.html).toContain("en-GB");
      expect(fixtureBody("/en/lang-deeper")?.html).toContain("en-GB");
    });

    it("reads the cookie exactly, so a lookalike value is not a choice", () => {
      // `lang=en-GB` and `mylang=en` are not `lang=en`. A loose match here would make
      // the fixture answer English for a visitor who never chose it, and then the
      // journey would be testing the fixture's bug rather than the site's.
      expect(fixtureBody("/lang", "lang=nb")?.html).toContain("nb-NO");
      expect(fixtureBody("/lang", "other=1; lang=en")?.html).toContain("en-GB");
      expect(fixtureBody("/lang", "mylang=en")?.html).toContain("nb-NO");
    });

    it("puts language-specific words in the chrome of EVERY page of that language", () => {
      // The measured reason: a marker that exists only on the landing page makes a
      // `text-absent` persistence check vacuous one click later, and a broken
      // override then reports PASS.
      for (const path of ["/lang", "/lang-deeper", "/lang-broken"]) {
        expect(fixtureBody(path)?.html, path).toContain("Om oss");
      }
      for (const path of ["/en/lang", "/en/lang-deeper", "/en/lang-ignored"]) {
        expect(fixtureBody(path)?.html, path).toContain("About us");
      }
    });

    it("keeps the onward content link inside <main>, so a click can be content-scoped", () => {
      // A CSS comma resolves in DOM order, so an unscoped click selector reaches the
      // nav first. Gaps C-11: that made a broken override report PASS.
      expect(fixtureBody("/lang")?.html).toContain("<main>");
      expect(fixtureBody("/en/lang-ignored")?.html).toContain("<main>");
    });
  });

  describe("the search flow", () => {
    it("submits to a DIFFERENT path, so the results page is a real navigation", () => {
      // In-place DOM mutation would let a journey "search" without the browser ever
      // navigating, which is precisely the capability these fixtures exist to prove.
      expect(fixtureBody("/search")?.html).toContain('action="/search-results"');
      expect(fixtureBody("/search")?.html).toContain('type="search"');
    });

    it("offers clickable results whose links leave the results page", () => {
      const html = fixtureBody("/search-results")?.html ?? "";
      expect(html).toContain('class="result"');
      expect(html).toContain('href="/search-result"');
      expect(fixtureBody("/search-result")?.status).toBe(200);
      expect(fixtureBody("/search-result")?.html).toContain("<h1>");
    });

    it("has an empty state whose results REGION is present and whose list is empty", () => {
      // An empty result set is a correct answer to a query, not a defect. A journey
      // must be able to visit this page and find nothing wrong with it.
      const html = fixtureBody("/search-empty")?.html ?? "";
      expect(html).toContain('id="results"></ul>');
      expect(html).toContain('id="empty-state"');
      expect(html).toContain("<h1>");
    });

    it("has a dead-results variant, which is the only positive proof a click navigated", () => {
      // The 4xx finding sits on a step that runs AFTER the click, so it cannot
      // appear unless the browser really followed the link.
      expect(fixtureBody("/search-dead")?.html).toContain('action="/search-dead-results"');
      expect(fixtureBody("/search-dead-results")?.html).toContain('href="/status-404"');
    });

    it("keeps every search route OUT of DEFECTS — only the dead links are a defect", () => {
      // DEFECTS is the list EXP-006 iterates, and each entry must break exactly one
      // thing. A search page that works is not a defect, and listing it would make
      // the experiment expect a finding that should never appear.
      for (const p of ["/search", "/search-results", "/search-result", "/search-empty", "/search-dead", "/search-dead-results"]) {
        expect(DEFECTS.some((d) => d.path === p), p).toBe(false);
      }
    });
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
