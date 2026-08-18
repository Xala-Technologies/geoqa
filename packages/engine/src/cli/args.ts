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
  geoqa tenant list [--json]

Multi-tenancy:
  --tenant <id>    scope the whole invocation to one tenant, from
                   inputs/tenants/<id>.yaml

      Evidence moves to <evidence-root>/<tenantId>/<runId>. A tenant id becomes a
      directory name, so it is constrained to lowercase letters, digits and inner
      hyphens, and the RESOLVED path is re-checked to be inside the root — a path
      that escapes its tenant's root is a cross-tenant read, which is a security
      defect and not a bug.

      A tenant declares the sites it OWNS and the markets it asked for, and both
      are refused before anything launches. A run against a site the tenant does
      not own is either a mistake or this engine being aimed at somebody else's
      product from residential IPs; a market nobody asked for is a bill. Ownership
      is compared by ORIGIN, never by prefix: https://acme.no.evil.test starts with
      https://acme.no as a string.

      A tenant file holds the NAME of an environment variable for its proxy
      credentials and for its proxy sub-account username, never either value.
      Credentials come from the environment only, and a sub-account username
      identifies a billable account at a vendor.

      QUOTA is enforced before anything launches. A tenant declares trafficMb and
      runsPerDay; traffic is read from the VENDOR (the only authoritative figure,
      since bytes are counted at the proxy) and the run count is derived from the
      tenant's own evidence directories, because the vendor has no idea what a run
      is. A matrix is expanded first so the check knows the real page count: a
      430-page sweep against a tenant with 100 MB left is refused before the browser
      starts, instead of dying at page 90 with a 407 that looks like a broken proxy.

      A traffic figure that could NOT be read is unmeasured, never zero. It warns and
      proceeds rather than blocking — with a vendor-enforced cap per sub-account,
      exhaustion is isolated to the tenant that caused it, so refusing every tenant's
      work because a usage API is down would cause more harm than it prevents. The
      warning says the guard is not in force. The run ceiling still applies, because
      that number is ours and is always readable.

      When the vendor enforces its own cap the effective ceiling is the LOWER of the
      two. When it enforces none, geoqa says so: a cap geoqa enforces can be bypassed
      by a bug in geoqa, and one the vendor enforces cannot.

      Omitting --tenant is not an error: single-target use is still the common case
      and the shared evidence root is still correct for it. No tenant rule applies
      then either, which is the honest consequence rather than a silent default.

  geoqa run --url <url> --country <cc> --city <c> --device mobile|desktop
            --journey <id> [--locale <tag>] [--timezone <iana>]
            [--session-duration <min>] [--rotate-ip] [--evidence] [--json]
      The control-plane entry. Same runtime as journey run — one browser, one
      network session, evidence written, a new proxy session id so the
      residential pool rotates the exit. --json writes one event per line
      (observedIp, liveUrl, confidence, message) so a console can screen the
      session. journey run --json stays a single object; that is the
      agent-to-agent contract and it does not stream.

      --locale and --timezone must match the profile or the run is refused:
      the profile is the identity. --rotate-ip and --evidence are how a run
      already works; passing them as false is refused. --session-duration
      fills {sessionduration} in the proxy template (Decodo default 10).

      liveUrl is http://127.0.0.1:4848 when the engine is agent-browser,
      or AGENT_BROWSER_DASHBOARD_URL when set. Playwright has no dashboard.

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
                   [--durable] [--temporal-address <host:port>]
      Market x device x journey, with a bounded pool. --market
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

      --concurrency defaults to 4, which EXP-007 measured rather than guessed:
      100% completion and verdict agreement at 2, 4, 8, 12 and 16, and 4 rather
      than 16 because the default must be safe on the smallest machine that will
      run it. Each in-flight scenario costs a browser context and, on
      agent-browser, a whole Chrome. The result records both the bound and the
      peak actually reached.

      --durable runs the same sweep as a Temporal workflow instead of in this
      process, so a crash halfway through does not lose the finished scenarios.
      It needs a server (temporal server start-dev) and a worker (pnpm worker).
      If it cannot reach either it FAILS: it never falls back to running here,
      because the two produce identical output and a silent fallback would be
      undetectable.

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

  geoqa gate check --url <url> [--journey <id>] [--geo <profile>]
                   [--block-at critical|high|medium|low] [--min-confidence <n>]
                   [--min-geo-confidence <n>] [--tenant <id>] [--json]
      May this page be published? Runs a NORMAL journey against a candidate URL and
      returns a verdict a publisher conditions on. Exit 0 allows; anything else does not.

      This is geoqa's half of the content pipeline and the boundary is deliberate:
      generation and publishing stay outside. The division the whole system rests on is
      that agents produce and geoqa verifies, so a generator living inside the verifier
      would collapse the separation that makes the verdict worth anything.

      THREE states, and the middle one is where gates usually go wrong.

        allow    measured, and clean by the declared thresholds
        block    the page has a problem we MEASURED — fix the page
        unknown  we could NOT measure — a geoqa defect, not the page's

      unknown still prevents publishing. It is a different sentence from block, not a
      different outcome: telling an author their page is broken when the truth is that
      our browser could not read it wastes their time and costs the gate its credibility.

      DEFAULT DENY throughout. No run, no verdict, a thrown error, an errored run — every
      one of them blocks. A gate that opens when it cannot see is not a gate, and the
      absence of a verdict is not a verdict.

  geoqa keywords research --tenant <id> [--market <a,b,...>] [--budget <n>]
                          [--limit <n>] [--json]
      Where a tenant actually ranks, per term and per market, from its own
      inputs/tenants/<id>/keywords.yaml. Every term x market costs ONE real search credit, so a
      run that would exceed the budget — or the provider's remaining quota — is refused
      before it spends anything, with the number it would have spent.

      Three states per row, and they are not interchangeable. A query that could not run
      is unmeasured and scores nothing. A populated SERP without this tenant on it is
      absent and scores a real, low number. A ranking scores by position. The mean is
      taken over the MEASURED rows only: averaging in the failures would let an exhausted
      SERP account read as a tenant with poor visibility.

      The provider's health is probed FIRST, so an exhausted account produces one honest
      sentence instead of N unmeasured rows that look like a site nobody can find.

      Exits 1 when queries were planned and none could be measured.

  geoqa runs list [--url <url>] [--geo <profile>] [--journey <id>]
                  [--verdict PASS|FAIL|ERROR|PASS_WITH_WARNINGS]
                  [--since <iso>] [--limit <n>] [--json]
      The run history, and the REGRESSIONS in it — checks that used to pass and now do
      not. Exits 1 when there is one, so a scheduled check goes red.

      A regression is scoped to one profile + journey + target, because "the h1 check
      started failing" is only meaningful for a fixed combination of those three;
      merging them is how a real regression gets averaged into noise. Only the
      TRANSITION is reported, so a check that broke on Monday is one entry with a
      Monday date rather than one per day since. A failure with no earlier pass is not
      a regression — it may never have worked. And an ERROR run is skipped rather than
      counted as a failed check: ERROR means geoqa could not read the page, and
      reporting our own instrumentation failure as the site's regression is the one
      confusion this project refuses to make.

      --limit applies to the printed list only, never to the summary or the
      regressions: how many runs there have been, and what broke, are questions about
      all of them.

  geoqa runs rebuild [--json]
      Rebuild the index from the runs on disk. Exits 1 if any run directory could not
      be read, because a gap in the history must not look like a clean rebuild.

      The index at <evidence-root>/runs.jsonl is a DERIVED CACHE, not the truth. Each
      run's own run.json is the authority on that run, so a corrupt, truncated,
      hand-edited or deleted index costs nothing permanent — which is why this is a
      JSONL file over the evidence tree rather than a database that owns the record. A
      rebuilt entry is poorer than an appended one (run.json carries the journey's
      verdict, not the assembled confidence report) and says so rather than filling the
      gaps with defaults that would read as real readings.

  geoqa findings file [--dry-run] [--json]
      Open GitHub issues from the run index. Site checks group by host
      and carry a site:<host> label. A mapped host files on that site's
      repo (tenant repositories:); instrumentation stays on
      GEOQA_GITHUB_REPO and gets the urgent label. Already-filed keys
      are skipped, then retagged.
      GEOQA_GITHUB_TOKEN and GEOQA_GITHUB_REPO required; GEOQA_CONSOLE_URL
      adds links. A missing token is not an error — the sweep still
      finished. Exits 1 when the store is unreadable or GitHub refuses.

  geoqa findings repair [--dry-run] [--json]
      After issues exist, clone each destination repo and run claude -p
      (Max login, not the API) to open a PR. app.digilist.no branches
      from dev; every other mapped repo from main. Auto-merge is asked
      for. Already-repaired keys are skipped. A missing token is not an
      error. Exits 1 when a store is unreadable or a repair fails.

  geoqa evidence inspect <runId> [--json]
      Show a run's evidence manifest, what is missing, and its completeness.

  geoqa assist explain <runId> [--json]
      After a run, draft a ticket from the evidence brief via claude -p.
      Uses the operator Max login, not an API key — ANTHROPIC_API_KEY is
      stripped from the child so a leftover key cannot switch the bill.
      The journey is not re-run. The model is the writer, not the judge:
      it must not invent a metric or change the verdict. Off the
      measurement path on purpose. Exit 1 when Claude is missing or the
      package cannot be read.

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

  geoqa server [--port <n>] [--ui-root <path>] [--secure]
  geoqa server hash <password>
      The operator console. Watch decides what to run and how often; Live
      shows screening frames while a session is in flight. Needs
      GEOQA_ADMIN_PASSWORD_HASH and GEOQA_SESSION_SECRET. hash prints those
      exports — never write them into a committed file.

      Watch writes inputs/tenants/<id>/watch.yaml. Settings stays read-only: it
      reports the files the engine already reads. Live is a feed, not remote control
      — a click from the console would make a seeded run unreproducible.

      The scheduler lives in this process. Last start and last finish are
      written under the evidence root so a restart does not look like a
      first sweep. Dying loses the in-memory live board; the evidence
      packages remain.       Default watch is paused so opening the server does
      not spend the proxy allowance.

      HTTP, not only the CLI. POST /api/run starts one journey (same
      runtime as geoqa run). GET /api/run returns inFlight, events and
      sessions. Cookie session or Authorization: Bearer GEOQA_API_TOKEN
      (32+ characters, optional). GET /api/live is the screening board.

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
                             profiles that exist. --device (default desktop) and
                             --visitor anonymous|returning (default anonymous)
                             pick between them. A first-time visitor is the
                             neutral subject: it carries nothing in and keeps
                             nothing out, which is what a place name means when
                             nobody says otherwise. Naming a place that has no
                             profile REFUSES and lists the ones there are;
                             giving both --geo and --country/--city refuses,
                             because two identities have no correct answer.
                             matrix run uses --market instead.

Global:
  --json           machine-readable output (the integration contract)
  --evidence-root  where evidence is written (default: ./evidence)
  --headed         show the browser window
`;
