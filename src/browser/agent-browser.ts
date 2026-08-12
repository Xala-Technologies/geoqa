/**
 * The one file that knows `agent-browser` exists.
 *
 * Everything is a thin call into `execAgentBrowser` plus a pure mapper. The
 * `exec` function is injectable, so every method here is covered without
 * launching Chrome — and the mappers, which are where the real risk lives, are
 * tested separately against payloads captured from the real CLI.
 */
import { commandArgs, screenshotCommand, scrollCommand, snapshotCommand } from "./args.js";
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

/** Injectable transport, so the adapter is testable without a browser. */
export type ExecFn = (args: string[], env: NodeJS.ProcessEnv) => Promise<ExecOutcome<unknown>>;

export interface RuntimeOptions {
  exec?: ExecFn;
  bin?: string;
  /** Base env; the session's own `env` (notably `TZ`) is layered on top. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  idleMs?: number;
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

  constructor(config: BrowserSessionConfig, options: RuntimeOptions = {}) {
    this.config = config;
    this.sessionId = config.sessionId;
    // The session's env wins: `TZ` is the only mechanism that actually moves
    // the browser's clock (measured in EXP-000 — `--args --lang` does not work,
    // `TZ` does), so a profile must be able to override an ambient value.
    this.env = { ...(options.env ?? process.env), ...(config.env ?? {}) };
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

  async getText(selector: string): Promise<BrowserResult<string>> {
    return mapOk(await this.run(["get", "text", selector]), (d) => toText(d));
  }

  async getTitle(): Promise<BrowserResult<string>> {
    return mapOk(await this.run(["get", "title"]), (d) => toText(d, "title"));
  }

  async getUrl(): Promise<BrowserResult<string>> {
    return mapOk(await this.run(["get", "url"]), (d) => toText(d, "url"));
  }

  async count(selector: string): Promise<BrowserResult<number>> {
    return mapOk(await this.run(["get", "count", selector]), toCount);
  }

  async isVisible(selector: string): Promise<BrowserResult<boolean>> {
    return mapOk(await this.run(["is", "visible", selector]), toVisible);
  }

  async snapshot(options: SnapshotOptions = {}): Promise<BrowserResult<string>> {
    return mapOk(await this.run(snapshotCommand(options)), toSnapshot);
  }

  click(selector: string): Promise<BrowserResult<unknown>> {
    return this.run(["click", selector]);
  }

  scroll(direction: "up" | "down" | "left" | "right", px?: number): Promise<BrowserResult<unknown>> {
    return this.run(scrollCommand(direction, px));
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

  close(): Promise<BrowserResult<unknown>> {
    return this.run(["close"]);
  }
}
