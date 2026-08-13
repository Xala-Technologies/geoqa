/**
 * Argument parsing, kept pure so the CLI's contract is testable without
 * running anything.
 *
 * `--json` is not decoration. Agent-to-agent integration must not depend on
 * parsing human-readable output, so every command supports it and the JSON
 * shape is the actual contract.
 */
import type { RunEngine } from "../run/context.js";

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

/**
 * Every value a repeatable flag was given, in order.
 *
 * Read off `argv` rather than `ParsedArgs.flags`, because `flags` is a record:
 * a repeated `--market` OVERWRITES, so `--market oslo --market berlin` would
 * silently become a one-market matrix that then reports PASS over a third of
 * the coverage it was asked for. Both spellings are collected (`--k v` and
 * `--k=v`) since a caller cannot be expected to know which one a flag supports.
 */
function flagValues(argv: string[], name: string): string[] {
  const flag = `--${name}`;
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === flag) {
      const next = argv[i + 1];
      // A `--market --json` is a missing value, not a market called "--json".
      if (next !== undefined && !next.startsWith("--")) {
        values.push(next);
        i++;
      }
      continue;
    }
    if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
  }
  return values;
}

/**
 * A repeatable and/or comma-separated list flag: `--market oslo,berlin` and
 * `--market oslo --market berlin` mean the same thing.
 *
 * Empty entries are dropped rather than passed on, because a trailing comma
 * would otherwise expand to a scenario whose market is the empty string — a
 * profile lookup that fails 30 scenarios into an overnight matrix.
 */
export function flagList(argv: string[], name: string): string[] {
  return flagValues(argv, name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** Parse a repeatable `--<name> k=v` into an object. */
export function flagPairs(argv: string[], name: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const value of flagValues(argv, name)) {
    const eq = value.indexOf("=");
    // `eq > 0`, not `!== -1`: `=value` has no key, and a pair with an empty key
    // would silently overwrite whatever a previous one set.
    if (eq > 0) pairs[value.slice(0, eq)] = value.slice(eq + 1);
  }
  return pairs;
}

/** Parse repeated `--var k=v` into an object. */
export function flagVars(argv: string[]): Record<string, string> {
  return flagPairs(argv, "var");
}

/**
 * A duration flag: bare ms, or with an `ms` / `s` / `m` / `h` suffix.
 *
 * `null` for anything unreadable, so a caller can REFUSE rather than fall back.
 * That distinction is the whole reason this returns a union: the value this
 * parses is EXP-002's stability window, whose default is 24 seconds against a
 * PRD asking for ten minutes. A `--stability-window 10min` that silently became
 * the default would produce a summary measuring 24s — and, because the summary
 * note names the window it actually used, a reader would see a coherent,
 * confident, wrong answer to the question they thought they asked.
 *
 * Zero and negatives are unreadable too. A zero-length window reports perfect
 * stability having waited for nothing.
 */
export function parseDurationMs(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|min|h)?$/.exec(value.trim());
  if (!match) return null;
  const scale = { ms: 1, s: 1_000, m: 60_000, min: 60_000, h: 3_600_000 }[match[2] ?? "ms"] as number;
  const ms = Number(match[1]) * scale;
  return ms > 0 ? ms : null;
}

/**
 * A URL list, as a `--urls-file` body: one per line, `#` comments, blanks
 * skipped.
 *
 * Every line is validated HERE, before anything launches, and one bad line
 * refuses the whole file with its line number. The alternative was measured: 430
 * URLs were driven from a shell loop, and a list whose entries are only checked
 * as each one is opened turns a typo on line 217 into a scenario that reports
 * `unmeasured` two hundred pages into an overnight matrix. Same rule as a
 * mistyped `--market`: refuse the expansion, not the two-hundredth run of it.
 *
 * Order is PRESERVED and duplicates are KEPT. Sitemap order is meaningful to
 * whoever reads the results, and repeating a URL is a legitimate way to ask for a
 * second sample of one page.
 */
export function parseUrlList(text: string): { ok: true; urls: string[] } | { ok: false; errors: string[] } {
  const urls: string[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // A trailing `#` comment is not stripped: `#` is legal in a URL fragment, so
    // cutting at one would silently rewrite the target. Only a whole-line comment
    // counts.
    const line = (lines[i] as string).trim();
    if (line === "" || line.startsWith("#")) continue;
    let parsed: URL;
    try {
      parsed = new URL(line);
    } catch {
      errors.push(`line ${i + 1}: "${line}" is not a URL`);
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      // Refused by name, because `file:` would make a matrix "pass" against local
      // disk while claiming to have visited a site.
      errors.push(`line ${i + 1}: "${line}" is ${parsed.protocol} — only http and https can be visited`);
      continue;
    }
    urls.push(line);
  }
  if (errors.length > 0) return { ok: false, errors };
  if (urls.length === 0) return { ok: false, errors: ["no URLs — every line was blank or a comment"] };
  return { ok: true, urls };
}

/**
 * `--engine`, or `null` for a name no adapter answers to.
 *
 * Returning `null` instead of falling back matters: the previous form read
 * anything that was not exactly "playwright" as agent-browser, so
 * `--engine playwrite` ran a different engine than the one asked for and
 * reported a perfectly successful run of it. An unrecognised engine is the same
 * class of failure as an unknown config key — the user believes the setting took
 * and nothing ever contradicts them.
 */
export function parseEngine(value: string): RunEngine | null {
  return value === "agent-browser" || value === "playwright" ? value : null;
}

export const USAGE = `geoqa — geographic experience & evidence engine

Usage:
  geoqa browser verify [--engine agent-browser|playwright] [--geo <profile>]
                       [--url <url>] [--json]
      Prove the browser primitives this engine depends on, by USING each one
      against a real page — a --help listing says nothing about whether a
      command answers.

      --engine chooses which adapter is proven. --geo names the profile the
      Playwright context is built from: locale, timezone, coordinates and
      viewport are context options there, so that engine cannot be built without
      an identity. The agent-browser session is unchanged by it, because
      geography reaches that engine as a TZ variable and an injected script,
      which the run path writes and this command does not.

  geoqa proxy verify --geo <profile> [--provider direct|http-proxy]
                     [--engine agent-browser|playwright] [--no-corroborate]
                     [--json]
      Open a session and report the observed egress identity and browser
      environment, on both axes, with a per-axis verdict.

      A SECOND, independent IP-geo database (ipv4.geojs.io) is read by default and
      the two readings are reported side by side. Measured: one Decodo ISP exit resolved
      to Sao Paulo per Decodo's own endpoint and New York per ipinfo, for the same
      IP. An engine whose whole job is proving where a visitor is cannot treat one
      lookup as ground truth, because a wrong database looks exactly like a wrong
      proxy and the two need opposite fixes. Disagreement about the COUNTRY is a
      mismatch and caps the run's network-identity confidence; disagreement about
      the city is recorded and is never a defect, because databases name the
      exchange (this machine reads Tonsberg, Rykkin and Oslo simultaneously).
      Different IPs across the two reads is neither — it means a dual-stack route
      or a rotation, so the two locations describe different visitors and are not
      compared at all. That is why the second source is pinned to IPv4: ipinfo.io
      publishes no AAAA record, and a dual-stack corroborating host is read over
      IPv6 by any dual-stack client, which makes the axis permanently unverified.
      Measured, not assumed.

      --no-corroborate skips the second lookup.

  geoqa profile list [--json]
  geoqa journey list [--json]

  geoqa journey run --url <url> --geo <profile> --journey <id>
                    [--provider direct|http-proxy]
                    [--engine agent-browser|playwright] [--seed <n>]
                    [--repeat <n>] [--var k=v]... [--corroborate] [--json]
      One run, start to finish, in this process. The playwright engine takes
      locale, timezone, coordinates and viewport as context options and GRANTS
      the geolocation permission, so it needs no locale init script.

      --seed fixes the journey's human-length pauses and its optional steps.
      Omitted, it is derived from the run id: every run paces differently, and
      any one run replays exactly. Take the seed from a failing run's run.json
      to repeat exactly what it did.

      --corroborate reads a second IP-geo database, as proxy verify does by
      default. OFF here on purpose: this is one extra probe per RUN, and a
      430-page sweep would spend 430 of them against a free endpoint's monthly
      allowance. An engine that exhausts its own corroborating source reports
      unverified for every later run, which is the failure an exhausted proxy
      already produced once.

      --repeat runs the journey n times (default 1) in ONE browser and ONE
      network session, and MEASURES flakiness instead of masking it. The journey
      itself never retries: a silent second attempt turns a real intermittent
      failure into a pass. So every attempt is kept, each step is reported at the
      WORST outcome any attempt saw — a check that failed once and passed twice
      is still a finding — and each finding carries the attempts it appeared in.
      3 of 3 is reported as reproduced and near-certain; 1 of 3 is reported at
      much lower confidence, which is the honest reading of "we saw it once and
      could not repeat it". Attempt k runs at seed+k so the attempts pace
      differently, and the base seed still replays the whole set.

      A journey declaring writes:true CHANGES STATE on the target — it
      registers, submits or books for real. The run says so before starting and
      records it in the evidence.

  geoqa matrix run (--url <url> | --urls-file <path>)
                   --market <a,b,...> --journey <a,b,...>
                   [--device mobile,desktop] [--concurrency <n>]
                   [--provider direct|http-proxy]
                   [--engine agent-browser|playwright] [--seed <n>]
                   [--repeat <n>] [--var k=v]... [--headed]
                   [--dry-run] [--allow-writes] [--corroborate] [--json]
      Market x device x journey, in this process, with a bounded pool. --market
      and --journey are required and both accept commas and repetition;
      --device defaults to mobile,desktop, because a market covered on one
      device cannot catch a device-specific defect.

      Every profile and journey the expansion needs is validated BEFORE anything
      launches, and one bad name refuses the whole matrix: discovering a typo
      ninety browser launches in is not a report, it is a bill. One scenario
      failing never ends the matrix — it is recorded as its own outcome, and a
      scenario that could not be executed at all is recorded as unmeasured
      rather than dropped, so a gap can never read as a market that was fine.

      --urls-file adds a PAGE axis: one scenario per page per market/device/
      journey, run inside the same bounded pool. One URL per line, # comments and
      blank lines skipped, order and duplicates preserved because sitemap order is
      meaningful and a repeated URL is a second sample. Every line is validated
      before anything launches and one bad line refuses the whole matrix.

      This axis exists because the first site-wide sweep had no bounded path
      through the engine at all: 430 pages driven from a shell loop, alongside
      three other browser fleets, made a selector-visible check report a missing
      h1 on six pages that demonstrably had one. All six passed re-run alone. A
      sweep that cannot be bounded eventually invents defects out of its own load.

      --dry-run prints the expansion and the scenario count and launches
      nothing. --allow-writes is REQUIRED when any selected journey declares
      writes:true, because at matrix scale that is one real form or registration
      per scenario; the dry run tells you the number for free.

      --seed is the base seed for the whole matrix. Each scenario runs at
      base + a hash of its own key, so scenarios differ from each other while
      the entire matrix replays exactly from one number.

      --concurrency is PROVISIONAL (default 2): each in-flight scenario costs a
      browser context and, on agent-browser, a whole Chrome. The result records
      both the bound and the peak actually reached.

  geoqa experiment run <id> [--samples <n>] [--geo <profile>] [--url <url>]
                            [--stability-window <duration>] [--stability-reads <n>]
                            [--concurrency <n>] [--json]
      Take n samples and write results.jsonl + summary.json.

      --stability-window (EXP-002) is how long one sample holds a single network
      session open, as ms or with an s/m/h suffix. Default 24s, because ten
      minutes x --samples 10 is 100 minutes and a feasibility check that takes an
      hour and a half gets killed halfway. The PRD asks about ten minutes:
      --stability-window 10m --samples 3. Every summary names the window it
      actually measured, so a cheap run can never be read as the expensive claim.

      --stability-reads (default 5) is how many egress readings are spread across
      that window; raising the window costs wall clock, not probe rate, because
      ipinfo rate-limiting a long run would turn a stickiness measurement into a
      throttling measurement.

      --concurrency (EXP-007, default 3) is how many full runs execute at once in
      one sample — the number matrix run --concurrency is currently guessing.

  geoqa evidence inspect <runId> [--json]
      Show a run's evidence manifest, what is missing, and its completeness.

  geoqa evidence prune [--apply] [--max-age <tier>=<days|null>]...
                       [--max-total <bytes>] [--privacy-days <days|off>]
                       [--sweep-tiers pass,warning] [--delete-unreadable]
                       [--json]
      Report what would be removed from the evidence tree, with sizes, and
      remove it only when handed --apply. Retention tiers decide what a run
      CAPTURES; this decides how long it is KEPT. Planning never deletes, and
      the default is therefore a dry run: a destructive default is how someone
      loses the one trace that mattered.

      --max-age is per tier and repeatable, e.g. --max-age pass=7
      --max-age fail=null. The word null (or off) disables age selection for
      that tier. Defaults: pass=7 warning=30 fail=180 investigation=180 — a
      passing run's artifacts are cheap to discard because they are cheap to
      REGENERATE, while a failure's trace may be the only copy of a bug that
      never recurs.

      --privacy-days (default 14) applies to runs whose manifest flags possible
      personal data, and only ever SHORTENS a tier's ceiling, never extends it.
      Those runs are never selected by a size sweep either: a disk-space job must
      not be the thing that quietly removes the only record of what was exposed.

      --max-total caps the whole tree (plain bytes, or a KB/MB/GB suffix). The
      sweep spends --sweep-tiers only, cheapest and oldest first, and reports a
      shortfall rather than reaching for a failure — could not get under the cap
      must never read as did.

      A run whose manifest will not parse is reported and LEFT ALONE; only
      --delete-unreadable removes it. Not knowing what something was is a reason
      to look, not a licence to delete.

      Exit 1 when anything was refused or failed, or when a --max-total could not
      be met, so a scheduled prune goes red instead of looking fine.

Configuration:
  geoqa.config.json in the repo root, when present, supplies the defaults for
  --provider, --evidence-root and the verify endpoint, and is the only way to set
  the agent-browser command and idle timeouts. Precedence is always
  FLAG > config file > built-in default.

  An absent file is not an error and the run says which it used. A malformed,
  unknown-key or unreadable config IS an error and stops the run: silently
  falling back to defaults for a file somebody edited on purpose is the exact
  defect that config surface was built to close. Credentials are refused by
  name — proxy credentials come from GEOQA_PROXY_* environment variables only.

Identity:
  --geo <profile>            a profile id, e.g. oslo-desktop
  --country <cc> --city <c>  the same thing by place, resolved against the
                             profiles that exist. --device (default desktop)
                             picks between them. Naming a place that has no
                             profile REFUSES and lists the ones there are;
                             giving both --geo and --country/--city refuses,
                             because two identities have no correct answer.
                             matrix run uses --market instead.

Global:
  --json           machine-readable output (the integration contract)
  --evidence-root  where evidence is written (default: ./evidence)
  --headed         show the browser window
`;
