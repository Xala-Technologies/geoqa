/**
 * The one file that knows the real `playwright` package exists.
 *
 * Everything here is I/O and adaptation: launch a browser, create a context with
 * a geographic identity, register the listeners whose buffers `PlaywrightRuntime`
 * reads, and map the real API onto the structural interfaces in
 * `playwright.ts`. There is no judgement to test — which is why this file is
 * coverage-excluded and `playwright.ts`, which holds all of the behaviour, is
 * not.
 *
 * Adapting explicitly (an object literal per interface) rather than passing
 * Playwright's objects through structurally is deliberate: Playwright's
 * `evaluate` and `screenshot` are heavily overloaded, and relying on
 * assignability would make an upstream signature change a puzzle here instead of
 * a compile error.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright";
import type { ConsoleMessage, NetworkRequest, PageError } from "./types.js";
import { INTERACTION_OBSERVER_SCRIPT, type PwContext, type PwLocator, type PwObserved, type PwPage, type PwSession } from "./playwright.js";

/**
 * A context's geographic and device identity.
 *
 * Primitives only, no `GeoProfile`: `browser/` is the bottom layer and must not
 * import from `geo/`. The caller that knows about profiles does the mapping.
 */
export interface PlaywrightContextOptions {
  /** agent-browser's `--proxy` equivalent. `null` = direct egress. */
  proxyUrl: string | null;
  /** Comma-separated hosts to bypass, e.g. a local fixture server. */
  proxyBypass: string | null;
  locale: string;
  timezoneId: string;
  coordinates: { latitude: number; longitude: number };
  viewport: { width: number; height: number };
  userAgent: string | null;
  /** A key of Playwright's `devices`, e.g. "Pixel 5". */
  deviceName: string | null;
  headed: boolean;
  /** Identifies which context served a call, for the run record. */
  identity: string;
  /**
   * Where Playwright should record the HAR, or `null`/absent for no recording.
   *
   * A context option because that is the only thing it can be: the recording is
   * armed before the first navigation or never, and it is flushed when the
   * context closes. `PwSession.harPath` carries the same value up so
   * `harStart`/`harStop` can answer about it truthfully.
   *
   * The three fields below are the ONLY optional ones on this interface, and
   * deliberately so: every geographic axis stays required, because a caller that
   * forgets one produces a run that claims a market it never reached, while a
   * caller that wants neither a HAR nor a visitor session (a one-off context, an
   * e2e probe) should not have to say so twice. `string | null` rather than a
   * bare optional so the caller that DOES care can be explicit.
   */
  harPath?: string | null;
  /**
   * A previously saved session (cookies + localStorage) to open the context with
   * — this is what makes a `returning` visitor real rather than declared.
   *
   * The file must exist: Playwright throws on a missing `storageState` path, and
   * the decision about whether a returning visitor was actually restored belongs
   * above this layer, where it can be reported instead of swallowed.
   */
  restoreStatePath?: string | null;
  /** Where to write the session when the context closes. `null` keeps nothing. */
  saveStatePath?: string | null;
  /** Override the visibility budget. Lowered in tests so they stay fast. */
  visibilityTimeoutMs?: number;
}

/**
 * Launch once, then hand out contexts.
 *
 * **No launch-level proxy.** Older Playwright needed a
 * `proxy: { server: "per-context" }` placeholder before a context-level proxy was
 * honoured, and that advice is now actively wrong: measured against Playwright
 * 1.62, the placeholder makes Chromium treat "per-context" as a real proxy host
 * and every HTTP navigation dies with `ERR_PROXY_CONNECTION_FAILED`. It was
 * caught by the end-to-end suite failing at step 0 of every journey — a fake
 * runtime could never have found it.
 *
 * Contexts set their own proxy, which is what makes N geographic identities
 * possible inside ONE browser process — the entire reason for preferring
 * Playwright here.
 */
export function launchBrowser(headed: boolean): Promise<Browser> {
  return chromium.launch({ headless: !headed });
}

/**
 * A selector, as the two kinds of question a journey asks of it.
 *
 * Playwright locators are STRICT: a selector matching more than one element makes
 * `isVisible`, `innerText` and `click` throw rather than answer. agent-browser
 * tolerated multi-match and acted on the first hit, so journeys were written that
 * way — `selector-visible` with `nav, header nav, [role='navigation']` is exactly
 * the idiom, one selector listing the places a nav might live.
 *
 * Found by running the `browse` journey against the real digilist.no homepage,
 * where that selector resolves to TWELVE elements: the strict-mode violation
 * surfaced as an `unreadable` check, so the engine reported its own blindness and
 * the run came back ERROR. The fixture pages are too simple to have caught it.
 *
 * So the read-and-act calls take `.first()` — "is ANY match visible", which is the
 * question `selector-visible` is asking. Three deliberately do not:
 *
 *   count               must see every match; that is its whole purpose.
 *   fill/select/check   a form selector resolving to twelve controls is a bug in
 *                       the journey, and filling the first one silently would hide
 *                       it. Let strict mode fail loudly here.
 */
/**
 * A proxy URL, as Playwright wants it.
 *
 * Credentials must be SEPARATE fields. Chromium's `--proxy-server` ignores
 * userinfo embedded in the URL, so passing
 * `http://user:pass@gate.vendor.com:7000` as `server` produces a proxy that is
 * reached but never authenticated: every navigation then hangs until it times out,
 * with no error naming the cause. Measured against a real residential gateway —
 * `page.goto` failed with `Timeout 30000ms exceeded` and the egress read as
 * `never read`, which looks exactly like an unreachable vendor.
 *
 * `decodeURIComponent` because a vendor password is percent-encoded on the way
 * into the URL and Chromium needs the raw bytes.
 */
export function playwrightProxy(
  proxyUrl: string,
  bypass: string | null,
): { server: string; username?: string; password?: string; bypass?: string } {
  const parsed = new URL(proxyUrl);
  const username = parsed.username ? decodeURIComponent(parsed.username) : "";
  const password = parsed.password ? decodeURIComponent(parsed.password) : "";
  parsed.username = "";
  parsed.password = "";
  return {
    // Chromium wants scheme://host:port with no trailing path.
    server: parsed.toString().replace(/\/$/, ""),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(bypass ? { bypass } : {}),
  };
}

/**
 * How long to let an element become visible before calling it absent.
 *
 * Deliberately seconds. The cost of waiting is a slower run on a genuinely
 * missing element; the cost of not waiting is a false site defect, and this
 * project would rather be slow than wrong.
 */
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 5_000;

const asLocator = (page: Page, selector: string, visibilityTimeoutMs: number): PwLocator => {
  const all = page.locator(selector);
  const one = all.first();
  return {
    innerText: () => one.innerText(),
    count: () => all.count(),
    /**
     * "Is ANY match visible", and WAIT for it rather than sampling once.
     *
     * Two lessons, both measured against digilist.no.
     *
     * The multi-match part: `nav, header nav, [role='navigation']` resolves to 12
     * elements there, 7 visible, and the invisible ones are collapsed mobile
     * drawers — so asking only about `.first()` reports a perfectly good desktop
     * nav as absent depending on DOM order.
     *
     * The WAITING part is the one that cost real credibility. A single sample plus
     * a 600ms settle in the runtime reported a missing `h1` on six pages whose
     * HTML demonstrably contained one; all six passed when re-run alone. The
     * engine was manufacturing site defects out of its own load. Playwright's
     * locators auto-wait, which is precisely the tool for this — a poll-and-settle
     * reimplemented on top of it was strictly worse.
     *
     * A timeout returns `false`, not a throw: "not visible within the budget" is a
     * real reading about the page. The budget has to be generous enough that a
     * slow machine cannot fabricate a defect, which is why it is seconds and not
     * milliseconds.
     */
    isVisible: async () => {
      try {
        await all.filter({ visible: true }).first().waitFor({ state: "visible", timeout: visibilityTimeoutMs });
        return true;
      } catch {
        return false;
      }
    },
    click: () => one.click(),
    ariaSnapshot: () => one.ariaSnapshot(),
    fill: (value) => all.fill(value),
    selectOption: (values) => all.selectOption(values),
    check: () => all.check(),
  };
};

const asPage = (page: Page, visibilityTimeoutMs: number): PwPage => ({
  goto: async (url) => {
    await page.goto(url);
  },
  reload: async () => {
    await page.reload();
  },
  title: () => page.title(),
  url: () => page.url(),
  evaluate: (expression) => page.evaluate(expression),
  locator: (selector) => asLocator(page, selector, visibilityTimeoutMs),
  waitForSelector: async (selector) => {
    await page.waitForSelector(selector);
  },
  waitForTimeout: (ms) => page.waitForTimeout(ms),
  setViewportSize: (size) => page.setViewportSize(size),
  screenshot: async (options) => {
    await page.screenshot(options);
  },
  wheel: (deltaX, deltaY) => page.mouse.wheel(deltaX, deltaY),
  pressKey: (key) => page.keyboard.press(key),
});

const asContext = (context: BrowserContext): PwContext => ({
  setGeolocation: (coords) => context.setGeolocation(coords),
  setExtraHTTPHeaders: (headers) => context.setExtraHTTPHeaders(headers),
  startTracing: () => context.tracing.start({ screenshots: true, snapshots: true }),
  stopTracing: (path) => context.tracing.stop({ path }),
  saveStorageState: async (target) => {
    // The parent directory is ours to create: the visitor store lives beside the
    // run directories rather than inside one, so nothing else has made it.
    mkdirSync(dirname(target), { recursive: true });
    await context.storageState({ path: target });
  },
  close: () => context.close(),
});

/**
 * Create the context and start collecting.
 *
 * The listeners are registered BEFORE the first navigation on purpose: a console
 * error thrown during initial load is exactly the kind a journey asserts on, and
 * attaching afterwards would miss it while still reporting "no console errors".
 *
 * Geolocation is GRANTED here rather than stubbed in page script. Under
 * agent-browser the permission was denied by headless Chrome and had to be faked
 * by overwriting `navigator.geolocation`; a context that grants it means a site
 * localising off the real API is exercised through the real path.
 *
 * `recordHar` and `storageState` are here for the same structural reason the
 * listeners are: both are context-creation options, so "later" does not exist for
 * them. A HAR armed after the first navigation would be missing the load it was
 * collected to explain, and a session restored after the first navigation would
 * have the page already rendered for an anonymous visitor.
 */
export async function openContext(browser: Browser, options: PlaywrightContextOptions): Promise<PwSession> {
  const device = options.deviceName === null ? {} : (devices[options.deviceName] ?? {});
  const harPath = options.harPath ?? null;
  // The HAR's directory is normally the run's evidence directory, made when the
  // init script was written — but a launch must not die because a caller created
  // its runtime without going through `prepareRun`.
  if (harPath !== null) mkdirSync(dirname(harPath), { recursive: true });
  const context = await browser.newContext({
    ...device,
    locale: options.locale,
    timezoneId: options.timezoneId,
    geolocation: options.coordinates,
    permissions: ["geolocation"],
    viewport: options.viewport,
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    ...(options.restoreStatePath ? { storageState: options.restoreStatePath } : {}),
    ...(harPath
      ? {
          recordHar: {
            path: harPath,
            // `full`, because `minimal` keeps only what HAR replay needs and
            // drops the timings, sizes and headers that make a HAR worth opening
            // during a failure investigation.
            mode: "full" as const,
            // Response bodies are OMITTED. A HAR is written by Playwright
            // straight to disk and never passes through `redactDeep`, so
            // anything it carries is unredactable by construction; bodies are the
            // largest and most personal part of that. What remains is still
            // enough to see what was requested, in what order, and how long it
            // took.
            content: "omit" as const,
          },
        }
      : {}),
    ...(options.proxyUrl ? { proxy: playwrightProxy(options.proxyUrl, options.proxyBypass ?? null) } : {}),
  });

  // Arm the interaction observer before any document's own scripts. INP cannot be
  // reconstructed afterwards — see INTERACTION_OBSERVER_SCRIPT — so a read-time
  // observer would report a fast page as unmeasured.
  await context.addInitScript({ content: INTERACTION_OBSERVER_SCRIPT });

  const consoleMessages: ConsoleMessage[] = [];
  const pageErrors: PageError[] = [];
  const requests: NetworkRequest[] = [];

  context.on("console", (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });
  context.on("weberror", (error) => {
    pageErrors.push({ message: error.error().message, stack: error.error().stack ?? null });
  });
  context.on("response", (response) => {
    const request = response.request();
    requests.push({
      url: response.url(),
      method: request.method(),
      status: response.status(),
      resourceType: request.resourceType(),
    });
  });
  // A request that never got a response is still a fact worth having — a failed
  // asset shows up here and nowhere else.
  context.on("requestfailed", (request) => {
    requests.push({
      url: request.url(),
      method: request.method(),
      status: null,
      resourceType: request.resourceType(),
    });
  });

  const page = await context.newPage();
  const observed = (): PwObserved => ({
    console: [...consoleMessages],
    errors: [...pageErrors],
    requests: [...requests],
  });

  return {
    page: asPage(page, options.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS),
    context: asContext(context),
    observed,
    deviceName: options.deviceName,
    harPath,
    saveStatePath: options.saveStatePath ?? null,
    identity: options.identity,
  };
}

/**
 * The `PwOpen` a `PlaywrightRuntime` is constructed with: launches a browser and
 * opens one context, closing the browser when the context closes so a run leaves
 * no orphan process behind.
 *
 * The context is closed BEFORE the browser, and that order is load-bearing now
 * that a HAR is recorded: `context.close()` is what flushes it, and killing the
 * browser first would leave a truncated file where the manifest expects one.
 */
export function playwrightOpener(options: PlaywrightContextOptions): () => Promise<PwSession> {
  return async () => {
    const browser = await launchBrowser(options.headed);
    const session = await openContext(browser, options);
    const closeContext = session.context.close;
    return {
      ...session,
      context: {
        ...session.context,
        close: async () => {
          await closeContext();
          await browser.close();
        },
      },
    };
  };
}
