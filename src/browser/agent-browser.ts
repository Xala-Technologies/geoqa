/**
 * The one file that knows `agent-browser` exists.
 *
 * Everything is a thin call into `execAgentBrowser` plus a pure mapper. The
 * `exec` function is injectable, so every method here is covered without
 * launching Chrome — and the mappers, which are where the real risk lives, are
 * tested separately against payloads captured from the real CLI.
 */
import {
  commandArgs,
  fillCommand,
  fillCommandLabel,
  screenshotCommand,
  scrollCommand,
  selectCommand,
  snapshotCommand,
} from "./args.js";
import { pinchExpression } from "./pinch.js";
import { execAgentBrowser, type ExecOutcome } from "./exec.js";
import {
  toA11yViolations,
  toConsoleMessages,
  toCount,
  toNavigateResult,
  toNetworkRequests,
  toPageErrors,
  toSnapshot,
  toText,
  toVisible,
  toVitals,
} from "./map.js";
import type {
  A11yViolation,
  BrowserResult,
  BrowserRuntime,
  BrowserSessionConfig,
  ConsoleMessage,
  NavigateResult,
  NetworkRequest,
  PageError,
  ScreenshotOptions,
  SnapshotOptions,
  Vitals,
} from "./types.js";

/** agent-browser's wording for a selector that matched nothing. */
const ELEMENT_NOT_FOUND = /element not found/i;

/**
 * A reported "Element not found" — the ONE failure that might mean the page is
 * simply not ready rather than that the element is absent.
 */
function isElementNotFound(
  outcome: ExecOutcome<unknown>,
): outcome is Extract<ExecOutcome<unknown>, { ok: false }> {
  return !outcome.ok && outcome.failure.kind === "reported" && ELEMENT_NOT_FOUND.test(outcome.failure.detail);
}

/**
 * A first negative visibility reading, in either of the two forms it takes:
 * a reported "Element not found", or a successful check returning false. An
 * element that is present but mid-entrance-animation gives the second.
 */
function isNegativeVisibility(outcome: ExecOutcome<unknown>): boolean {
  if (isElementNotFound(outcome)) return true;
  return outcome.ok && toVisible(outcome.data) === false;
}

/** How long to settle before re-checking an element that appeared absent. */
export const DEFAULT_ABSENCE_SETTLE_MS = 600;

/**
 * Darwin `sockaddr_un` is 104 bytes including NUL. macOS `$TMPDIR` is already
 * `/var/folders/…/T/` (~49). A matrix run id
 * `run_<ms>_alesund-desktop-browse-0` made the socket 107, and Live recorded
 * ERROR before the page opened — every screenshot, viewport and navigation
 * failed as "session name too long". `/tmp/geoqa-ab` leaves room for the
 * longest current slug (`kristiansand-desktop-returning-visitor-430`).
 */
export const DEFAULT_AGENT_BROWSER_SOCKET_DIR = "/tmp/geoqa-ab";

export function withAgentBrowserSocketDir(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.AGENT_BROWSER_SOCKET_DIR) return env;
  return { ...env, AGENT_BROWSER_SOCKET_DIR: DEFAULT_AGENT_BROWSER_SOCKET_DIR };
}

/** Injectable transport, so the adapter is testable without a browser. */
export type ExecFn = (args: string[], env: NodeJS.ProcessEnv) => Promise<ExecOutcome<unknown>>;

export interface RuntimeOptions {
  exec?: ExecFn;
  bin?: string;
  /** Base env; the session's own `env` (notably `TZ`) is layered on top. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  idleMs?: number;
  /**
   * Milliseconds to settle before confirming an element is absent. Lowered in
   * tests so the confirm-absence retry costs nothing there.
   */
  absenceSettleMs?: number;
}

/**
 * Map a successful outcome's payload, passing any failure straight through.
 * Exists so no method has to re-implement the `if (!out.ok) return out` dance —
 * and so a mapper can never accidentally run on a failed outcome's absent data.
 */
export function mapOk<T>(outcome: ExecOutcome<unknown>, fn: (data: unknown) => T): ExecOutcome<T> {
  if (!outcome.ok) return outcome;
  const { ok: _ok, data, ...meta } = outcome;
  return { ok: true, data: fn(data), ...meta };
}

export class AgentBrowserRuntime implements BrowserRuntime {
  readonly sessionId: string;
  private readonly config: BrowserSessionConfig;
  private readonly exec: ExecFn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly absenceSettleMs: number;
  /** Set by the first `close`, so a second one is a no-op rather than a transport failure. */
  private closed = false;

  constructor(config: BrowserSessionConfig, options: RuntimeOptions = {}) {
    this.config = config;
    this.sessionId = config.sessionId;
    // The session's env wins: `TZ` is the only mechanism that actually moves
    // the browser's clock (measured in EXP-000 — `--args --lang` does not work,
    // `TZ` does), so a profile must be able to override an ambient value.
    this.env = withAgentBrowserSocketDir({ ...(options.env ?? process.env), ...(config.env ?? {}) });
    this.absenceSettleMs = options.absenceSettleMs ?? DEFAULT_ABSENCE_SETTLE_MS;
    this.exec =
      options.exec ??
      ((args, env) =>
        execAgentBrowser({
          args,
          env,
          ...(options.bin ? { bin: options.bin } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
        }));
  }

  private run(command: string[]): Promise<ExecOutcome<unknown>> {
    return this.exec(commandArgs(this.config, command), this.env);
  }

  async open(url: string): Promise<BrowserResult<NavigateResult>> {
    return mapOk(await this.run(["open", url]), toNavigateResult);
  }

  async reload(): Promise<BrowserResult<NavigateResult>> {
    return mapOk(await this.run(["reload"]), toNavigateResult);
  }

  async evaluate<T>(expression: string): Promise<BrowserResult<T>> {
    // agent-browser returns `data.result` as a STRING for every eval, so a
    // caller wanting structure must JSON.stringify inside the expression and
    // parse here. Anything unparseable is returned as the raw string.
    return mapOk(await this.run(["eval", expression]), (data) => {
      const raw = toText(data, "result");
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    });
  }

  /**
   * Rendered text, with an EMPTY reading confirmed — the same rule as `isVisible` below.
   *
   * This engine is the DEFAULT, so leaving the confirmation to the Playwright adapter would
   * give the default the weaker protection. `assertions.ts` refuses a still-empty read on
   * either engine, so the safety property held regardless; what the retry adds is the
   * difference between a genuine PASS and an honest refusal, and a run that could have read
   * the page should read it.
   *
   * Only an EMPTY read is confirmed. A non-empty read that lacks the value is a real reading
   * of a real page, and re-reading it would be the silent retry this engine refuses everywhere
   * else — an intermittent site defect turned into a green run.
   */
  async getText(selector: string): Promise<BrowserResult<string>> {
    let out = await this.run(["get", "text", selector]);
    if (out.ok && toText(out.data) === "") {
      await this.run(["wait", String(this.absenceSettleMs)]);
      out = await this.run(["get", "text", selector]);
    }
    return mapOk(out, (d) => toText(d));
  }

  async getTitle(): Promise<BrowserResult<string>> {
    return mapOk(await this.run(["get", "title"]), (d) => toText(d, "title"));
  }

  async getUrl(): Promise<BrowserResult<string>> {
    return mapOk(await this.run(["get", "url"]), (d) => toText(d, "url"));
  }

  /**
   * REFUSED on this engine, by name, rather than approximated with `count`.
   *
   * agent-browser 0.34.0 has `get count`, which counts every match including hidden ones, and
   * no visible-only variant. Returning that number would be worse than returning nothing: the
   * whole point of the reading is to say how many elements a click could plausibly have hit,
   * and on the digilist nav that is 7 of 12 — so a count of 12 would make an unambiguous click
   * look ambiguous and an ambiguous one look worse than it is.
   *
   * A named failure is the established shape for a primitive an engine does not have (see
   * `HAR_NOT_ARMED`). The evidence records the absence rather than a wrong number.
   */
  visibleCount(selector: string): Promise<BrowserResult<number>> {
    const detail =
      "agent-browser has no visible-only element count: `get count` includes hidden elements, and reporting that as the number a click could have hit would make an unambiguous click look ambiguous and an ambiguous one look worse than it is. Use --engine playwright for this reading.";
    return Promise.resolve({
      // `reported` is the kind a refusal takes throughout — a well-formed answer of "no", not a
      // transport failure. Same shape `playwright.ts` uses for HAR and mid-session `setDevice`.
      ok: false,
      failure: { kind: "reported", detail, exitCode: null, signal: null },
      stdout: "",
      stderr: detail,
      durationMs: 0,
      command: `agent-browser:visibleCount ${selector}`,
    });
  }

  async count(selector: string): Promise<BrowserResult<number>> {
    return mapOk(await this.run(["get", "count", selector]), toCount);
  }

  /**
   * A selector that matches nothing is NOT VISIBLE — but absence has to be
   * CONFIRMED, not assumed on the first miss.
   *
   * Two lessons, in the order they were paid for.
   *
   * **First**: agent-browser reports `success:false, error:"Element not
   * found: …"` for a missing element, which the transport layer correctly
   * classifies as a `reported` failure. Passing that straight through made
   * "the page is missing its CTA" indistinguishable from "the browser broke",
   * so a genuine site defect was filed against US. EXP-006 scored 75%
   * detection; converting the error to `false` took it to 100%.
   *
   * **Second, and the reason for the retry**: that conversion was too eager.
   * The same "Element not found" also fires when the page simply has not
   * rendered yet — and under load it fires often. Measured while five sweep
   * agents drove ~55 concurrent browser processes: a blog post whose `h1` is
   * demonstrably present and visible (63 consecutive polls, opacity 1, above
   * the fold) failed this check in 3 of 4 runs, and passed every time it ran
   * alone. The engine was reporting a false site defect under its own load.
   *
   * So a first miss is treated as "not ready", not as "not there": settle
   * briefly and look again. Only a second miss is absence. The cost is one
   * extra round trip on genuinely-absent elements — which are, by definition,
   * the rare case worth being right about.
   *
   * ONLY this specific reported error is converted. A timeout, a crash, an
   * unparseable envelope — anything meaning we never got to look — stays a
   * failure, because those genuinely are our defect.
   */
  async isVisible(selector: string): Promise<BrowserResult<boolean>> {
    let out = await this.run(["is", "visible", selector]);
    // ANY negative gets one confirmation, whether it arrives as an error
    // ("Element not found") or as a plain `visible: false`. Both mean the same
    // thing on a page that is still arriving, and both were observed: the
    // not-found form under load, and the false form on xala.no, whose h1 has an
    // entrance fade and reads opacity 0 for the first second or so. That one
    // failed 4 of 4 runs — deterministic, not flaky — because the journey is
    // faster than the animation.
    if (isNegativeVisibility(out)) {
      await this.run(["wait", String(this.absenceSettleMs)]);
      out = await this.run(["is", "visible", selector]);
    }
    if (isElementNotFound(out)) {
      const { ok: _ok, failure: _failure, ...meta } = out;
      return { ok: true, data: false, ...meta };
    }
    return mapOk(out, toVisible);
  }

  async snapshot(options: SnapshotOptions = {}): Promise<BrowserResult<string>> {
    return mapOk(await this.run(snapshotCommand(options)), toSnapshot);
  }

  click(selector: string): Promise<BrowserResult<unknown>> {
    return this.run(["click", selector]);
  }

  /**
   * Fill a field, and make sure the value cannot survive into a log.
   *
   * `execAgentBrowser` records the argv in `ExecMeta.command` so a failing call
   * is reproducible by hand — which for this one command would put a password in
   * every evidence package that recorded the outcome. The command string is
   * therefore replaced with a masked form before the result is returned. The cost
   * is that this single call is not copy-pasteable; a leaked credential with a
   * long half-life is the worse trade.
   */
  async fill(selector: string, value: string): Promise<BrowserResult<unknown>> {
    const out = await this.run(fillCommand(selector, value));
    return { ...out, command: fillCommandLabel(selector) };
  }

  press(key: string): Promise<BrowserResult<unknown>> {
    return this.run(["press", key]);
  }

  select(selector: string, values: string[]): Promise<BrowserResult<unknown>> {
    return this.run(selectCommand(selector, values));
  }

  check(selector: string): Promise<BrowserResult<unknown>> {
    return this.run(["check", selector]);
  }

  scroll(direction: "up" | "down" | "left" | "right", px?: number): Promise<BrowserResult<unknown>> {
    return this.run(scrollCommand(direction, px));
  }

  pinch(selector: string, direction: "in" | "out"): Promise<BrowserResult<unknown>> {
    return this.evaluate(pinchExpression(selector, direction));
  }

  waitFor(target: string): Promise<BrowserResult<unknown>> {
    return this.run(["wait", target]);
  }

  setViewport(width: number, height: number): Promise<BrowserResult<unknown>> {
    return this.run(["set", "viewport", String(width), String(height)]);
  }

  setDevice(name: string): Promise<BrowserResult<unknown>> {
    return this.run(["set", "device", name]);
  }

  setGeo(latitude: number, longitude: number): Promise<BrowserResult<unknown>> {
    return this.run(["set", "geo", String(latitude), String(longitude)]);
  }

  setHeaders(headers: Record<string, string>): Promise<BrowserResult<unknown>> {
    return this.run(["set", "headers", JSON.stringify(headers)]);
  }

  screenshot(path: string, options: ScreenshotOptions = {}): Promise<BrowserResult<unknown>> {
    return this.run(screenshotCommand(path, options));
  }

  async console(): Promise<BrowserResult<ConsoleMessage[]>> {
    return mapOk(await this.run(["console"]), toConsoleMessages);
  }

  async errors(): Promise<BrowserResult<PageError[]>> {
    return mapOk(await this.run(["errors"]), toPageErrors);
  }

  async networkRequests(): Promise<BrowserResult<NetworkRequest[]>> {
    return mapOk(await this.run(["network", "requests"]), toNetworkRequests);
  }

  harStart(): Promise<BrowserResult<unknown>> {
    return this.run(["network", "har", "start"]);
  }

  harStop(path: string): Promise<BrowserResult<unknown>> {
    return this.run(["network", "har", "stop", path]);
  }

  traceStart(): Promise<BrowserResult<unknown>> {
    return this.run(["trace", "start"]);
  }

  traceStop(path: string): Promise<BrowserResult<unknown>> {
    return this.run(["trace", "stop", path]);
  }

  async vitals(): Promise<BrowserResult<Vitals>> {
    return mapOk(await this.run(["vitals"]), toVitals);
  }

  async a11y(): Promise<BrowserResult<A11yViolation[]>> {
    return mapOk(await this.run(["a11y"]), toA11yViolations);
  }

  /**
   * Close once. A second call is a no-op, not a second `close` on the daemon.
   *
   * `harStop` does not close on this engine — the CLI writes the file on demand — so the double
   * close arrives from the other direction: any caller that closes explicitly and then hits
   * `executeRun`'s `finally`. Re-running `close` against a daemon that has already gone would
   * report a transport failure for a close that succeeded.
   */
  async close(): Promise<BrowserResult<unknown>> {
    if (this.closed) {
      return { ok: true, data: null, stdout: "", stderr: "", durationMs: 0, command: "agent-browser:close (already closed)" };
    }
    this.closed = true;
    return this.run(["close"]);
  }
}
