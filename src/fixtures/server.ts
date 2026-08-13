/**
 * A local server that serves deliberately broken pages.
 *
 * EXP-006 asks whether a defect produces a finding whose evidence explains
 * itself. Answering that needs defects we control — which is why they are
 * injected here rather than hunted for on a live site. Breaking production to
 * test the tester is not a trade anyone should make, and a real bug that
 * happens to exist today cannot be relied on to still exist tomorrow.
 *
 * Each route breaks exactly one thing, so a finding can be attributed to it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FindingCategory } from "../findings/types.js";

export interface DefectFixture {
  /** URL path, also the fixture's id. */
  path: string;
  description: string;
  /** The finding category a correct engine should produce. */
  expects: FindingCategory;
  /** The journey check that should catch it. */
  caughtBy: string;
}

export const DEFECTS: DefectFixture[] = [
  { path: "/healthy", description: "A page with nothing wrong — the control", expects: "unknown", caughtBy: "(nothing)" },
  { path: "/status-404", description: "The page itself returns 404", expects: "http", caughtBy: "no-http-4xx" },
  { path: "/status-500", description: "The page itself returns 500", expects: "http", caughtBy: "no-http-5xx" },
  { path: "/broken-image", description: "An <img> whose source 404s", expects: "http", caughtBy: "no-http-4xx" },
  { path: "/missing-cta", description: "No <h1> at all", expects: "functional", caughtBy: "selector-visible" },
  { path: "/js-error", description: "An uncaught exception on load", expects: "javascript", caughtBy: "no-page-errors" },
  { path: "/console-error", description: "A console.error on load", expects: "javascript", caughtBy: "no-console-errors" },
  { path: "/no-links", description: "A page with no internal links", expects: "navigation", caughtBy: "selector-count-min" },
];

/**
 * The page shell every fixture is served in.
 *
 * The viewport meta tag is LOAD-BEARING, not boilerplate. A mobile profile that
 * emulates a real device sets Chromium's `isMobile`, and a page with no
 * `<meta name="viewport">` then falls back to the legacy 980px layout viewport —
 * so `window.innerWidth` reports 980 however small the window is. Measured: 980
 * without the tag, 390 with it, at the same 390x844 window.
 *
 * Without the tag every mobile fixture run reported `viewport: mismatch` and lost
 * its `trustworthy` flag. That verdict was CORRECT — a page missing this tag
 * really does render at 980px on a phone — which makes it a site defect worth
 * detecting rather than something to suppress. The fixtures carry the tag because
 * they stand in for real responsive pages; a route that omits it deliberately
 * would be a useful ninth defect.
 */
const shell = (title: string, body: string): string =>
  `<!doctype html><html lang="nb-NO"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>${title}</title></head><body>${body}</body></html>`;

const LINKS = ["/a", "/b", "/c"].map((h) => `<a href="${h}">lenke ${h}</a>`).join(" ");
const HEADING = "<h1>Fixture</h1>";

/** The body for each defect path. Pure, so the routing table is testable. */
export function fixtureBody(path: string): { status: number; html: string } | null {
  switch (path) {
    // Chrome requests this unprompted on every navigation. Letting it 404 puts
    // an http finding on EVERY fixture including the control, which is how the
    // first EXP-006 run reported the healthy page as defective.
    case "/favicon.ico":
      return { status: 204, html: "" };
    /**
     * A stand-in for the egress-identity endpoint, so an end-to-end run can
     * verify both geographic axes without reaching the internet.
     *
     * NOT a defect, so deliberately absent from `DEFECTS`. Serving it as HTML is
     * fine for both consumers: `observeNetwork` reads `innerText` of the body,
     * and `observeEgressIp` calls `response.json()`, which parses the body text
     * regardless of content type. A constant IP also means a healthy run
     * observes the same egress at both ends, which is what `egressHeld` expects.
     */
    case "/ipinfo":
      return {
        status: 200,
        html: JSON.stringify({
          ip: "213.52.15.251",
          city: "Lysaker",
          region: "Akershus",
          country: "NO",
          org: "AS2116 GLOBALCONNECT AS",
          timezone: "Europe/Oslo",
        }),
      };
    /**
     * A contact form, and its confirmation.
     *
     * Here so the input half of the DSL — fill, select, check, press, and a real
     * submit — can be proven end to end without registering an account on a live
     * product. `/contact` posts to itself; the server answers a POST with
     * `/contact-sent`, so a journey can assert on a confirmation the way a human
     * would read one.
     */
    case "/contact":
      return {
        status: 200,
        html: shell(
          "Contact",
          `${HEADING}<form method="post" action="/contact">
             <input name="name" id="name" placeholder="Navn">
             <input name="email" id="email" type="email" placeholder="E-post">
             <select name="topic" id="topic"><option value="sales">Salg</option><option value="support">Support</option></select>
             <input name="consent" id="consent" type="checkbox">
             <textarea name="message" id="message"></textarea>
             <button type="submit" id="send">Send</button>
           </form>${LINKS}`,
        ),
      };
    case "/contact-sent":
      return { status: 200, html: shell("Takk", `${HEADING}<p id="confirmation">Takk for meldingen din.</p>${LINKS}`) };
    /**
     * Site search, its results, and one result's page.
     *
     * Here because **no journey clicked anything**. `browse.yaml` has zero click
     * steps, so "open a result" (J03) and "follow a contextual link" (J05) were not
     * merely unwritten — the click primitive was never exercised through a real
     * navigation in any test above the runtime adapters. A search flow is the
     * cheapest way to exercise it honestly: type, submit, land somewhere new, click
     * a result, land somewhere new again. Three real navigations, each verifiable.
     *
     * The form is a GET to a different path, so the results page is a genuine
     * navigation rather than in-place DOM mutation. The query survives as
     * `?q=...`, which the router strips — deliberately, because a fixture that
     * varied its body by query would be answering a different question on every
     * run.
     *
     * Not defects, so absent from `DEFECTS`.
     */
    case "/search":
      return {
        status: 200,
        html: shell(
          "Søk",
          `${HEADING}<form method="get" action="/search-results" role="search">
             <input type="search" name="q" id="q" placeholder="Søk">
             <button type="submit" id="do-search">Søk</button>
           </form>${LINKS}`,
        ),
      };
    case "/search-results":
      return {
        status: 200,
        html: shell(
          "Søkeresultater",
          `${HEADING}<select id="sort" name="sort"><option value="relevance">Relevans</option><option value="date">Dato</option></select>
           <ul id="results">
             <li><a class="result" href="/search-result">Første treff</a></li>
             <li><a class="result" href="/healthy">Andre treff</a></li>
             <li><a class="result" href="/contact">Tredje treff</a></li>
           </ul>${LINKS}`,
        ),
      };
    /**
     * A search whose results are DEAD LINKS.
     *
     * Two jobs. It is a defect worth detecting on a real site — a results page that
     * renders three perfectly good-looking links to pages that 404 — and it is the
     * only positive proof available that a click actually NAVIGATED: the
     * `no-http-4xx` finding it produces sits on a step that runs after the click,
     * so the finding cannot appear unless the browser really followed the link. A
     * fake click always succeeds and would report exactly nothing here.
     */
    case "/search-dead":
      return {
        status: 200,
        html: shell(
          "Søk",
          `${HEADING}<form method="get" action="/search-dead-results" role="search">
             <input type="search" name="q" id="q" placeholder="Søk">
             <button type="submit" id="do-search">Søk</button>
           </form>${LINKS}`,
        ),
      };
    case "/search-dead-results":
      return {
        status: 200,
        html: shell(
          "Søkeresultater",
          `${HEADING}<ul id="results">
             <li><a class="result" href="/status-404">Treff som ikke finnes</a></li>
           </ul>${LINKS}`,
        ),
      };
    case "/search-result":
      return { status: 200, html: shell("Treff", `${HEADING}<p id="detail">Detaljene for treffet.</p>${LINKS}`) };
    /**
     * A search that legitimately found nothing.
     *
     * The results REGION is present and empty, which is the whole point: an empty
     * result set is a correct answer to a query, not a defect. A journey that
     * asserted a minimum result count against every search would report this page
     * as broken — so J03 asserts the region exists and only counts results on a
     * query whose term is known to match, which is why the term is a variable.
     */
    case "/search-empty":
      return {
        status: 200,
        html: shell(
          "Ingen treff",
          `${HEADING}<ul id="results"></ul><p id="empty-state">Ingen treff for søket ditt.</p>${LINKS}`,
        ),
      };
    case "/healthy":
      return { status: 200, html: shell("Healthy", `${HEADING}<p>Alt i orden.</p>${LINKS}`) };
    case "/status-404":
      return { status: 404, html: shell("Not found", `${HEADING}<p>Finnes ikke.</p>${LINKS}`) };
    case "/status-500":
      return { status: 500, html: shell("Server error", `${HEADING}<p>Feil.</p>${LINKS}`) };
    case "/broken-image":
      return { status: 200, html: shell("Broken image", `${HEADING}<img src="/missing.png" alt="borte">${LINKS}`) };
    case "/missing-cta":
      return { status: 200, html: shell("No heading", `<p>Ingen overskrift her.</p>${LINKS}`) };
    case "/js-error":
      return {
        status: 200,
        html: shell("JS error", `${HEADING}${LINKS}<script>throw new Error("fixture: uncaught");</script>`),
      };
    case "/console-error":
      return {
        status: 200,
        html: shell("Console error", `${HEADING}${LINKS}<script>console.error("fixture: console");</script>`),
      };
    /**
     * A heading that arrives LATE — the false-defect reproduction.
     *
     * Under load, `selector-visible` reported a missing `h1` on six digilist.no
     * pages whose raw HTML contained one, and all six passed when re-run alone.
     * The engine was inventing site defects out of its own slowness, which is the
     * single failure mode this project exists to prevent.
     *
     * 900ms is chosen to exceed the old 600ms absence-settle, so this route fails
     * against a poll-and-settle implementation and passes against one that
     * auto-waits. It is a regression test for the engine, not a defect fixture —
     * hence absent from `DEFECTS`.
     */
    case "/slow-heading":
      return {
        status: 200,
        html: shell(
          "Slow heading",
          `<p>Venter…</p>${LINKS}<script>
             setTimeout(() => {
               const h = document.createElement('h1');
               h.textContent = 'Late but present';
               document.body.insertBefore(h, document.body.firstChild);
             }, 900);
           </script>`,
        ),
      };
    case "/no-links":
      return { status: 200, html: shell("No links", `${HEADING}<p>Ingen lenker.</p>`) };
    default:
      return null;
  }
}

export interface FixtureServer {
  origin: string;
  close: () => Promise<void>;
}

/**
 * Start on an ephemeral port and report the origin.
 *
 * Port 0 rather than a fixed port so two experiments can run at once and so a
 * leftover process from a previous run cannot silently serve the fixtures.
 */
export function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    // A submitted form is answered with its confirmation, so a journey can prove
    // the write landed rather than only that the button was clickable. The body
    // is deliberately not read: what was typed is the visitor's, and a fixture
    // that echoed it would be the one place this repo writes form input to a log.
    if (req.method === "POST" && path === "/contact") {
      req.resume();
      const fixture = fixtureBody("/contact-sent");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fixture?.html ?? "");
      return;
    }
    const fixture = fixtureBody(path);
    if (!fixture) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no fixture");
      return;
    }
    res.writeHead(fixture.status, { "content-type": "text/html; charset=utf-8" });
    res.end(fixture.html);
  });

  return new Promise<FixtureServer>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
