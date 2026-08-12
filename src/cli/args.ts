/**
 * Argument parsing, kept pure so the CLI's contract is testable without
 * running anything.
 *
 * `--json` is not decoration. Agent-to-agent integration must not depend on
 * parsing human-readable output, so every command supports it and the JSON
 * shape is the actual contract.
 */
export interface ParsedArgs {
  command: string[];
  flags: Record<string, string | boolean>;
  positional: string[];
}

/**
 * `--key value`, `--key=value` and bare `--flag`. A `--key` followed by
 * another `--key` is a boolean, not a key whose value is a flag name.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }

  // The command is the leading positional words; anything after the first
  // flag-looking token stays positional (e.g. an experiment id).
  const command: string[] = [];
  for (const word of positional) {
    if (command.length < 2 && /^[a-z][\w-]*$/i.test(word)) command.push(word);
    else break;
  }
  return { command, flags, positional: positional.slice(command.length) };
}

export function flagString(args: ParsedArgs, name: string, fallback: string): string {
  const value = args.flags[name];
  return typeof value === "string" ? value : fallback;
}

export function flagNumber(args: ParsedArgs, name: string, fallback: number): number {
  const value = args.flags[name];
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

/** Parse repeated `--var k=v` into an object. */
export function flagVars(argv: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--var") continue;
    const pair = argv[i + 1];
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq > 0) vars[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return vars;
}

export const USAGE = `geoqa — geographic experience & evidence engine

Usage:
  geoqa browser verify [--json]
      Prove the agent-browser primitives this engine depends on.

  geoqa proxy verify --geo <profile> [--json]
      Open a session and report the observed egress identity and browser
      environment, on both axes, with a per-axis verdict.

  geoqa profile list [--json]
  geoqa journey list [--json]

  geoqa journey run --url <url> --geo <profile> --journey <id>
                    [--provider direct|http-proxy] [--var k=v]... [--json]
      One run, start to finish, in this process.

  geoqa experiment run <id> [--samples <n>] [--geo <profile>] [--url <url>] [--json]
      Take n samples and write results.jsonl + summary.json.

  geoqa evidence inspect <runId> [--json]
      Show a run's evidence manifest, what is missing, and its completeness.

Global:
  --json           machine-readable output (the integration contract)
  --evidence-root  where evidence is written (default: ./evidence)
  --headed         show the browser window
`;
