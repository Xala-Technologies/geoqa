/**
 * The browser seam.
 *
 * `agent-browser` is infrastructure, not the product API. Everything above this
 * file talks to `BrowserRuntime`; only `agent-browser.ts` knows the CLI exists.
 * That is what keeps a journey spec from being welded to one automation tool —
 * and it is cheap, because the interface is small and the adapter is thin.
 */
import type { ExecOutcome } from "./exec.js";

/** Every runtime call returns the same verified-or-explicitly-failed outcome. */
export type BrowserResult<T> = ExecOutcome<T>;

/**
 * A browser identity. Everything here except `sessionId` is a LAUNCH option:
 * agent-browser hashes them into a `launchHash`, and changing any of them
 * starts a different browser process. Measured, not assumed —
 * `--init-script` flipped the hash from 12798… to 16587… in EXP-000.
 *
 * The practical consequence: one profile is one browser. Two markets cannot
 * share a process, so parallel market coverage costs one Chrome each.
 */
export interface BrowserSessionConfig {
  /** agent-browser `--session`; isolates cookies, storage and history. */
  sessionId: string;
  /** `--namespace`; isolates the daemon socket itself. One per market. */
  namespace?: string;
  /** `--proxy`, credentials included. Never logged — see redact.ts. */
  proxy?: string;
  /** `--proxy-bypass`. */
  proxyBypass?: string;
  /** `--user-agent`. */
  userAgent?: string;
  /** `--init-script`, repeatable. How locale is actually overridden. */
  initScripts?: string[];
  /** `--headed`; default is headless. */
  headed?: boolean;
  /** Extra env for the spawn. `TZ` here is what moves the browser's clock. */
  env?: NodeJS.ProcessEnv;
}

export interface NavigateResult {
  url: string;
  title: string;
  targetId: string;
  /** agent-browser's launch identity — proof of which browser served this. */
  launchHash: string | null;
  /** True when this command started a new browser process. */
  browserLaunched: boolean;
}

export interface ConsoleMessage {
  type: string;
  text: string;
}

export interface PageError {
  message: string;
  stack: string | null;
}

export interface NetworkRequest {
  url: string;
  method: string;
  status: number | null;
  resourceType: string | null;
}

/** Core Web Vitals, straight from agent-browser's own `vitals` command. */
export interface Vitals {
  lcp: number | null;
  cls: number | null;
  ttfb: number | null;
  fcp: number | null;
  inp: number | null;
}

export interface A11yViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: number;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  /** Overlay numbered element labels — useful on a failure frame. */
  annotate?: boolean;
}

export interface SnapshotOptions {
  interactiveOnly?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
}

/**
 * What the journey engine and the evidence collector are allowed to ask a
 * browser to do. Deliberately no `chat`, no `eval`-driven control flow beyond
 * observation: Phase 0 journeys are deterministic, and an LLM in this layer
 * would make a failing run unreproducible.
 */
export interface BrowserRuntime {
  readonly sessionId: string;

  open(url: string): Promise<BrowserResult<NavigateResult>>;
  reload(): Promise<BrowserResult<NavigateResult>>;

  /** Read-only page observation. */
  evaluate<T>(expression: string): Promise<BrowserResult<T>>;
  getText(selector: string): Promise<BrowserResult<string>>;
  getTitle(): Promise<BrowserResult<string>>;
  getUrl(): Promise<BrowserResult<string>>;
  count(selector: string): Promise<BrowserResult<number>>;
  isVisible(selector: string): Promise<BrowserResult<boolean>>;
  /**
   * How many VISIBLE elements a selector matches.
   *
   * For the evidence rather than for a check. A union in a click step is legitimate and
   * ambiguous at once — `#results a, .result` taking the first of three results is exactly what
   * a journey means — so this cannot refuse anything. But a CSS comma resolves in DOCUMENT
   * order rather than as a preference list, and a report that recorded neither the count nor
   * the landing URL could not tell that apart from clicking the nav. See gaps C-11.
   */
  visibleCount(selector: string): Promise<BrowserResult<number>>;
  snapshot(options?: SnapshotOptions): Promise<BrowserResult<string>>;

  /** Interaction. */
  click(selector: string): Promise<BrowserResult<unknown>>;
  scroll(direction: "up" | "down" | "left" | "right", px?: number): Promise<BrowserResult<unknown>>;
  waitFor(target: string): Promise<BrowserResult<unknown>>;

  /**
   * Input. Present so journeys can exercise real functionality — forms, search,
   * CRUD — rather than only reading pages.
   *
   * `fill` CLEARS first, so a journey is not sensitive to whatever a previous
   * step or a browser autofill left behind. Its value is treated as a secret by
   * everything downstream: a step result records that a field was filled and the
   * selector it targeted, never the text, because these carry credentials and
   * personal data straight into an evidence package otherwise.
   */
  fill(selector: string, value: string): Promise<BrowserResult<unknown>>;
  press(key: string): Promise<BrowserResult<unknown>>;
  select(selector: string, values: string[]): Promise<BrowserResult<unknown>>;
  check(selector: string): Promise<BrowserResult<unknown>>;

  /** Environment. */
  setViewport(width: number, height: number): Promise<BrowserResult<unknown>>;
  setDevice(name: string): Promise<BrowserResult<unknown>>;
  setGeo(latitude: number, longitude: number): Promise<BrowserResult<unknown>>;
  setHeaders(headers: Record<string, string>): Promise<BrowserResult<unknown>>;

  /** Evidence. */
  screenshot(path: string, options?: ScreenshotOptions): Promise<BrowserResult<unknown>>;
  console(): Promise<BrowserResult<ConsoleMessage[]>>;
  errors(): Promise<BrowserResult<PageError[]>>;
  networkRequests(): Promise<BrowserResult<NetworkRequest[]>>;
  harStart(): Promise<BrowserResult<unknown>>;
  harStop(path: string): Promise<BrowserResult<unknown>>;
  traceStart(): Promise<BrowserResult<unknown>>;
  traceStop(path: string): Promise<BrowserResult<unknown>>;
  vitals(): Promise<BrowserResult<Vitals>>;
  a11y(): Promise<BrowserResult<A11yViolation[]>>;

  close(): Promise<BrowserResult<unknown>>;
}
