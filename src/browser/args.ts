/**
 * Pure argv composition for agent-browser.
 *
 * Kept separate from the adapter so the part that is easy to get wrong — flag
 * order, which options are launch-identity and which are per-command — is
 * testable without spawning a browser.
 */
import type { BrowserSessionConfig, ScreenshotOptions, SnapshotOptions } from "./types.js";

/**
 * Global flags that identify the session and its browser.
 *
 * Order matters to agent-browser only in that globals must precede the
 * subcommand. Within that, this order is fixed so a `command` string in a log
 * is diffable between two runs.
 *
 * Every flag here except `--session` contributes to agent-browser's
 * `launchHash`: change one and you get a different browser process. That is why
 * they are rebuilt for every single command rather than set once — the daemon
 * matches an existing browser by these flags, so omitting them on a later call
 * would silently route the command to a *different* browser than the one the
 * journey started in.
 */
export function sessionArgs(config: BrowserSessionConfig): string[] {
  const args = ["--session", config.sessionId];
  if (config.namespace) args.push("--namespace", config.namespace);
  if (config.proxy) args.push("--proxy", config.proxy);
  if (config.proxyBypass) args.push("--proxy-bypass", config.proxyBypass);
  if (config.userAgent) args.push("--user-agent", config.userAgent);
  for (const script of config.initScripts ?? []) args.push("--init-script", script);
  if (config.headed) args.push("--headed");
  return args;
}

/** A full argv: session globals, the command, then `--json`. */
export function commandArgs(config: BrowserSessionConfig, command: string[]): string[] {
  return [...sessionArgs(config), ...command, "--json"];
}

export function snapshotCommand(options: SnapshotOptions = {}): string[] {
  const args = ["snapshot"];
  if (options.interactiveOnly) args.push("-i");
  if (options.compact) args.push("-c");
  if (options.depth !== undefined) args.push("-d", String(options.depth));
  if (options.selector) args.push("-s", options.selector);
  return args;
}

export function screenshotCommand(path: string, options: ScreenshotOptions = {}): string[] {
  const args = ["screenshot", path];
  if (options.fullPage) args.push("--full");
  if (options.annotate) args.push("--annotate");
  return args;
}

export function scrollCommand(direction: string, px?: number): string[] {
  return px === undefined ? ["scroll", direction] : ["scroll", direction, String(px)];
}

/**
 * `fill`, not `type`: it clears the field first, so a journey does not depend on
 * what a previous step or a browser autofill left in it.
 *
 * The value lands in argv, which means it reaches `ExecMeta.command` — the
 * string kept so a failing call is reproducible by hand. That is exactly where a
 * password would leak, so the adapter masks it there; see `fillCommandLabel`.
 */
export function fillCommand(selector: string, value: string): string[] {
  return ["fill", selector, value];
}

/** What a filled field is called in a log or a step detail: never its value. */
export function fillCommandLabel(selector: string): string {
  return `fill ${selector} <redacted>`;
}

export function selectCommand(selector: string, values: string[]): string[] {
  return ["select", selector, ...values];
}
