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

/**
 * Language-specific site chrome, on EVERY page of that language.
 *
 * The words matter and they are chosen, not decorative. A persistence claim is
 * asserted with a marker word, and a marker that appears only on the HOMEPAGE
 * makes the claim vacuous one click later: `text-absent` is trivially true on a
 * page that never had the word. Measured — the first version of this fixture used
 * "Velkommen", which is on the homepage and nowhere else, and the broken-override
 * run reported PASS. `Om oss` and `About us` are in the nav of every page of their
 * language and of no page of the other.
 */
const NB_CHROME = `<nav><a href="/lang">Hjem</a> <a href="/om-oss">Om oss</a></nav>`;
const EN_CHROME = `<nav><a href="/en/lang">Home</a> <a href="/en/about">About us</a></nav>`;
const HEADING = "<h1>Fixture</h1>";

/**
 * What a fixture answers with.
 *
 * `headers` exists for `Set-Cookie`, and therefore for the one thing a stateless
 * path-per-page server could not express: a CHOICE a visitor made that has to
 * survive a navigation. A language override is exactly that, and so is a dismissed
 * cookie banner — the highest-value untested scenario on the plan.
 */
export interface FixtureResponse {
  status: number;
  html: string;
  headers?: Record<string, string>;
}

/**
 * The body for each fixture path. Pure, so the routing table is testable.
 *
 * `cookie` is the raw request header, and reading it is what lets a fixture answer
 * differently for a returning visitor without any server state. Pure still: the
 * same path and the same cookie always produce the same page.
 */
export function fixtureBody(path: string, cookie = ""): FixtureResponse | null {
  /** Did the visitor already choose English? */
  const prefersEnglish = /(?:^|;\s*)lang=en(?:;|$)/.test(cookie);
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
    /**
     * A page that renders NO text at all, ever.
     *
     * The other half of the empty-read rule. A settle is not a guarantee, and the engine does
     * not pretend it is: "the page rendered nothing" and "we looked too early" are
     * indistinguishable from inside a text check, and when this engine cannot distinguish it
     * does not blame the page. The check is reported unreadable — our defect — which still
     * blocks the publish gate. A different sentence, the same outcome.
     */
    case "/empty-body":
      return { status: 200, html: shell("Empty body", "") };
    /**
     * A client-rendered page: an EMPTY body that fills in after hydration.
     *
     * Modelled on xala.no, which is where this was found. `getText` is `innerText`, and
     * Playwright auto-waits only for the element to be ATTACHED — so a read taken at `load`
     * returns zero characters and every text check compares against an empty string, then files
     * the result as a SITE finding. Measured on the real site: 0 characters at `load`, 6,077 one
     * second later, against a page whose `<html lang>` is `nb-NO` and entirely correct.
     *
     * A regression test for the engine rather than a defect fixture — like `/slow-heading`, and
     * for the same reason it is absent from `DEFECTS`. The delay is 300ms: long enough that an
     * unsettled read reliably sees nothing, short enough that the suite does not pay for it.
     */
    case "/hydrates-late":
      return {
        status: 200,
        html: shell(
          "Hydrates late",
          `<script>
             setTimeout(() => {
               document.body.innerHTML = '<h1>Vi bygger saksbehandlingssystemer</h1><p>Priser fra kr 1 200.</p>' + ${JSON.stringify(LINKS)};
             }, 300);
           </script>`,
        ),
      };
    /**
     * A manual language override, and whether it survives the next click.
     *
     * The scenario: a visitor on a Norwegian IP gets Norwegian, chooses English,
     * navigates internally, and should still be reading English. It is worth a
     * fixture because the failure is invisible to every other check — the page
     * renders, returns 200, has a heading, and is simply in the wrong language,
     * which a geo-redirect that runs on every request will happily do forever.
     *
     * Both real mechanisms are exercised, because sites use one or the other and a
     * journey that only knew one would report a working site as broken:
     *
     * - **Path prefix** (`/en/lang`), which is what digilist.no does.
     * - **Cookie** (`lang=en`), so `/lang-deeper` with no prefix ALSO answers in
     *   English once the choice has been made. That is the returning-visitor half,
     *   and it needs no `storageState` to demonstrate within one run.
     *
     * `<p id="locale">` carries the resolved locale as text, so an assertion can
     * name the claim exactly rather than hunting for a translated word that might
     * legitimately appear in either language.
     */
    case "/lang":
      return prefersEnglish
        ? {
            status: 200,
            html: shell(
              "Home",
              `${EN_CHROME}<h1>Welcome</h1><p id="locale">en-GB</p><p>English, because you chose it.</p>
               <main><a href="/lang-deeper" id="deeper">Read more</a></main>`,
            ),
          }
        : {
            status: 200,
            html: shell(
              "Hjem",
              `${NB_CHROME}<h1>Velkommen</h1><p id="locale">nb-NO</p><p>Norsk, fordi du er i Norge.</p>
               <a href="/en/lang" id="to-english">English</a>
               <main><a href="/lang-deeper" id="deeper">Les mer</a></main>`,
            ),
          };
    case "/en/lang":
      return {
        status: 200,
        // The cookie is the override. Without it the next unprefixed page would
        // geo-redirect straight back to Norwegian, which is the bug this fixture
        // stands in for.
        headers: { "set-cookie": "lang=en; Path=/; SameSite=Lax" },
        html: shell(
          "Home",
          `${EN_CHROME}<h1>Welcome</h1><p id="locale">en-GB</p><p>English, because you chose it.</p>
           <main><a href="/en/lang-deeper" id="deeper">Read more</a>
           <a href="/lang-deeper" id="deeper-unprefixed">Read more (no prefix)</a></main>`,
        ),
      };
    case "/en/lang-deeper":
      return {
        status: 200,
        html: shell("Details", `${EN_CHROME}<h1>Details</h1><p id="locale">en-GB</p><p>Still English.</p>${LINKS}`),
      };
    case "/lang-deeper":
      return prefersEnglish
        ? { status: 200, html: shell("Details", `${EN_CHROME}<h1>Details</h1><p id="locale">en-GB</p><p>Still English.</p>${LINKS}`) }
        : { status: 200, html: shell("Detaljer", `${NB_CHROME}<h1>Detaljer</h1><p id="locale">nb-NO</p><p>Fortsatt norsk.</p>${LINKS}`) };
    /**
     * The same flow with the override BROKEN — the geo-redirect wins.
     *
     * `/lang-broken` is the entry point and it has to be: a journey that lands on
     * the geo-chosen language cannot start on the English page. Pointed at
     * `/en/lang-ignored` directly, the run reported ERROR rather than FAIL —
     * the switcher is not on that page, so the visibility check failed and the
     * click could not be performed. Which is gaps C-9 biting a second time, in my
     * own test design this time: a step whose selector a preceding check already
     * proved absent still runs, and "we could not verify" outranks the real
     * finding.
     *
     * `/en/lang-ignored` sets no cookie and links onward unprefixed, so the
     * visitor is silently returned to Norwegian on the next click. A journey that
     * asserts the override persisted must FAIL here, or it asserts nothing.
     */
    case "/lang-broken":
      return {
        status: 200,
        html: shell(
          "Hjem",
          `${NB_CHROME}<h1>Velkommen</h1><p id="locale">nb-NO</p><p>Norsk, fordi du er i Norge.</p>
           <a href="/en/lang-ignored" id="to-english">English</a>
           <main><a href="/lang-deeper" id="deeper">Les mer</a></main>`,
        ),
      };
    case "/en/lang-ignored":
      return {
        status: 200,
        html: shell(
          "Home",
          `${EN_CHROME}<h1>Welcome</h1><p id="locale">en-GB</p><p>English, for now.</p>
           <main><a href="/lang-deeper" id="deeper">Read more</a></main>`,
        ),
      };
    /**
     * A button whose handler blocks the main thread for ~120ms.
     *
     * Here because INP turned out to be unmeasurable on every other fixture, and
     * that is not a bug in the engine. Chromium reports event-timing entries only
     * above a threshold (the observer is armed at `durationThreshold: 16`), so a
     * click on a page with no handler is genuinely too fast to produce an entry —
     * `inp: null` is then a fact about the page, not a failed read.
     *
     * Which means an `inp-below` check could not be PROVEN end to end without a page
     * that is actually slow to respond. 120ms is chosen to sit above the threshold
     * and below Google's 200ms "good" bar, so one page can demonstrate both a
     * measured pass and, at a tighter budget, a measured fail.
     */
    case "/slow-interaction":
      return {
        status: 200,
        html: shell(
          "Slow interaction",
          `${HEADING}<button id="slow">Trykk</button><p id="out">—</p>${LINKS}<script>
             document.getElementById('slow').addEventListener('click', () => {
               // Deliberately blocking, not a timeout: INP measures the delay before
               // the next paint, and an async wait would leave the frame free.
               const until = performance.now() + 120;
               while (performance.now() < until) { /* hold the main thread */ }
               document.getElementById('out').textContent = 'trykket';
             });
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
    const fixture = fixtureBody(path, req.headers.cookie ?? "");
    if (!fixture) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no fixture");
      return;
    }
    res.writeHead(fixture.status, { "content-type": "text/html; charset=utf-8", ...fixture.headers });
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
