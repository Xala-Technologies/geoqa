/**
 * The Playwright implementation of `BrowserRuntime`.
 *
 * This exists beside `agent-browser.ts` rather than replacing it, because the
 * seam was built for exactly this: nothing above `BrowserRuntime` knows which
 * engine served a run, so journeys, geo verification, evidence, findings and
 * confidence are untouched by the swap.
 *
 * Why Playwright for Phase 1, in the order the reasons matter:
 *
 *   1. **A proxy per browser context.** agent-browser keys a browser PROCESS by
 *      its launch flags, so one profile is one Chrome and market coverage costs
 *      one process each. Playwright gives every context its own network
 *      identity, which is what turns a 9-location × 2-device × 5-journey matrix
 *      from an overnight job into a nightly one.
 *   2. **A real geolocation permission.** Headless Chrome under agent-browser
 *      DENIES the permission, so the locale init script had to stub
 *      `getCurrentPosition`. A Playwright context grants it properly, so a site
 *      that localises off the Geolocation API is tested against the real flow.
 *   3. **Tracing is start/stop.** HAR and video are context-creation options in
 *      Playwright, but tracing is not — which is what finally lets the `fail`
 *      retention tier actually contain a trace.
 *   4. **A returning visitor is expressible.** `storageState` is cookies and
 *      localStorage from a previous session, which is exactly what a profile
 *      means by `visitorType: returning`. agent-browser keys its storage to the
 *      session name, and the session name is the run id, so there every run is a
 *      first-time visitor whatever the profile claims.
 *
 * The rule that survives the swap unchanged, and matters most: **transport
 * garbage must never be parseable as a result.** A library throws where a CLI
 * returned an envelope, so every call here is wrapped and every throw becomes a
 * named failure. Letting a Playwright `TimeoutError` propagate out of a check
 * would collapse the failed-vs-errored distinction — the engine would report its
 * own blindness as a site defect, which is the one thing this project exists not
 * to do.
 */
import { toVitals } from "./map.js";
import type { ExecFailureKind, ExecOutcome } from "./exec.js";
import type {
  A11yViolation,
  BrowserResult,
  BrowserRuntime,
  ConsoleMessage,
  NavigateResult,
  NetworkRequest,
  PageError,
  ScreenshotOptions,
  SnapshotOptions,
  Vitals,
} from "./types.js";

/**
 * How long to settle before believing an element is not visible.
 *
 * Same doctrine and the same settle as the agent-browser adapter's
 * confirm-absence retry: a first negative reading is treated as "not ready", not
 * as "not there". Measured under load, a demonstrably present `h1` failed the
 * check in 3 of 4 runs while the engine drove ~55 concurrent browsers.
 */
export const DEFAULT_ABSENCE_SETTLE_MS = 600;

/** Default wheel distance for a `scroll` with no explicit pixel count. */
export const DEFAULT_SCROLL_PX = 600;

/**
 * Why a HAR cannot be produced by a context that was not created for one.
 *
 * `recordHar` is a CONTEXT-CREATION option: the recording is armed before the
 * first navigation or it does not exist. A mid-session start is not merely
 * unsupported by the API — it would be the wrong artifact, missing the page load
 * the HAR was collected to explain.
 */
export const HAR_NOT_ARMED =
  "HAR must be requested when the context is created; this context was created without it";

/**
 * What `harStop` used to say, and why it no longer needs to.
 *
 * Playwright writes the HAR when the context CLOSES, so a `harStop` that merely asked nicely
 * genuinely could not produce the file, and this message said so rather than describing a
 * `har` artifact nothing had written — the 221-byte-file failure the agent-browser path had
 * already made once.
 *
 * The message was honest and the situation it described was still a defect: the manifest
 * reported `har` MISSING on every fail-tier run, holding completeness at 88% for an artifact
 * that was sitting on disk moments later. Refusing accurately is not the same as being right.
 *
 * `harStop` now CLOSES the context, because on this engine that IS the flush — see the comment
 * on the method. Kept exported because the wording is still the clearest statement of why the
 * ordering in `collectEvidence` is what it is, and a test pins it.
 */
export const harPendingDetail = (path: string): string =>
  `HAR is recording to ${path} and Playwright writes it when the context CLOSES; it cannot be flushed on demand, so the file does not exist yet`;

/**
 * Asked to flush somewhere other than where the recording was armed.
 *
 * Worth its own message: the caller is about to look for a HAR at a path nothing
 * will ever write, and reporting a generic refusal would leave the real file
 * sitting unlisted beside it.
 */
export const harElsewhereDetail = (armed: string, asked: string): string =>
  `HAR is recording to ${armed}, which is fixed at context creation; it cannot be written to ${asked}`;

// ── The slice of Playwright this adapter uses ─────────────────────────────
//
// Declared structurally rather than imported from `playwright`, so the whole
// adapter is testable with plain objects and the suite never launches Chromium.
// `playwright-launch.ts` is the only file that adapts the real API onto these.

export interface PwLocator {
  innerText(): Promise<string>;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  /**
   * How many VISIBLE elements this selector matches.
   *
   * Distinct from `count()`, which counts every match including hidden ones. On the seam
   * because the EVIDENCE needs it: a union in a click step is legitimate and ambiguous at the
   * same time, and recording the count is what lets a report tell "the first of three search
   * results" from "the nav link that happened to come first in the document". See gaps C-11.
   */
  visibleCount(): Promise<number>;
  click(): Promise<void>;
  ariaSnapshot(): Promise<string>;
  fill(value: string): Promise<void>;
  selectOption(values: string[]): Promise<unknown>;
  check(): Promise<void>;
}

export interface PwPage {
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  title(): Promise<string>;
  url(): string;
  evaluate(expression: string): Promise<unknown>;
  locator(selector: string): PwLocator;
  waitForSelector(selector: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
  pressKey(key: string): Promise<void>;
}

export interface PwContext {
  setGeolocation(coords: { latitude: number; longitude: number }): Promise<void>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  startTracing(): Promise<void>;
  stopTracing(path: string): Promise<void>;
  /** Cookies + localStorage, written where a later run can load them back. */
  saveStorageState(path: string): Promise<void>;
  close(): Promise<void>;
}

/** What the listeners registered at context creation have accumulated. */
export interface PwObserved {
  console: ConsoleMessage[];
  errors: PageError[];
  requests: NetworkRequest[];
}

export interface PwSession {
  page: PwPage;
  context: PwContext;
  observed(): PwObserved;
  /**
   * The device the context was built with, so `setDevice` can answer honestly
   * instead of pretending a context-creation option is settable at runtime.
   */
  deviceName: string | null;
  /**
   * Where the context will flush its HAR when it closes, or `null` when no
   * recording was armed. Carried for the same reason `deviceName` is: it is a
   * context-creation fact, and the only way `harStart`/`harStop` can answer about
   * it truthfully instead of guessing.
   */
  harPath: string | null;
  /**
   * Where to save cookies + localStorage when the context closes, or `null` for
   * a visitor whose session must NOT outlive the run.
   *
   * A `returning` profile is the only thing that sets this. An anonymous visitor
   * keeps nothing, because a state file written for one would silently make the
   * next run of that profile a returning visitor nobody asked for.
   */
  saveStatePath: string | null;
  /** Which context served a call. Stands in for agent-browser's `launchHash`. */
  identity: string;
}

const TIMEOUT = /timeout|timed out/i;
const GONE = /closed|crashed|disconnected|target page/i;

/**
 * Map a thrown Playwright error onto the transport's existing failure kinds.
 *
 * The kinds are deliberately NOT extended for Playwright. Everything above the
 * seam branches on `kind`, and adding engine-specific values would leak the
 * engine upward — the thing the seam exists to prevent. `reported` already means
 * "the tool told us it failed", which is what an assertion-free Playwright throw
 * is.
 */
export function classifyPlaywrightError(error: unknown): { kind: ExecFailureKind; detail: string } {
  const detail = error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || TIMEOUT.test(detail)) return { kind: "timeout", detail };
  if (GONE.test(detail)) return { kind: "exit", detail };
  return { kind: "reported", detail };
}

/**
 * Opens the browser context. Called at most once per runtime, on first use.
 *
 * Lazy on purpose: `buildRuntime` is synchronous, and every Temporal Activity
 * reconstructs its runtime from a serialisable `RunSpec` rather than carrying a
 * handle. Launching eagerly would force that seam to become async and ripple
 * through every stage. Deferring also means a launch failure arrives as a named
 * transport failure like any other, instead of as a throw from a constructor.
 */
export type PwOpen = () => Promise<PwSession>;

export interface PlaywrightRuntimeOptions {
  now?: () => number;
  absenceSettleMs?: number;
}

/**
 * The page global the interaction observer accumulates into, read back by
 * `VITALS_EXPRESSION`. Named once so the writer and the reader cannot drift.
 */
export const INTERACTION_KEY = "__geoqaInteractions";

/**
 * Arm an interaction observer in every document, BEFORE its own scripts run.
 *
 * INP is the one vital that cannot be reconstructed after the fact. Chromium's
 * default event-timing buffer only retains entries slower than ~104ms, so an
 * observer registered at read time sees whichever interactions happened to be
 * slow and NOTHING on a page where every response was quick — which is exactly
 * the reading that makes a fast page look unmeasured and a slow-but-not-terrible
 * one look faster than it was. Arming first is the same doctrine as registering
 * the console listener before the first navigation and arming the trace before
 * anything loads: you cannot go back and observe a moment that has passed.
 *
 * `durationThreshold: 16` is the lowest the Event Timing spec allows. An
 * interaction faster than one frame therefore stays invisible unless it was the
 * FIRST one, which `first-input` reports at any duration — so the value read back
 * can understate the truth by at most a frame. That bound is named rather than
 * hidden, and it is the honest cost of measuring from inside the page.
 */
export const INTERACTION_OBSERVER_SCRIPT = `(() => {
  const KEY = ${JSON.stringify(INTERACTION_KEY)};
  // Idempotent: re-arming would replace the map and drop interactions already
  // recorded for this document.
  if (window[KEY]) return;
  const worst = {};
  window[KEY] = worst;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // interactionId 0 means the event was not part of an interaction — a
        // hover, a programmatic dispatch — and carries no INP meaning.
        if (!entry.interactionId) continue;
        const seen = worst[entry.interactionId];
        if (seen === undefined || entry.duration > seen) worst[entry.interactionId] = entry.duration;
      }
    });
    observer.observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch {
    // A browser without Event Timing leaves the map EMPTY, which reads back as
    // "not measured" — never as a fast zero.
  }
})()`;

/**
 * Read Core Web Vitals from the page's own performance timeline.
 *
 * agent-browser shipped a `vitals` command; Playwright does not, so the metrics
 * are collected here. `buffered: true` matters — LCP and layout-shift entries
 * are emitted before any observer we register could exist, and without the
 * buffer a fast page reports no LCP at all.
 *
 * The subtle one is CLS. **No layout-shift entries means CLS is zero, not
 * unmeasured** — the observer ran and nothing moved. Reporting `null` there made
 * `cls-below` unreadable on a perfectly stable page, which the end-to-end suite
 * caught as an `instrumentation` finding on the healthy fixture. The genuine
 * "we could not measure it" case is a browser that does not support the entry
 * type at all, so that is what is checked, rather than inferring it from an
 * empty list. LCP is the opposite: there is no meaningful LCP of zero, so an
 * absent entry stays `null` and the engine's confirm-the-null retry decides.
 *
 * `inp` is a real number when the journey HAS interacted and `null` when it has
 * not. INP is the worst interaction latency (the p98 discount only starts above
 * 50 interactions, and a journey is nowhere near that), gathered from two
 * sources that overlap deliberately: the map `INTERACTION_OBSERVER_SCRIPT`
 * accumulated, and `first-input` — the one entry type that reports an interaction
 * regardless of how fast it was. No interaction entries at all means `null`: a
 * visitor who never touched the page has no INP, and a fabricated 0 would pass
 * every threshold. A duration that IS 0 is a measured interaction faster than
 * Event Timing's 8ms granularity, which is a reading, not an absence.
 */
export const VITALS_EXPRESSION = `(async () => {
  // An LCP or layout-shift entry can still be EMITTED while we read, so those
  // reads wait out a settle. Interactions are the opposite: a click that has not
  // happened will not happen while we look, so their window only has to cover
  // the observer's own delivery task. Waiting 400ms for them would add that to
  // every vitals read on every read-only journey, for nothing.
  const EMIT_WAIT_MS = 400;
  const INTERACTION_WAIT_MS = 150;
  const supported = (type) => {
    try { return (PerformanceObserver.supportedEntryTypes || []).indexOf(type) !== -1; } catch { return false; }
  };
  const read = (type, waitMs) => new Promise((resolve) => {
    try {
      const existing = performance.getEntriesByType(type);
      if (existing.length) return resolve(existing);
      const observer = new PerformanceObserver((list) => { observer.disconnect(); resolve(list.getEntries()); });
      observer.observe({ type, buffered: true });
      setTimeout(() => { observer.disconnect(); resolve(performance.getEntriesByType(type)); }, waitMs);
    } catch { resolve([]); }
  });
  // One interaction can emit several events (pointerdown, pointerup, click); they
  // share an interactionId and INP counts the worst of them, once.
  const worstPerInteraction = (entries) => {
    const worst = {};
    for (const entry of entries) {
      if (!entry.interactionId) continue;
      const seen = worst[entry.interactionId];
      if (seen === undefined || entry.duration > seen) worst[entry.interactionId] = entry.duration;
    }
    return Object.keys(worst).map((id) => worst[id]);
  };
  const navigation = performance.getEntriesByType('navigation')[0] || null;
  const paints = await read('paint', EMIT_WAIT_MS);
  const lcps = await read('largest-contentful-paint', EMIT_WAIT_MS);
  const shifts = await read('layout-shift', EMIT_WAIT_MS);
  const fcp = paints.find((p) => p.name === 'first-contentful-paint') || null;
  const lcp = lcps.length ? lcps[lcps.length - 1] : null;
  const cls = shifts.filter((s) => !s.hadRecentInput).reduce((total, s) => total + s.value, 0);
  const armed = (() => { try { return window[${JSON.stringify(INTERACTION_KEY)}] || null; } catch { return null; } })();
  // No armed map means no observer ran before load (a context built without the
  // init script), so all that is left is whatever the default event-timing buffer
  // kept — the slow interactions only. Worse than the armed path, and better
  // than reporting nothing at all.
  const latencies = armed
    ? Object.keys(armed).map((id) => armed[id])
    : worstPerInteraction(await read('event', INTERACTION_WAIT_MS));
  for (const entry of await read('first-input', INTERACTION_WAIT_MS)) latencies.push(entry.duration);
  return JSON.stringify({
    lcp: lcp ? lcp.startTime : null,
    cls: supported('layout-shift') ? cls : null,
    ttfb: navigation ? navigation.responseStart : null,
    fcp: fcp ? fcp.startTime : null,
    inp: latencies.length ? Math.max(...latencies) : null,
  });
})()`;


export class PlaywrightRuntime implements BrowserRuntime {
  readonly sessionId: string;
  private readonly launch: PwOpen;
  private readonly now: () => number;
  private readonly absenceSettleMs: number;
  private opened: Promise<PwSession> | null = null;
  /** Set by the first successful `close`, so a second one is a no-op rather than a false alarm. */
  private closed = false;

  constructor(sessionId: string, launch: PwOpen, options: PlaywrightRuntimeOptions = {}) {
    this.sessionId = sessionId;
    this.launch = launch;
    this.now = options.now ?? Date.now;
    this.absenceSettleMs = options.absenceSettleMs ?? DEFAULT_ABSENCE_SETTLE_MS;
  }

  /** The context, opened once and reused — one journey is one session. */
  private session(): Promise<PwSession> {
    this.opened ??= this.launch();
    return this.opened;
  }

  /** Run one operation, converting any throw into a named failure. */
  private async attempt<T>(command: string, run: () => Promise<T>): Promise<ExecOutcome<T>> {
    const started = this.now();
    try {
      const data = await run();
      return { ok: true, data, stdout: "", stderr: "", durationMs: this.now() - started, command };
    } catch (error) {
      const { kind, detail } = classifyPlaywrightError(error);
      return {
        ok: false,
        failure: { kind, detail, exitCode: null, signal: null },
        stdout: "",
        stderr: detail,
        durationMs: this.now() - started,
        command,
      };
    }
  }

  /** `attempt`, with the session resolved first so a launch failure is typed too. */
  private withSession<T>(command: string, run: (session: PwSession) => Promise<T>): Promise<ExecOutcome<T>> {
    return this.attempt(command, async () => run(await this.session()));
  }

  /**
   * A capability Playwright has, but not at this point in a session's life.
   *
   * Reported as a failure rather than a silent no-op: the evidence manifest
   * lists what it EXPECTED and did not get, so an honest refusal surfaces as a
   * missing artifact. A no-op returning `ok` would produce a package that looks
   * complete and contains nothing.
   */
  private refuse<T>(command: string, detail: string): ExecOutcome<T> {
    return {
      ok: false,
      failure: { kind: "reported", detail, exitCode: null, signal: null },
      stdout: "",
      stderr: detail,
      durationMs: 0,
      command,
    };
  }

  private navigation(session: PwSession, title: string): NavigateResult {
    return {
      url: session.page.url(),
      title,
      targetId: session.identity,
      // Non-null so EXP-000's browser-launch metric stays measurable: it asks
      // which browser served the call, and the context identity answers that.
      launchHash: session.identity,
      // Always false, and correct: the launcher creates the browser before the
      // first command runs, so no COMMAND ever starts one.
      browserLaunched: false,
    };
  }

  async open(url: string): Promise<BrowserResult<NavigateResult>> {
    return this.withSession(`playwright:goto ${url}`, async (session) => {
      await session.page.goto(url);
      return this.navigation(session, await session.page.title());
    });
  }

  async reload(): Promise<BrowserResult<NavigateResult>> {
    return this.withSession("playwright:reload", async (session) => {
      await session.page.reload();
      return this.navigation(session, await session.page.title());
    });
  }

  async evaluate<T>(expression: string): Promise<BrowserResult<T>> {
    return this.withSession("playwright:evaluate", async (s) => (await s.page.evaluate(expression)) as T);
  }

  async getText(selector: string): Promise<BrowserResult<string>> {
    return this.withSession(`playwright:innerText ${selector}`, (s) => s.page.locator(selector).innerText());
  }

  async getTitle(): Promise<BrowserResult<string>> {
    return this.withSession("playwright:title", (s) => s.page.title());
  }

  async getUrl(): Promise<BrowserResult<string>> {
    return this.withSession("playwright:url", (s) => Promise.resolve(s.page.url()));
  }

  async count(selector: string): Promise<BrowserResult<number>> {
    return this.withSession(`playwright:count ${selector}`, (s) => s.page.locator(selector).count());
  }

  /**
   * How many VISIBLE elements a selector matches — for the evidence, not for a check.
   *
   * No retry and no settle, unlike `isVisible` below, and the asymmetry is deliberate: absence
   * is a CLAIM about the page and a claim has to survive a settle, whereas this is a count taken
   * at one instant to annotate an action taken at that same instant. Re-reading it later would
   * describe a different page.
   */
  visibleCount(selector: string): Promise<BrowserResult<number>> {
    return this.withSession(`playwright:visibleCount ${selector}`, (s) => s.page.locator(selector).visibleCount());
  }

  /**
   * Visible, with a negative reading CONFIRMED rather than trusted.
   *
   * Playwright is kinder than the CLI here — a selector matching nothing
   * returns `false` instead of an error, so "the page has no CTA" can no longer
   * be mistaken for "the browser broke". The retry survives for the other half
   * of the lesson: an element mid-entrance-animation is also `false`, and under
   * load that produced a false site defect on a page whose heading was
   * demonstrably present and visible.
   */
  async isVisible(selector: string): Promise<BrowserResult<boolean>> {
    const first = await this.withSession(`playwright:isVisible ${selector}`, (s) =>
      s.page.locator(selector).isVisible(),
    );
    if (!first.ok || first.data) return first;
    await this.withSession("playwright:settle", (s) => s.page.waitForTimeout(this.absenceSettleMs));
    return this.withSession(`playwright:isVisible ${selector} (confirm)`, (s) =>
      s.page.locator(selector).isVisible(),
    );
  }

  /**
   * The accessibility tree, as Playwright's ARIA snapshot.
   *
   * `interactiveOnly`, `compact` and `depth` are agent-browser's knobs with no
   * Playwright equivalent; `selector` does have one, so it is honoured and the
   * rest are ignored rather than faked.
   */
  async snapshot(options?: SnapshotOptions): Promise<BrowserResult<string>> {
    const selector = options?.selector ?? "body";
    return this.withSession(`playwright:ariaSnapshot ${selector}`, (s) => s.page.locator(selector).ariaSnapshot());
  }

  async click(selector: string): Promise<BrowserResult<unknown>> {
    return this.withSession(`playwright:click ${selector}`, (s) => s.page.locator(selector).click());
  }

  /**
   * Fill a field. The command string names the selector and MASKS the value.
   *
   * Registration, login and contact-form journeys put passwords and personal
   * data through here, and `command` is kept in every outcome so a failing call
   * can be reproduced by hand — which for this one call would write the
   * credential into the evidence package. The selector is enough to diagnose; the
   * value is not ours to keep.
   */
  async fill(selector: string, value: string): Promise<BrowserResult<unknown>> {
    return this.withSession(`playwright:fill ${selector} <redacted>`, (s) => s.page.locator(selector).fill(value));
  }

  async press(key: string): Promise<BrowserResult<unknown>> {
    return this.withSession(`playwright:press ${key}`, (s) => s.page.pressKey(key));
  }

  async select(selector: string, values: string[]): Promise<BrowserResult<unknown>> {
    return this.withSession(`playwright:selectOption ${selector}`, (s) =>
      s.page.locator(selector).selectOption(values),
    );
  }

  async check(selector: string): Promise<BrowserResult<unknown>> {
    return this.withSession(`playwright:check ${selector}`, (s) => s.page.locator(selector).check());
  }

  async scroll(direction: "up" | "down" | "left" | "right", px = DEFAULT_SCROLL_PX): Promise<BrowserResult<unknown>> {
    const deltas: Record<typeof direction, [number, number]> = {
      down: [0, px],
      up: [0, -px],
      right: [px, 0],
      left: [-px, 0],
    };
    const [dx, dy] = deltas[direction];
    return this.withSession(`playwright:wheel ${direction} ${px}`, (s) => s.page.wheel(dx, dy));
  }

  /**
   * `wait` carries either a selector or a millisecond count — the engine passes
   * a stringified number for its settle, and journeys pass selectors.
   */
  async waitFor(target: string): Promise<BrowserResult<unknown>> {
    if (/^\d+$/.test(target)) {
      return this.withSession(`playwright:waitForTimeout ${target}`, (s) => s.page.waitForTimeout(Number(target)));
    }
    return this.withSession(`playwright:waitForSelector ${target}`, (s) => s.page.waitForSelector(target));
  }

  async setViewport(width: number, height: number): Promise<BrowserResult<unknown>> {
    return this.withSession(`playwright:setViewportSize ${width}x${height}`, (s) =>
      s.page.setViewportSize({ width, height }),
    );
  }

  /**
   * Devices are a CONTEXT-CREATION option in Playwright, not a runtime setting,
   * so this can only confirm what the launcher already did.
   *
   * Confirming rather than assuming is the whole point: reporting success for a
   * device that was never applied is exactly what let a mobile profile render at
   * 1280px with every other check green.
   */
  async setDevice(name: string): Promise<BrowserResult<unknown>> {
    const command = `playwright:setDevice ${name}`;
    const applied = await this.withSession(command, (s) => Promise.resolve(s.deviceName));
    if (!applied.ok) return applied;
    if (applied.data === name) return { ...applied, data: null };
    return this.refuse(
      command,
      `device "${name}" cannot be applied mid-session — Playwright takes it at context creation, and this context was built with ${
        applied.data === null ? "no device" : `"${applied.data}"`
      }`,
    );
  }

  async setGeo(latitude: number, longitude: number): Promise<BrowserResult<unknown>> {
    return this.withSession(`playwright:setGeolocation ${latitude},${longitude}`, (s) =>
      s.context.setGeolocation({ latitude, longitude }),
    );
  }

  async setHeaders(headers: Record<string, string>): Promise<BrowserResult<unknown>> {
    return this.withSession("playwright:setExtraHTTPHeaders", (s) => s.context.setExtraHTTPHeaders(headers));
  }

  async screenshot(path: string, options?: ScreenshotOptions): Promise<BrowserResult<unknown>> {
    // `annotate` is an agent-browser overlay with no Playwright equivalent.
    return this.withSession(`playwright:screenshot ${path}`, (s) =>
      s.page.screenshot({ path, fullPage: options?.fullPage ?? false }),
    );
  }

  async console(): Promise<BrowserResult<ConsoleMessage[]>> {
    return this.withSession("playwright:console", (s) => Promise.resolve(s.observed().console));
  }

  async errors(): Promise<BrowserResult<PageError[]>> {
    return this.withSession("playwright:pageerror", (s) => Promise.resolve(s.observed().errors));
  }

  async networkRequests(): Promise<BrowserResult<NetworkRequest[]>> {
    return this.withSession("playwright:network", (s) => Promise.resolve(s.observed().requests));
  }

  /**
   * Report on a HAR that was armed at context creation — never start one.
   *
   * `recordHar` is a context option, so by the time anything can call this the
   * answer is already fixed: either the recording has been running since before
   * the first navigation (better than any mid-session start could be) or there is
   * none and this REFUSES. Succeeding on an unarmed context would put `har` in
   * the manifest with nothing behind it.
   */
  async harStart(): Promise<BrowserResult<unknown>> {
    const command = "playwright:harStart";
    const armed = await this.withSession(command, (s) => Promise.resolve(s.harPath));
    if (!armed.ok) return armed;
    if (armed.data === null) return this.refuse(command, HAR_NOT_ARMED);
    return armed;
  }

  /**
   * Flush the HAR — which on this engine means CLOSING the context.
   *
   * Playwright writes the HAR at `context.close()` and offers no flush-on-demand, so an
   * adapter has two choices: refuse accurately, or perform the only operation that satisfies
   * what the caller asked for. It refused for a while, and refusing accurately turned out not
   * to be the same as being right — the manifest reported `har` MISSING on every fail-tier run
   * and completeness sat at 88% for a file that appeared on disk seconds later, when the run's
   * `finally` closed the same context.
   *
   * So `harStop(path)` means what its name says: after it returns ok, the HAR at `path` is
   * complete and readable. The two refusals that describe a real mismatch survive, because
   * neither can be fixed by closing anything — nothing was recorded, or the recording is armed
   * to a DIFFERENT path and closing would leave the caller looking for a file nothing will ever
   * write while the real one sits unlisted beside it.
   *
   * **The cost, stated where it is paid:** the context is dead afterwards. `collectEvidence`
   * collects the HAR last for exactly this reason, after every live read — vitals, console,
   * snapshot, trace, a11y — and the ordering there carries the same warning. A HAR collected
   * before the trace would have taken the trace's context with it.
   */
  async harStop(path: string): Promise<BrowserResult<unknown>> {
    const command = `playwright:harStop ${path}`;
    const armed = await this.withSession(command, (s) => Promise.resolve(s.harPath));
    if (!armed.ok) return armed;
    if (armed.data === null) return this.refuse(command, HAR_NOT_ARMED);
    if (armed.data !== path) return this.refuse(command, harElsewhereDetail(armed.data, path));
    return this.close();
  }

  /** Tracing IS start/stop in Playwright — the reason the fail tier can finally hold one. */
  async traceStart(): Promise<BrowserResult<unknown>> {
    return this.withSession("playwright:tracing.start", (s) => s.context.startTracing());
  }

  async traceStop(path: string): Promise<BrowserResult<unknown>> {
    return this.withSession(`playwright:tracing.stop ${path}`, (s) => s.context.stopTracing(path));
  }

  async vitals(): Promise<BrowserResult<Vitals>> {
    const out = await this.withSession("playwright:vitals", async (s) => {
      const raw = await s.page.evaluate(VITALS_EXPRESSION);
      return typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    });
    if (!out.ok) return out;
    const { ok: _ok, data, ...meta } = out;
    return { ok: true, data: toVitals(data), ...meta };
  }

  /**
   * Accessibility violations need an axe run, which is a separate dependency
   * (`@axe-core/playwright`) and deliberately out of Phase 1. Refused, so the
   * `investigation` tier reports a11y as missing rather than as clean.
   */
  a11y(): Promise<BrowserResult<A11yViolation[]>> {
    return Promise.resolve(
      this.refuse("playwright:a11y", "a11y requires @axe-core/playwright, which is not wired in Phase 1"),
    );
  }

  /**
   * Save the visitor's session, then close. Closing what was never opened is a
   * no-op, not a failure.
   *
   * On close for the same reason the HAR flushes there: cookies and localStorage
   * are only worth keeping once the journey has finished with them, and a state
   * captured mid-run would describe a visitor halfway through a login.
   *
   * A save failure is what `close` REPORTS, even when the close itself succeeded.
   * If that file is not written, the next run of a `returning` profile is a
   * first-time visitor wearing a returning profile's name — the exact silent
   * substitution this wiring exists to prevent — and a green close would be the
   * only trace of it.
   */
  /**
   * Close once, and say ok if asked again.
   *
   * The second call is not hypothetical: `harStop` closes the context to flush the HAR, and
   * `executeRun`'s `finally` closes it again on the way out. Playwright tolerates a repeated
   * `context.close()`, but `saveVisitorSession` does NOT — it would try to write storage state
   * through a dead context and report a failed save for a session that was saved correctly the
   * first time, which is exactly the false alarm B-7 exists to prevent.
   */
  async close(): Promise<BrowserResult<unknown>> {
    if (this.opened === null) {
      return this.attempt("playwright:close (never opened)", () => Promise.resolve(null));
    }
    if (this.closed) return this.attempt("playwright:close (already closed)", () => Promise.resolve(null));
    this.closed = true;
    const saved = await this.saveVisitorSession();
    const closed = await this.withSession("playwright:close", (s) => s.context.close());
    return saved.ok ? closed : saved;
  }

  /** No configured path is not a failure: an anonymous visitor keeps nothing. */
  private saveVisitorSession(): Promise<ExecOutcome<string | null>> {
    return this.withSession("playwright:storageState", async (s) => {
      if (s.saveStatePath === null) return null;
      await s.context.saveStorageState(s.saveStatePath);
      return s.saveStatePath;
    });
  }
}
