import { describe, expect, it, vi } from "vitest";
import type { BrowserResult, Vitals } from "../types.js";
import {
  DEFAULT_SCROLL_PX,
  HAR_NOT_ARMED,
  INTERACTION_KEY,
  INTERACTION_OBSERVER_SCRIPT,
  PlaywrightRuntime,
  VITALS_EXPRESSION,
  classifyPlaywrightError,
  harElsewhereDetail,
  harPendingDetail,
  type PwLocator,
  type PwObserved,
  type PwPage,
  type PwSession,
} from "../playwright.js";

/** Unwrap a successful result, failing the test loudly if it was not one. */
const dataOf = <T,>(out: BrowserResult<T>): T => {
  if (!out.ok) throw new Error(`expected ok, got ${out.failure.kind}: ${out.failure.detail}`);
  return out.data;
};

/** A locator whose every answer is overridable. */
const locator = (over: Partial<PwLocator> = {}): PwLocator => ({
  innerText: () => Promise.resolve("body text"),
  count: () => Promise.resolve(9),
  isVisible: () => Promise.resolve(true),
  visibleCount: () => Promise.resolve(1),
  click: () => Promise.resolve(),
  ariaSnapshot: () => Promise.resolve("- heading"),
  fill: () => Promise.resolve(),
  selectOption: () => Promise.resolve(null),
  check: () => Promise.resolve(),
  ...over,
});

interface Calls {
  goto: string[];
  selectors: string[];
  waits: (string | number)[];
  wheel: [number, number][];
  screenshots: { path: string; fullPage: boolean }[];
  viewports: { width: number; height: number }[];
  geo: { latitude: number; longitude: number }[];
  headers: Record<string, string>[];
  keys: string[];
  traceStarted: number;
  traceStopped: string[];
  statesSaved: string[];
  closed: number;
}

const observedFixture: PwObserved = {
  console: [{ type: "error", text: "boom" }],
  errors: [{ message: "TypeError", stack: null }],
  requests: [{ url: "https://x/a.js", method: "GET", status: 404, resourceType: "script" }],
};

function session(
  over: {
    page?: Partial<PwPage>;
    locator?: Partial<PwLocator>;
    deviceName?: string | null;
    /** What the context was created with, so HAR can be answered honestly. */
    harPath?: string | null;
    saveStatePath?: string | null;
    saveStorageState?: (path: string) => Promise<void>;
  } = {},
): { session: PwSession; calls: Calls } {
  const calls: Calls = {
    goto: [], selectors: [], waits: [], wheel: [], screenshots: [], viewports: [],
    geo: [], headers: [], keys: [], traceStarted: 0, traceStopped: [], statesSaved: [], closed: 0,
  };
  const page: PwPage = {
    goto: (url) => {
      calls.goto.push(url);
      return Promise.resolve();
    },
    reload: () => Promise.resolve(),
    title: () => Promise.resolve("Digilist"),
    url: () => "https://digilist.no/blogg",
    evaluate: () => Promise.resolve(null),
    locator: (selector) => {
      calls.selectors.push(selector);
      return locator(over.locator);
    },
    waitForSelector: (selector) => {
      calls.waits.push(selector);
      return Promise.resolve();
    },
    waitForTimeout: (ms) => {
      calls.waits.push(ms);
      return Promise.resolve();
    },
    setViewportSize: (size) => {
      calls.viewports.push(size);
      return Promise.resolve();
    },
    screenshot: (options) => {
      calls.screenshots.push(options);
      return Promise.resolve();
    },
    wheel: (dx, dy) => {
      calls.wheel.push([dx, dy]);
      return Promise.resolve();
    },
    pressKey: (key) => {
      calls.keys.push(key);
      return Promise.resolve();
    },
    ...over.page,
  };
  return {
    calls,
    session: {
      page,
      context: {
        setGeolocation: (coords) => {
          calls.geo.push(coords);
          return Promise.resolve();
        },
        setExtraHTTPHeaders: (headers) => {
          calls.headers.push(headers);
          return Promise.resolve();
        },
        startTracing: () => {
          calls.traceStarted++;
          return Promise.resolve();
        },
        stopTracing: (path) => {
          calls.traceStopped.push(path);
          return Promise.resolve();
        },
        saveStorageState:
          over.saveStorageState ??
          ((path): Promise<void> => {
            calls.statesSaved.push(path);
            return Promise.resolve();
          }),
        close: () => {
          calls.closed++;
          return Promise.resolve();
        },
      },
      observed: () => observedFixture,
      deviceName: over.deviceName ?? null,
      harPath: over.harPath ?? null,
      saveStatePath: over.saveStatePath ?? null,
      identity: "ctx-oslo-1",
    },
  };
}

/** A runtime over a fake session, with the settle lowered to nothing. */
const runtimeOver = (
  built: { session: PwSession; calls: Calls },
  options: { absenceSettleMs?: number } = {},
): PlaywrightRuntime =>
  new PlaywrightRuntime("run_1", () => Promise.resolve(built.session), {
    now: () => 1_000,
    absenceSettleMs: options.absenceSettleMs ?? 0,
  });

describe("classifyPlaywrightError", () => {
  it("names a Playwright timeout as a timeout, not a generic failure", () => {
    const error = Object.assign(new Error("locator.click: Timeout 30000ms exceeded"), { name: "TimeoutError" });
    expect(classifyPlaywrightError(error)).toEqual({
      kind: "timeout",
      detail: "locator.click: Timeout 30000ms exceeded",
    });
  });

  it("recognises a timeout by message even without the error name", () => {
    expect(classifyPlaywrightError(new Error("Navigation timed out")).kind).toBe("timeout");
  });

  it("treats a dead page or context as an exit", () => {
    expect(classifyPlaywrightError(new Error("Target page, context or browser has been closed")).kind).toBe("exit");
    expect(classifyPlaywrightError(new Error("Page crashed")).kind).toBe("exit");
  });

  it("falls back to `reported` — the tool told us it failed", () => {
    expect(classifyPlaywrightError(new Error("strict mode violation")).kind).toBe("reported");
  });

  it("keeps only the first line, so a failure reads as one fact", () => {
    const error = new Error("locator.click: failed\nCall log:\n  - waiting for locator");
    expect(classifyPlaywrightError(error).detail).toBe("locator.click: failed");
  });

  it("handles a throw that is not an Error at all", () => {
    expect(classifyPlaywrightError("just a string")).toEqual({ kind: "reported", detail: "just a string" });
  });
});

describe("PlaywrightRuntime session lifetime", () => {
  it("opens the context once and reuses it — one journey is one session", async () => {
    const built = session();
    const open = vi.fn(() => Promise.resolve(built.session));
    const runtime = new PlaywrightRuntime("run_1", open);
    await runtime.getTitle();
    await runtime.getUrl();
    await runtime.count("a");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not open anything until something is actually asked of it", () => {
    const open = vi.fn(() => Promise.resolve(session().session));
    new PlaywrightRuntime("run_1", open);
    expect(open).not.toHaveBeenCalled();
  });

  it("turns a failed launch into a named failure rather than a throw", async () => {
    const runtime = new PlaywrightRuntime("run_1", () => Promise.reject(new Error("browserType.launch: no chromium")));
    const out = await runtime.getTitle();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure).toMatchObject({ kind: "reported", detail: "browserType.launch: no chromium" });
  });

  it("exposes the session id it was built with", () => {
    expect(runtimeOver(session()).sessionId).toBe("run_1");
  });
});

describe("PlaywrightRuntime navigation and reads", () => {
  it("opens a url and reports which context served it", async () => {
    const built = session();
    const out = await runtimeOver(built).open("https://digilist.no/blogg");
    expect(built.calls.goto).toEqual(["https://digilist.no/blogg"]);
    expect(out.ok && out.data).toMatchObject({
      url: "https://digilist.no/blogg",
      title: "Digilist",
      targetId: "ctx-oslo-1",
      // Non-null so EXP-000's browser-launch metric stays measurable.
      launchHash: "ctx-oslo-1",
      browserLaunched: false,
    });
  });

  it("reloads and re-reads the title", async () => {
    const out = await runtimeOver(session()).reload();
    expect(out.ok && out.data.title).toBe("Digilist");
  });

  it("converts a navigation throw into a typed failure, never a rejection", async () => {
    const built = session({ page: { goto: () => Promise.reject(new Error("net::ERR_PROXY_CONNECTION_FAILED")) } });
    const out = await runtimeOver(built).open("https://digilist.no");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failure.kind).toBe("reported");
      expect(out.failure.detail).toContain("ERR_PROXY_CONNECTION_FAILED");
      expect(out.command).toBe("playwright:goto https://digilist.no");
    }
  });

  it("reads text, title, url and count", async () => {
    const runtime = runtimeOver(session());
    expect(dataOf(await runtime.getText("body"))).toBe("body text");
    expect(dataOf(await runtime.getTitle())).toBe("Digilist");
    expect(dataOf(await runtime.getUrl())).toBe("https://digilist.no/blogg");
    expect(dataOf(await runtime.count("a"))).toBe(9);
  });

  it("evaluates an expression and hands back whatever the page returned", async () => {
    const built = session({ page: { evaluate: () => Promise.resolve({ language: "nb-NO" }) } });
    const out = await runtimeOver(built).evaluate<{ language: string }>("1");
    expect(out.ok && out.data.language).toBe("nb-NO");
  });

  it("snapshots the body by default and honours an explicit selector", async () => {
    const built = session();
    const runtime = runtimeOver(built);
    expect((await runtime.snapshot()).ok).toBe(true);
    await runtime.snapshot({ selector: "main" });
    expect(built.calls.selectors).toEqual(["body", "main"]);
  });
});

describe("PlaywrightRuntime isVisible", () => {
  it("returns true on the first read without a second look", async () => {
    const isVisible = vi.fn(() => Promise.resolve(true));
    const out = await runtimeOver(session({ locator: { isVisible } })).isVisible("h1");
    expect(out.ok && out.data).toBe(true);
    expect(isVisible).toHaveBeenCalledTimes(1);
  });

  it("CONFIRMS a negative before believing it, and reports an element that only needed time", async () => {
    // An element mid-entrance-animation reads false. Under load that produced a
    // false site defect on a heading that was demonstrably present.
    let call = 0;
    const isVisible = vi.fn(() => Promise.resolve(++call > 1));
    const built = session({ locator: { isVisible } });
    const out = await runtimeOver(built).isVisible("h1");
    expect(out.ok && out.data).toBe(true);
    expect(isVisible).toHaveBeenCalledTimes(2);
    // The settle happened between the two reads.
    expect(built.calls.waits).toEqual([0]);
  });

  it("reports a genuinely absent element as not visible after the confirm", async () => {
    const isVisible = vi.fn(() => Promise.resolve(false));
    const out = await runtimeOver(session({ locator: { isVisible } })).isVisible("h1");
    expect(out.ok && out.data).toBe(false);
    expect(isVisible).toHaveBeenCalledTimes(2);
  });

  it("passes a broken read straight through instead of calling it absent", async () => {
    const built = session({ locator: { isVisible: () => Promise.reject(new Error("strict mode violation")) } });
    const out = await runtimeOver(built).isVisible("h1");
    expect(out.ok).toBe(false);
  });
});

describe("PlaywrightRuntime interaction", () => {
  it("clicks through a locator", async () => {
    const click = vi.fn(() => Promise.resolve());
    const built = session({ locator: { click } });
    expect((await runtimeOver(built).click("a.cta")).ok).toBe(true);
    expect(built.calls.selectors).toEqual(["a.cta"]);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("maps every scroll direction onto a wheel delta", async () => {
    const built = session();
    const runtime = runtimeOver(built);
    await runtime.scroll("down", 100);
    await runtime.scroll("up", 100);
    await runtime.scroll("right", 100);
    await runtime.scroll("left", 100);
    expect(built.calls.wheel).toEqual([
      [0, 100],
      [0, -100],
      [100, 0],
      [-100, 0],
    ]);
  });

  it("uses a default distance when a journey gives no pixel count", async () => {
    const built = session();
    await runtimeOver(built).scroll("down");
    expect(built.calls.wheel).toEqual([[0, DEFAULT_SCROLL_PX]]);
  });

  it("waits on a millisecond count or a selector, depending on the target", async () => {
    const built = session();
    const runtime = runtimeOver(built);
    await runtime.waitFor("250");
    await runtime.waitFor("#results");
    expect(built.calls.waits).toEqual([250, "#results"]);
  });
});

describe("PlaywrightRuntime environment", () => {
  it("sets the viewport", async () => {
    const built = session();
    expect((await runtimeOver(built).setViewport(390, 844)).ok).toBe(true);
    expect(built.calls.viewports).toEqual([{ width: 390, height: 844 }]);
  });

  it("confirms a device the context was actually built with", async () => {
    const out = await runtimeOver(session({ deviceName: "Pixel 5" })).setDevice("Pixel 5");
    expect(out.ok).toBe(true);
    expect(out.ok && out.data).toBeNull();
  });

  it("REFUSES a device the context was not built with, rather than reporting success", async () => {
    // Reporting success for a device never applied is what let a mobile profile
    // render at 1280px with every other check green.
    const out = await runtimeOver(session({ deviceName: "Pixel 5" })).setDevice("iPhone 15");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failure.kind).toBe("reported");
      expect(out.failure.detail).toContain("context creation");
      expect(out.failure.detail).toContain('"Pixel 5"');
    }
  });

  it("says so plainly when the context has no device at all", async () => {
    const out = await runtimeOver(session({ deviceName: null })).setDevice("Pixel 5");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.detail).toContain("no device");
  });

  it("passes a launch failure through setDevice instead of guessing", async () => {
    const runtime = new PlaywrightRuntime("r", () => Promise.reject(new Error("launch failed")));
    const out = await runtime.setDevice("Pixel 5");
    expect(out.ok).toBe(false);
  });

  it("sets geolocation and extra headers on the context", async () => {
    const built = session();
    const runtime = runtimeOver(built);
    await runtime.setGeo(59.9139, 10.7522);
    await runtime.setHeaders({ "Accept-Language": "nb-NO" });
    expect(built.calls.geo).toEqual([{ latitude: 59.9139, longitude: 10.7522 }]);
    expect(built.calls.headers).toEqual([{ "Accept-Language": "nb-NO" }]);
  });
});

describe("PlaywrightRuntime evidence", () => {
  it("screenshots, defaulting fullPage off", async () => {
    const built = session();
    const runtime = runtimeOver(built);
    await runtime.screenshot("/e/hero.png");
    await runtime.screenshot("/e/mid.png", { fullPage: true });
    expect(built.calls.screenshots).toEqual([
      { path: "/e/hero.png", fullPage: false },
      { path: "/e/mid.png", fullPage: true },
    ]);
  });

  it("returns what the listeners collected, not a fresh empty read", async () => {
    const runtime = runtimeOver(session());
    expect(dataOf(await runtime.console())).toEqual(observedFixture.console);
    expect(dataOf(await runtime.errors())).toEqual(observedFixture.errors);
    expect(dataOf(await runtime.networkRequests())[0]?.status).toBe(404);
  });

  it("starts and stops a trace — the reason the fail tier can hold one", async () => {
    const built = session();
    const runtime = runtimeOver(built);
    expect((await runtime.traceStart()).ok).toBe(true);
    expect((await runtime.traceStop("/e/trace.zip")).ok).toBe(true);
    expect(built.calls.traceStarted).toBe(1);
    expect(built.calls.traceStopped).toEqual(["/e/trace.zip"]);
  });

  it("REFUSES HAR entirely when the context was not created with a recording", async () => {
    // The previous adapter called harStop with no matching start and produced a
    // 221-byte file the manifest counted as present.
    const runtime = runtimeOver(session({ harPath: null }));
    for (const out of [await runtime.harStart(), await runtime.harStop("/e/network.har")]) {
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.failure.detail).toBe(HAR_NOT_ARMED);
    }
  });

  it("reports the HAR a context WAS created with as already recording", async () => {
    // Armed at creation is the only honest "started": the recording covers the
    // first navigation, which a mid-session start never could.
    const out = await runtimeOver(session({ harPath: "/e/network.har" })).harStart();
    expect(out.ok).toBe(true);
    expect(out.ok && out.data).toBe("/e/network.har");
  });

  it("CLOSES the context to flush the HAR, because on this engine that IS the flush", async () => {
    // It used to refuse here, accurately: Playwright writes the HAR at close and there is no
    // flush-on-demand, so `ok` would have described an artifact nothing had written. Refusing
    // accurately turned out not to be the same as being right — the manifest reported `har`
    // missing on every fail-tier run, for a file that appeared seconds later when the run's
    // `finally` closed the same context. `harStop` now means what its name says.
    const built = session({ harPath: "/e/network.har" });
    const out = await runtimeOver(built).harStop("/e/network.har");
    expect(out.ok).toBe(true);
    expect(built.calls.closed).toBe(1);
  });

  it("still says plainly that a HAR cannot be flushed on demand", () => {
    // Kept because it is the clearest statement of WHY the har block is collected last, and
    // that ordering is load-bearing: a HAR taken before the trace takes the trace's context.
    expect(harPendingDetail("/e/network.har")).toContain("does not exist yet");
  });

  it("saves the visitor session once, not once per close", async () => {
    // `harStop` closes and `executeRun`'s finally closes again. Playwright tolerates a repeated
    // context.close(); saveStorageState does not — it would write through a dead context and
    // report a failed save for a session saved correctly the first time.
    const built = session({ harPath: "/e/network.har", saveStatePath: "/e/state.json" });
    const runtime = runtimeOver(built);
    expect((await runtime.harStop("/e/network.har")).ok).toBe(true);
    expect((await runtime.close()).ok).toBe(true);
    expect(built.calls.statesSaved).toEqual(["/e/state.json"]);
    expect(built.calls.closed).toBe(1);
  });

  it("names BOTH paths when asked to flush a HAR somewhere it is not recording", async () => {
    // Otherwise a human looks for network.har in the run directory while the real
    // file sits somewhere else entirely.
    const out = await runtimeOver(session({ harPath: "/e/run_1/network.har" })).harStop("/e/other/network.har");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failure.detail).toBe(harElsewhereDetail("/e/run_1/network.har", "/e/other/network.har"));
    }
  });

  it("passes a launch failure through the HAR calls instead of guessing", async () => {
    const runtime = new PlaywrightRuntime("r", () => Promise.reject(new Error("launch failed")));
    expect((await runtime.harStart()).ok).toBe(false);
    expect((await runtime.harStop("/e/network.har")).ok).toBe(false);
  });

  it("REFUSES a11y rather than reporting a clean page it never audited", async () => {
    const out = await runtimeOver(session()).a11y();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.detail).toContain("@axe-core/playwright");
  });
});

describe("PlaywrightRuntime vitals", () => {
  it("parses the metrics the page reported", async () => {
    const built = session({
      page: {
        evaluate: (expression) => {
          expect(expression).toBe(VITALS_EXPRESSION);
          return Promise.resolve(JSON.stringify({ lcp: 104, cls: 0.76, ttfb: 20, fcp: 80, inp: null }));
        },
      },
    });
    const out = await runtimeOver(built).vitals();
    expect(out.ok && out.data).toEqual({ lcp: 104, cls: 0.76, ttfb: 20, fcp: 80, inp: null });
  });

  it("accepts an already-structured return as well as a JSON string", async () => {
    const built = session({
      page: { evaluate: () => Promise.resolve({ lcp: 900, cls: 0, ttfb: 1, fcp: 2, inp: null }) },
    });
    const out = await runtimeOver(built).vitals();
    expect(out.ok && out.data.lcp).toBe(900);
  });

  it("keeps an unread metric NULL rather than reporting a good zero", async () => {
    const built = session({ page: { evaluate: () => Promise.resolve(JSON.stringify({})) } });
    const out = await runtimeOver(built).vitals();
    expect(out.ok && out.data).toEqual({ lcp: null, cls: null, ttfb: null, fcp: null, inp: null });
  });

  it("fails loudly when the metrics payload cannot be parsed", async () => {
    const built = session({ page: { evaluate: () => Promise.resolve("not json") } });
    const out = await runtimeOver(built).vitals();
    expect(out.ok).toBe(false);
  });

  it("passes an evaluation failure through instead of inventing metrics", async () => {
    const built = session({ page: { evaluate: () => Promise.reject(new Error("Execution context destroyed")) } });
    const out = await runtimeOver(built).vitals();
    expect(out.ok).toBe(false);
  });
});

describe("PlaywrightRuntime close", () => {
  it("closes the context", async () => {
    const built = session();
    const runtime = runtimeOver(built);
    await runtime.getTitle();
    expect((await runtime.close()).ok).toBe(true);
    expect(built.calls.closed).toBe(1);
  });

  it("is a no-op — not a failure — when nothing was ever opened", async () => {
    const built = session();
    const open = vi.fn(() => Promise.resolve(built.session));
    const out = await new PlaywrightRuntime("run_1", open).close();
    expect(out.ok).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(built.calls.closed).toBe(0);
  });

  it("keeps NOTHING for a visitor with no session path — an anonymous visitor stays anonymous", async () => {
    // Saving state for an anonymous profile would make the NEXT run of it a
    // returning visitor nobody asked for.
    const built = session({ saveStatePath: null });
    const runtime = runtimeOver(built);
    await runtime.getTitle();
    expect((await runtime.close()).ok).toBe(true);
    expect(built.calls.statesSaved).toEqual([]);
  });

  it("saves the returning visitor's session BEFORE closing the context", async () => {
    const built = session({ saveStatePath: "/e/visitors/oslo-mobile.json" });
    const runtime = runtimeOver(built);
    await runtime.getTitle();
    expect((await runtime.close()).ok).toBe(true);
    expect(built.calls.statesSaved).toEqual(["/e/visitors/oslo-mobile.json"]);
    expect(built.calls.closed).toBe(1);
  });

  it("REPORTS a session that could not be saved, even though the close succeeded", async () => {
    // A green close would be the only trace of it, and the next run of the
    // profile would silently be a first-time visitor calling itself returning.
    const built = session({
      saveStatePath: "/nope/visitors/oslo-mobile.json",
      saveStorageState: () => Promise.reject(new Error("ENOENT: no such file or directory")),
    });
    const runtime = runtimeOver(built);
    await runtime.getTitle();
    const out = await runtime.close();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.detail).toContain("ENOENT");
    // The browser is still closed: leaking a process would be a second failure.
    expect(built.calls.closed).toBe(1);
  });

  it("reports a failed close even when the session was saved", async () => {
    const built = session({ saveStatePath: "/e/visitors/oslo-mobile.json" });
    built.session.context.close = () => Promise.reject(new Error("Target page, context or browser has been closed"));
    const runtime = runtimeOver(built);
    await runtime.getTitle();
    const out = await runtime.close();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.kind).toBe("exit");
  });
});

describe("PlaywrightRuntime input", () => {
  it("fills, presses, selects and checks", async () => {
    const filled: string[] = [];
    const selected: string[][] = [];
    let checked = 0;
    const built = session({
      locator: {
        fill: (value) => {
          filled.push(value);
          return Promise.resolve();
        },
        selectOption: (values) => {
          selected.push(values);
          return Promise.resolve(null);
        },
        check: () => {
          checked++;
          return Promise.resolve();
        },
      },
    });
    const runtime = runtimeOver(built);
    expect((await runtime.fill("#email", "qa@example.test")).ok).toBe(true);
    expect((await runtime.press("Enter")).ok).toBe(true);
    expect((await runtime.select("#topic", ["support"])).ok).toBe(true);
    expect((await runtime.check("#consent")).ok).toBe(true);
    expect(filled).toEqual(["qa@example.test"]);
    expect(selected).toEqual([["support"]]);
    expect(checked).toBe(1);
    expect(built.calls.keys).toEqual(["Enter"]);
    expect(built.calls.selectors).toEqual(["#email", "#topic", "#consent"]);
  });

  it("MASKS the filled value in the command string", async () => {
    const out = await runtimeOver(session()).fill("#password", "hunter2-the-real-one");
    expect(out.command).toBe("playwright:fill #password <redacted>");
    expect(JSON.stringify(out)).not.toContain("hunter2-the-real-one");
  });

  it("reports a failed fill as a typed failure, with the value still masked", async () => {
    const built = session({ locator: { fill: () => Promise.reject(new Error("Timeout 30000ms exceeded")) } });
    const out = await runtimeOver(built).fill("#email", "secret-value");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.kind).toBe("timeout");
    expect(JSON.stringify(out)).not.toContain("secret-value");
  });
});

// ── The code that runs INSIDE the page ──────────────────────────────────────
//
// `VITALS_EXPRESSION` and `INTERACTION_OBSERVER_SCRIPT` are strings evaluated by
// the browser, which makes them the one part of this adapter that every test
// above leaves untouched: those assert what we do with a metrics payload, never
// that the payload is right. Node has no `PerformanceObserver` and no `window`,
// so both arrive injected and the real source is executed against them.

type FakeEntry = Record<string, unknown>;
type Deliver = (list: { getEntries: () => FakeEntry[] }) => void;

/** A page that already has a fast, stable, uninteracted-with load behind it. */
const SETTLED_TIMELINE: Record<string, FakeEntry[]> = {
  navigation: [{ responseStart: 20 }],
  paint: [{ name: "first-contentful-paint", startTime: 80 }],
  "largest-contentful-paint": [{ startTime: 104 }],
  "layout-shift": [{ value: 0.05, hadRecentInput: false }],
};

interface Timeline {
  /** What `performance.getEntriesByType` already holds. */
  sync?: Record<string, FakeEntry[]>;
  /** What a buffered observer delivers a task later, per entry type. */
  buffered?: Record<string, FakeEntry[]>;
  /** Entry types the browser admits to supporting. */
  supported?: string[];
  /** The page's globals — the interaction map lands here. */
  window?: Record<string, unknown>;
}

async function evaluateVitals(timeline: Timeline = {}): Promise<Vitals> {
  const sync = { ...SETTLED_TIMELINE, ...timeline.sync };
  const buffered = timeline.buffered ?? {};
  const supported = timeline.supported ?? ["paint", "largest-contentful-paint", "layout-shift", "event", "first-input"];

  class FakeObserver {
    static supportedEntryTypes = supported;
    constructor(private readonly callback: Deliver) {}
    observe(init: { type: string }): void {
      const entries = buffered[init.type] ?? [];
      // A buffered observer delivers in a later task, and an EMPTY buffer never
      // calls back at all — which is what the expression's own timeout is for.
      if (entries.length) setTimeout(() => this.callback({ getEntries: () => entries }), 0);
    }
    disconnect(): void {}
  }

  const run = new Function("window", "performance", "PerformanceObserver", `return ${VITALS_EXPRESSION};`) as unknown as (
    win: Record<string, unknown>,
    perf: { getEntriesByType: (type: string) => FakeEntry[] },
    observer: unknown,
  ) => Promise<string>;
  const raw = await run(timeline.window ?? {}, { getEntriesByType: (type) => sync[type] ?? [] }, FakeObserver);
  return JSON.parse(raw) as Vitals;
}

/** Install the init script into a fake page, and hand back a way to fire events. */
function arm(
  win: Record<string, unknown>,
  options: { unsupported?: boolean } = {},
): { inits: unknown[]; emit: (entries: FakeEntry[]) => void } {
  const inits: unknown[] = [];
  let deliver: Deliver | null = null;
  class FakeObserver {
    constructor(callback: Deliver) {
      deliver = callback;
    }
    observe(init: unknown): void {
      if (options.unsupported) throw new Error("Unsupported entry type: event");
      inits.push(init);
    }
    disconnect(): void {}
  }
  const install = new Function("window", "PerformanceObserver", INTERACTION_OBSERVER_SCRIPT) as unknown as (
    w: Record<string, unknown>,
    o: unknown,
  ) => void;
  install(win, FakeObserver);
  return { inits, emit: (entries) => deliver?.({ getEntries: () => entries }) };
}

describe("INTERACTION_OBSERVER_SCRIPT", () => {
  it("arms a BUFFERED observer at the lowest threshold the spec allows", () => {
    // Chromium's default event-timing buffer keeps only entries above ~104ms, so
    // an observer armed at read time reports a fast page as never interacted with.
    const { inits } = arm({});
    expect(inits).toEqual([{ type: "event", buffered: true, durationThreshold: 16 }]);
  });

  it("keeps the WORST duration per interaction, because INP is the worst interaction", () => {
    // One interaction emits pointerdown, pointerup and click under a shared
    // interactionId; counting them separately would report the same tap twice.
    const win: Record<string, unknown> = {};
    const { emit } = arm(win);
    emit([
      { interactionId: 5, duration: 40 },
      { interactionId: 5, duration: 120 },
      { interactionId: 6, duration: 8 },
    ]);
    expect(win[INTERACTION_KEY]).toEqual({ 5: 120, 6: 8 });
  });

  it("ignores an event that was not part of an interaction", () => {
    // interactionId 0 is a hover or a programmatic dispatch — no INP meaning.
    const win: Record<string, unknown> = {};
    arm(win).emit([{ interactionId: 0, duration: 900 }]);
    expect(win[INTERACTION_KEY]).toEqual({});
  });

  it("does not re-arm, so a second install cannot drop what is already recorded", () => {
    const win: Record<string, unknown> = {};
    arm(win).emit([{ interactionId: 1, duration: 64 }]);
    const second = arm(win);
    expect(second.inits).toEqual([]);
    expect(win[INTERACTION_KEY]).toEqual({ 1: 64 });
  });

  it("leaves the map EMPTY rather than throwing when the browser has no Event Timing", () => {
    // An empty map reads back as "not measured". A missing map would send the
    // vitals read down its buffered fallback, and a throw here would break the
    // page's first script.
    const win: Record<string, unknown> = {};
    arm(win, { unsupported: true });
    expect(win[INTERACTION_KEY]).toEqual({});
  });
});

describe("VITALS_EXPRESSION", () => {
  it("reads every metric off the timeline the page already has", async () => {
    expect(await evaluateVitals()).toEqual({ lcp: 104, cls: 0.05, ttfb: 20, fcp: 80, inp: null });
  });

  it("takes the LAST largest-contentful-paint entry — LCP is the final candidate", async () => {
    const vitals = await evaluateVitals({ sync: { "largest-contentful-paint": [{ startTime: 100 }, { startTime: 420 }] } });
    expect(vitals.lcp).toBe(420);
  });

  it("reports CLS as ZERO when the observer ran and nothing moved", async () => {
    // Reporting null here made `cls-below` unreadable on a perfectly stable page.
    const vitals = await evaluateVitals({ sync: { "layout-shift": [] } });
    expect(vitals.cls).toBe(0);
  });

  it("reports CLS as null ONLY when the browser cannot observe layout shifts", async () => {
    const vitals = await evaluateVitals({ supported: ["paint", "largest-contentful-paint"] });
    expect(vitals.cls).toBeNull();
  });

  it("excludes a layout shift the visitor's own interaction caused", async () => {
    const vitals = await evaluateVitals({
      sync: { "layout-shift": [{ value: 0.4, hadRecentInput: true }, { value: 0.01, hadRecentInput: false }] },
    });
    expect(vitals.cls).toBe(0.01);
  });

  it("reports INP as the worst interaction the armed observer recorded", async () => {
    const vitals = await evaluateVitals({ window: { [INTERACTION_KEY]: { 7: 40, 9: 208 } } });
    expect(vitals.inp).toBe(208);
  });

  it("keeps INP null when the journey never interacted, rather than reporting a fast zero", async () => {
    // A visitor who never touched the page has no INP, and a 0 would pass every
    // threshold anyone could set on it.
    const vitals = await evaluateVitals({ window: { [INTERACTION_KEY]: {} } });
    expect(vitals.inp).toBeNull();
  });

  it("reports the FIRST interaction when it is the only one the browser kept", async () => {
    // `first-input` has no duration threshold, so it is what makes a fast
    // interaction measurable at all.
    const vitals = await evaluateVitals({
      window: { [INTERACTION_KEY]: {} },
      sync: { "first-input": [{ duration: 24 }] },
    });
    expect(vitals.inp).toBe(24);
  });

  it("takes the worst of the armed map and the first interaction together", async () => {
    const vitals = await evaluateVitals({
      window: { [INTERACTION_KEY]: { 3: 96 } },
      sync: { "first-input": [{ duration: 312 }] },
    });
    expect(vitals.inp).toBe(312);
  });

  it("falls back to the buffered event entries when nothing was armed before load", async () => {
    // A context built without the init script sees only what Chromium's default
    // buffer kept — worse than the armed path, better than reporting nothing.
    const vitals = await evaluateVitals({
      buffered: {
        event: [
          { interactionId: 1, duration: 120 },
          { interactionId: 1, duration: 180 },
          { interactionId: 2, duration: 144 },
        ],
      },
    });
    expect(vitals.inp).toBe(180);
  });

  it("ignores non-interaction events in that fallback too", async () => {
    const vitals = await evaluateVitals({ buffered: { event: [{ interactionId: 0, duration: 900 }] } });
    expect(vitals.inp).toBeNull();
  });

  it("reports exactly what the armed script recorded — the writer and the reader agree", async () => {
    // The pair is the claim: an observer armed before load, read back by the
    // vitals expression, produces a real INP for a journey that clicked.
    const win: Record<string, unknown> = {};
    arm(win).emit([
      { interactionId: 11, duration: 56 },
      { interactionId: 12, duration: 232 },
    ]);
    expect((await evaluateVitals({ window: win })).inp).toBe(232);
  });
});

describe("getText settles an EMPTY reading", () => {
  it("re-reads once when the first read returns nothing", async () => {
    // Playwright auto-waits for the element to be ATTACHED, and a client-rendered shell's
    // <html> is attached before a single character exists. Measured on xala.no: 0 chars at
    // load, 6,077 one second later — and the engine filed that as a site defect.
    let call = 0;
    const built = session({
      locator: {
        innerText: () => {
          call += 1;
          return Promise.resolve(call === 1 ? "" : "Vi bygger saksbehandlingssystemer");
        },
      },
    });
    expect(dataOf(await runtimeOver(built).getText("html"))).toBe("Vi bygger saksbehandlingssystemer");
    expect(call).toBe(2);
  });

  it("does NOT re-read a page that rendered text and simply lacks the value", async () => {
    // The silent retry this engine refuses everywhere else. A non-empty read is a real reading
    // of a real page, and re-reading it would turn an intermittent site defect into a green
    // run — exactly the damage `--repeat` exists to avoid doing.
    let call = 0;
    const built = session({
      locator: {
        innerText: () => {
          call += 1;
          return Promise.resolve("hello");
        },
      },
    });
    expect(dataOf(await runtimeOver(built).getText("body"))).toBe("hello");
    expect(call).toBe(1);
  });

  it("hands back the empty string when the page really did render nothing", async () => {
    // A settle is not a guarantee, and this does not pretend it is: `assertions.ts` reports a
    // still-empty read as unreadable rather than as a site failure.
    const built = session({ locator: { innerText: () => Promise.resolve("") } });
    expect(dataOf(await runtimeOver(built).getText("body"))).toBe("");
  });
});

describe("visibleCount", () => {
  it("reports how many VISIBLE elements a selector matched", async () => {
    // For the evidence, not for a check: it lets a report tell "the first of three search
    // results" from "the nav link that happened to come first in the document".
    const built = session({ locator: { visibleCount: () => Promise.resolve(7) } });
    expect(dataOf(await runtimeOver(built).visibleCount("nav a"))).toBe(7);
  });

  it("passes a browser failure through rather than reporting a count of zero", async () => {
    // Zero visible elements and "we could not count" are different facts, and only one of
    // them says anything about the page.
    const built = session({ locator: { visibleCount: () => Promise.reject(new Error("detached")) } });
    const out = await runtimeOver(built).visibleCount("nav a");
    expect(out.ok).toBe(false);
  });
});
