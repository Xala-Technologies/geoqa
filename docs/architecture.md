# Architecture

How `geoqa` is put together and why each seam is where it is. Operational rules
live in [`AGENTS.md`](../AGENTS.md); requirements in [`prd.md`](prd.md); what is
missing in [`gaps.md`](gaps.md).

---

## 1. The one idea

**Geography is two axes, not one.**

| Axis | Set by | What it changes |
|---|---|---|
| **Network identity** | proxy / cloud-browser region | the IP the *server* sees → CDN edge, geo-redirects, currency, latency |
| **Browser environment** | locale, clock, coordinates, viewport — a `TZ` variable plus an injected script on one engine, context options on the other | what the *page's JavaScript* believes → `navigator.language`, `Intl`, Geolocation, layout |

They are set by different mechanisms, they fail independently, and they are
verified separately — both **through the browser itself**, never through Node's
`fetch`. A Node request leaves over a different socket and, with a proxy attached
at browser launch, a completely different route; measuring the wrong client is
the instrumentation lie that makes an evidence engine worthless
(`geo/observe.ts`).

Every axis carries one of three verdicts:

- `match` — proven right
- `mismatch` — proven wrong
- `unverified` — **the probe produced no reading**

The third is the load-bearing one. A run with Oslo coordinates arriving from a
Frankfurt IP is either a plausible production bug or a worthless QA profile, and
only a two-axis check tells you which. Collapsing `unverified` into either
neighbour is how a QA system reports 100% confidence about a market it never
reached.

## 2. Layers and the dependency rule

Dependencies point one way. Each layer knows only the one below it.

```
                       cli/  ──────────────┐
                        │                  │  experiments/  (harness + definitions;
                        │  config/         │   sampling logic lives in cli/samplers.ts)
                        ▼                  │
      ┌───────  run/ stages → matrix  ──────┤
      │             │      │      │         │
      ▼             ▼      ▼      ▼         ▼
   journeys/      geo/  evidence/ findings/ confidence/
      │             │      │
      └──────┬──────┘      │        network/  (providers + cooldown)
             ▼             │
         browser/  ◄───────┘   the ONLY layer that knows an engine exists

   temporal/  wraps the SAME run/ stages as durable Activities
   fixtures/  a local HTTP server serving deliberately broken pages
```

Those arrows are no longer a convention. Six of them are enforced by
`pnpm boundaries` — see [§18](#18-the-layer-map-as-a-tool).

| Directory | Responsibility |
|---|---|
| `browser/` | Drive a browser and return typed data or a named failure. `types.ts` is the seam; `agent-browser.ts` and `playwright.ts` are the two implementations; `exec.ts` owns process lifecycle and timeouts; `map.ts` turns captured payloads into typed values; `args.ts` builds argv; `bin.ts` resolves the binary; `playwright-launch.ts` is the only file that imports the real Playwright package; `engines.ts` is how a caller above the seam asks for one without naming a launcher. |
| `geo/` | Profiles (YAML → `GeoProfile`), two-axis observation, three-valued verification, and the weighted-but-capped `geoConfidence`. |
| `network/` | `GeoNetworkProvider` (`direct`, `http-proxy`), env-only credential resolution, real TCP health probes, and a persisted per-provider cooldown. |
| `journeys/` | The deterministic step/assert DSL (`spec.ts`), its executor (`engine.ts`), and the *pure* judgement of a reading (`assertions.ts`). |
| `evidence/` | Write-time redaction, artifact store, the manifest with tiered retention plus honest `missing`/`completeness`, and `prune.ts` — how long a package is *kept*, as opposed to what it captured. |
| `findings/` | Step results → findings, with severity, independent confidence, and a `validationMethod` telling a human how to re-check by hand. |
| `confidence/` | Five separate axes; `overall` weighted then capped by the weakest. |
| `run/` | `RunSpec` (serialisable identity), the individually callable stages, one atomic end-to-end `executeRun`, and `matrix.ts` — many runs under a bounded pool. |
| `config/` | `geoqa.config.json`: schema, credential guard, and defaults imported from the constants the code already uses. Sits below `cli/` and imports only constants and types from `geo/`, `network/` and `evidence/`. |
| `temporal/` | The same stages as Activities, with per-stage retry policies, plus the run and matrix workflows. |
| `experiments/` | The statistical harness — `pass`/`fail`/`unmeasured`, rates that can be `null`, JSONL sample log, summary. |
| `cli/` | Pure arg parsing, dependency-injected commands, and a thin dispatch entrypoint. |
| `fixtures/` | Eight routes that each break exactly one thing, so a finding can be attributed to a known defect. |

## 3. The four seams, and what each one buys

**The browser seam** (`browser/types.ts`). Everything above talks to
`BrowserRuntime`. The engine is infrastructure, not the product API, so a journey
spec is never welded to one automation tool — and it is cheap, because the
interface is small and the adapters are thin. It also makes the entire unit suite
browser-free: inject `fake-runtime.ts` and nothing launches Chrome.

The seam has now been paid off twice over. **Two engines implement it** — see
[§13](#13-two-engines) — and adding the second changed nothing above
`browser/`: journeys, geo verification, evidence, findings and confidence were
untouched.

Deliberately absent from the interface: `chat`, and any `eval`-driven control
flow beyond observation. Phase 0 journeys are deterministic; an LLM in this layer
would make a failing run unreproducible.

**The outcome seam** (`ExecOutcome<T>`). Every browser call returns
`{ok: true, data}` or `{ok: false, failure: {kind, detail, exitCode, signal}}`.
There is no code path returning success with absent data. Six named failure
kinds — `spawn`, `timeout`, `idle`, `exit`, `unparseable`, `reported` — because
"the console was clean" and "we never managed to read the console" must not score
the same. `parseEnvelope` scans stdout for the *last* structurally valid envelope
(the daemon prepends lifecycle chatter on a cold start) and returns `null` rather
than an empty success when nothing qualifies.

Three separate timeouts, because one combined timeout hides stalls: **idle** (no
output for N ms → wedged, kill it), **absolute** (total wall clock), and neither
fires for a process that exits on its own, however slowly. A watchdog kill is
reported as what the watchdog saw — "idle for 45s" is actionable; "SIGKILL" is
not.

**The read/judge seam** (`journeys/engine.ts` vs `journeys/assertions.ts`).
`gatherReading` touches the browser; `evaluateCheck` is pure. That makes the
judgement testable without a browser, and it is also what makes the third outcome
possible: a check whose input was never read is `unreadable`, not `failed`. In a
`PageReading`, `null` means "not read" and an empty array means "read, and there
were none".

`gatherReading` fetches **only** what the check declares via `checkNeeds` —
`vitals` and `a11y` each cost a real round-trip, and fetching them for a journey
that never asserts on them would double a run's wall clock for nothing.

**The stage seam** (`run/stages.ts`). Each stage takes its dependencies as
arguments rather than importing them. The CLI calls them in sequence in one
process; each Temporal Activity calls exactly one. Neither knows about the other.
If a stage imported from `temporal/`, it would stop being runnable from a plain
CLI and Phase 0's experiments would need a Temporal server to do anything at all.

## 4. A run, end to end

`pnpm geoqa journey run --url … --geo … --journey …`

```
cli/index.ts          parse argv → dispatch (no judgement here; coverage-excluded)
  ├─ loadConfig(configPath(root))  absent → defaults, and SAYS which; broken → exit 2
  │                                flag > config file > built-in default, thereafter
cli/commands.ts       journeyRun(deps, options)
  │
  ├─ selectProvider(name)          unknown name → direct, with a LOUD warning
  ├─ newRunId(profileId, now)      run_<epoch>_<profileId> — sortable, self-describing
  │
  ├─ run/execute.ts prepareRun()
  │    ├─ loadGeoProfile              invalid → StageError (hard, early)
  │    ├─ provider.health(now)        `unusable` → throw; `unconfigured` → throw unless direct
  │    ├─ provider.createSession()    !ok → throw. NEVER a silent downgrade to direct
  │    ├─ direct egress?              → warning: geographic claims are unproven
  │    └─ writeInitScript()           evidence/<runId>/init-locale.js, BEFORE launch
  │
  └─ run/execute.ts executeRun()
       ├─ loadInputs()                profile + journey, both validated
       ├─ buildRuntime()              agent-browser: toSessionConfig → namespace =
       │                              market id, env.TZ, --init-script, --proxy,
       │                              --user-agent
       │                              playwright: locale/timezone/coordinates/
       │                              viewport as context options, geolocation
       │                              GRANTED, HAR armed, visitor state resolved
       ├─ applyDeviceProfile()        setDevice + setViewport  ← BEFORE any observation
       ├─ traceStart()                record always, keep only if the tier earns it
       ├─ verifyEnvironment()         observeNetwork + observeBrowser → verifyGeo
       ├─ noteProviderOutcome()       a verified-right egress CLEARS the cooldown
       ├─ executeJourney() × repeat   resolveSteps({target, ...vars}) → runJourney,
       │                              attempt k at seed+k, in the SAME session
       ├─ mergeAttempts()             worst outcome per step + occurrence counts
       ├─ verifyEgressHeld()          did one session serve the whole set? (§12)
       ├─ collectEvidence()           tier from verdict → artifacts → manifest → disk
       ├─ assembleResult()            findings + ranking + five-axis confidence
       └─ finally runtime.close()     unless keepOpen
```

Three orderings in that list are correctness requirements, not style:

1. **Device before observation.** Missed on the first live run and caught only by
   opening the screenshot: an `oslo-mobile` run rendered at 1280px because
   nothing set the viewport. Every check passed, the evidence package was 100%
   complete, and the run was quietly measuring a desktop layout under a mobile
   profile's name. Nothing in the logs said so — the artifact did.
2. **Geo before journey.** Verifying afterwards tells you the run was
   geographically wrong only once the wall clock is spent, and leaves a full
   evidence package that looks authoritative about a market it never reached.
3. **Init script before launch.** `--init-script` is a *launch* flag:
   agent-browser hashes it into the launch identity and registers it before first
   navigation. Written later, the page has already loaded with the host's locale.

### Why the init script exists at all

The obvious mechanisms do not work. Measured in EXP-000 against agent-browser
0.34.0:

| Mechanism | Result |
|---|---|
| `--args "--lang=de-DE"` | `navigator.language` unchanged |
| `set headers Accept-Language` | moves the HTTP header **only**; page JS still reads the host's language |
| `--init-script` | works — `navigator.language` became `de-DE` |
| `TZ` env var | the only thing that moves the browser's clock; nothing in the CLI does it |
| `set geo` | records coordinates, but headless Chrome *denies the permission*, so the page gets "User denied Geolocation" — hence the stub in `localeInitScript` |

### One profile is one browser

agent-browser is a **daemon**. Browser state lives in the daemon, keyed by
session name and launch flags, and every flag in `BrowserSessionConfig` except
`sessionId` is a launch option folded into a `launchHash` (measured:
`--init-script` flipped it from `12798…` to `16587…`). Two consequences:

- A Temporal Activity carries no browser handle — it carries the flags that
  *identify* one, and the daemon hands back the same browser. So `RunSpec` must
  reconstruct those flags exactly; get one wrong and the daemon silently gives
  you a **different** browser rather than an error.
- Two markets can never share a process. Parallel market coverage costs one
  Chrome each, which is why `namespace` is set to the market id — making explicit
  what would otherwise be left to a hash collision to decide.

## 5. The verdict model

Four levels, each derived from the one before, and each keeping its distinctions
rather than averaging them away.

**Step outcome** (`journeys/engine.ts`)

| Outcome | Meaning |
|---|---|
| `passed` | read the page, it was right |
| `failed` | read the page, it was wrong → **a site defect** |
| `errored` | the reading never arrived → **our defect** (`instrumentation`) |
| `skipped` | never executed, because a state-changing step failed earlier |

State-changing steps (`open`, `reload`, `click`, `scroll`, `wait`) are fatal —
after one fails there is no page, so later steps are marked `skipped` rather than
executed and reported as passing. Observations (`assert`, `screenshot`,
`snapshot`) never halt the run: the point is to collect every failure in one
pass. A failed screenshot costs evidence, not the run.

**Journey verdict** (`verdictFor`)

`ERROR` (any errored step) > `FAIL` (a critical/high failure) >
`PASS_WITH_WARNINGS` (only lower-severity failures) > `PASS`.

`ERROR` outranking `FAIL` is deliberate: if the engine could not read the page,
the honest headline is "we do not know", not "the page is broken". Those lead a
human to completely different next actions.

**Retention tier** (`evidence/manifest.ts`)

| Verdict | Tier | Keeps |
|---|---|---|
| `PASS` | `pass` | metadata, screenshot, vitals |
| `PASS_WITH_WARNINGS` | `warning` | + console, network |
| `FAIL` | `fail` | + HAR, trace, snapshot |
| `ERROR` | `investigation` | + a11y |

Deliberately asymmetric. A passing run keeps almost nothing — a trace and a HAR
for every green run costs gigabytes to prove something nobody will open. A
failure keeps everything, because re-running to collect what was discarded is
often impossible: the bug may not reproduce. `ERROR` maps to `investigation`
rather than `fail` because that is when we know least and need most, and a11y is
cheap and occasionally reveals the page never rendered at all.

Two properties of that table are easy to get wrong:

- **One `kind` can have several container formats.** The `trace` kind is a
  Chrome-trace JSON from agent-browser and a **ZIP** from Playwright, and the kind
  deliberately does not say which: retention and completeness ask whether a run kept
  a trace, not what it came wrapped in. The artifact's `path` extension and `mime`
  are the authority on the format, and a reader that branches on `kind` to pick a
  parser will be wrong on one engine. Keeping the engine out of the kind is also
  what keeps `evidence/` from ever learning an engine name.
- **A tier decides capture, never lifetime.** Nothing in this table expires
  anything; that is [§17](#17-evidence-has-a-shelf-life).

`manifest.json` and every `--json` payload carry a `schemaVersion` from **one**
constant, `GEOQA_SCHEMA_VERSION` (`evidence/manifest.ts`), stamped by the writer
and never passed in by a caller — a caller-supplied version is how two writers
diverge. It bumps on a removal, rename, type change or meaning change, and
deliberately not on an added field: a version that changes every commit trains
consumers to ignore it.

**Finding** (`findings/classify.ts`) — one per non-passing, non-skipped step. A
skipped step is *not* a finding; filing it would double-count the failure that
halted the run.

### Repeating a journey, and merging the attempts

Repetition sits *before* those four levels rather than beside them: N attempts
become one step list, and the four derivations then run once, unchanged.

The journey never retries, so the only way flakiness becomes a number is to run it
N times **on purpose**: `--repeat N` (`ExecuteOptions.repeat`, clamped to ≥ 1).
`mergeAttempts` (`journeys/engine.ts`) collapses the attempts into one
`JourneyResult` plus a per-label occurrence count, and everything downstream —
`verdictFor`, the retention tier, findings, confidence — is re-derived from the
merged step list exactly as it is for a single run.

**The merge takes the worst outcome at each step index, never the last one**
(`errored` > `failed` > `passed` > `skipped`). This is the decision the whole
feature rests on. A check that failed on attempt 1 and passed on attempt 3 is a
real intermittent site defect; a merge that used the last attempt would file
nothing for it, silently destroying the exact signal three attempts were paid for
— the damage of a silent retry, reached from the other end. The whole step record
travels with the worst outcome, so the finding's `expected`/`observed` come from
the attempt that saw the failure rather than being blended across attempts.

`occurrences` keeps it honest in the other direction: the finding is filed either
way, but 1-of-3 pulls its confidence far below the flat 92 and 3-of-3 earns
`status: "reproduced"`. Counting is **per attempt, deduped by label**, because
`findingsFromSteps` looks occurrences up by label and two steps sharing one would
otherwise let a single attempt contribute 2, push occurrences past attempts, and
make `reproduced` unreachable for precisely the repeated checks.

Four details that are consequences rather than choices:

- **One session for all N attempts.** Repeats happen inside the browser and
  network session the run already opened, so §12's closing egress check spans the
  whole set and the run is still one visitor. A session per attempt would take LCP
  from one visitor and CLS from another.
- **Attempt k runs at `seed + k`.** With `probability` steps and drawn pause
  lengths, identical seeds would make N identical attempts — measuring the site
  under one pacing N times instead of measuring variability. The base seed is what
  is recorded, and it replays the whole set.
- **`durationMs` is the sum**; screenshots come from the last attempt, because
  every attempt writes the same paths and only the last survives on disk.
- **The egress-held step counts as seen in every attempt.** It is one measurement
  of the whole set; reporting it as 1-of-3 would understate the only reading there
  was.

What the evidence package does **not** yet carry is the attempt count itself, so a
`--repeat 3` finding claims three attempts that `run.json` cannot corroborate
([gaps B-4](gaps.md#b-4--finding-reproducibility-is-fed-the-durable-path-and-runjson-are-not)).
The durable path has no repeat of its own either: `runJourneyActivity` runs one
attempt and `assemble` forwards neither count.

## 6. Evidence

An evidence package exists to answer one question months later: *can we reproduce
this?* So the manifest records not only what was captured but what was
**expected** and is absent.

- A required artifact that could not be produced is still **described**, at zero
  bytes. A package that quietly omits the console log on a JavaScript failure
  would otherwise look identical to one where the console was clean.
- `completeness` is the share of required *kinds* present, not a file count —
  counting files would let twelve screenshots paper over a missing trace, which
  is precisely backwards.
- A zero-byte artifact is worse than an absent one, because it looks like
  evidence; `emptyArtifacts` names them and `missingArtifacts` excludes them from
  "present".
- `REQUIRED_QUESTIONS` encodes the eight questions a package must answer (what,
  where, when, which market, which device, which step, reproducible?, what
  technical evidence).

**Redaction runs at capture time, not as an export pass.** The moment an
unredacted value is written it exists in a file, a backup, and possibly a git
object — "we redact on export" is how credentials reach evidence archives.
`redactDeep` masks by key name and by pattern: credentials in URLs, sensitive
query params, emails, and Norwegian national ID numbers (11 digits, masked on
sight — the false-positive cost of an 11-digit order number is trivial next to
writing a real one to disk).

**Masking a property NAME uses a narrower list than masking a query parameter,
and the difference is deliberate.** In a URL, `?key=`, `?session=` and `?card=`
carry values chosen by the site, so `isSensitiveKey` stays broad. As an object
property, those same words are structure in this codebase — `MetricSpec.key` says
which metric a number belongs to, `SessionConfig.sessionId` is a browser session
*name* equal to the run id, `auth` is a mode — so `isSensitivePropertyName`
filters `STRUCTURAL_FIELD_NAMES` out of the set and matches on the whole
normalised name or its last camel/separator segment (`userPassword`, `authToken`),
never on a substring. Substring matching is what caused the damage: `"key"` masked
`MetricSpec.key` in every committed experiment summary, destroying the identity of
every metric, and going further would have masked `className` (contains `ssn`) and
the boolean `cookieIsolated`. `authorization`, `token`, `credit_card` and `cvv`
still mask by name, which is where a real secret lives.

One artifact still bypasses all of this: a **HAR is written by the browser, not
through `writeJsonArtifact`**, so nothing in this layer sees it. Bodies are omitted
at creation for exactly that reason, but request bodies and cookie headers are not
([gaps B-3](gaps.md#b-3--har-is-recorded-now-and-still-absent-from-every-manifest)).

Screenshots are a different problem and are **not** solved: no regex finds
personal data in an image. What is done honestly is to bound it —
`screenshotRisk` flags any page that had a form or an authenticated session as
`review`, and the manifest carries a `privacyNote` so a human knows which
artifacts need care before sharing.

## 7. Confidence

Five axes that stay separate, because five things can each be independently wrong
and a single number hides which.

| Axis | Computed from |
|---|---|
| `geo` | network country (0.75) + city (0.25); capped at 0.4 when country mismatched |
| `browser` | language (0.40) + timezone (0.35) + viewport (0.25) |
| `journey` | `(executed − errored×2 − skipped×0.5) / total` |
| `evidence` | the manifest's own `completeness` |
| `searchObservation` | **`null`** — no SERP source is wired, so no number is invented |

`overall` is the weighted sum, then **capped by the weakest axis**
(`min(weighted, weakest×0.4 + weighted×0.6)`). That cap is the entire reason for
keeping the axes apart: a run that executed perfectly from the wrong country is
not an 80%-confident run. `notes` states in words why the number is what it is.

Errored steps are punished far harder than failed ones in the journey axis — a
failed step is the journey *working* (it looked, and the page was wrong); an
errored step is the journey *not* working, and a run full of them has a verdict
that means nothing.

Finding-level confidence is separate again (`confidenceFor`): a failed check that
genuinely read the page starts at 92; an instrumentation failure starts at 60,
because "the browser could not read the console" is a weaker claim about the
world than "the console contained an error". Repetition is the strongest evidence
available, so 3-of-3 pushes toward 99 and 1-of-3 pulls hard toward "we saw it
once and could not repeat it". A single attempt reports the flat base and
`status: "observed"` — the band only opens once `--repeat` has supplied attempts
to compare.

## 8. Network providers

```ts
interface GeoNetworkProvider {
  name: string
  health(nowMs): Promise<ProviderHealth>     // usable | unconfigured | unusable
  createSession(market, nowMs): Promise<SessionResult>
  close(): Promise<void>
}
```

`health()` is a **real probe**, which is why it is not called `available()` — it
opens a TCP connection and reports what happened. It is also deliberately modest
about what it proves: reachability, not that the account has credit, which no
vendor reports until you spend some. The authoritative signal is
`noteProviderOutcome`, recorded after a run's egress is actually verified.

Two providers ship:

- **`direct`** — no proxy. Egresses from wherever this machine sits. Always
  usable, never geographic, and the baseline every other provider is measured
  against.
- **`http-proxy`** — a generic authenticated proxy, one URL per market, resolved
  **from env only**, most specific first: `GEOQA_PROXY_<MARKET>` →
  `GEOQA_PROXY_<COUNTRY>` → `GEOQA_PROXY_TEMPLATE`.

A third — "the egress *is* the browser host", i.e. a cloud-browser region such as
Browserbase or Kernel, which agent-browser supports natively via `-p <provider>`
— is a deliberate hole rather than an oversight. It needs no proxy URL, so it
will implement the same interface with `proxyUrl: null` and carry its region in
the session. Adding it does not change the interface, which is the point of
having one.

**The cooldown contract** has two rules and the second is the one that gets
forgotten: a failure freezes the provider for an hour, and **a success clears
it**. Omitting the clear is how a sibling project froze every agent for a day on
a subscription that had already recovered. Topping up a proxy account is the
whole recovery; the next successful run must be able to prove it.

`redactProxyUrl` guards every path a proxy URL could take toward a human. The
scheme check in it is load-bearing: `new URL("user:pass@gw")` *parses* — reading
`user:` as the scheme — so an unguarded version returns a malformed proxy string
verbatim with the password still in it. Anything that is not a recognised proxy
scheme is masked whole. A URL carrying a session key needs no special handling
there: the key lives in the username, and the username is masked wholesale
alongside the password.

### The session key lives in the username

Residential vendors have no API for stickiness. They encode the sticky session in
the proxy **username**, e.g.
`http://user-cc-de-sessid-abc123-sesstime-15:pw@gw.vendor.net:7777`, so the proxy
URL is a small template language: `{market}`, `{country}`, `{countryLower}`,
`{city}`, `{cityLower}` and `{session}`. Without the last one, every connection the
browser opens can be handed a different exit and §12's rotation check becomes the
only thing standing between us and a measurement drawn from two visitors.

Substitution runs **uniformly over whichever of the three env sources won**, not
over `GEOQA_PROXY_TEMPLATE` alone. Template-only substitution quietly made both geo
targeting and the session key a privilege of the *least* specific variable: pinning
one market to its own vendor URL is exactly the case that most wants a sticky key,
and that was the one form returned verbatim.

Three details carry the rest:

- **The id is minted before the URL is resolved.** The other order puts one key in
  the proxy username and a different one on the session we report — a run claiming
  a stickiness it never asked the vendor for, with §12's rotation check diagnosing
  the wrong thing.
- **Validation runs on the substituted URL.** `gw.io:{session}` — a real
  port-per-session vendor shape — does not parse raw and does parse once the key is
  in. The corollary is that a session id which cannot live inside a URL refuses the
  run rather than quietly egressing from somewhere unintended.
- **An unknown placeholder is left verbatim, never blanked.** A vendor's own syntax
  may contain braces, and emptying part of a username authenticates as *somebody
  else* instead of failing.

`health()` will not probe a URL that still contains a `{` — a placeholder is not a
host, and reporting an untested reachability would be worse than reporting none.
That honesty currently collides with `prepareRun`'s refusal to run an
`unconfigured` provider, so a placeholder-bearing URL cannot start a `journey run`
at all; see
[gaps B-8](gaps.md#b-8--closed--a-template-can-start-a-run).
And none of this has been exercised against a real vendor: we can show the key
reaches the URL, not that any vendor honours it
([gaps A-1](gaps.md#a-1--closed--proven-against-a-live-residential-vendor)).

## 9. Durability: the same stages, twice

`run/stages.ts` is called two ways.

**In-process** (`executeRun`): one run, start to finish, in a single process.
There is no persisted intermediate state between stages that a separate scheduled
process must pick up later, so there is nothing to orphan when the process dies.

**Durable** (`temporal/`): one run = one workflow execution. Each Activity calls
exactly one stage. If the process dies, Temporal resumes the same execution from
its history — and that history is also the audit trail, which answers a second
failure mode: a run that silently dropped all its work used to look identical to
an idle one. It cannot here, because every Activity, retry and failure is in the
history whether or not anything reported it.

Retry policies are per-stage, and each number is an argument:

| Activity | Timeout | Attempts | Why |
|---|---|---|---|
| `prepare` | 2 min | 3 @ 2s | a proxy refusing one connection is the textbook transient failure |
| `verifyGeoActivity` | 3 min | 2 @ 5s | two page loads, but a verification that keeps failing is usually telling the truth |
| `runJourneyActivity` | 10 min | **1** | it *is* the measurement — a silent retry converts a real intermittent failure into a pass |
| `collectEvidence` / `assemble` | 3 min | 2 @ 2s | writes, safely repeatable |
| `closeSession` | 1 min | 1 | must run in `finally`; a browser that will not close will not close |

The matrix workflow uses **child** workflows rather than a loop of activities, so
one market failing does not take the matrix with it and each run keeps its own
retry budget and separately inspectable history. `geoQaMatrixWorkflow` still runs
its children **sequentially**, which is now true of the durable path *only* — the
in-process runner ([§16](#16-the-matrix-runner)) is bounded-concurrent. That is a
real divergence between the two execution modes and it is tracked as one
([gaps D-2](gaps.md#d-2--the-in-process-matrix-runs-the-durable-one-still-cannot-be-started)),
along with the fact that no client starts a workflow at all: the durable path is
implemented and, in practice, undrivable.

Workflow code may not read the clock, which is why the assembled `durationMs` is
0 there — the duration a human cares about is already on the execution.

## 10. Experiments vs tests

Two different questions, two different mechanisms.

| | Test | Experiment |
|---|---|---|
| Asks | does our implementation behave correctly? | is our assumption about the world true? |
| Nature | deterministic | statistical |
| Needs | nothing external | a browser and a network |
| Runs in | CI, every push | a human or scheduled action |
| A failure is | a bug | **a fact we now know** |

The harness (`experiments/harness.ts`) enforces the honesty rules:

- `rate()` returns **`null`** for an empty denominator. "0 of 0 sessions egressed
  from Norway" is not 0% and not 100% — it is a question we did not ask.
- `evaluateMetric` turns a `null` value into `unmeasured` **with a reason
  attached**, never into a pass.
- `overallVerdict`: `unmeasured` > `fail` > `pass`. Zero metrics is also
  `unmeasured`.
- A throwing sample is recorded as a failed sample and the run **continues** — an
  experiment that aborts on the first failure measures nothing, and the failures
  are usually the interesting part.
- Everything written to `results.jsonl` and `summary.json` goes through
  `redactDeep` first.

The Phase 0 results, including the one recorded as `unmeasured` and why, are in
[`prd.md`](prd.md#5-acceptance-targets) and `inputs/experiments/*/README.md`.

## 11. Testing architecture

Nothing in the suite launches Chrome, opens a socket, or touches the network.
Every boundary is injectable:

| Boundary | Injection point |
|---|---|
| the browser | `CommandDeps.makeRuntime`, or `fake-runtime.ts` directly |
| process spawn | `ExecOptions.spawnFn` |
| a whole run | `CommandDeps.runOnce` |
| a matrix scenario | `MatrixOptions.run` / `MatrixOptions.plan` |
| TCP probing | `CommandDeps.probe` / `ProviderOptions.probe` |
| the clock | `CommandDeps.now`, `RunOptions.now`, `EngineOptions.now`, `MatrixOptions.now` |
| the filesystem | `CommandDeps.repoRoot` / `evidenceRoot`, `loadJourney`'s `read` |
| the evidence tree | `CommandDeps.pruneFs` — so `evidence prune` is covered against a plain-object tree and can never be pointed at the real one |
| the config file | `loadConfig`'s `read` |
| a saved visitor session | `resolveVisitorState`'s `exists` — the judgement is pinned, not the filesystem |
| session ids | `ProviderOptions.newSessionId` |

The coverage gate is 100% lines/statements/functions with a short exclusion list,
and **every exclusion carries a comment naming why** — an exclusion without a
reason is how "the agent never runs at all" becomes invisible to a green suite.
`temporal/workflows.ts` is the interesting one: it runs for real inside
`@temporalio/testing`, but Temporal bundles workflow code into an isolated V8
sandbox that v8 coverage cannot see into, so it always reports 0% however
thoroughly it ran. Tested-but-unobservable, not untested.

Coverage proves lines *ran*, not that anything was asserted. CI can enforce only
that half; the other half is the repo's own rule that every fix is pinned by a
test. What CI *can* now enforce mechanically is the layer map — a separate gate
with a separate kind of failure ([§18](#18-the-layer-map-as-a-tool)).

`fixtures/server.ts` exists so EXP-006 can ask "does a defect produce a finding
whose evidence explains itself?" against defects we control. Breaking production
to test the tester is not a trade anyone should make, and a real bug that happens
to exist today cannot be relied on to still exist tomorrow. Each of its eight
routes breaks exactly one thing and declares the category and check that should
catch it.

## 12. Verifying the egress held

Both geographic axes are read *before* the journey, which answers "are we where
we asked to be?" for one moment. A sticky-session proxy makes a second claim over
a span of time: that the exit IP does not change mid-journey. That claim is
measured, not trusted.

After the journey and before evidence collection, `verifyEgressHeld` re-reads the
egress IP and compares it to the opening reading:

| Outcome | `egressHeld` | Consequence |
|---|---|---|
| both read, same IP | `match` | none; `trustworthy` may stay true |
| both read, different IP | `mismatch` | an `errored` `critical` `instrumentation` step → run is `ERROR` |
| either unread | `unverified` | recorded, no step, run unaffected |

Three details carry the design:

**It reads through an in-page `fetch`, not a navigation.** `observeNetwork`
navigates, and evidence collection reads vitals, console, network and the a11y
tree *after* this runs — navigating to an identity endpoint first would make every
one of those describe ipinfo.io instead of the site. A page-context `fetch` leaves
over the same browser connection, so it is a genuine reading of the same egress,
while leaving the page alone. A strict `connect-src` CSP blocks it, which yields
`unverified`: the honest outcome, and strictly better than a corrupted package.

**A rotation is ours, not the site's.** The page did nothing wrong; our network
moved under the measurement, so nothing observed can be attributed. Filing it
against the site would be the same mistake as reporting a dead browser as a
broken page.

**It is expressed as an appended step, not a parallel verdict system.**
`withExtraStep` appends to `steps` and re-derives counts and verdict, so the
existing machinery does the rest: `verdictFor` returns `ERROR`,
`findingsFromSteps` produces an instrumentation finding, the tier escalates to
`investigation`, and `journeyConfidence` drops. Everything downstream already
follows from `steps`, so appending to it is the only edit needed.

## 13. Two engines

| | `agent-browser` (default) | `playwright` (`--engine playwright`) |
|---|---|---|
| Shape | a CLI daemon, one process per command | a library, in-process |
| Failure signal | a JSON envelope with `success: false` | a thrown exception |
| Proxy scope | a launch flag → **one profile is one browser** | a **context** option → many identities per browser |
| Locale | an injected init script (`--args --lang` does nothing) | `locale` context option |
| Clock | the `TZ` env var only | `timezoneId` context option |
| Geolocation | permission DENIED, so `getCurrentPosition` is stubbed | permission **granted**, real API |
| Device descriptor | `set device <name>` against agent-browser's own table | a `devices[…]` key, taken at context creation |
| Vitals | a `vitals` command | an injected `PerformanceObserver` read |
| INP | whatever the CLI reports | an **interaction observer armed before the page's own scripts**, `null` when nothing was interacted with |
| a11y | an `a11y` command | needs `@axe-core/playwright`; refused for now |
| HAR | start/stop commands | armed at context creation, flushed on **close**; `harStart` reports on it and `harStop` refuses, naming why |
| Trace | start/stop commands, `trace.json` | `context.tracing` start/stop, **`trace.zip`** |
| Returning visitor | not possible — cookies are isolated per `--session`, and the session name is the run id | `storageState` restored at creation, saved before close |

The per-context proxy is the reason Playwright exists here: the matrix that now
ships — 8 markets × 2 devices × 6 journeys — is **96 scenarios**, and at one Chrome
each that is an overnight job rather than a nightly one. Something runs it now
([§16](#16-the-matrix-runner)); nothing schedules it
([gaps A-3](gaps.md#a-3--the-matrix-runs-in-process-now-nothing-schedules-it-and-the-bound-is-a-guess)).

Three rows in that table are asymmetries worth stating rather than discovering:

**INP is armed, not read.** Chromium's default event-timing buffer retains only
entries slower than ~104ms, so an observer registered at vitals time reports a
*fast* page as never having been interacted with and can understate INP by up to
that threshold. Registering the observer in every document before its own scripts
bounds the residual error at one frame (16ms), and that bound is stated where the
number is produced. Same doctrine as arming the trace and the console listeners
before first load: a measurement you can only take at the start cannot be taken at
the end. Interaction reads use a short window rather than the vitals emit settle,
because a click that has not happened will not happen while we look — otherwise
every read-only journey paid the settle twice.

**HAR can only be armed at creation, so it is armed always and kept selectively** —
the same record-always / keep-on-failure shape as the trace. The difference is the
flush: Playwright writes the file when the *context* closes, which is after
`collectEvidence` has already described the directory, so the manifest still
reports `har` as missing and a passing run currently leaves an unlisted one on
disk. Both are open
([gaps B-3](gaps.md#b-3--har-is-recorded-now-and-still-absent-from-every-manifest)).

**A returning visitor exists on one engine only.** `resolveVisitorState`
(`run/context.ts`) is the pure judgement of what a run's visitor *actually* is, as
opposed to what its profile claims: an `anonymous` profile restores nothing **and
saves nothing** (saving would silently make the next run returning); a `returning`
profile on Playwright restores the file if it is there and, if it is not, still
saves one to seed the next run while reporting that this run tested a *first-time*
visitor; on agent-browser it reports that the engine cannot do it at all. The state
file lives at `<evidenceRoot>/visitors/<profileId>.json` — outside any run
directory, because it must outlive one run, and because live cookies are a
credential rather than evidence and an evidence package is the one thing here that
gets copied to a human.

The device-descriptor row is the one place both engines take the **same profile
string** — `device.emulate`, `"Pixel 5"` on every mobile profile — into two
different lookup tables, and neither engine reports a miss: Playwright falls back
to no emulation, agent-browser answers with a warning the run continues past. The
descriptor supplies the mobile user agent, scale factor and touch; the profile's
viewport is applied afterwards and wins, so the one axis that *is* verified matches
either way. That asymmetry is
[gaps C-8](gaps.md#c-8--emulate-is-a-playwright-descriptor-name-applied-to-two-engines-and-no-axis-checks-it).

Two things a swap like this must not break, and how each is held:

- **Named failures.** `classifyPlaywrightError` maps throws onto the *existing*
  `ExecFailureKind` values — `TimeoutError` → `timeout`, a closed page → `exit`,
  everything else → `reported`. The kinds are never extended per engine, because
  everything above the seam branches on `kind` and engine-specific values would
  leak the engine upward.
- **Honest refusals.** Where Playwright genuinely cannot do something at that
  point in a session's life (HAR, a11y, a device the context was not built with),
  the adapter returns a named failure rather than a silent no-op. A no-op
  returning `ok` would produce an evidence package that looks complete and
  contains nothing; a refusal makes the manifest's `missing` list true.

`playwright.ts` holds all of the behaviour and is testable with plain objects,
because it talks to structural interfaces (`PwPage`, `PwContext`, `PwLocator`)
rather than to Playwright's types. `playwright-launch.ts` is the only file that
imports the real package: it launches, creates the context, registers the
listeners whose buffers the runtime reads, and maps the real API onto those
interfaces. It is pure I/O, so it is coverage-excluded — and covered by the
end-to-end suite instead.

Session opening is **lazy**. `buildRuntime` is synchronous and every Temporal
Activity rebuilds its runtime from a serialisable `RunSpec`, so an eager launch
would force that seam to become async and start browsers nothing uses. Deferring
also means a launch failure arrives as a named transport failure rather than as a
throw from a constructor.

## 14. Three kinds of test

| | Unit (`pnpm test`) | End-to-end (`pnpm test:e2e`) | Experiment (`geoqa experiment run`) |
|---|---|---|---|
| Asks | is the judgement right about this reading? | does a real browser actually do this? | is our assumption about the world true? |
| Needs | nothing | a real Chromium + a local server | a browser and the internet |
| Runs in | CI, every push | on demand | a human or scheduled action |
| Failure is | a bug | a bug, usually in the adapter | a fact we now know |

The unit suite is the CI gate and stays browser-free: `fake-runtime.ts` proves
every branch of judgement without launching anything, and the 100% threshold is
enforced there. What it structurally cannot prove is that a *reading is real* —
inject a fake and the adapter is unexamined.

That is what `e2e/` is for. It drives the real `executeRun` with a real Chromium
against `fixtures/server.ts`, offline (the verify endpoint points at an `/ipinfo`
fixture route, so nothing depends on ipinfo.io being up or on where the machine
sits). It asserts the things only a browser can settle: that `locale` moves
`navigator.language`, that `timezoneId` moves `Intl`, that the viewport is what
the page rendered at, that the geolocation permission is granted rather than
denied, that vitals come back as numbers, that a proxy applies to one context and
not its sibling, and that a fail-tier run keeps a non-empty trace.

It has already paid for itself twice, both times on defects a fake runtime could
never surface: an obsolete launch-level `proxy: { server: "per-context" }`
placeholder that made Chromium treat "per-context" as a real proxy host and killed
every HTTP navigation, and CLS reported as `null` — hence "unmeasured" — on any
page with no layout shift, when no shift means zero.

## 15. Configuration

`geoqa.config.json` in the repo root, optional, read once at the top of `main`.
The module exists because the documented config used to be **inert**: every key in
the example was actually decided by a hardcoded constant or a CLI flag, so anyone
who copied the example and edited it got silently no effect
([gaps B-1](gaps.md#b-1--the-config-file-is-read-now--except-for-two-keys)). Four
rules follow from that failure, and each is here to stop it recurring somewhere
new.

**Precedence is flag > file > built-in default, everywhere.** The loader collapses
the last two, so a flag's fallback *is* the configured value and no command has to
implement the order itself.

**Every default is imported, never retyped** — `DEFAULT_VERIFY_ENDPOINT` from
`geo/observe.ts`, `DEFAULT_COOLDOWN_MS` from `network/provider.ts`, `RETENTION`
from `evidence/manifest.ts`. A hand-copied default is a second source of truth
whose drift is invisible: the config keeps serving the old number after the
constant moves. `RETENTION` is deep-copied on the way out, because handing out the
reference would let one caller's narrowing silently narrow every later run in the
process *and* the completeness computed against it.

The `browser` timeouts are the deliberate exception and the strongest form of the
rule. `DEFAULT_TIMEOUT_MS` and `DEFAULT_IDLE_MS` are module-private to
`browser/exec.ts`, and importing them from `config/` would trip
`engine-internals-are-private` ([§18](#18-the-layer-map-as-a-tool)) — so those keys
are left **unset**, meaning "exec.ts decides". `exactOptionalPropertyTypes` then
forces callers to spread them conditionally, which is what stops "unset" being
passed on as `0`.

**An unknown key is rejected, and so is a credential-shaped one.** A silently
dropped `verifyEndoint` typo is B-1 arrived at by accident. Credentials are refused
*by shape, before the schema runs*, so `network.proxyUrl` gets a message naming
`GEOQA_PROXY_<MARKET>` rather than a generic "unrecognized key" — which would
invite the reader to conclude the feature does not exist yet and try harder. The
guard reuses `isSensitiveKey` from `evidence/redact.ts` so it inherits that list
rather than keeping a second copy, plus a fragment list for the proxy shapes it
misses. Bare `pass` and `user` are deliberately *not* fragments: `evidence.retention.pass`
is a legitimate key, and a guard that rejects legitimate config gets deleted within
a week, taking the real protection with it.

**An absent file is not an error; a broken one is fatal.** Missing means a fully
defaulted config with `source: "defaults"`, and the run *prints which of the two it
used* on stderr — a run on defaults because the file sits one directory up must not
look identical to a run that honoured it. Malformed JSON, a schema violation, an
unknown key, a credential and an unreadable-but-present file are all hard stops
(exit 2). `ENOENT` is the only errno read as "no config": a directory or an EACCES
file at that path must not read as absent.

Several rejections are themselves load-bearing, each with a test naming the failure
it prevents: an **empty retention tier** (divides by zero in `completenessOf` and
reports `NaN` completeness — an evidence package that cannot say how complete it
is), **`cooldownMs: 0`** (writes an already-expired cooldown, indistinguishable in
the store from a provider that never failed — "do not pause after a failure" is a
different design, not a number), a **zero timeout** (`exec.ts` reads 0 as "no cap",
and an uncapped run does not fail, it hangs), and a **non-HTTP `verifyEndpoint`**
(the page fetches it from inside the browser, so a bad scheme would not fail
loudly — it would make the network axis `unverified`, turning a typo into "we could
not measure it").

`$comment` is allowed on every object, as a string or an array of strings, and is
the only key accepted without being honoured. It carries a sigil rather than
looking like an ordinary word so a reader can see at a glance that it is prose, and
so `comments` is still rejected.

## 16. The matrix runner

`run/matrix.ts` expands market × device × journey and executes the scenarios
through a bounded worker pool. It knows nothing about profiles, paths or providers:
`plan(scenario) → ExecuteOptions` is **injected**, because resolving
`<market>-<device>` to a profile file would mean either duplicating
`cli/commands.ts`'s helpers or importing them, and `run/` may not depend on `cli/`.
The consequence is a feature: a `plan` that *refuses* — `prepareRun` throwing
rather than degrading a market to direct egress — arrives here as an `unmeasured`
scenario recorded with its message, not as a hole and not as a pass.

Four decisions carry the design:

- **Four outcomes, not three.** `passed` / `warned` / `siteFailed` /
  `unmeasured`, where `unmeasured` covers both an `ERROR` verdict (the run
  happened, its instrumentation did not) and a throw (no result at all),
  distinguished by whether a result exists. The mapping is a
  `Record<GeoQaRunResult["verdict"], MatrixOutcome>`, so a new run verdict is a
  compile error here rather than something that lands silently in a default arm.
  The aggregate ranks `ERROR > FAIL > PASS_WITH_WARNINGS > PASS`, and an **empty
  matrix is `ERROR`** — zero scenarios is zero evidence, mirroring
  `overallVerdict`'s treatment of zero metrics.
- **One failure never takes the matrix down.** A scenario returns rather than
  throws; if it propagated, the `Promise.all` over the pool would reject and every
  still-queued scenario would go unattempted, leaving gaps indistinguishable from
  markets that were fine.
- **Deterministic ordering, twice over.** `expandMatrix` deduplicates and *sorts*
  each axis, so ordering is a function of the axis set rather than of argument
  order — `--market oslo,berlin` and `--market berlin,oslo` produce byte-identical
  output. Results are gathered in completion order and sorted back by scenario
  index at the end; that was chosen over pre-sized slots specifically because a
  "this slot is empty" guard would be an uncoverable `throw` under the 100% gate,
  while sorting cannot produce a hole at all.
- **The bound is provisional and says so.** `DEFAULT_MATRIX_CONCURRENCY = 2`,
  because each in-flight scenario is a browser context and, on agent-browser, a
  whole Chrome — the proxy is a launch flag there. `resolveConcurrency` reads
  `NaN`/`Infinity` (a bad `--concurrency` parse) as *the default*, never as
  unlimited, and clamps below 1 up to 1. `MatrixResult.concurrency` records the
  limit **and the peak actually reached**, so EXP-007 has something to read and a
  matrix that died of memory pressure can still say what it was attempting.

Above it, `matrixRun` (`cli/commands.ts`) holds the judgement the runner has no
business knowing: validate **every** profile and journey up front and refuse the
whole matrix listing all bad names, select the provider once, derive each
scenario's seed as `scenarioSeed(base, scenario.key)` so scenarios differ while the
matrix replays from one number, and put the journey in the run id — without which
two journeys on one profile prepared in the same millisecond share an evidence
directory and the second overwrites the first's manifest. `--dry-run` returns a
null result rather than an empty one with a green-looking verdict, and
`--allow-writes` is demanded before launch rather than announced during it, because
at matrix scale an announcement is one real form per scenario too late.

## 17. Evidence has a shelf life

Retention tiers decide what a run **captures**. `evidence/prune.ts` decides how
long it is **kept** — a distinction that matters because the privacy note ("may
contain personal data") makes unbounded local accumulation a liability rather than
a disk-space question.

`planPrune` never deletes; `executePrune` deletes only when handed
`{apply: true}`, and the dry run still re-validates every path so refusals surface
before anyone types `--apply`. There is deliberately **no `--dry-run` flag** — the
dry run is the default, because a destructive default is how somebody loses the one
trace that mattered.

The policy mirrors the retention asymmetry, applied to time instead of capture:
`pass: 7`, `warning: 30`, `fail: 180`, `investigation: 180` days. A pass's
screenshot and vitals are cheap to discard because they are cheap to *regenerate*;
a failure's trace may be the only copy of a bug that never recurs, and
`investigation` is precious for the same reason.

Three rules keep it from becoming the thing that destroys the evidence:

- **Privacy shortens, never extends.** A run is flagged if its manifest carries a
  privacy note *or* any artifact has `risk: "review"` — both sources, because the
  note is derived, so trusting only the note lets a wording change or an older
  manifest silently un-flag runs. A flagged run's ceiling drops to
  `privacyMaxAgeDays` (14) when that is shorter, so a flagged failure goes at 14
  days rather than 180: a frame that plausibly holds a name decays in value far
  faster than in liability. Deletion is never silent — the plan carries
  `reason: "privacy"` and the manifest's note verbatim.
- **A size sweep may not spend a failure.** `maxTotalBytes` sweeps only the tiers
  it is allowed to spend (`pass`, `warning` by default), cheapest first and oldest
  first, and stops the instant it is under the cap. Flagged runs are never selected
  by it at all: a disk-space job must not be the thing that quietly removes the only
  record of what was exposed. If it runs out of tiers it reports
  `sizeShortfallBytes` rather than reaching further — "could not get under the cap"
  must never read as "did".
- **An unidentifiable run is reported and left alone.** No readable manifest, an
  unrecognised tier, or an unparseable `createdAt` lands in `plan.unknown` with a
  `why`. An unparseable timestamp is deliberately neither age 0 (exempt forever) nor
  the epoch (deleted at once). Only `--delete-unreadable` removes it: not knowing
  what something was is a reason to look, not a licence to delete.

`resolveRunDir` is the only way a directory becomes deletable, and it refuses `.`,
`..`, absolute paths and the root itself. `executePrune` **re-derives** every path
rather than trusting a plan that may have been serialised, printed and handed back.
The filesystem arrives as an injected `PruneFs`, and the real one treats only
*directories* as runs and reports a symlink as a symlink — `browser verify` writes
a loose `verify.png` into the evidence root, and a link out of the root must be
neither walked nor deleted.

## 18. The layer map as a tool

Every arrow in [§2](#2-layers-and-the-dependency-rule) used to depend on a reviewer
remembering it. `pnpm boundaries` (`dependency-cruiser`, config in
`.dependency-cruiser.mjs`) now enforces six of them as errors, and CI runs it as
**its own step before the tests**: a layering violation is different news from a
failing assertion, it reads as "this import crossed a boundary the design rests on"
rather than "something broke", and it fails in seconds instead of after the Temporal
suite has downloaded a server.

| Rule | Forbids |
|---|---|
| `engine-internals-are-private` | anything outside `src/browser/` reaching `exec.ts`, `args.ts` or `playwright-launch.ts` |
| `engine-packages-stay-in-browser` | anything outside `src/browser/` naming `playwright*` or `agent-browser` |
| `stages-must-not-know-temporal` | `run/`, `journeys/`, `geo/` → `temporal/` |
| `never-import-the-worker` | anything → `temporal/worker.ts` (it has an unguarded top-level `main()`) |
| `browser-is-the-bottom-layer` | `browser/` → `geo/`, `run/`, `journeys/`, `evidence/` |
| `no-circular-dependencies` | any cycle, type-only edges included |

Two configuration choices are load-bearing rather than incidental. `tsConfig` must
be set: without it the `.js`-extension imports resolve to nothing and the check
reports a clean, empty graph — a pass because it saw nothing, which is exactly the
failure mode this repo cares about most. And `tsPreCompilationDeps: true`, so
changing `import` to `import type` is not a way to cross a boundary unnoticed.
Every rule was proven to fire against a deliberate violation, because a rule with
a mistyped pattern is a silent no-op.

Output is `--output-type err-long`, which prints each rule's own comment next to
the violation, so a CI log explains the invariant instead of naming a rule.

Scope is `src` only, deliberately: `e2e/` dynamically imports
`browser/playwright-launch.js` and is the only thing covering that file, so
cruising it would report the intent as a defect.

It paid for itself on its first run against the real tree: `run/context.ts` was
importing `playwrightOpener` out of `playwright-launch.ts`, which compiled, worked,
and meant `geoqa profile list` loaded Playwright's whole module tree to print a
list of YAML files. The rule was not weakened — `browser/engines.ts` now owns
engine construction, so the layer above the seam names an engine rather than a
launcher ([gaps B-9](gaps.md#b-9--closed-the-boundary-lints-first-catch)).

## 19. Extension points

The wiring checklists — a new check, a new step action, a new experiment, a new
config key, a new market, a new egress provider, a new engine — are in
[`AGENTS.md`](../AGENTS.md#wiring-checklists).
