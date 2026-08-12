/**
 * A healthy fake browser, shared by the run-layer tests. Not a test file — it
 * has no `.test.ts` suffix, so vitest neither collects nor covers it.
 */
import type { BrowserResult, BrowserRuntime } from "../../browser/types.js";

const meta = { stdout: "", stderr: "", durationMs: 1, command: "c" };

export const ok = <T,>(data: T): BrowserResult<T> => ({ ok: true, data, ...meta });

export const bad = <T,>(kind = "exit"): BrowserResult<T> => ({
  ok: false,
  failure: { kind: kind as never, detail: "nope", exitCode: 1, signal: null },
  ...meta,
});

export const IPINFO_OSLO = JSON.stringify({
  ip: "213.52.15.251",
  city: "Lysaker",
  region: "Akershus",
  country: "NO",
  org: "AS2116 GLOBALCONNECT AS",
  timezone: "Europe/Oslo",
});

export const BROWSER_ENV_OSLO = JSON.stringify({
  language: "nb-NO",
  languages: ["nb-NO", "nb"],
  timezone: "Europe/Oslo",
  userAgent: "HeadlessChrome/151",
  viewport: { width: 390, height: 844 },
  geolocation: { latitude: 59.9139, longitude: 10.7522 },
});

export function fakeRuntime(over: Partial<BrowserRuntime> = {}): BrowserRuntime {
  return {
    sessionId: "run_1",
    open: (url) => Promise.resolve(ok({ url, title: "T", targetId: "t", launchHash: "h", browserLaunched: false })),
    reload: () => Promise.resolve(ok({ url: "u", title: "T", targetId: "t", launchHash: "h", browserLaunched: false })),
    getText: () => Promise.resolve(ok(IPINFO_OSLO)),
    getTitle: () => Promise.resolve(ok("Digilist")),
    getUrl: () => Promise.resolve(ok("https://digilist.no/")),
    count: () => Promise.resolve(ok(9)),
    isVisible: () => Promise.resolve(ok(true)),
    snapshot: () => Promise.resolve(ok("- heading")),
    evaluate: <T,>() => Promise.resolve(ok(BROWSER_ENV_OSLO as unknown as T)),
    click: () => Promise.resolve(ok(null)),
    scroll: () => Promise.resolve(ok(null)),
    waitFor: () => Promise.resolve(ok(null)),
    setViewport: () => Promise.resolve(ok(null)),
    setDevice: () => Promise.resolve(ok(null)),
    setGeo: () => Promise.resolve(ok(null)),
    setHeaders: () => Promise.resolve(ok(null)),
    screenshot: () => Promise.resolve(ok(null)),
    console: () => Promise.resolve(ok([])),
    errors: () => Promise.resolve(ok([])),
    networkRequests: () => Promise.resolve(ok([])),
    harStart: () => Promise.resolve(ok(null)),
    harStop: () => Promise.resolve(ok(null)),
    traceStart: () => Promise.resolve(ok(null)),
    traceStop: () => Promise.resolve(ok(null)),
    vitals: () => Promise.resolve(ok({ lcp: 900, cls: 0, ttfb: 10, fcp: 40, inp: null })),
    a11y: () => Promise.resolve(ok([])),
    close: () => Promise.resolve(ok(null)),
    ...over,
  } as BrowserRuntime;
}
