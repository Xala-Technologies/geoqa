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

const shell = (title: string, body: string): string =>
  `<!doctype html><html lang="nb-NO"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

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
