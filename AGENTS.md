# AGENTS.md

Working brief for any coding agent in this repository. Vendor-neutral — Claude
Code, Codex, Cursor and friends all read this file. `CLAUDE.md` points here.

Depth lives in [`docs/`](docs/):
[architecture](docs/architecture.md) · [PRD](docs/prd.md) · [gaps](docs/gaps.md) · [what shipped](development-update.md)

## What this is

`geoqa` drives a real browser against live sites to answer "what does a visitor
in market X actually experience here, and can we prove it?" — then writes an
evidence package.

Journeys behave like a visitor: mostly reading and browsing at human speed, and
exercising real functionality — search, registration, login, contact forms, CRUD.
A journey that changes state says so (`writes: true`); everything else is
read-only. Nothing writes to Linear, Convex, or any repo.

There is **no build step**. TypeScript executes directly through `tsx`; `tsc`
runs only with `--noEmit`.

## Commands

```bash
pnpm install
pnpm browser:install        # agent-browser install — Chrome for Testing (~179MB)
pnpm playwright:install     # playwright install chromium — only for the e2e suite

pnpm lint                   # tsc --noEmit (still no ESLint, still no formatter)
pnpm typecheck              # same thing
pnpm boundaries             # dependency-cruiser — the layer map, ENFORCED (its own CI step)
pnpm test                   # vitest run — no browser, no network, no sockets
pnpm test:watch
pnpm test:coverage          # enforces the 100% gate; this is what CI runs
pnpm test:e2e               # REAL Chromium + real HTTP server + real evidence

pnpm geoqa <args>           # tsx src/cli/index.ts
pnpm worker                 # Temporal worker (connects and polls forever)
```

Single test file / single test:

```bash
pnpm vitest run src/journeys/__tests__/engine.test.ts
pnpm vitest run src/journeys/__tests__/engine.test.ts -t "some test name"
```

CLI surface (`pnpm geoqa --help` is authoritative):

```bash
pnpm geoqa profile list
pnpm geoqa journey list
pnpm geoqa browser verify [--engine agent-browser|playwright] [--geo <profile>]
pnpm geoqa proxy verify --geo oslo-mobile [--provider http-proxy] [--engine …]
pnpm geoqa journey run --url <url> --geo <profile> --journey <id> \
                       [--engine agent-browser|playwright] [--seed <n>] \
                       [--repeat <n>] [--var k=v]... [--headed]
pnpm geoqa matrix run --url <url> --market <a,b,…> --journey <a,b,…> \
                      [--device mobile,desktop] [--concurrency <n>] \
                      [--dry-run] [--allow-writes] [--seed <n>] [--repeat <n>]
pnpm geoqa experiment run EXP-001 --samples 10 [--geo …] [--url …]
pnpm geoqa evidence inspect <runId>
pnpm geoqa evidence prune [--apply] [--max-age <tier>=<days|null>]... \
                          [--max-total <bytes>] [--privacy-days <days|off>] \
                          [--sweep-tiers pass,warning] [--delete-unreadable]
```

Every command accepts `--json`, and **the JSON shape is the integration
contract** — agent-to-agent callers must never parse the human-readable output. It
carries `schemaVersion` from `GEOQA_SCHEMA_VERSION` (`evidence/manifest.ts`), which
bumps on a breaking change and never on an added field.

Exit codes: `journey run` exits 1 on `FAIL`/`ERROR`; `matrix run` the same, which
includes an *executed* matrix of zero scenarios (zero scenarios is zero evidence);
`experiment run` exits 1 only on `fail` (an `unmeasured` verdict is not a failed
run); `evidence prune` exits 1 when anything was refused or failed **or** when a
`--max-total` could not be met, so a scheduled prune goes red instead of looking
fine. A bad flag value is 2, not a default — `--engine playwrite` is refused rather
than silently running agent-browser.

`geoqa.config.json` in the repo root, when present, supplies the defaults for
`--provider`, `--evidence-root` and the verify endpoint. Precedence is always
**flag > config file > built-in default**; an absent file is not an error and the
run prints which of the two it used; a malformed, unknown-key, credential-bearing
or unreadable file exits 2 rather than falling back.

Two keys documented in `geoqa.config.example.json` are **still inert**
(`evidence.retention`, `network.cooldownMs`) — see
[gaps B-1](docs/gaps.md#b-1--closed--every-key-in-the-example-is-honoured-at-the-call-site)
before adding a third.

Real-browser commands (`browser verify`, `proxy verify`, `journey run`,
`matrix run`, `experiment run`) need `pnpm browser:install` first, or
`pnpm playwright:install` for `--engine playwright`. CI deliberately installs
neither — the whole suite runs against an injected fake runtime.

## Layer map

Dependencies point one way; each layer knows only the one below it.

```
cli/          parse → dispatch → print (index.ts is thin; commands.ts holds the judgement)
config/       geoqa.config.json: schema + credential guard + IMPORTED defaults
run/          context (RunSpec) → stages → execute (one run) → matrix (many, bounded)
journeys/     spec (YAML DSL) → engine (executes) → assertions (pure judgement) + random (seeded)
geo/          profile → observe (both axes) → verify (three-valued verdicts)
network/      GeoNetworkProvider (direct | http-proxy) + a persisted cooldown store
evidence/     redact-at-write → store → manifest (tiered retention) → prune (shelf life)
findings/     classify: step results → severity + confidence + how a human re-checks it
confidence/   five independent axes, overall capped by the weakest
browser/      the ONLY layer that knows an engine exists
experiments/  harness + definitions; per-experiment sampling logic in cli/samplers.ts
temporal/     the same run/ stages, wrapped as durable Activities
fixtures/     a local HTTP server: deliberately broken pages, a contact form, an /ipinfo route
```

`config/` sits below `cli/` and imports only constants and types from `geo/`,
`network/` and `evidence/` — never the other way round, because a default must come
from the module that owns it.

**These arrows are enforced.** `pnpm boundaries` fails the build on six of them;
the rationale for each is in the rule's own `comment` in
`.dependency-cruiser.mjs`, so the CI log explains the invariant rather than naming
a rule. It caught a real violation on its first run against this tree
([gaps B-9](docs/gaps.md#b-9--closed-the-boundary-lints-first-catch)), which is why
`browser/engines.ts` exists: the layer above the seam may name an *engine*, never a
launcher.

Root-level `profiles/*.yaml` and `journeys/*.yaml` are inputs; `infra/` provisions
one country-correct exit per market (read its README before spending anything);
`evidence/` and `experiments/*/results.jsonl` are gitignored run output. The matrix
is **data, not code**: 16 profiles (8 markets × {mobile, desktop}) × 6 journeys =
96 scenarios. `geoqa matrix run` executes them under a bounded pool; nothing
schedules it ([gaps A-3](docs/gaps.md#a-3--the-matrix-runs-in-process-now-nothing-schedules-it-and-the-bound-is-a-guess)).

## Load-bearing invariants

These are the rules a plausible-looking change will break. Each exists because
it was already broken once. Rationale in
[docs/architecture.md](docs/architecture.md).

**1. The browser seam.** Two engines implement `BrowserRuntime`
(`src/browser/types.ts`) and nothing above knows which one served a run:
`agent-browser.ts` (the default, a CLI daemon) and `playwright.ts` (a library,
selected with `--engine playwright`). Only those files may know their engine
exists, and **construction lives inside `browser/` too** (`engines.ts`): a caller
above the seam names an engine, never a launcher. `pnpm boundaries` enforces that,
and it has already caught it being broken. Adding a runtime method means touching
the interface, **both** adapters, and `fake-runtime.ts`.
**2. Transport garbage must never be parseable as a result.** Every browser call
returns `{ok: true, data}` or `{ok: false, failure: {kind, detail, …}}`. There is
no path returning success with absent data. `null` in a `PageReading` means "not
read"; an empty array means "read, and there were none".

On the Playwright engine this takes deliberate work: a library **throws** where a
CLI returned an envelope, so every call is wrapped and every throw is mapped onto
the existing `ExecFailureKind` values. Letting a `TimeoutError` escape a check
would collapse invariant 3 — the engine would file its own blindness as a site
defect. The failure kinds are never extended per engine; that would leak the
engine upward.
**3. A failed assertion and a broken tool are different events.** An assert that
read the page and found it wrong is `failed` → a site finding. An assert whose
reading never arrived is `errored` → category `instrumentation`, severity forced
to `high`, and **never filed against the site**. Counted separately
(`counts.failed` vs `counts.errored`). `ERROR` outranks `FAIL`, because "we do
not know" and "the page is broken" lead a human to different actions.
**4. Three-valued geo verdicts, per axis, never merged.** `match` / `mismatch` /
`unverified`. `unverified` means the probe produced no reading — neither a pass
nor a failure, and collapsing it into either neighbour is the exact failure the
design exists to prevent. Geography is **two axes**: network identity (the IP the
server sees) and browser environment (what the page's JS believes). Verified
separately, both through the browser.
**5. A threshold that could not be measured is never a pass.** In experiments
`unmeasured` outranks `fail`, which outranks `pass`. `rate()` returns `null` for
an empty denominator, never 0 or 100.
**6. No silent geographic downgrade.** If a provider cannot serve a market,
`prepareRun` throws. Falling back to direct egress would produce a run that
looks like a Berlin run, carries a full evidence package, and was executed from
Norway. `direct` egress always carries an explicit warning that geographic
claims are unproven.
**7. The journey never retries; `--repeat N` measures instead.** A silent second
attempt converts a real intermittent site failure into a pass, so repetition is
always explicit: N attempts inside ONE browser and ONE network session (invariant
16 still holds across the set), attempt k at `seed + k` so the attempts genuinely
differ, and every attempt kept. `mergeAttempts` (`journeys/engine.ts`) then reports
each step index at the **worst** outcome any attempt saw — never the last. A check
that failed once and passed twice would otherwise produce no finding at all, which
is the retry's damage arrived at from the other end. The per-label occurrence count
keeps it honest the other way: the finding is filed either way, and 1-of-3 lands at
much lower confidence than 3-of-3, which is `reproduced`. Counting is per attempt,
so occurrences can never exceed attempts. Per-activity retry policies and their
reasoning are in `temporal/workflows.ts`; the durable path has no repeat of its own
yet ([gaps B-4](docs/gaps.md)).
**8. Confidence axes stay separate.** `overall` is weighted *and then capped by
the weakest axis*. `searchObservation` is `null` and stays `null` until a SERP
source exists — never invent a number for something unmeasured.
**9. Ordering in `run/stages.ts`.** `applyDeviceProfile` → `verifyEnvironment` →
journey → evidence. The device must be applied before anything is observed (a
mobile profile silently rendered at 1280px once, and every check passed), and geo
must be verified before the journey so a wrong-market run is not paid for in wall
clock and then dressed in an authoritative evidence package. `verifyEnvironment`
reads the viewport *back* rather than assuming the request took. Within
`applyDeviceProfile`, the descriptor (`device.emulate`, which carries the mobile UA,
scale factor and touch) goes first and the profile's own viewport goes second, so
the declared box always wins over the descriptor's — the viewport is a verified
axis and must mean what the profile says.
**10. Confirm a negative before reporting it.** `isVisible` and the vitals read
both re-check after a settle when the first reading is negative/null — an element
mid-animation and an async-emitted LCP each produce false defects otherwise. A
null that survives the settle is a real null. The corollary is that **absence of
evidence must not be confused with evidence of absence in either direction**: no
layout-shift entries means CLS is *zero*, not unmeasured, and getting that
backwards made `cls-below` unreadable on a perfectly stable page.
**11. Redaction happens at write time**, not as an export pass
(`evidence/redact.ts`). Proxy URLs go through `redactProxyUrl` anywhere they
could reach a human — log, summary, manifest. Proxy credentials come from
`GEOQA_PROXY_*` env vars only, never from `geoqa.config.json` — the config loader
**refuses credential-shaped keys by name**, with a message saying where the value
belongs rather than a generic "unknown key".

Masking by *property name* uses a narrower list than masking a *query parameter*,
and the two disagree on purpose. `key`, `auth`, `session`, `sessionid` and `card`
are structural field names here (`STRUCTURAL_FIELD_NAMES`) and are never masked by
name; in a URL those same words carry values and stay masked. Matching is on the
whole normalised name or its last camel/separator segment, never a substring:
substring matching masked `MetricSpec.key` and destroyed the identity of every
metric in every committed experiment summary, and going further would mask
`className` (contains `ssn`). A HAR is written by the browser and never passes
through this layer at all — see [gaps B-3](docs/gaps.md#b-3--har-is-recorded-now-and-still-absent-from-every-manifest).
**12. Two execution modes, one implementation.** The CLI calls the
`run/stages.ts` functions in sequence in one process; each Temporal Activity
calls exactly one of them. A stage may never import from `temporal/` — that
would make it unrunnable without a Temporal server. Stages take dependencies as
arguments. `RunSpec` must be fully JSON-serialisable *and* carry everything
needed to rebuild the exact browser launch flags: agent-browser is a daemon keyed
by session name + launch flags, so a wrong flag silently hands back a *different*
browser rather than an error.
**13. Never import `temporal/worker.ts`** to read a value from it — it has an
unguarded top-level `main()`. Shared constants live in `temporal/constants.ts`.
**14. A filled value is a secret; a written record is announced.** Journeys
register, log in, send contact forms and perform CRUD, so `fill`/`select` values
arrive through `--var` and must never reach disk. Both adapters mask the value in
`ExecMeta.command`, and `describeAction` renders `fill #password ok (value not
recorded)` — a step result says which selector was filled, never what went into
it. Separately, a journey that changes state declares `writes: true`: the run
announces it before starting, records it in `run.json`, and flags every
screenshot `review`, because a frame taken mid-form plausibly holds a name or an
email and no redaction pass can find that in an image.
**15. Human-like variation must stay replayable.** `pause` draws a length from a
range and `probability` decides whether an optional step happens — both from a
SEEDED generator (`journeys/random.ts`), with the seed on `RunSpec`, recorded in
`run.json`, and settable via `--seed`. Unseeded variation would mean "it failed
and I cannot tell you what it did". A step that does not happen is reported
`skipped`, never dropped: the step list keeps its length and indices, so "we never
looked" stays distinguishable from "it was fine". `probability: 1` and `0` do not
draw at all, so adding a certain step cannot shift every later decision.
**16. One journey is one network session, and that is verified.** A rotating exit
mid-journey does not merely look inauthentic — it takes LCP from one visitor and
CLS from another, so nothing measured can be attributed. `executeRun` re-reads the
egress IP after the journey (via an in-page `fetch`, so the check cannot disturb
the page the evidence describes) and a proven rotation becomes an `errored`,
`critical`, `instrumentation` step, taking the run to `ERROR`. An unreadable
closing probe is `unverified` and produces no step — we are not entitled to a
verdict we could not read.
**17. A setting that nothing reads is worse than a hardcoded constant.** The whole
config surface exists because it used to be inert: every documented key was
actually decided by a constant or a flag, and anyone who edited the file got
silently no effect, with nothing ever contradicting them. So: a key in
`geoqa.config.example.json` must be honoured; a key the design will not honour must
be **absent**; an unknown key is **rejected** (a dropped `verifyEndoint` typo is the
same defect by accident); every default is **imported** from the constant the code
already uses, never retyped, or left unset to mean "that module decides"; an absent
file is fine and the run **says which it used**; a broken file is fatal rather than
a quiet fall back to defaults. Two keys are currently inert and it is a tracked
defect, not a precedent ([gaps B-1](docs/gaps.md#b-1--the-config-file-is-read-now--except-for-two-keys)).
**18. The layer map is a tool, not a memory.** `pnpm boundaries` is a CI gate of
its own, before the tests. Adding a rule means adding a `comment` naming the
failure it prevents, and **proving it fires** against a deliberate violation — a
rule with a mistyped pattern is a silent no-op, which is invariant 17's failure
wearing a different hat. Type-only edges count: switching to `import type` must not
be a way across a boundary. Never weaken a rule to make the tree pass; the tree is
what is wrong.
**19. A matrix must not be able to hide a hole.** A scenario that could not be
executed — a throw, an `ERROR` verdict, or a *preparation* that refused rather than
downgrading a market (invariant 6) — is recorded as `unmeasured` with its reason,
never dropped and never absent. One failure never ends the run: a rejected pool
would leave every queued scenario unattempted and the gaps indistinguishable from
markets that were fine. An empty executed matrix is `ERROR`, because zero scenarios
is zero evidence. And every profile and journey name is validated **before anything
launches** — finding a typo ninety browser launches in is not a report, it is a
bill.
**20. Retention decides capture; pruning decides lifetime; neither substitutes for
the other.** `evidence prune` plans without deleting and deletes only on `--apply`,
and there is deliberately no `--dry-run` flag to forget. Privacy flags only ever
**shorten** a ceiling, a flagged run is never selected to free disk space, a cap
that could not be met is reported as a shortfall rather than met by spending a
failure, and a run whose identity cannot be established is reported and **left in
place**. Not knowing what something was is a reason to look, not a licence to
delete.
**21. Anything that can only be armed at the start is armed for EVERY run, and
kept selectively.** The retention tier is not known until the journey ends, so the
trace, the HAR, the console listener and the interaction observer are all
record-always / keep-on-failure — none of them can be started retroactively for the
run that turned out to need one. Reading instead of arming is a measurement error,
not a shortcut: Chromium's event-timing buffer retains only entries slower than
~104ms, so an observer registered at vitals time reports a *fast* page as never
interacted with. Where arming means the artifact exists on every run, the tier is
honoured by **deleting** rather than by not starting — which HAR does not do yet,
and is why a passing run currently leaves an unlisted `network.har` behind
([gaps B-3](docs/gaps.md#b-3--har-is-recorded-now-and-still-absent-from-every-manifest)).

**22. A session key inside a vendor username contains no separator the vendor
parses.** A residential proxy username is a `-`-delimited parameter list, so a
hyphenated session value is silently truncated at its first hyphen. That collapsed
EVERY run in a market onto one sticky exit — sequential as well as concurrent —
while `egressHeld` reported `match`, because the IP genuinely did hold: it was the
same one every time. `defaultSessionId` is alphanumeric and
`substituteProxyPlaceholders` strips hyphens again, so an injected id cannot
reintroduce it.

**23. A city verdict is a DISTANCE, not a string comparison.** Egress databases
name the exchange's suburb, so comparing names reported `unverified` for Skui
(15km from Oslo) and for Gällivare (1100km from Stockholm) alike — which made a
city-match rate mean anything you wanted. `compareCity` measures great-circle
distance against `CITY_RADIUS_KM` when coordinates exist, which makes `mismatch`
reachable. Without coordinates it falls back to names and keeps the old asymmetry:
no distance, no proof of wrongness.

**24. A path that escapes its tenant's root is a security defect, not a bug.**
Tenant ids are pattern-constrained AND every resolved path is re-checked with
`containedPath`. Containment is `path.relative`, never `startsWith` —
`/evidence/acme` starts with `/evidence/ac`. An absolute segment is refused too,
because `path.resolve("/evidence", "/etc")` is `/etc`.

**25. The publish gate is DEFAULT DENY.** No run, a thrown error, an errored run
or one unread step all block, and the exit code is 0 only for `allow`. `unknown`
(our defect) is a different SENTENCE from `block` (the page's problem) but the same
outcome — a gate that opens when it cannot see is not a gate.

**26. Every value a UI displays is a `Measured<T>`.** A reading with its text, or
an explicit absence carrying the reason. A renderer cannot show a missing metric as
a value because an absence is a different TYPE — and a dashboard is where a number
gets believed, so `0` for a null LCP would undo the whole verdict model at the last
step. Zero stays a REAL reading where zero is meaningful: a CLS of 0 means nothing
moved.

**27. An action's timeout is not a navigation's.** `DEFAULT_ACTION_TIMEOUT_MS =
8_000` for `click`/`fill`/`selectOption`/`check`; navigations keep the long budget.
A cold page on a residential proxy legitimately takes ten seconds, so a short
navigation timeout would invent failures on healthy sites — but an element an action
names either resolved during that load or is not coming. The 30 seconds this
replaces were not merely wasted: `ERROR` outranks `FAIL`, so they ended by
relabelling *the search box is not visible* as *we could not verify*.

**28. An ambiguous action is RECORDED, never refused.** A `click`/`fill`/`select`/
`check` whose selector matched more than one VISIBLE element gets a note in its step
detail. Strict mode is the tempting fix and it is wrong: `#results a, .result`
taking the first of three results is what that journey means. The defect is a report
that reads identically whether the click hit the first search result or the nav link
that happened to come first in the document. Visible-only, silent at one match, and
an engine that cannot count (`agent-browser`) says nothing rather than guessing.

**29. A reproducibility claim is written to the EVIDENCE too, and derived once.**
`executeRun` builds `{attempts, occurrences}` a single time and hands it to both
`collectEvidence` and `assembleResult`. Two derivations of one number are two chances
to disagree, and a finding claiming 3-of-3 beside a package recording 2 attempts
leaves no way to tell which is lying. Occurrences are keyed by `occurrenceKey(step)`
— index AND label — because labels are not unique and a label-only key can report
`reproduced` for a step never seen to fail twice.

**30. The HAR is collected LAST, and `harStop` closes the context.** On Playwright,
closing IS the flush — there is no flush-on-demand — so the block sits after every
live read (vitals, console, snapshot, trace, a11y). Its position is load-bearing: a
HAR collected before the trace takes the trace's context with it. `close()` is
idempotent on both engines because the flush and `executeRun`'s `finally` both call
it, and a second `saveStorageState` through a dead context would report a failed save
for a session saved correctly.

**31. A tier that does not retain the HAR DELETES it after the close.** `harPath` is
armed on every run — it cannot be started retroactively — and Playwright flushes it
whether anything asked or not, so a green run left an unlisted network log on disk.
Unlisted is the worse half: pruning walks the manifest. `pruneUnlistedHar` says so in
the log, because a deleted file is the one thing a reader cannot go back and check.

**32. A config key is honoured at the CALL SITE, and the retention policy is one
table.** Parsing a key nothing reads is B-1, and it recurred twice inside the module
written to prevent it. `evidence.retention`, `network.cooldownMs` and the `browser`
caps now travel on `RunSpec`/`ExecuteOptions` to the code that acts on them. The
retention table reaches both `collectEvidence` and `buildManifest` — honouring it in
the collector alone would report the kinds the config excluded as MISSING and drop
completeness for obeying the config. Carried as a copy: `RETENTION` is module-level
and mutable, and one run narrowing a tier must not narrow every later run's.

**33. A zero reading is not a reading about the page.** An empty text read is confirmed
after a settle (`getText`, mirroring `isVisible`) and then reported **unreadable** —
never failed, never passed. Only the empty read is retried; a non-empty one that lacks
the value is a real site finding, and re-reading it would be the silent retry the
engine refuses everywhere else. Same rule for an unfilled `{placeholder}`: it is our
defect, not a verdict, and `text-absent` is where it mattered — every page lacks the
literal string `{forbiddenCurrency}`, so the check went green having verified nothing.

**34. An ERRORED step is ours, whatever the journey declared.** `categoryFor` checks
the outcome before the declaration, exactly as `severityFor` already did. R-13 lets a
step override the category derived from its CHECK KIND, not the one derived from its
OUTCOME — no author can know in advance that a step will be unreadable, and
`localization.yaml` was filing our blindness as localization defects.

**35. An attribute is not text, and a claim is only valid under its own conditions.**
`attribute-contains` reads markup through `evaluate` (both engines have it, so no seam
primitive and no refusal); `""` is an absent attribute and `null` is "we could not
look". The localization journey asserts the declaration AND the copy, because declaring
a language is not writing it. And it runs under the market's locale: a site serving
`lang` by `Accept-Language` is correct, and looks broken to a probe that never said
what language it wanted — a mistake made three times now, recorded as gaps C-18.

**36. A mobile profile takes the mobile IDENTITY and refuses the mobile LAYOUT.**
`userAgent`, `hasTouch` and `deviceScaleFactor` are declared; `isMobile` never is,
because it alone hands `window.innerWidth` to the page's markup — 980 without a
viewport meta tag against the 390 the profile declares. The viewport is the axis this
engine is most careful about, and a descriptor would trade it for a user agent. The UA
is written out rather than taken from Playwright's version-synced descriptor: a profile
is a declaration, and one that shifted with a dependency upgrade would make two runs
different subjects under one name.

**37. The concurrency bound and its pool live in `run/pool.ts`, which imports NOTHING.**
Both execution modes use it — `runMatrix` and `geoQaMatrixWorkflow` — because invariant
12 does not accept two copies of one rule. It has no imports because workflow code runs
in a deterministic sandbox and cannot pull in the graph `run/matrix.ts` reaches through
`executeRun`; the shared part has to be the part that touches nothing. `boundedPool`'s
contract is that `work` never throws: a rejected task would reject the pool and leave
every queued scenario unattempted, so the gaps would be indistinguishable from markets
that were fine.

## Testing conventions

- `src/**/__tests__/*.test.ts`. Helpers without a `.test.ts` suffix (e.g.
  `src/run/__tests__/fake-runtime.ts`) are collected neither as tests nor as
  coverage.
- Nothing in the suite launches Chrome, opens a socket, or hits the network.
  Dependencies arrive by injection: `CommandDeps` (clock, fs root, browser factory,
  TCP probe, `pruneFs`), `ExecOptions.spawnFn`, `loadJourney`'s `read`,
  `loadConfig`'s `read`, `MatrixOptions.run`/`plan`, `resolveVisitorState`'s
  `exists`. `pruneFs` is not a convenience: without it a test for
  `evidence prune` would be pointed at the repo's real `evidence/`.
- **Coverage gate: 100% lines/statements/functions**, enforced in CI. Exclusions
  live in `vitest.config.ts` and **every exclusion must carry a comment naming
  why**. Prefer narrowing a type to make a switch genuinely exhaustive over
  adding an unreachable `default` arm (see `ActableStep` in `journeys/engine.ts`).
- Verify by execution, not inspection: mapper tests use payloads captured from
  the real CLI, and Temporal workflows run inside `@temporalio/testing` with a
  real worker, so retry counts are assertions about executions that actually
  happened. `temporal/workflows.ts` is coverage-excluded because V8 cannot see
  into Temporal's sandbox — tested-but-unobservable, not untested.
- **Experiments are not tests.** A test asks "does our implementation behave
  correctly?" (deterministic, in CI, failure = bug). An experiment asks "is our
  assumption about the world true?" (statistical, needs a browser and network,
  failure = a fact we now know). Experiments are a human/scheduled action, never
  a CI job.
- **The e2e suite is the third thing** (`e2e/*.e2e.ts`, `pnpm test:e2e`, its own
  `vitest.e2e.config.ts`). Unit tests prove the judgement is right about a reading
  it was handed; only this proves the reading is real. It runs a real Chromium
  through the real `executeRun` against the local fixture server — offline, since
  the verify endpoint points at a fixture route. It is the only thing covering
  `playwright-launch.ts`, and it has already caught two defects no fake runtime
  could: an obsolete launch-level proxy placeholder that killed every navigation,
  and CLS reported as unmeasured on a stable page. Add an e2e case whenever a
  claim is about what a **browser** does rather than about what we do with a
  reading.

## TypeScript notes

`strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`verbatimModuleSyntax`, `noFallthroughCasesInSwitch`.

- `exactOptionalPropertyTypes` is why the codebase is full of
  `...(x ? { key: x } : {})` — you cannot assign `undefined` to an optional
  property. Follow the idiom rather than widening the type to `| undefined`.
- `verbatimModuleSyntax` + ESM: relative imports carry a `.js` extension even
  though the source is `.ts`. Type-only imports need `import type`.
- The `@geoqa/*` path alias is declared in **both** `tsconfig.json` and
  `vitest.config.ts`. Change one, change both, or tests break.

## Wiring checklists

**A new journey check:** `CheckSchema` (`journeys/spec.ts`) → `checkNeeds` and
`evaluateCheck` (`journeys/assertions.ts`) → `CATEGORY_BY_CHECK`
(`findings/classify.ts`) → the `category` enum in `AssertStepSchema` if it needs
a new one → `VITAL_FOR_CHECK` (`journeys/engine.ts`) if it reads Core Web Vitals.

**A new journey step action:** `StepSchema` → the `StepAction` union → `act()` in
`journeys/engine.ts` (exhaustive by type, so a missing arm is a compile error) →
`describeAction` if its record needs anything other than `<action> ok` → decide
whether a failure is fatal (state-changing) or not (evidence-only, like
`screenshot`/`snapshot`). If it carries user input, mask the value everywhere:
the adapters' `command`, `describeAction`, and `resolveSteps`' interpolation are
the three places it can leak.

**A new runtime method:** `BrowserRuntime` → `agent-browser.ts` (+ `args.ts`) →
`playwright.ts` (+ the structural interface it needs, + `playwright-launch.ts`) →
`fake-runtime.ts` AND the local `runtime()` helper in
`journeys/__tests__/engine.test.ts`. Both fakes are cast, so a missing method is a
runtime failure rather than a compile error.

**A new experiment:** an `ExperimentSpec` in `experiments/definitions.ts` (and
its export list) → a `{sample, summarise}` pair in `cli/samplers.ts` registered
in `SAMPLERS` → an `experiments/<id>/` directory with `hypothesis.json`,
`configuration.json`, `README.md`. If the sampler takes an option, it needs a field
on `ExperimentOptions` (`cli/commands.ts`) **and** a flag in `cli/index.ts` **and** a
line in `USAGE`, or the option is unreachable — which is invariant 17 in a new
place, and is currently true of three of them
([gaps A-3b](docs/gaps.md#a-3b--exp-007-exists-now-and-has-never-been-run)). The
directory documents an experiment that has not been run until it has: no
`results.jsonl`, no `summary.json`, and machine-specific fields left `null` rather
than copied from another run.

**A new config key:** decide first whether the design will honour it — if not, it
does not go in the example (invariant 17). Then `ConfigFileSchema` +
`GeoQaConfig` + `resolveConfig` (`config/schema.ts`), with the default **imported**
from the module that owns the constant → the honouring call site in `cli/index.ts`
or `cli/commands.ts` → `USAGE`'s Configuration block → a `$comment` in
`geoqa.config.example.json` saying what it does and what it does not. A test that
asserts the example's values equal the imported constants is what stops the example
drifting.

**A new CLI command:** `USAGE` (`cli/args.ts`) → a `commands.ts` function taking
`CommandDeps` (all its I/O injected, so it is testable at 100%) → dispatch in
`cli/index.ts` (coverage-excluded, so it must hold no judgement) → a
`render…Result` printer for humans and a stable object for `--json` → an exit code
that distinguishes "did not work" from "worked and found nothing".

**A new market:** two files, `profiles/<city>-mobile.yaml` and
`profiles/<city>-desktop.yaml` — a market covered on one device cannot catch a
device-specific defect, which is the class the first live run hit. Each `id` equals
its filename, mobile is 390×844 with `emulate`, desktop is 1440×900 without. No
`src/` change: `profile list` reads the directory, and the tests assert the
invariants (every city on both devices, id matches filename) rather than a literal
list, so a market costs no test edit. The file's header comment names the failure
that market is there to catch, and no two profiles reuse a sentence.

**A new egress provider:** implement `GeoNetworkProvider` (`network/types.ts`)
and register it in `selectProvider` (`network/provider.ts`). `health()` is a
*real* probe by design, which is why it is not called `available()`. A
cloud-browser region provider will carry `proxyUrl: null` and its region in the
session — the interface does not change for it.

**A new browser engine:** implement `BrowserRuntime` over structural interfaces
(see `playwright.ts`'s `PwPage`/`PwContext`) so the adapter is testable with plain
objects → put the real API adaptation in a separate thin file and coverage-exclude
it *with a reason*, then add it to `.dependency-cruiser.mjs`'s
`engine-internals-are-private` so nothing above reaches into it → expose a factory
from `browser/engines.ts` → add the engine to `RunEngine` and `buildRuntime`
(`run/context.ts`), which calls that factory → map the profile in a pure, tested
function → decide what it must **refuse** rather than silently no-op → add an e2e
case. Nothing above `browser/` may learn the engine's name, and a capability the
engine lacks is a named failure, not a quiet success.

## gitignore

Paths naming run-output directories are **root-anchored with a leading slash**,
deliberately. A bare `evidence/` matches at any depth and silently excluded
`src/evidence/` — the entire module — from the first push. Everything built
locally because the files were on disk; a clean clone did not compile.

One comment in there is now wrong: `/geoqa.config.json` is annotated "local config
carries proxy credentials", and it cannot — credentials come from `GEOQA_PROXY_*`
only and the loader refuses credential-shaped keys by name. It is ignored because it
is a per-checkout override, which is a different reason.

## Status

Phase 0 (feasibility) complete; Phase 1 has landed as **capability, not yet as
evidence**. Two engines, 16 profiles, human-paced journeys with seeded variation,
journeys that fill forms and change state, a bounded matrix runner, a config file
that is read, evidence pruning, an enforced layer map, a versioned wire contract.
What has not happened is the measurement: EXP-007 has never run, the matrix has
never been executed against a live site, and the central geographic claim still has
no exit IP behind it.

Deterministic, no LLM anywhere in the pipeline — a failing run must be
reproducible.

**Before starting anything, read [docs/gaps.md](docs/gaps.md).** One entry there is
red on the current tree: the e2e suite asserts a trace filename the Playwright
engine no longer writes. It is one filename, and it is ahead of whatever you were
about to do.
