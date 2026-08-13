# Gaps

What is not built, what is built but unproven, and what is built but quietly not
working. Written 2026-08-12 against `9f10d48`, and revised the same day —
repeatedly — for the Phase 1 Playwright work, the market matrix, `{session}`,
`--repeat`, and then for the config loader, the in-process matrix runner,
evidence pruning, the boundary lint, the schema version and EXP-007.

**Closed since first writing.** Each of these was a live entry here and is now
either gone or reduced to a stated residue: the EXP-001 sampler could not route
at all; nothing started tracing, so every fail-tier trace was zero bytes; the
geolocation permission was denied and stubbed (Playwright); the screenshot
privacy flag was hardcoded; a sticky-session key could not be expressed in a
proxy URL; finding reproducibility was plumbed but fed by nothing;
`geoqa.config.json` was read by nothing ([B-1](#b-1--closed--every-key-in-the-example-is-honoured-at-the-call-site));
redaction masked every experiment metric key ([B-2](#b-2--redaction-no-longer-masks-structural-field-names));
`visitorType` was declared and unused ([B-7](#b-7--a-returning-visitor-is-restored-now-and-nothing-says-when-it-was-not));
the layering invariants were enforced by review only ([D-1](#d-1--the-layer-map-is-enforced-by-a-tool-now-and-it-has-already-earned-it));
a Playwright trace was written to a `.json` path ([D-1c](#d-1c--closed-a-trace-carries-its-own-format));
the JSON contract was unversioned ([D-3](#d-3--closed-the-json-contract-carries-a-version));
nothing pruned evidence ([D-4](#d-4--closed-evidence-has-a-shelf-life-now));
EXP-007 was cited and did not exist ([A-3b](#a-3b--exp-007-exists-now-and-has-never-been-run));
and the matrix had no entrypoint ([D-2](#d-2--the-in-process-matrix-runs-the-durable-one-still-cannot-be-started)).

Each entry says how it was established, so it can be re-checked rather than
believed. Items marked **verified now** were confirmed against files in the
working tree while writing this document; they are not inherited from a report or
from the README.

**One entry is red right now** and will fail on the next run of the suite it
belongs to:
[B-10](#b-10--closed--the-e2e-derives-the-trace-filename).
It is one filename. Start there.

Sections: [capability](#a-capability-gaps) · [defects](#b-defects-verified-now) ·
[measurement](#c-measurement-gaps) · [tooling](#d-tooling-and-process-gaps)

---

## A. Capability gaps

Declared, designed for, not built. These are known and intentional.

### A-1 · CLOSED — proven against a live residential vendor

**Closed 2026-08-12.** Decodo residential, city-level, verified end to end against
digilist.no. Six of eight cities returned `city: match`:

| Market | Observed | ASN |
|---|---|---|
| Oslo | Oslo | Starlink |
| Bergen | **Bergen** | Lyse Tele |
| Trondheim | *Molde* — `unverified` | Svorka |
| Stockholm | Stockholm | Telia |
| Gothenburg | *Stockholm* — `unverified` | Tele2 |
| Copenhagen | Copenhagen | Hi3G |
| Berlin | Berlin | Starlink |
| London | London | Community Fibre |

Bergen ran at `overall 100 · geo 100`, every axis verified. The two `unverified`
cities are the pool handing back a neighbouring exchange, and `compareCity`
reported them as unproven rather than either claiming the city or failing a
working session — the Lysaker rule earning its keep on a case nobody planned for.

**Three blocking bugs had to be fixed first, all found by pointing it at a real
vendor and none catchable by a fake runtime:**

1. `health()` treated a comma-separated pool as one URL, so a multi-exit market
   reported the vendor unconfigured and refused to run.
2. `health()` refused to probe any URL containing `{`, returned `unconfigured`,
   and `prepareRun` treats that as a hard refusal — **so a template, the only way
   a residential vendor is ever configured, could never start a run at all.**
   Placeholders live in the username; the gateway host and port are literal.
3. Chromium ignores proxy credentials embedded in the URL. Playwright needs
   `username`/`password` as separate fields, or every navigation hangs 30s with
   nothing naming the cause. Fixed via `playwrightProxy()`.

**Measured cost:** ~1 MB per journey. Ten proxied journeys consumed 0.01 GB.

**Still true:** rotation needs ≥2 exits per market to have anything to rotate
through. Residential pools supply that; a static VM IP does not.

### A-1b · The record of what this used to say

**The central capability has still never been exercised**, but the code can now
measure it honestly the moment an exit exists. Every session egresses from this
machine, so EXP-001's `country-match` and `city-match` remain `unmeasured`.

**What changed: the purchase is now specified rather than pending.** `infra/`
ships a provisioning path — one `Standard_B1ls` VM per market running tinyproxy,
Azure because it is the only major cloud with both Norway East and Denmark East,
about $7/month per exit and roughly $28/month for four. `provision-exits.sh`
does nothing without `--apply` and checks SKU availability per region before
creating anything, so a half-provisioned matrix is not a failure mode. The
`infra/README.md` also makes the cheapest honest point available: for the home
market, the office's own Norwegian ISP address is more realistic than anything
purchasable, and it is the default (`--provider direct`) — with the two caveats
that it does not make EXP-001 measurable, and that an office address may be
privileged inside our own stack, which would make every result about blocking and
throttling wrong in the flattering direction.

Still true, and worth knowing before spending:

- `http-proxy` has never made a request through a real proxy. `createSession`
  validates that the URL *parses*; nothing validates that the proxy *works* until
  a run verifies egress afterwards. `{session}` is likewise unexercised: we can
  prove the key reaches the URL, not that any vendor honours it.
- **A URL with a placeholder in it still cannot start a `journey run`** — the
  health gate reads any `{` as "unconfigured" and `prepareRun` refuses. A sticky
  URL contains `{session}` by construction, so this is on the critical path. See
  [B-8](#b-8--closed--a-template-can-start-a-run).
- **Bergen, Trondheim and Gothenburg city-level exits are not sold at any price.**
  Those three markets stay differentiated on the browser axis only, with the
  network axis reporting country-level, unless somebody runs a small always-on box
  on a home connection there. `geoqa` says which is which rather than claiming a
  city it cannot prove ([C-4](#c-4--closed--a-wrong-city-is-now-distinguishable-from-a-naming-artifact)).
- The sticky window must exceed the journey's wall clock. `runJourneyActivity`
  allows 10 minutes and a residential vendor session commonly defaults to about
  10 — an edge, not a margin. `--repeat N` narrows it further, because all N
  attempts run inside one session by design.

Where: `network/provider.ts`, `cli/samplers.ts` (`NO_VENDOR_NOTE`), `infra/`,
`experiments/EXP-001-geo-ip/summary.json`.

**Cannot be closed by code.** An exit IP is a purchase (or a colleague's spare
Pi). Everything the code can do about it is done.

### A-2 · CLOSED — a real SERP source, and `searchObservation` is wired

`src/search/` with a SerpApi adapter. Named for the vendor we actually have credentials
for: the register said "Serper", the working account is SerpApi, and building against a
vendor whose key nobody has would have produced an adapter nothing could prove.

**`health()` is a real probe with three states, verified live:**

```
real key : usable      — SerpApi account Active, 2505 search(es) left
bad key  : unusable    — SerpApi rejected the credentials: Invalid API key…
no key   : unconfigured — SERPAPI_KEY is not set
```

The middle state a credentials check cannot see is the one that matters:
`total_searches_left: 0` with valid credentials is **`unusable`**, because a search
source that cannot answer is worse than an absent one. Empty results read as "nobody
ranks" — which is the DataForSEO failure in `network/types.ts`, and that account is
overdrawn right now while still authenticating. A missing quota field is
`searchesLeft: null` ("does not say"), never `0`.

**The three-state observation, which is the whole point:**

| What happened | `searchObservation` |
|---|---|
| Provider could not answer | `null`, with a reason |
| Results came back, we are NOT in them | a real LOW score (2) |
| Results came back, we rank | scored by position |

"No results at all" is `null`, not zero. An exhausted account returns an empty list, and
so does a parse we got wrong, while "your site is invisible" is one of the most alarming
things this system could say. But "results, but not us" IS a real reading and scores 2 —
a small NUMBER rather than 0, so a measured absence is distinguishable at a glance from an
unmeasured one.

`searchObservation` is deliberately **excluded from `overall`**. The other four axes answer
"can this run's readings be believed"; this one answers "is this page visible in search".
Averaging them would let good search visibility disguise a run that could not read the page.

**Two bugs the first live queries found, both in code I had just written.**

`hl=nb` is REFUSED: *"Unsupported `nb` interface language"*. Google's interface language
for Norwegian is the macrolanguage `no`, not the correct BCP-47 tag a browser sends. A
blind reduction to the primary subtag was wrong for the first market this project was
built for. Fixed with a documented map of the divergences.

`location=Oslo,NO` is REFUSED too. The accepted form is a canonical name from the
vendor's own gazetteer, and its shape is not derivable — `Oslo,Oslo,Norway`,
`Bergen,Vestland,Norway`, `Stockholm,Stockholm Municipality,Stockholm County,Sweden`,
`Berlin,Germany`. So a city is now RESOLVED via the free `/locations.json`, filtered by
country code — because a search for "Oslo" returns `Oslo,Minnesota,United States` in the
same list, and taking the first match would have run a Norwegian market's SERP from
Minnesota and reported it as Oslo. An unresolvable city **refuses the query** rather than
quietly running a country-wide search: the caller asked what a visitor in that city sees.

Both failures were caught on the first live query precisely because the adapter reports an
unreadable response as unmeasured rather than as an empty SERP. A client that returned
`[]` would have reported "digilist ranks nowhere in Norway" twice, confidently.

**A live finding.** For `leie lokaler`, digilist.no is absent from the top 10 in both Oslo
and Bergen — a MEASURED absence, score 2:

```
Oslo    9 results  | digilist: absent  | top3: booking.oslo.kommune.no, aktivioslo.no, selskapslokaler.no
Bergen 10 results  | digilist: absent  | top3: www.bergen.kommune.no, selskapslokaler.no, www.kulturhusetibergen.no
```

**Residual:** nothing in the run path calls `search()` yet — the axis accepts an
observation and no command produces one. That is the wiring for the keyword/SEO agents
(slices 13–15), and it is named here rather than left to be discovered, because an option
nothing reads is the defect B-1 closed.

### A-3 · The matrix runs in process now; nothing schedules it, and the bound is a guess

**Closed: something runs the matrix.** `src/run/matrix.ts` expands
market × device × journey, runs the scenarios through a **bounded worker pool**,
and `geoqa matrix run` drives it. Verified: `expandMatrix` dedupes and *sorts*
each axis so ordering is a function of the axis set rather than of argument order;
results are collected in completion order and sorted back to expansion order;
one scenario throwing never rejects the pool, because a rejected `Promise.all`
would leave every queued scenario unattempted and the gaps indistinguishable from
markets that were fine. A scenario that could not be executed at all is recorded
`unmeasured` with its message, never dropped — including a *preparation* that
refused, which is invariant 6 arriving here as data rather than as a hole.

Still open, and each is a different kind of open:

- **CLOSED: the concurrency default is measured now.** `DEFAULT_MATRIX_CONCURRENCY = 4`.
  EXP-007 ran for the first time (it could not before — the samplers were
  agent-browser-only and there is no Chrome for that engine here, which slice 4 fixed). On
  a 14-core / 36 GB laptop against a local fixture server: 100% completion, 100% verdict
  agreement and 100% egress-held at 2, 4, 8, 12 and 16, with wall clock per session at
  x1.01, x1.01, x1.14, x1.09 and x1.30. Raised to 4 rather than 16 because the default must
  be safe on the smallest machine that will run it, and because
  `peak-memory-per-session` stays unmeasurable so the OOM risk is still unquantified. A
  CPU-derived bound is the obvious next step and is deliberately NOT taken on one data
  point.

  The original wording, kept because the reasoning was right: `DEFAULT_MATRIX_CONCURRENCY = 2`,
  commented as a placeholder for EXP-007, because each in-flight scenario costs a
  browser context and, on agent-browser, a whole Chrome. `MatrixResult.concurrency`
  records both the limit and the peak actually reached, so the number EXP-007 needs
  is being collected while the guess stands.
- **Nothing schedules it on a clock.** `geoqa matrix run` is a command a human
  types. 16 profiles × 6 journeys is **96 scenarios**, and at human pacing
  ([R-58](prd.md#behaving-like-a-visitor)) that is an overnight job — which is
  exactly the shape that wants a scheduler and a self-hosted runner on the office
  connection (`infra/README.md`: a CI runner is in a datacentre and silently loses
  the Norwegian egress).
- **On Playwright, N concurrent scenarios launch N browsers.** `buildRuntime`
  opens one browser per run, so the per-context proxy that made concurrency
  possible is not yet being spent on sharing one browser. That is where the real
  memory win is, and it should wait for EXP-007's numbers rather than precede them.

Where: `run/matrix.ts`, `cli/commands.ts` (`matrixRun`, `scenarioSeed`).

### A-3b · EXP-007 exists now, and has never been run

**Closed as a citation gap.** `EXP_007` is a real `ExperimentSpec` with five
metrics, registered in `EXPERIMENTS`, with a `{sample, summarise}` pair in
`SAMPLERS` and an `experiments/EXP-007-concurrency/` directory. One sample is a
**solo control run first, alone**, then a batch of N at once — without the control
"the batch agreed with itself" scores a meaningless 100%. Each batch session gets
a distinct profile, and asking for more sessions than there are profiles
**refuses**: a run id is `run_<ms>_<profileId>`, so two sessions on one profile in
the same millisecond collide on the run id, hence on the agent-browser session
name, and the daemon hands back the *same* browser — the batch would measure one
browser twice while reporting two.

Three things remain true, and the first is the one that matters:

- **The experiment has not been run.** The directory documents an experiment that
  has not happened: no `results.jsonl`, no `summary.json`, the verdict column reads
  *not run*, and every machine-specific field in `configuration.json` is `null`
  with a status line saying that filling one in from another run would be a
  forgery.
- **`--concurrency` does not reach it.** `ConcurrencyOptions` is declared in
  `cli/samplers.ts` and intersected with `ExperimentOptions`, but
  `ExperimentOptions` itself (`cli/commands.ts`) carries no `concurrency` field
  and `cli/index.ts` passes none — **verified now** by reading the `experimentRun`
  call site. So the experiment can only ever run at `DEFAULT_CONCURRENCY = 3`. Same
  wiring as [C-1](#c-1--the-stability-window-is-a-parameter-and-a-flag-now-reaches-it)
  and [D-1b](#d-1b--the-engine-choice-is-uniform-except-for-the-experiment-samplers);
  all three are the same three lines.
- **`peak-memory-per-session` is declared and permanently `unmeasured`**
  (`NO_MEMORY_PROBE_NOTE`), because the browser is out of process on both engines
  and nothing samples the process tree. Consequence: EXP-007's overall verdict will
  be `unmeasured` until a process-tree probe exists. That is deliberate — OOM is
  the exact fear that kept concurrency at 1, so the target is declared and reported
  honestly rather than omitted.

Where: `experiments/definitions.ts` (`EXP_007`), `cli/samplers.ts`
(`sampleConcurrency`, `concurrencyProfiles`), `experiments/EXP-007-concurrency/`.

### A-6 · CLOSED — tenants are a first-class type, and isolation is demonstrated

`tenants/<id>.yaml` → `Tenant`, evidence at `<root>/<tenantId>/<runId>`, and both
scope rules refused before anything launches. Decided with the owner: a YAML registry
now, a database at run persistence where queries across runs are the actual
requirement; and a proxy sub-account per tenant, so exhaustion is a 407 on that
sub-user alone rather than everyone's runs (slice 7 provisions them).

Isolation is DEMONSTRATED rather than asserted. Two tenants, two real runs, two
disjoint trees:

```
<root>/digilist/run_1786611417809_oslo-desktop
<root>/acme/run_1786611421089_oslo-desktop
```

The security work is `containedPath`, extracted as a primitive because slice 8 needs
the same rule for tenant-scoped profiles and journeys, and a containment check
reimplemented per call site is one that is subtly different in one of them. Three
escapes refused: `..` above the root, an ABSOLUTE segment (which discards the root
entirely — `path.resolve("/evidence", "/etc")` is `/etc`), and a segment resolving to
the root itself, which would hand one tenant the shared tree. Containment is
`path.relative`, never `startsWith`, because `/evidence/acme` starts with
`/evidence/ac`.

Two decisions worth keeping visible. The tenant id refuses UPPERCASE, and not on
style: macOS and Windows filesystems are case-insensitive while Linux is not, so
`Acme` and `acme` would be two tenants in CI and one on a laptop — a cross-tenant
read reproducing only on the machine nobody tests on. And target ownership is compared
by ORIGIN: `https://digilist.no.evil.test` starts with `https://digilist.no` as a
string, so a prefix test would authorise an attacker's host.

**Residual:** quota is DECLARED and not yet enforced. `trafficMb` and `runsPerDay` are
parsed and validated and nothing reads them — which is precisely the defect B-1 closed
for the config file, so it is named here rather than left to be discovered. Slice 7.

### A-7 · CLOSED — per-tenant proxy quota, enforced before launch

The incident this closes: one 430-page sweep consumed an entire allowance, and every
run afterwards returned a bare `407` that reads exactly like a wrong password. An hour
went into the wrong place.

Two numbers, two sources, deliberately not interchangeable. **Traffic** comes from the
vendor (`GET /v2/sub-users`) because bytes are counted at the proxy and an estimate
that drifted would be worse than none — it would be trusted. **Run count** is derived
from the tenant's own evidence directories, because the vendor has no idea what a run
is; derived rather than stored, because a counter file can be deleted, written twice
or left behind by a crash, and every one of those makes the ceiling wrong in the
direction that lets work through.

A matrix is EXPANDED first so the check knows the real page count. Verified live:

```
this run is estimated at 202 MB and tenant "digilist" has 14 MB left of 700 MB —
refusing before anything launches.
```

**The third state is the point.** A traffic figure that could not be read is `null`,
never `0` — the DataForSEO lesson in `network/types.ts`, where a credentials-present
check let a zero-balance account pass for weeks. It warns and proceeds rather than
blocking, and that is a deliberate trade: with a vendor-enforced cap per sub-account,
exhaustion is isolated to the tenant that caused it, so refusing every tenant's work
because a usage API is down would cause more harm than it prevents. The run ceiling
still applies, because that number is ours and is always readable.

**A live finding, and it is about the isolation model rather than the code.** The
account's only sub-user has `traffic_limit: null` — **no vendor-side cap is set**. So
the strong half of the owner's chosen isolation is not in force, and geoqa's own check
is currently the only guard. It says so on every metered run:

```
warning: the vendor enforces no traffic cap on tenant "digilist"'s sub-account, so
this check is the ONLY thing standing between it and the whole account allowance.
```

`auto_disable` is also `false`, so exhaustion will not stop the sub-account either.
**Action for the owner: set a per-sub-account traffic limit at Decodo.** A cap geoqa
enforces can be bypassed by a bug in geoqa; one the vendor enforces cannot.

When a vendor cap IS set, the effective ceiling is the LOWER of the two — a tenant
budget above the vendor's limit is a budget that cannot be spent, and pretending
otherwise refuses late instead of early.

**Residual:** `MB_PER_PAGE_LOAD` is 1, from a measured ~1.2 MB/page on digilist.no
through residential. It is rounded DOWN on purpose (an estimate used to refuse work
should under-state, or it blocks runs that would have fitted) and is named as an
estimate everywhere it surfaces. A tenant whose pages are much heavier will
under-estimate; per-tenant calibration from observed usage is the fix and needs run
persistence.

### B-11 · FIXED — a profile or journey id could be a path

**Security fix, and it predates multi-tenancy.** `profilePath` and `journeyPath`
`path.join`ed a CLI-supplied id straight onto a directory, so:

```
$ geoqa proxy verify --geo ../../../../etc/hosts
profile "…": /Volumes/etc/hosts.yaml: ENOENT
```

Verified against the code before the fix. The blast radius was limited — only `.yaml`
files were reachable and a parse failure was the usual outcome — but the id came from
the command line, the resolved path was echoed back, and a YAML parse error can quote
the line it failed on. An attacker-controlled read attempt with a disclosure channel is
enough to call it a defect rather than a wart.

Closed by `DataIdSchema` (same shape and same reasoning as `TenantIdSchema`: these ids
become filenames) plus `containedPath` on every candidate, which is the belt to the
pattern's braces. Found while building tenant-scoped data, which is the honest story:
the traversal was not what the slice was for, and adding a second search root is what
made anybody look at how the first one was joined.

The error also improved: `no profile named "x" — looked in <paths>` instead of the
loader's ENOENT, which told a reader about the filesystem rather than about their typo.

### A-8 · CLOSED — profiles and journeys can be tenant-scoped

`tenants/<id>/profiles/` and `tenants/<id>/journeys/`, resolved BEFORE the repo's own.
A tenant's file wins by name, and everything it has not customised falls back to the
shared set — so a tenant declaring one custom journey still gets the other seven,
without forking the engine.

Proven live. `tenants/digilist/journeys/landing-page.yaml` tightens the LCP budget from
the shared 2500ms to 1200ms:

```
shared:  landing-page   13 steps  Landing page validation
tenant:  landing-page    8 steps  Landing page validation (digilist budgets)

$ geoqa journey run --tenant digilist … --journey landing-page
  ✓ fast for THIS tenant
PASS
```

The listing de-duplicates by filename, so a tenant's override REPLACES the shared entry
rather than appearing twice — a listing that disagreed with the resolver would be worse
than no listing.

**One regression caught by the suite and worth recording.** Making the path builders
throw broke `matrix run`'s "report every problem at once" contract: it aborted on the
first bad name, turning "these four names are wrong" into "this one is", once per run.
The matrix now resolves through `resolveDataPath` and collects refusals like any other
validation error.

**And a process mistake of mine, recorded because it shipped.** A live-verification step
used `git checkout tenants/digilist.yaml` to undo a temporary edit, and silently
discarded the `proxySubUser` field added minutes earlier in the same slice — so
[A-7](#a-7--closed--per-tenant-proxy-quota-enforced-before-launch) was committed
describing a field the tenant file did not have. Restored here. `git checkout` is not an
undo for a file with other uncommitted work in it.

### A-4 · CLOSED — findings and verdicts are queryable across runs

`<evidenceRoot>/runs.jsonl`, one record per run, appended as each finishes, under the
tenant's evidence root when a run is scoped — so a tenant's history inherits the
containment already proven in `tenant/registry.ts` rather than inventing its own.

**The decision worth recording is that the index is a DERIVED CACHE, not the truth.**
Each run's `run.json` is the authority on that run, so a corrupt, truncated,
hand-edited or deleted index costs nothing permanent and `geoqa runs rebuild`
reconstructs it. A store that owned the record would introduce exactly the failure this
project exists to prevent: a confident answer about runs that did not happen the way it
says.

**Why not SQLite, which Node now ships.** `node:sqlite` is EXPERIMENTAL — it prints a
warning on every invocation and its own documentation says it may change at any time.
A CLI that emits an experimental-feature warning before every line of output is a worse
tool, and "may change at any time" is a poor foundation for the store that trends and a
UI are meant to depend on. JSONL costs one line per run, is greppable, diffs in a
review, and cannot lose a run because the run is still on disk. **When SQLite becomes
right:** when a query needs an index rather than a scan — a tenant with 10,000 runs is a
10 MB file scanned in milliseconds, but a hosted UI serving many tenants concurrently is
a different problem, and this shape imports into a table without a rewrite.

Regression detection is the payoff and is proven live on a stable origin: a page loses
its `h1`, and

```
1 regression(s) — a check that used to pass and now does not:
  has a primary heading · oslo-desktop/h1 · last good …05.988Z → first bad …08.306Z
```

Four deliberate narrowings, each of which prevents a specific false report:

- Scoped to one profile + journey + target. "The h1 check started failing" is only
  meaningful for a fixed combination, and merging them averages a real regression into
  noise.
- Only the TRANSITION. A check that broke on Monday is one entry with a Monday date, not
  one per day since — a list that grows while nothing new breaks is a list nobody reads.
- A failure with no earlier pass is NOT a regression. It may never have worked, and
  saying otherwise sends somebody looking for a change that does not exist.
- An `ERROR` run is SKIPPED, not read as a failed check. `ERROR` means geoqa could not
  read the page; reporting our own instrumentation failure as the site's regression is
  the single confusion this whole codebase is built to avoid.

Three honesty properties carried through: `meanConfidence` is `null` for an empty
history rather than 0; a `null` vital stays null rather than becoming a zero that would
show a page getting faster the moment it stopped being measurable; and `--limit`
truncates the printed list only, never the summary or the regressions.

**Appending can never fail a run.** A run that verified a site correctly and wrote its
evidence has not failed at anything a user cares about if a cache line could not be
written, so the problem is logged and the result returned.

**Residual:** a rebuilt record is poorer than an appended one — `run.json` carries the
journey's verdict and seed but not the assembled confidence report — and it says so
rather than filling the gaps with defaults that would read as real readings. Widening
`run.json` to carry the assembled result would close it and is a schema change.

### A-5 · Adaptive recovery deferred

PRD §37. Deliberately deferred until the deterministic path has a baseline worth
deviating from — an adaptive journey that recovers from a failure is a journey
whose failures cannot be compared with yesterday's.

**Cannot be closed by code.** It is a decision, and the decision is "not yet".

Where: `journeys/spec.ts`.

---

## B. Defects (verified now)

Built, wired, and not doing what it looks like it does. Most of these were found
by reading the code and its output rather than by a failing test — the suite is
green on them. Two were not, and that is progress:
[B-9](#b-9--closed-the-boundary-lints-first-catch) was caught by the boundary lint
on its first run against the real tree, and
[B-10](#b-10--closed--the-e2e-derives-the-trace-filename) fails
the e2e suite out loud. A defect a tool shouts about is a better defect than one a
document has to remember.

### B-1 · CLOSED — every key in the example is honoured at the call site

**Closed for most of the surface.** `src/config/load.ts` reads
`geoqa.config.json` from the repo root, `src/config/schema.ts` validates it, and
`cli/index.ts` loads it once at the top of `main` with precedence
**flag > config file > built-in default**. Three properties are load-bearing and
each is pinned by a test:

- **An absent file is not an error**, and the run *always says which it used* —
  `config: <path>` or `config: built-in defaults (no geoqa.config.json at <path>)`
  on stderr. A run on defaults because the file sits one directory up otherwise
  looks identical to a run that honoured it, which is B-1 in miniature.
- **A malformed, unknown-key, credential-shaped or unreadable-but-present file is
  a hard stop** (exit 2), never a fallback to defaults. ENOENT is the only errno
  read as "no config": a directory or an EACCES file at that path must not read as
  absent. A silently-dropped `verifyEndoint` typo is the same class of failure as
  B-1 itself.
- **Every default is imported from the constant the code already uses** —
  `DEFAULT_VERIFY_ENDPOINT`, `DEFAULT_COOLDOWN_MS`, `RETENTION`. A hand-copied
  default is a second source of truth whose drift is invisible. The `browser`
  timeouts are the deliberate exception: `exec.ts`'s numbers are module-private and
  a boundary rule forbids importing them, so the keys are left **unset** meaning
  "exec.ts decides", which is the strongest available version of one source of
  truth.

Honoured today, **verified** at the call site: `network.provider` (fallback for
`--provider`), `network.verifyEndpoint` (reaches `proxyVerify`, `journeyRun`,
`matrixRun`, and lands on `RunSpec.verifyEndpoint`), `evidence.root` (via
`resolveEvidenceRoot`; relative paths resolved against the repo root, flag wins).

**CLOSED: `evidence.retention` decides what a run collects AND what its manifest
calls required.** It was parsed, validated, defaulted and deep-copied, then read by
nobody — B-1's own defect recurring inside the module built to prevent it. It now
travels on `RunSpec` (a plain record of string arrays, so the durable path rebuilds
it unchanged) and reaches both `collectEvidence` and `buildManifest`. **Both halves
were required together**: had only the collector honoured a narrowed tier, every run
would report the kinds the config told it not to keep as MISSING and completeness
would fall — a policy that punishes you for setting it. Carried as the loader's copy,
never a reference to the module-level `RETENTION`, so one run narrowing a tier cannot
narrow what every later run in the process keeps; a test pins that.

**CLOSED: `network.cooldownMs`, and the store it belongs to was unreachable
entirely.** Nothing in the CLI passed `cooldownPath` either, so `httpProxyProvider`
returned null from `cooldownUntil` and `noteProviderOutcome` returned immediately —
a vendor that failed mid-sweep was retried on every scenario, which is exactly what
the store was ported from agent-fleet to prevent. Both halves are wired: the READ
into `selectProvider`, the WRITE into `executeRun`. A store that only ever added
would freeze a recovered vendor, so the success path clears it, unchanged. The file
lives at `<evidence-root>/cooldowns.json`, beside `runs.jsonl` — both derived state
about this installation — and is resolved AFTER the `--tenant` swap, so a tenant with
its own proxy account neither inherits nor causes another tenant's freeze.

**CLOSED: `browser.commandTimeoutMs` / `idleTimeoutMs` reach `journey run` and
`matrix run`.** They reached `browser verify` and `proxy verify` only, so a cap on a
hung command applied to the two commands least likely to hang and silently not to the
two that do the work. Now on `RunSpec` — both plain numbers, neither changes
agent-browser's launch identity, so invariant 12 holds. Spread conditionally, because
`exec.ts` reads 0 as "no cap" and a run with no cap does not fail, it hangs.

**CLOSED: `ProviderOptions.cooldownMs` deleted.** Nothing read it; the live path is
`noteProviderOutcome`'s own options. Passing the config value there would have looked
wired and done nothing — a fresh B-1 inside the fix for B-1.

**CLOSED: the `.gitignore` rationale.** `/geoqa.config.json` is not ignored because
it carries credentials — it cannot; they come from `GEOQA_PROXY_*` only (R-26) and
the loader refuses a credential-shaped key by name. It is ignored because evidence
roots, timeouts and retention are machine-local choices, and a committed one would
silently retune everyone else's runs. `geoqa.config.example.json`'s claim that every
key is READ is now true of the run as well as the loader.

**One half stays open, and it belongs to D-2 rather than here.** The durable path
READS cooldowns (`prepare` forwards `cooldownPath` to `selectProvider`) and never
WRITES one: `noteProviderOutcome` lives in `executeRun`, which is the in-process path
only. So a Temporal run would honour a freeze the CLI set and never set one itself.
Putting the other three keys on `RunSpec` means the durable path picks all of them up
for free — `collectEvidenceActivity` passes `args.spec`, `buildRuntime` reads the caps
— so the cooldown write is the single remaining asymmetry, and it waits behind
[D-2](#d-2--the-in-process-matrix-runs-the-durable-one-still-cannot-be-started) with
B-4's, because nothing starts a worker to exercise it.

Where: `evidence/manifest.ts` (`RetentionPolicy`), `run/context.ts` (`RunSpec`),
`run/stages.ts`, `run/execute.ts`, `network/cooldown.ts` (`cooldownStorePath`),
`network/provider.ts`, `cli/commands.ts`, `cli/index.ts`,
`geoqa.config.example.json`, `.gitignore`.

### B-2 · Redaction no longer masks structural field names

**Closed.** `redactDeep` now matches property names with
`isSensitivePropertyName`: the whole normalised name (lowercased, separators
stripped, so `api_key` ≡ `apiKey`) or its last camel/separator segment
(`userPassword`, `authToken`), against a set that explicitly **excludes**
`STRUCTURAL_FIELD_NAMES` — `key`, `auth`, `session`, `sessionid`, `card`. No
substring matching, deliberately: substring was B-2's mechanism, and `includes`
would go further still and mask `className` (contains `ssn`) and the boolean
`cookieIsolated`.

Query-parameter masking (`isSensitiveKey`) is unchanged and stays broad — in a URL
those words carry *values*, so `?key=`, `?session=` and `?card=` are still masked.
The same word therefore gets opposite verdicts from the two functions on purpose,
and a test says so. `authorization`, `token`, `credit_card` and `cvv` still mask by
name, which is where a real secret lives.

Pinned by a test asserting a `MetricSpec.key` survives a `redactDeep` round trip —
the regression that destroyed the identity of every metric in every committed
experiment summary.

**The seven committed `summary.json` files still read `"key": "***"`, and are
deliberately not regenerated.** They record runs that happened; rewriting them
without re-running the experiment would falsify a result, and re-running needs a
browser and the network. They are correct as artifacts of a defective writer. The
only honest route to readable summaries is to re-run and record new files
alongside.

One incidental change to know about: `cli/samplers.ts` writes
`observedCookie` in the EXP-003 isolation probe, whose tail segment is `cookie`, so
it is masked in `results.jsonl` from now on where the old regex missed it. A real
site's cookie *is* sensitive; the verdict field `cookieIsolated` is untouched, so
nothing about the experiment becomes unreadable.

Where: `evidence/redact.ts`, `evidence/__tests__/redact.test.ts`.

### B-3 · CLOSED — the HAR is recorded, listed, flagged, and deleted when unretained

**Recording: closed.** A Playwright context is created with
`recordHar: { path, mode: "full", content: "omit" }`, armed for **every** run —
the same record-always / keep-on-failure shape as the trace, and for the same
reason: a HAR cannot be started retroactively for the run that turned out to need
one. `content: "omit"` because a HAR never passes through `redactDeep`.
`harStart` now reports on the armed recording; `harStop` **refuses in all three
cases**, each with a distinct truth — nothing armed, armed to a *different* path
than asked (both paths named, so nobody hunts for a file that will never appear),
or armed correctly and pending, which says plainly that Playwright writes it when
the context CLOSES and the file does not exist yet.

**CLOSED: presence in the manifest. `harStop` closes the context, because on this
engine that IS the flush.** It used to refuse, accurately — Playwright offers no
flush-on-demand, so `ok` would have described a file nothing had written. Refusing
accurately turned out not to be the same as being right: `missing` listed `har` on
every fail-tier run and completeness sat at **88%** for a recording that landed on
disk seconds later, when the run's own `finally` closed the same context.

Two consequences of that, both handled where they are paid:

- **The `har` block is collected LAST**, after vitals, console, network, snapshot,
  trace and a11y. Its position is load-bearing, not a matter of reading order — a
  HAR collected before the trace would have taken the trace's context with it.
- **`close()` is idempotent on both engines.** `harStop` closes and the `finally`
  closes again. Playwright tolerates a repeated `context.close()`; `saveStorageState`
  does not, and would have reported a failed save for a session saved correctly the
  first time — the exact false alarm B-7 exists to prevent. agent-browser's would
  have re-run the CLI against a dead daemon.

E2E now asserts fail-tier completeness is **100** and the HAR is non-empty.

**CLOSED: the pass-tier retention hole.** `harPath` is armed unconditionally, and
Playwright flushes on close whether anything asked or not, so a green run — whose
whole point is to keep almost nothing — left a full network recording on disk that no
manifest listed. An *unlisted* file is the worse half: pruning walks the manifest, so
nothing would ever have removed it. "Never call stop" was sufficient for the trace and
is not sufficient here, because the flush is not ours to skip. `pruneUnlistedHar` runs
after the close, deletes a HAR the manifest does not list, and SAYS SO in the log — a
deleted file is the one thing a reader cannot go back and check. A failed delete is
reported as a retention problem, never as a failed run. E2E asserts a passing run
leaves no `network.har`.

**CLOSED: the HAR carries the same risk flag as a screenshot, and needs it more.**
`screenshotRisk` is now `artifactRisk`, because it stopped being about screenshots.
Bodies are omitted at creation but REQUEST bodies and `Cookie` headers are not, so a
login journey's HAR can hold a filled credential — and unlike an image, which needs a
human to read it, a HAR is grep-able. `privacyNote` was widened from "screenshot(s)"
to "artifact(s)": a reader who trusted the old wording would have shared a file
holding a request body because the sentence only warned about images.

**One conflict this created, resolved explicitly.** `keepOpen` says "do not close the
session" and a har tier now says "close it to flush the HAR". A `keepOpen` run collects
NO HAR: the manifest reports it missing, which is true — the file does not exist — and
the run logs the reason rather than leaving it to be inferred from a completeness
number. Handing a caller that said it still needed the session a dead one is the worse
half of the trade, and describing a file nothing wrote is the worst of the three.

Still true and unsolvable rather than unfinished, the same as B-6: the flag bounds the
problem, it does not remove it. Nothing detects personal data inside a HAR any more
than inside an image.

Where: `browser/playwright.ts` (`harStop`, `close`), `browser/agent-browser.ts`
(`close`), `run/stages.ts` (`pruneUnlistedHar`, collection order), `run/execute.ts`,
`evidence/redact.ts` (`artifactRisk`), `evidence/manifest.ts` (`privacyNote`).

### B-4 · Reproducibility is fed and now CORROBORATED; only the durable path is left

**Closed for `journey run`.** `--repeat N` runs the journey N times inside one
browser and one network session, `mergeAttempts` collapses the attempts taking the
**worst** outcome at each step index, and `executeRun` forwards `attempts` plus
per-label `occurrences` into `findingsFromSteps`. 3-of-3 lands near 99 and reports
`reproduced`; 1-of-3 lands far below the flat 92; a single-attempt run behaves
exactly as before.

**CLOSED: `run.json` corroborates the count.** `CollectInput.reproducibility` carries
the attempt count and the per-step occurrences into the evidence, and `executeRun`
derives them **once** for both consumers. That last part is the point: the result
carries them so a finding can say `reproduced`, and the package carries them so that
claim can be checked rather than believed — and two derivations of one number are two
chances for them to disagree, which would leave no way to tell which is lying. An
`executeRun` test asserts the two agree. Omitted entirely on a single run, because a
`1` reads as a decision not to repeat rather than as the absence of one. `steps`
remains the MERGED list, and the comment says so, so nobody reads `attempts: 3` as
three step lists.

**CLOSED: occurrences are keyed per step, not per label.** `occurrenceKey(step)` is
`${index}:${label}` — the index makes it correct, the label keeps it readable. Under
the old label-only key, two steps sharing a label shared one count: an unlabelled
assert's label is its check kind, so a journey with two `text-present` asserts merged
them, and one failing every attempt beside one failing never read as *both* failing
every attempt — `reproduced` on a step never seen to fail twice. Within a single
attempt the same two summed to 2 of 1, which made `occurrences === attempts`
unreachable for exactly the checks that repeat. Safe because a journey is
deterministic (R-10), so index N is the same step in every attempt — the assumption
`mergeAttempts` already makes when it takes the worst outcome at each index. The
per-attempt `Set` that used to guard the sum is gone with it, rather than kept as a
guard that can no longer fire.

Still open in one place:

- **The durable path still runs one attempt.** `runJourneyActivity` calls
  `executeJourney` once and has no repeat path; `assemble` forwards neither
  `attempts` nor `occurrences`, so a Temporal run's findings are all `observed`.
  Two execution modes, one implementation — except here. Blocked with the rest of
  [D-2](#d-2--the-in-process-matrix-runs-the-durable-one-still-cannot-be-started):
  nothing starts a worker, so the path cannot be exercised end to end.

### B-5 · Rotation is detected, but only a PROVEN rotation

Unchanged, and listed because the limitation is worth stating rather than
discovering. `executeRun` re-reads the egress IP after the journey via an in-page
`fetch`, so the check cannot disturb the page the evidence describes. A proven
rotation appends an `errored`, `critical`, `instrumentation` step, taking the run
to `ERROR` — correct, because measurements drawn from two exits cannot be
attributed to the site.

What it does NOT do is prove stability. An unreadable closing probe — a strict
`connect-src` CSP blocks the fetch — yields `unverified` and no step, so a run can
still silently span two exits if we never got to look. That is the honest outcome
(an unreadable probe must not discard a good run) but it means `egressHeld: match`
is the only positive claim, and `unverified` is common on hardened sites.

### B-6 · The screenshot privacy flag was hardcoded

**Closed.** `collectEvidence` used to call `screenshotRisk({ hadForm: false,
authenticated: false })` with both values literal — harmless while journeys only
read pages, a lie the moment one could register an account or send a contact form.
Both are now derived: `hadForm` from whether any step filled, selected or checked
a control, `authenticated` from the journey's `writes` declaration. A form
journey's screenshots are flagged `review` and the manifest carries a privacy note
naming them. Proven end to end against a real submitted form.

Still true, and unsolvable rather than unfinished: nothing detects personal data
*in* an image. The flag bounds the problem; it does not remove it. And see
[B-3](#b-3--closed--the-har-is-recorded-listed-flagged-and-deleted-when-unretained) —
the HAR is a second artifact with the same problem, and it carries the same flag now.

### B-7 · CLOSED — a real cookie is proven to survive between two runs

**Closed for the mechanism.** `PwContext.saveStorageState` plus
`PwSession.saveStatePath` mean a Playwright context saves the visitor's session
**before** closing, and reports the save failure even when the close succeeded —
a green close would otherwise be the only trace of a lost session, and the next
run would be a first-time visitor calling itself returning. `resolveVisitorState`
(`run/context.ts`) decides what a run's visitor actually is:

- `anonymous` → restores nothing *and saves nothing*, because saving would
  silently make the next run returning;
- `returning` + playwright + file present → `restored: true`;
- `returning` + playwright + file absent → `restored: false`, still saves, to seed
  the next run;
- `returning` + agent-browser → `path: null`, because that engine isolates cookies
  per `--session` and the session name is the run id, so every run arrives as a
  first-time visitor.

The state file lives at `<evidenceRoot>/visitors/<profileId>.json`, outside any run
directory, because it must outlive one run and because it holds live cookies — a
credential, not evidence.

**CLOSED: the honesty half.** `executeRun` resolves the visitor state, LOGS the
`unmet` sentence, and `run.json` now carries
`visitor: { declared, restored, unmet }` — purely additive, so no schema bump. A run
that tested a first-time visitor and a run that tested a returning one are no longer
indistinguishable in the evidence. The declaration is an intention; `restored` is an
observation, and only one of them is evidence.

**CLOSED: nothing exercised it.** `profiles/oslo-desktop-returning.yaml` is the first
profile to declare `visitorType: returning`, so the restore branches are no longer
dead in every real run. It is a separate profile rather than a flipped flag on
`oslo-desktop` for two reasons: a returning visitor is a different test subject (a
cookie banner, "welcome back" copy and a geo-redirect all behave differently on a
second visit, and both cases need covering), and the state file is keyed by profile
id, so a shared id would have the anonymous and returning runs fighting over one
session file. Named `oslo-desktop-returning` rather than `oslo-returning` because the
matrix builds ids as `<market>-<device>` and the shorter name reads as a device called
"returning".

Adding it immediately broke `--country NO --city Oslo`, which then matched two desktop
profiles and refused — the ambiguity check working correctly and the feature becoming
useless. `PlaceSelection` gained `visitor`, defaulting to `anonymous`: a first-time
visitor is the neutral subject, and it is what a place name means when nobody says
otherwise. `--visitor returning` asks for the other.

The original diagnosis, kept because it was accurate: `resolveVisitorState` computes an `unmet`
sentence for the two cases where the declaration was not met, and **nothing
surfaces it** — **verified now**: `grep -rn "resolveVisitorState\|\.unmet" src`
excluding tests returns two hits, both inside `run/context.ts` itself. Nothing
logs it and `run.json` does not record whether a session was restored, while it
*does* record `visitorType: returning` from the profile either way. So a run that
tested a first-time visitor and a run that tested a returning one are
indistinguishable in the evidence — the same class of lie as an unmeasured metric
reported as fine. Two lines in `execute.ts` (log the warning) and one field in
`collectEvidence`'s `run.json` (`visitor: { declared, restored, unmet }`, purely
additive so no schema bump) close it.

**CLOSED: a real cookie is proven to survive.** `/returning` serves two branches that
differ ONLY by a cookie — both 200, both with a heading and links — and
`journeys/returning-visitor.yaml` asserts `#visitor` reads `returning`. The e2e runs
`oslo-desktop-returning` twice against it:

| Run | Verdict | `run.json` visitor |
|---|---|---|
| first | **FAIL** — correctly, the site has never seen this browser | `restored: false`, `unmet` naming the seeded session |
| second | **PASS** | `restored: true`, `unmet: null` |

Three details are the point rather than polish. The marker is `<p id="visitor">`, not
translated copy — a word like "tilbake" could legitimately appear on a first visit, and
`/lang` carries `<p id="locale">` for the same reason. The cookie is the only difference
between the branches, so nothing else in the journey can account for a passing second
run. And `Max-Age` is a year rather than a session cookie, because Playwright's
`storageState` persists cookies with an expiry and drops session ones — a session
cookie would have failed at the wrong layer, for the wrong reason.

**Verified by MUTATION, not only by passing.** Disabling the restore branch
(`if (false && exists(file))`) makes the second run fail and the first still pass,
which is the shape a real proof has: the test is sensitive to exactly the mechanism it
names. [C-6](#c-6--coverage-proves-execution-not-assertion) says coverage proves
execution rather than assertion, so a new test for a previously-dead path is worth
checking that way before it is believed.

Where: `browser/playwright.ts`, `run/context.ts` (`VISITOR_STATE_DIR`,
`resolveVisitorState`), `profiles/*.yaml`.

### B-8 · CLOSED — a template can start a run

**Closed 2026-08-13.** `health()` bailed on seeing `{` and returned
`unconfigured`, which `prepareRun` treats as a hard refusal for any non-direct
provider — so a template, the only way a residential vendor is ever configured,
could never start a run at all. The reasoning was wrong where it counted:
placeholders live in the USERNAME while the gateway host and port are literal,
which is exactly what a reachability probe needs. Placeholders are now replaced
with an inert token before parsing. Two tests that pinned the old behaviour were
rewritten to assert the fix.

### B-9 · Closed: the boundary lint's first catch

**Closed, and worth recording because it is the argument for
[D-1](#d-1--the-layer-map-is-enforced-by-a-tool-now-and-it-has-already-earned-it)
existing at all.** The first run of `pnpm boundaries` against the real tree failed:

```
error engine-internals-are-private: src/run/context.ts → src/browser/playwright-launch.ts
```

`run/context.ts` imported `playwrightOpener` straight out of the launcher. That
compiled and worked perfectly, and it was still a real leak:
`playwright-launch.ts` is the one file that names the `playwright` package, and
`cli/commands.ts` imports `run/context.js` as a *value*, so `pnpm geoqa profile
list` was loading Playwright's whole module tree to print a list of YAML files.
(`temporal/workflows.ts` uses `import type`, so the Temporal sandbox never paid
for it.)

The rule was **not** weakened to make the tree pass. `src/browser/engines.ts` now
owns engine construction end to end — `createPlaywrightRuntime(sessionId, options)`
wrapping `playwrightOpener` + `PlaywrightRuntime`, with
`PlaywrightContextOptions` re-exported as a type — and `run/context.ts` names an
engine rather than a launcher. A factory rather than a re-export from
`playwright.ts`, deliberately: the launcher imports types *from* `playwright.ts`,
so re-exporting there would make the two mutually dependent and trip
`no-circular-dependencies`, which counts type edges. Constructing still launches
nothing, and `context.test.ts`'s existing `instanceof` assertion covers the new
function, so no exclusion was needed.

**Verified now**: `npx depcruise src --output-type err-long` →
*no dependency violations found (93 modules, 365 dependencies cruised)*.

Where: `browser/engines.ts`, `run/context.ts`, `.dependency-cruiser.mjs`.

### B-10 · CLOSED — the e2e derives the trace filename

**Closed 2026-08-13.** The e2e hardcoded `trace.json` and drifted the moment the
two engines started writing different formats. It now calls
`traceArtifactFormat("playwright")`, so the assertion cannot disagree with the
collector again.

## C. Measurement gaps

What this engine can and cannot currently measure, and why. Several of these are
**not code-closable**: they are properties of a vendor, a browser or a contract, and
recording the limit is the whole point — an unmeasurable thing reported as measured
is the failure this project exists to prevent.

### C-1 · The stability window is a parameter, and a flag now reaches it

**Closed as a hardcoded constant.** `STABILITY_READS` and
`STABILITY_INTERVAL_MS` are gone. `resolveStabilityWindow` takes
`stabilityWindowMs` / `stabilityReads`, derives the **interval** from the window
(`windowMs / (reads - 1)`), and throws on `reads < 2` or a non-positive window
rather than reporting perfect stability having waited for nothing. Each sample
records the `windowMs` and `intervalMs` it used, so a `results.jsonl` line stays
interpretable and two runs at different windows are not mistaken for comparable
observations. `stabilityWindowNote()` renders the real window and says plainly
whether the PRD's ten minutes were covered — and the long branch still refuses to
over-claim, because a rotation that healed between two reads is invisible either
way.

The window is the knob and the interval is derived on purpose: ten minutes at the
old fixed 6s spacing would be 101 hits on the identity endpoint per sample, which
trips ipinfo's rate limit and converts a stickiness measurement into a throttling
measurement.

**CLOSED.** `--stability-window <duration>` and `--stability-reads <n>` reach the
resolver, via `experimentKnobs()` in `cli/samplers.ts`. The PRD's window is
`--stability-window 10m --samples 3`, and 24s stays the default deliberately (ten
minutes × 10 samples is 100 minutes; a feasibility check that long gets killed
halfway, and a killed run leaves `results.jsonl` half-written with no summary).

Two details are the point rather than polish. The duration accepts an `ms`/`s`/
`m`/`h` suffix and **refuses** what it cannot read: a `--stability-window 10min`
that fell back to the default would have produced a summary measuring 24 seconds,
and because `stabilityWindowNote` names the window it actually used, the reader
would have seen a coherent, confident answer to a question they never asked. And
the knobs are parsed in `samplers.ts`, not `args.ts` — the knob types belong to
the sampler that reads them, `ExperimentOptions` does not grow a field per
experiment, and `args.ts` could not import them anyway (`samplers` → `commands` →
`args` already, and dependency-cruiser refuses the cycle).

**What is still not done is the live run.** EXP-002 remains `unmeasured` because
the samplers build agent-browser regardless of `--engine`
([D-1b](#d-1b--the-engine-choice-is-uniform-except-for-the-experiment-samplers)),
so a ten-minute stickiness run through Decodo has to wait for that. The flag is
no longer what is in the way.

Where: `cli/samplers.ts` (`experimentKnobs`, `DEFAULT_STABILITY_WINDOW_MS`,
`PRD_STABILITY_WINDOW_MS`, `resolveStabilityWindow`, `stabilityWindowNote`),
`cli/args.ts` (`parseDurationMs`), `cli/index.ts`.

### C-2 · The agent-browser contract is still frozen at captured payloads

The default engine's mappers (`browser/map.ts`) are tested against payloads
captured by hand from agent-browser 0.34.0, and **nothing automated verifies that
agent-browser still answers that way.** An upgrade can change a field name and
produce a green suite plus a silently wrong run. `agent-browser` is a caret
dependency (`^0.34.0`), so a lockfile refresh can move it.

Partly mitigated for the *other* engine: `pnpm test:e2e` drives a real Chromium
through the real `executeRun`, and it earns its keep — it caught a launch-level
`proxy: { server: "per-context" }` placeholder that made Chromium treat
"per-context" as a real proxy host and killed every HTTP navigation, and CLS
reported as `null` on a page with no layout shift when no shift means zero.

**Cannot be closed the same way.** An e2e for agent-browser needs a 179MB Chrome
for Testing download, which is the cost CI exists to avoid and which would make
the default engine's coverage contingent on a network fetch. Treat
`geoqa browser verify` as a manual release gate after any bump, and pin the
dependency exactly.

### C-3 · Geolocation is real on one engine, stubbed on the other

**Closed for Playwright.** A context is created with
`permissions: ["geolocation"]` and the profile's coordinates, so a site that
localises off the real Geolocation API is exercised through the real path. Proven
end to end: the page reads `{latitude: 59.9139, longitude: 10.7522}` rather than
`"denied"`.

**Cannot be closed for agent-browser**, which remains the default engine:
headless Chrome denies the permission (measured, EXP-000), so `localeInitScript`
overwrites `navigator.geolocation` with a resolved stub. That path never sees
denial, a timeout, or a prompt. `observeBrowser` reports what the page actually
saw, so the stub is honest — it is just not the real flow, and the engine offers
no way to make it one.

### C-4 · CLOSED — a wrong city is now distinguishable from a naming artifact

`compareCity` returns `unverified`, never `mismatch`, for a non-matching city —
correct, because egress databases name the exchange's suburb (the real Norway
baseline reads "Lysaker"). The consequence is that a genuinely wrong city (a
Frankfurt exit sold as Oslo) and a correctly-routed session with an oddly-named
exchange produce **the same verdict**.

**CLOSED — and the sentence this entry rested on turned out to be false.** "A city
can be proven right, never proven wrong" was true of a STRING comparison and of
nothing else. `compareCity` now measures great-circle distance against the
profile's own coordinates, so `mismatch` is reachable: a proxy that sold Stockholm
and delivered Uppsala has failed, and calling that unproven protected the vendor
rather than the measurement.

What forced it was the 102-session milestone, where the old axis produced two
numbers that were both true and neither usable — 72.5% city match counting exact
names, 100% counting everything not proven wrong. It reported `unverified` for Skui
(15km from Oslo) and for Gällivare (1100km from Stockholm) alike. Measured by
distance the answer is **84.3%**, with **zero** `unverified`, and the failures are
named: Uppsala, Munich, Trondheim. See [milestone.md](milestone.md).

The name comparison survives as the FALLBACK for when either side has no
coordinates, and there it keeps the original asymmetry — without a distance we
still cannot prove a city wrong. The original reasoning was right about suburbs and
over-applied to everything else.

Still true and unchanged: three of the eight markets have no purchasable
city-level exit at all
([A-1](#a-1--closed--proven-against-a-live-residential-vendor)).

**Two independent databases now put a number on how weak the city signal is, and
it is weaker than this entry assumed.** Across six live Decodo residential exits,
ipinfo and geojs agreed on the country every time and disagreed on the city
repeatedly — including one Norwegian exit placed in **Stavanger** by ipinfo and
**Bærum** by geojs, roughly 400 km apart, for the same IP. On a direct connection
the same pair reads Tønsberg and Rykkin.

That has a direct consequence for the 100-session milestone: a **≥90% city-match
bar measured against one database is measuring that database**, not the proxy. Two
vendors cannot agree on the city of a single IP, so no single vendor's answer is
the ground truth the bar implies. The threshold question in
`.claude/loops/close-gaps/test-plan.md` — does `unverified` count against the 90% —
should be decided knowing this: the honest reading is that country is the
measurable axis and city is corroborating evidence, not a pass/fail gate.

City divergence between sources is therefore recorded and **never** a verdict
(`compareSources`). Only a COUNTRY disagreement is a mismatch.

### C-5 · `inp` is measured on Playwright now, and nothing asserts on it

**Closed as "structurally unmeasurable".** An `INTERACTION_OBSERVER_SCRIPT` is
armed in **every document before its own scripts** and accumulates the worst
duration per `interactionId` at `durationThreshold: 16`. `VITALS_EXPRESSION`
returns a real `inp` = max(armed map ∪ `first-input` durations), `null` when there
were no interaction entries at all, plus a buffered-`event` fallback when nothing
was armed. Interaction reads use a 150ms window rather than the 400ms emit settle,
because a click that has not happened will not happen while we look — otherwise
every read-only journey paid 400ms twice.

Arming it rather than reading `event` at vitals time is the load-bearing choice:
Chromium's default event-timing buffer retains only entries slower than ~104ms, so
a read-time observer reports a *fast* page as never interacted with and can
understate INP by up to 104ms. Armed first, the residual error is bounded at one
frame (16ms), and that bound is stated in the comment. Same doctrine as arming the
trace and the console listeners before first load.

**CLOSED: a check asserts on it.** `inp-below` is in `CheckSchema`, needs only
`vitals`, and has a `VITAL_FOR_CHECK` entry so it gets the same confirm-the-null
re-read as LCP.

**Proving it required a new fixture, and that is the finding.** `inp` was `null` on
every existing fixture *even after a real click*. Chromium reports event-timing
entries only above a threshold, so a click on a page whose handler does nothing
expensive is genuinely too fast to produce an entry — `inp: null` is a fact about the
page, not a failed read. `/slow-interaction` blocks the main thread for ~120ms, which
sits above the threshold and below Google's 200ms bar, so one page demonstrates a
measured pass and, at a tighter budget, a measured finding. Both are asserted in the
e2e against real Chromium; a fake runtime returning a number proves the comparison and
never that an interaction was timed.

**And `inp-below` is deliberately NOT in any shipped journey.** An unreadable check is
categorised `instrumentation` and `ERROR` outranks `FAIL`, so asserting INP in a
general-purpose journey turns a clean run into "we could not verify" on most simple
pages — the engine blaming itself for a page that had nothing to measure. The check's
own `unread` reason therefore names BOTH causes, because they need different actions:
move the check after an interaction, or accept that the page responds too fast to
measure. Only the first is the journey's fault.

**Residual design question, recorded not answered:** a null INP is a property of the
page, and the verdict model treats any unread check as our defect. That is right for
"we tried to read the title and could not" and wrong here. Fixing it means a way for a
check to declare that its own null is a page fact rather than an instrumentation
failure — a real change to the verdict model, and not one to make in passing.

The original diagnosis, kept because it was accurate: adding a check means a
  `VITAL_FOR_CHECK` entry (`"inp-below": "inp"`) so the confirm-the-null re-read
  covers an interaction entry delivered a frame or two late — **verified**: that
  record currently holds `lcp-below` and `cls-below` only.
- **On agent-browser, `inp` is whatever the CLI reports** (`map.ts` maps
  `root.inp` straight through) and nothing verifies it, which is
  [C-2](#c-2--the-agent-browser-contract-is-still-frozen-at-captured-payloads)
  again.

Where: `browser/playwright.ts` (`INTERACTION_OBSERVER_SCRIPT`, `INTERACTION_KEY`),
`browser/playwright-launch.ts`, `journeys/spec.ts`.

### C-6 · Coverage proves execution, not assertion

The 100% gate proves lines *ran*. It cannot prove anything was asserted about
them. CI enforces half of the repo's own rule; the other half — every fix pinned
by a test, the pin mutation-checked — is convention. The CI comment says this
plainly, and it is worth keeping in view when a change is "covered".

**Cannot be closed cheaply.** Closing it means mutation testing: a large new
dependency and a much slower CI, paid on every push to catch a class of defect
that code review currently catches. Recorded as a known limit of the gate rather
than as work.

### C-7 · One live target

Everything observed against production is `digilist.no` (`/blogg`, homepage). The
journeys' selectors (`h1`, `a[href^='/']`) and thresholds are calibrated to it.
There is no evidence about how the journeys behave on a site with a cookie wall, a
client-side router, a login, or lazy-loaded content — all of which change what "the
page settled" means.

**The decision has been made: `xala.no` is the second site** (owner, 2026-08-13).
That was the whole blocker — this needed permission and a name, not an
implementation. What remains is the measuring, and the measuring is the point:
`fixtures/server.ts` covers *known* defects on purpose and cannot substitute,
because a fixture we wrote cannot surprise us.

A third site is still wanted, and the shape that would teach the most is one this
pair may not have: a cookie wall, a login, or heavy lazy-loading — each changes what
"the page settled" means, which is the assumption every journey rests on.

### C-8 · CLOSED — a mobile identity without the viewport cost, because the choice was false

**Partly closed, and the premise had gone stale.** No profile carries `emulate` any
more — all eight mobile profiles had it reverted, with a measured comment, because
emulation introduces a layout viewport and makes `window.innerWidth` a property of the
page's markup (980 without a viewport meta tag, 390 with it), which put the engine's
most safety-critical axis outside its own control.

**CLOSED: an unknown descriptor name no longer passes silently.** `openContext` threw
away the `?? {}` fallback and now REFUSES an unrecognised name. Same reasoning as an
unknown `--engine`: a successful run of something nobody asked for is worse than no
run. This was the bullet with teeth, because the old form failed invisibly in every
direction at once — no descriptor applied, `setDevice` still answering `ok` (it
compares the requested name against the name the context was built with, the same
string), and the viewport matching anyway.

**CLOSED: a verified axis exists.** `compareDevice` compares the profile's DECLARED
`userAgent` against `navigator.userAgent`, which was observed on every run and
compared to nothing. A proven mismatch costs the run its `trustworthy` flag. It is
asymmetric on purpose: a profile declaring no `userAgent` gets `unverified`, because a
claim nobody made cannot be verified — and inventing an expectation from `device.kind`
would report a mismatch on every mobile profile in this repo, all of which
deliberately carry no descriptor.

**Still open, and it is the honest residual:** an `emulate` name cannot be confirmed
from the page. A descriptor name is not a substring of the user-agent string it
produces — "Pixel 5" does not appear in the Android UA Playwright builds from it — so
`compareDevice` reports `unverified` with that reason rather than guessing at a marker.
An explicit `userAgent` in the profile is the stronger declaration and is the one that
can be verified.

**CLOSED, and the choice this entry posed turned out to be false.** It framed the
options as emulation (losing viewport control) or a hand-maintained `userAgent`
(paying maintenance). Playwright treats `isMobile`, `hasTouch`, `deviceScaleFactor`
and `userAgent` as **independent** context options, and only `isMobile` introduces the
layout viewport. Measured against a page with no viewport meta tag:

| context | `innerWidth` | `maxTouchPoints` | mobile UA |
|---|---|---|---|
| viewport only (the old state) | 390 | 0 | no |
| **viewport + `userAgent` + `hasTouch`** | **390** | **1** | **yes** |
| full `Pixel 5` descriptor | **980** | 1 | yes |

All eight mobile profiles now declare `userAgent`, `hasTouch: true` and
`deviceScaleFactor: 3`, and `openContext` passes each through without ever setting
`isMobile`. Verified from inside a page: `navigator.maxTouchPoints` is 1,
`"ontouchstart" in window` is true, and `matchMedia("(pointer: coarse)")` matches —
the three ways a site actually detects touch — while `window.innerWidth` is 390.

The device axis is `match` now rather than `unverified`, because the profile finally
makes a claim there is something to check.

**Why the user agent is written out, when Playwright's own descriptors are
version-synced with the shipped browser and would never go stale.** A profile is a
DECLARATION of a test subject. One that changed under you with a dependency upgrade
would make yesterday's run and today's run different subjects wearing the same name —
the same reasoning that puts the seed on the `RunSpec`. A real Android device in the
wild lags the newest Chrome anyway, so a pinned version is arguably the more
representative choice as well as the more reproducible one.

**One half crosses to the default engine and the other does not, stated rather than
discovered.** `toSessionConfig` passes `userAgent` through as agent-browser's
`--user-agent`, so the mobile UA reaches BOTH engines — which is the half that matters
for the defect this entry describes, since server-side device detection reads the UA.
`hasTouch` and `deviceScaleFactor` are Playwright context options with no agent-browser
equivalent short of `set device`, which brings back the layout viewport this whole
entry exists to avoid. So on the default engine a mobile profile is: mobile UA, mobile
viewport, **no touch**.

That asymmetry is worth a sentence rather than a fix. Touch is detected client-side,
and a page that branches on `(pointer: coarse)` renders differently on the two engines
— which is a real limitation of running two engines at all, already recorded as
[C-3](#c-3--geolocation-is-real-on-one-engine-stubbed-on-the-other) for geolocation.
The engine that serves every experiment is Playwright, and it has the complete
identity.

**Still true and unchanged:** an `emulate` name cannot be confirmed from the page, so a
profile using one still gets `unverified` on the device axis. No profile uses one, and
the refusal on an unknown name stays — but that path is now the exotic one rather than
the only one.

The original diagnosis of the three failure modes, kept because it was accurate:

- **On Playwright, an unknown name is silently ignored.** `openContext` does
  `devices[name] ?? {}`, and `setDevice` answers by comparing the requested name
  against the name the context was *built with* — the same string — so it returns
  `ok`. A typo produces a run with no emulation, no warning, and a perfectly
  matching viewport.
- **On agent-browser — the default engine — the name goes to a different tool's
  device table**, and nothing checks that the two tables agree on any name. A
  rejection is a *warning*, not a failure, so the run continues with the viewport
  alone.
- **No verified axis can catch either case.** `verifyGeo` compares country, city,
  language, timezone and viewport **width**, and the profile's viewport is applied
  after the descriptor and overrides it, so the width matches whether or not the
  descriptor took. `navigator.userAgent` is observed and written to the evidence
  but never compared to anything.

Consequence: a site doing server-side device detection off the UA, or feature
detection off touch, may be served its desktop variant under a mobile profile, and
every check would still pass — the failure mode of the very first live run (a
mobile profile rendered at 1280px), one layer in.

Cheapest closure is still an e2e assertion that a mobile profile's page reads a
mobile UA and `maxTouchPoints > 0`. **Verified now**:
`e2e/playwright-run.e2e.ts` drives `oslo-mobile` through a real Chromium and
asserts locale, timezone, viewport width, geolocation, vitals, egress and the
evidence package — and nothing at all about the user agent or touch.

---

### C-9 · CLOSED — an action step no longer spends a navigation budget on a missing element

Found by J03's first live run, and it cost 30 seconds and the run's verdict.

`search.yaml` asserts `selector-visible` on the search box and then `fill`s it.
On `digilist.no` the box is not visible, so:

```
✗ has a search box                    [high]  FAIL   — correct
! type the query — timeout            [high]  ERROR  — 30s, then instrumentation
```

Both lines are individually honest. Together they are worse than the first alone:
`ERROR` outranks `FAIL` ([R-19](prd.md)), so a clean, actionable site finding —
*the search box is not visible* — was reported as **"we could not verify"**, which
sends a reader to look for a broken proxy. And the 30-second default `fill` timeout
was spent on an element the run had already established was not there.

There is no step dependency in the journey DSL, deliberately — steps are data and
a conditional step is a program. So the fix was never "skip the fill". Of the two
honest options — a shorter timeout for input actions, or letting a `critical`
visibility check be fatal for later steps naming the same selector — the **first**
is the one taken, and the second is deliberately refused.

**What it does now.** `DEFAULT_ACTION_TIMEOUT_MS = 8_000` in
`browser/playwright-launch.ts`, applied to `click`, `fill`, `selectOption` and
`check`. Navigations keep the long budget: a cold page on a residential proxy in
Bodø legitimately takes ten seconds to load, and shortening *that* would invent
timeouts on healthy sites. An **action** is different — the element it names either
resolved during the load or it is not coming, and waiting 30 seconds to be told so
converts a clean site finding into 30 seconds of nothing.

**Why not selector-based fatality.** It reads well and it is wrong. A journey may
legitimately assert a selector absent and then act on a *different* element that
happens to share the string, and more importantly it makes one step's verdict
silently change another step's execution — which is a conditional step wearing a
disguise, and the DSL refuses those on purpose.

The verdict conflation this produced ([R-19](prd.md): `ERROR` outranks `FAIL`) is
unchanged and correct. What changed is its cost: the same journey against the same
broken site now reports the FAIL in 8 seconds rather than 30, and the shorter wait
is visible in the step detail rather than inferred.

Where: `browser/playwright-launch.ts` (`DEFAULT_ACTION_TIMEOUT_MS`).

### C-10 · digilist.no: the search box is reachable at no profile width (live finding)

Not a geoqa gap — a **finding about tenant zero**, recorded here because it is the
first defect J03 produced and it should not be lost.

`digilist.no` renders its inline search input inside
`class="hidden md:flex lg:hidden"`, which is visible **only** between 768px and
1023px. Confirmed by running J03 at both profile widths:

| Profile | Width | Search box |
|---|---|---|
| `oslo-desktop` | 1440px | not visible (`lg:hidden`) |
| `oslo-mobile` | 390px | not visible (base `hidden`) |

So on a phone and on a desktop — every width geoqa models, and the overwhelming
majority of real traffic — the search field is not reachable. A `<kbd>` hint sits
next to it, which suggests a keyboard-shortcut palette is the intended desktop
affordance; a keyboard shortcut is not a substitute for a visible control on a
touch device.

Worth stating plainly because of how it was found: **the markup contains a search
input, so any check that looked for presence rather than VISIBILITY would have
passed this site.** `selector-visible` is why it did not.

### C-11 · CLOSED — an ambiguous action is RECORDED, not refused

Found by J06 reporting **PASS on a deliberately broken override**, which is the
worst possible way to find anything.

A CSS comma is a **union resolved in DOM order**, not a preference list. For an
assertion that is exactly right: `selector-visible` on
`"nav, header nav, [role='navigation']"` asks "does this site have navigation", and
any match answers it. For a **click** it is wrong, because the browser clicks
whichever element appears first in the document — not the one the author listed
first, and not the one they meant.

Measured. J06's onward step was `click "#deeper, a[href^='/']"`. On the fixture the
nav precedes the content, so the click landed on the nav's **Home** link, the
journey never reached the page whose language it was checking, and both language
assertions passed against the wrong page. The broken-override run reported PASS.

All three click journeys had the same latent bug and two of them only worked by
accident of document order:

| Journey | Was | Now |
|---|---|---|
| `language-override` | `#deeper, a[href^='/']` | `main a[href^='/'], article a[href^='/'], #deeper` |
| `search` | `#results a, .result, [data-result], li a` | `#results a, .result, [data-result]` |
| `reader` | `a[href^='/']` | `main a[href^='/'], article a[href^='/']` |

`reader`'s is the one to note: a bare `a[href^='/']` clicks the **logo** on almost
every real site, so "follow a contextual link" would have gone home.

**Closed by recording it, and the choice of *record* over *refuse* is the whole
decision.** Playwright's strict mode is the obvious fix and it is the wrong one
here: `#results a, .result` matching three search results and acting on the first
is *exactly what that journey means*, and a strict-mode engine would error on a
correct journey. The failure this gap describes is not that a selector matched
several elements — it is that the report could not tell "the first of three search
results" from "the nav link that happened to come first", because it printed the
same line for both.

So `runJourney` now asks `visibleCount(selector)` before every step that targets an
element (`click`, `fill`, `select`, `check` — `press` sends a key to the page and
`scroll` moves the viewport, so neither chooses from a set), and when the answer is
greater than one it appends to that step's detail:

```
matched 3 visible elements and acted on the first — a CSS comma resolves in
document order, not as a preference list
```

Three properties of that note are deliberate. It counts **visible** elements, not
all matches, because a click cannot land on a hidden one and counting them would
make an unambiguous click look ambiguous. It says nothing at all when the count is
1, because a note on every row buries the rows that matter. And when the engine
**cannot** count it says nothing rather than guessing — `agent-browser` has no
visible-only count and refuses the call by name, which is the same honesty rule the
rest of the system runs on.

The journey selectors fixed in the table above stay fixed; this makes the next one
visible instead of silent.

Where: `journeys/engine.ts` (`ambiguityNote`, `TARGETED_ACTIONS`),
`browser/playwright.ts` and `browser/agent-browser.ts` (`visibleCount`).

Where: `journeys/*.yaml` (click steps), `browser/playwright.ts` (locator
resolution), `journeys/spec.ts` (where a per-action selector rule would live).

### C-12 · J06 does not complete on digilist.no, and the reason is not established

Recorded UNRESOLVED on purpose. J06 runs green against the fixtures in both
directions, and against `digilist.no` it does not finish:

```
passed   land on the geo-chosen language     https://digilist.no/
passed   choose the other language           https://digilist.no/en
errored  navigate onward                     click failed: timeout — 30000ms
```

The switch works. The onward click — `main a[href^='/'], article a[href^='/'],
#deeper` — finds no visible, actionable match within 30 seconds on `/en`.

**What this is NOT:** a claim about digilist.no. An earlier pass at this recorded a
localization defect on the strength of `curl` output, and that reading was WRONG.
`curl` sees the server shell, and the site is client-rendered: the shell for
`/en/leie` carries `lang="nb-NO"` and a Norwegian `<title>`, while the page a real
browser renders carries `lang="en"` and does contain the English chrome. A finding
derived from the pre-hydration HTML of an SPA is a finding about the framework, not
the site. Deleted rather than filed, and named here because the mistake is the
instructive part: **this engine reads through a browser for exactly this reason**,
and the moment an investigation stepped outside the browser it produced a confident
wrong answer within minutes.

**What it probably is:** the click selector, again — C-11's other half. A union
narrowed to visible matches still resolves in document order, and on a hydrating
SPA the first visible `main a[href^='/']` may be off-screen, covered, or replaced
between resolution and click. Establishing that needs a headed run against the live
site, which is a task, not a guess.

Two engine improvements came out of the attempt and are already landed:

- Every ACTION targets the first **visible** match rather than the first DOM match
  (`browser/playwright-launch.ts`). A union like `[hreflang='en']` otherwise
  resolves to the `<link>` in `<head>` — invisible, unclickable, 30 seconds, and an
  instrumentation failure.
- A navigating step **records the URL it landed on** (`journeys/engine.ts`). The
  first live failure could not be attributed at all, because a click recorded
  nothing; the table above is only readable because of that change.

Where: `journeys/language-override.yaml`, `browser/playwright-launch.ts`,
[C-11](#c-11--closed--an-ambiguous-action-is-recorded-not-refused). The ambiguity
note landed there now records exactly this shape when it happens.

### B-12 · FIXED — every run in a market shared one egress IP, because a hyphen truncated the sticky key

**The most consequential defect found so far.** It was not about concurrency at all.

A residential vendor's username is a `-`-delimited parameter list:
`user-<account>-country-no-city-oslo-session-<id>`. So the vendor parses a value up to the
next hyphen, and **a hyphenated session id is silently truncated at its first one.**
geoqa's id was `<market>-<epochMs>`, so the effective sticky key was just `<market>`.

Measured, and unambiguous:

```
session-oslo-1  → 188.92.250.221
session-oslo-2  → 188.92.250.221     identical
session-oslo-3  → 188.92.250.221
session-oslo    → 188.92.250.221     ← the truncated value
session-oslo1   → 84.210.158.133
session-oslo2   → 84.209.67.194      distinct
session-oslo3   → 212.89.117.129
```

**Consequence: every run in a market had always used the same exit IP.** Not just
concurrent runs — sequential ones too, across separate browser launches and separate
processes. The engine claimed a per-session network identity it had never had.

And nothing contradicted it. `egressHeld` compares a run's opening and closing IP, and they
genuinely did match — it was the same address every time. A guard that asks "did this run
hold its IP" cannot see "this run holds the IP every other run also holds".

Fixed: the id is now base-36 and alphanumeric (`oslors1`-shaped), and
`substituteProxyPlaceholders` strips hyphens as well, so an injected `newSessionId`, a
market id containing a hyphen, or a caller passing its own id cannot reintroduce it. Verified
— three concurrent Oslo sessions now return three distinct Oslo IPs.

**How three wrong hypotheses were eliminated first**, because the path matters more than the
answer:

1. *Session-id collision in the same millisecond.* Real, and fixed — but the IPs still
   shared afterwards, so it was a separate latent bug.
2. *The vendor collapses same-city keys.* No: four concurrent distinct keys in one city
   returned four distinct IPs.
3. *`sessionduration` changes the key's scope.* No: distinct keys work with and without it.

The step that broke it open was noticing that **every market has exactly two profiles**, so
"same market shares an exit" and "adjacent launches share an exit" were indistinguishable in
the data. Testing four concurrent runs across four DIFFERENT markets (four distinct IPs) and
three across ONE market (one IP) separated them — and then three SEQUENTIAL same-market runs
also sharing removed concurrency from the picture entirely.

**What this invalidates.** Any earlier claim in this repo about per-session rotation *within*
a market, including the "5 sessions → 5 IPs" note, unless that measurement used a hyphen-free
key. Rotation *between* markets was never affected. The 100-session milestone had not been
run, which is now clearly the right call rather than a cautious one.

Where: `network/provider.ts` (`defaultSessionId`, `substituteProxyPlaceholders`).

### A-9 · CLOSED — content-level SEO signals, from an artifact designed not to hold prose

The gap named its own closing conditions and they are now built. `content.json` is written on
every run: word count, 5-word shingles, headings, `h1` count and same-origin link targets.
`geoqa content analyse` reads them back and reports thin pages, orphans, near-duplicates and
heading problems.

**The artifact stores measurements, not prose, and that is the load-bearing decision.** A page
can contain personal data — a name in a testimonial, an address in a footer, a review — and an
evidence tree accumulating the rendered text of every page on a customer's site would be a
data-protection liability created for a word count. `evidence/redact.ts` exists because this
project already takes that seriously. A hash-like set of shingles answers "are these two pages
the same" without any of it being readable.

Three smaller decisions, each with a reason:

- **`innerText`, not `textContent`.** `textContent` includes `<script>` bodies and hidden
  elements, so a page with a large inlined JSON-LD blob measures as substantial content while a
  reader sees an empty page. "Thin" is a claim about what a person reads.
- **The duplicate threshold is deliberately HIGH** (0.6 Jaccard). Measured against the digilist
  finding that prompted it: 23 near-duplicate slug pairs whose content was only 6–14% similar.
  A threshold low enough to catch those would flag every page sharing a nav and a footer.
- **Orphans are scoped to the sweep and say so.** A page linked only from a page that was not
  crawled will appear in the list, and a report that blurred "orphaned here" with "orphaned on
  the site" would send somebody hunting for links that exist.

Verified over 24 real digilist pages: word counts 162–1652, 61–70 internal links each, **every
page exactly one `h1`**, one thin page (`/book-demo` at 162 words — a booking form, which is why
the report calls it a list to look at rather than a verdict), and **zero near-duplicates**. That
last result independently confirms the earlier manual finding: those slug pairs were
cannibalisation candidates by URL and not by content.

A failed content read costs the ARTIFACT, never the run. A run that verified geography and
executed its journey has not failed because a word count could not be taken.

**Still not built:** soft-404 detection as its own check. It remains largely expressible with
`text-absent` on "not found" wording, which is how `/en/blog` was caught.

### A-10 · CLOSED — the same page, compared across markets

`geoqa site analyse` reads the run history and answers the question a crawler running from
one datacentre cannot: **does this page behave differently depending on where the visitor
is?** Verified live over a real 2-page × 3-market matrix through Decodo:

```
2 page(s) across 3 market(s): berlin, bodo, oslo
  widest latency gaps between markets — a crawler from one datacentre sees none of this:
    https://digilist.no/faq:    TTFB 467ms in berlin vs 596ms in bodo — 1.3x
    https://digilist.no/priser: TTFB 541ms in oslo   vs 662ms in bodo — 1.2x
```

Three outputs, and each has a specific reason for existing:

- **Verdict divergence** — one URL, one set of HTML, different outcomes by market. This is
  the finding the whole engine exists to produce, and `site analyse` exits 1 when there is
  one so a scheduled check does not have to read the output.
- **Latency spread**, with the factor between fastest and slowest market. The sentence a
  "our local numbers look fine" argument dies on.
- **Coverage gaps** — a page measured in some markets and not others. A page nobody
  measured in Bodø is not a page that works in Bodø, and omitting it would read as full
  coverage.

`ERROR` runs are excluded from every comparison and counted in a warning instead. Including
them would make our own instrumentation failure look like a market where the site behaves
differently, which is the exact false geographic finding this project exists to avoid.

Two smaller honesty properties: a spread is `null` rather than `0` with fewer than two
readings, because "one market measured" and "every market identical" are different facts;
and a market's reading is the MEDIAN across its repeats rather than the latest, because a
single slow run is noise and "latest" means whichever finished last.


### C-13 · CLOSED — an empty text read is confirmed, then refused rather than blamed on the page

**Found by pointing the engine at a second real site**, which is exactly what
[C-7](#c-7--one-live-target) said a second site was for.

`getText` is `locator.innerText()`. Playwright auto-waits for the element to be
ATTACHED, and on a client-rendered site the `<html>` and `<body>` of the shell are
attached immediately — so the read returns `""` instantly, before hydration. Every
text check then compares against an empty string and files a **site** finding.

Measured on `xala.no`, a Next-style SPA:

| Moment | `body.innerText` | `body.innerHTML` | `h1` visible |
|---|---|---|---|
| `load` | **0 chars** | 1,404 | no |
| +1s | 6,077 | 80,534 | yes |
| +3s | 6,325 | 83,555 | yes |

The `localization` journey duly reported
`[high] page carries the market's language marker — observed 0 chars read`
against a site whose `<html lang>` is `nb-NO`, i.e. correct.

**This is a lesson the engine already learned once and never generalised.** `d7a4700`
and `9f10d48` made a negative VISIBILITY reading confirm itself before being reported,
because an element mid-entrance-animation reads as absent. A text read has exactly the
same failure mode and none of the protection — and it is worse, because
`selector-visible` at least has a 5-second budget, which is why the `landing-page`
journey passes on the same site in the same second that the text check reads zero.

**CLOSED in two places, because one was not enough.** `PlaywrightRuntime.getText`
re-reads once after a settle when the first read is EMPTY — the same shape as
`isVisible`, sharing the same `absenceSettleMs`. Only an empty read is retried: a
non-empty read that simply lacks the value is a real reading of a real page, and
re-reading it would be the silent retry this engine refuses everywhere else, turning
an intermittent site defect into a green run.

A settle is not a guarantee, so `assertions.ts` does not treat it as one. Text that is
still `""` afterwards is reported **unreadable**, never failed: "the page rendered
nothing" and "we looked too early" are indistinguishable from inside a check, and when
this engine cannot distinguish it does not blame the page. That lands as
`errored`/instrumentation and still blocks the publish gate — a different sentence,
the same outcome. It also closes the same hole on `text-absent`, where an empty page
trivially lacks every string and the check went green.

Proven three ways: unit tests on both halves, a `/hydrates-late` fixture reproducing
the shape at 300ms, and the live site — the same journey against the same xala.no page
now reads 6,000 characters and passes.

**Both engines confirm, not just Playwright.** agent-browser is the DEFAULT, so leaving
the retry to the other adapter would have given the default the weaker protection. The
`assertions.ts` refusal covers both regardless — what the retry adds is the difference
between a genuine PASS and an honest refusal, and a run that could have read the page
should read it.

Worth noting where this site had appeared before: `agent-browser.ts`'s `isVisible`
comment already names xala.no, whose `h1` has an entrance fade and read `opacity: 0`
for the first second — 4 failures of 4 runs, deterministic rather than flaky. The same
site produced this defect through a second primitive, a month apart. A page that is
slower than the engine breaks every read the engine does not settle, one at a time.

Where: `browser/playwright.ts` and `browser/agent-browser.ts` (`getText`),
`journeys/assertions.ts` (`NOTHING_RENDERED`), `fixtures/server.ts`
(`/hydrates-late`, `/empty-body`).

### C-14 · CLOSED — an unfilled `{placeholder}` is our defect, not a verdict

Found in the same run, and it is the more dangerous of the two.

[R-11](prd.md) leaves an unknown placeholder intact rather than replacing it with an
empty string, and that reasoning is sound where it was made: `open ""` would navigate
somewhere meaningless and report a page failure for a config typo. Carried into an
**assert**, the same rule produces two different lies:

- `text-contains` with `value: "{expectLanguageMarker}"` → asks whether the page
  contains the literal string `{expectLanguageMarker}`. It does not, so a **high**
  severity site finding is filed for a variable the operator forgot to pass.
- `text-absent` with `value: "{forbiddenCurrency}"` → asks whether the page LACKS the
  literal string `{forbiddenCurrency}`. Every page on earth does. **The check passes,
  green, having verified nothing.**

The second is the one that matters. A false FAIL wastes an afternoon; a false PASS is
the exact conflation of "we could not measure" with "it is fine" that this engine
exists to refuse, and it is invisible — the run reports PASS and nobody looks.

**CLOSED.** `evaluateCheck` refuses any check whose value still carries a `{word}`
after resolution, and names the missing variable in the message: *"the journey variable
{forbiddenCurrency} was never supplied … pass --var forbiddenCurrency=<value>"*. It
matches `resolveSteps`'s own pattern, so a value that merely contains braces — a JSON
blob, a template literal in real copy — is not caught by accident.

Proven live: the same journey against xala.no went from one false FAIL plus one silent
green PASS to two named refusals telling the operator exactly what to pass.

Where: `journeys/assertions.ts` (`UNFILLED_PLACEHOLDER`).

### C-15 · CLOSED — the language marker is read from the attribute where it lives

`localization.yaml` asserts
`text-contains selector: html value: "{expectLanguageMarker}"`, and its own
description calls it "the reason this project exists".

`getText` is `innerText`. A language marker lives in `<html lang="nb-NO">` — an
**attribute**, which `innerText` never returns. So even against a fully hydrated,
correctly-localised page the check cannot detect the thing it is named for.

Confirmed rather than reasoned: `digilist.no` renders 11,542 characters of
`innerText` and carries `lang="en"`; the string `en` as a *marker* is not findable in
that text in any meaningful way, and `nb-NO` would not be either.

**CLOSED, and the two options turned out not to be alternatives.** `attribute-contains`
and `attribute-absent` read a markup attribute; the journey now asserts **both** the
document's declaration and a marker in the visible copy, because they are different
claims and a journey checking one passes a site that got the other wrong:

| Fixture | `<html lang>` | Prose | Old journey | New journey |
|---|---|---|---|---|
| `/wrong-lang-attr` | `en` | Norwegian | passed | **fails** on the declaration |
| `/wrong-copy` | `nb-NO` | English | passed | **fails** on the copy and the currency |

Declaring a language is not writing it, and a half-finished translation ships
`lang="nb-NO"` over an untranslated page. Both are e2e-proven, with a control that
passes on a page getting both right — without one, a journey that failed everything
would look like it worked.

Read through `evaluate` rather than a new `BrowserRuntime` method. Both engines already
implement it, so this needs neither a seam primitive nor a refusal on the engine that
lacks one, and an attribute read has none of the timing subtlety that earned `getText`
and `isVisible` their own methods. Selector and attribute both cross as
`JSON.stringify`, so a selector carrying a quote cannot break out of the expression —
asserted against `JSON.stringify` itself rather than a hand-escaped literal, because
hand-written escaping in a test gets it wrong in the same direction as hand-written
escaping in the code.

`""` is an ABSENT attribute and `null` is "we could not look". Only the second refuses:
an absent attribute is a real reading of the page, and `attribute-absent` is entitled
to pass on it.

Where: `journeys/spec.ts` (`CheckSchema`), `journeys/assertions.ts`,
`journeys/engine.ts` (`readAttribute`), `journeys/localization.yaml`,
`fixtures/server.ts` (`/wrong-lang-attr`, `/wrong-copy`).

### C-16 · xala.no, the second live target: what the journeys found

Not geoqa gaps — **findings about the second site**, recorded so they are not lost,
and because C-7 is only worth closing if the measuring actually happens.

- **`landing-page`: PASS**, every axis verified, evidence complete.
- **`reader`: PASS**, journey confidence 74 — four steps never ran.
- **`search`: correctly FAILS, and there is no search box to find.** Verified directly
  at 1440px and 390px: `input[type='search']`, `input[name='q']`, `input[name='s']`,
  `[role='searchbox']` and every `input` on the page — **zero matches at either
  width**, hidden or otherwise. Unlike [C-10](#c-10--digilistno-the-search-box-is-reachable-at-no-profile-width-live-finding)
  on digilist, where the input exists and is hidden by a breakpoint, xala.no simply
  has no search. The follow-on `fill` then errors, which is [C-9](#c-9--closed--an-action-step-no-longer-spends-a-navigation-budget-on-a-missing-element)'s
  known and deliberate remaining behaviour — now at 8 seconds rather than 30.
- **`localization`: FAILS for two reasons that are both OURS**, C-13 and C-15. The
  site's `<html lang>` is `nb-NO` and correct.
- **The `h1` ROTATES between reads.** At +3s: "Vi bygger saksbehandlingssystemer";
  at +8s: "Vi bygger bevillingsportaler". Any text assertion against this page's
  headline is a coin flip, and no shipped journey does that — but a `text-contains`
  on an `h1` is an obvious thing for the next journey author to write.

**A methodological note worth keeping.** The first probe of this investigation read
`innerText` at `load` with no settle, got 0 characters, and produced the confident
hypothesis that `locator("html").innerText()` was broken. Running the same probe
against `digilist.no` returned 11,542 characters and killed it in one line. That is
[C-12](#c-12--j06-does-not-complete-on-digilistno-and-the-reason-is-not-established)'s
lesson arriving again from a new direction: **a measurement taken at the wrong moment
is not a weaker version of the right answer, it is a different and confident wrong
one.** The rule that saved it was comparing against a second subject before believing
the first.

### C-17 · CLOSED — an errored step was filed under the category the journey declared

Found by writing the e2e assertion for C-13, which stated the intended rule and failed.

`categoryFor` read the step's DECLARED category before the errored check:

```ts
if (step.category) return step.category;      // ← ran first
if (step.outcome === "errored") return "instrumentation";
```

`classify.ts` opens by stating the opposite: *a step we could not read never becomes a
site finding.* `localization.yaml` declares `category: localization` on both of its
text checks, so a run where the engine looked before the page rendered produced a pile
of **localization defects** titled "Could not verify: …". Somebody investigates the
site; our defect stays invisible — the exact failure the split exists to prevent, in
the journey this project is named for.

The inconsistency that gave it away is one function below: `severityFor` has always
overridden the step's declared severity for an errored step, with a comment saying why.
Category now does the same.

[R-13](prd.md) is unchanged and this honours it as written — a step may override the
category **derived from its check kind**. `instrumentation` is derived from the
OUTCOME, and no journey author can know in advance that a step will be unreadable.

Where: `findings/classify.ts` (`categoryFor`).

### C-18 · WITHDRAWN CLAIM — digilist.no does NOT serve the wrong language marker

Recorded because the claim reached four files before it was checked, and because it is
the third time this exact mistake has been made.

While building [C-15](#c-15--closed--the-language-marker-is-read-from-the-attribute-where-it-lives)
I asserted, in `gaps.md`, a journey comment, a schema comment and two test comments,
that **digilist.no serves `<html lang="en">` over Norwegian prose** — a concrete,
named, checkable claim about somebody's live site.

It is false. The probe that produced it created a Playwright context with **no
`locale`**, so the browser asked in `en-US`. digilist serves `lang` by
`Accept-Language`, and English is the correct answer to an English request:

| Context locale | `<html lang>` |
|---|---|
| default (`en-US`) | `en` |
| `nb-NO` | `nb-NO` |

Run under the `oslo-desktop` profile — which sets the locale the market implies — the
journey passes, correctly. The site is not defective; the measurement was.

**The pattern, three times now.** [C-12](#c-12--j06-does-not-complete-on-digilistno-and-the-reason-is-not-established)
was a localization defect filed against digilist from `curl` output, withdrawn once a
real browser was used. Then an `innerText` hypothesis from a read taken before
hydration, killed by comparing against a second site. Now a language claim from a
browser that never said what language it wanted. Every one of them is the same error:
**a measurement taken under conditions that do not match the claim is not a weaker
version of the right answer, it is a confident wrong one.**

The engine already knows this — it is why profiles carry a locale, why absence is
confirmed before it is reported, and why the whole project exists rather than trusting
a datacentre crawler. The instrument built to avoid this mistake does not protect an
investigator who steps outside it.

**What survives.** The C-15 defect was real and independently verified: `innerText`
never returns attributes, so the old check could not detect a language marker on any
site. The fixtures that prove it are constructed, not copied from a real site, and say
so.

## D. Tooling and process gaps

### D-1 · The layer map is enforced by a tool now, and it has already earned it

**Closed.** `.dependency-cruiser.mjs` declares six `error`-severity rules, each
with a `comment` naming the failure it prevents and the invariant it comes from:

| rule | forbids |
|---|---|
| `engine-internals-are-private` | anything in `src/` outside `src/browser/` → `browser/(exec\|args\|playwright-launch).ts` |
| `engine-packages-stay-in-browser` | anything outside `src/browser/` → `playwright`, `playwright-core`, `@playwright/*`, `agent-browser` |
| `stages-must-not-know-temporal` | `src/(run\|journeys\|geo)/` → `src/temporal/` |
| `never-import-the-worker` | any file → `src/temporal/worker.ts`, tests included |
| `browser-is-the-bottom-layer` | `src/browser/` → `src/(geo\|run\|journeys\|evidence)/` |
| `no-circular-dependencies` | any cycle, type-only ones included |

`pnpm boundaries` runs it with `--output-type err-long`, so the CI log prints each
rule's rationale next to the violation rather than just naming a rule, and CI runs
it as **its own step before the tests**: a layering violation is different news
from a failing assertion, and it fails in seconds instead of after the Temporal
suite has downloaded a server.

Four things a future reader should know before trusting it:

- **It found a real violation on its first run against the real tree**, and the
  rule was not weakened to make the tree pass. See
  [B-9](#b-9--closed-the-boundary-lints-first-catch). It is green now.
- **Every run prints `missing-typescript-transpiler`.** dependency-cruiser 18
  supports `typescript@>=2 <7` and this repo is on 7.0.2, so it warns that it
  "likely missed sources". Verified not to affect the exit code, and verified not
  to be true here: all 93 modules under `src/` appear in the graph, zero
  dependencies are unresolvable, and a probe tree confirmed a forbidden edge is
  still reported as `import`, `import type`, `import { type X }`, an inline
  `import("…").T` and a dynamic `await import()`. Redo that check if the parser
  fallback changes; there is no way to silence the warning without downgrading
  TypeScript.
- **Scope is `src` only, deliberately.** `e2e/playwright-run.e2e.ts` dynamically
  imports `browser/playwright-launch.js`, and the e2e suite is the only thing
  covering that file — cruising `e2e/` would report that intent as a defect.
- **`engine-packages-stay-in-browser` is currently vacuous for one of its
  targets**: nothing in `src/` imports the `agent-browser` package at all, because
  the adapter spawns its CLI binary. That rule guards the future rather than the
  present.

One narrowing, on purpose: the invariant says only `agent-browser.ts` may import
`exec.ts`; the shipped rule allows any file inside `src/browser/`, because
`playwright.ts` imports `type { ExecFailureKind }` from it and the failure kinds
are deliberately shared across engines.

Where: `.dependency-cruiser.mjs`, `package.json` (`boundaries`),
`.github/workflows/ci.yml`.

### D-1e · CLOSED, and it was stale when it was written

`proxy verify` has honoured `--engine` since `RuntimeRequest` landed:
`cli/commands.ts` passes `{ engine, profile }` to `makeRuntime`. **This entry
contradicted [D-1b](#d-1b--the-engine-choice-is-uniform-except-for-the-experiment-samplers)
in the same document**, which already said "closed for `browser verify` and
`proxy verify`".

Confirmed by running it, not by reading it — `proxy verify --geo bergen-desktop
--provider http-proxy --engine playwright` returns a full two-axis verification at
confidence 100 through a live Decodo exit, and did so repeatedly during the
corroboration work.

Left in place rather than deleted, because the failure it records is a real one and
it is about this file: two entries describing the same code disagreed, and the
pessimistic one was believed. A gap register nobody trusts is worse than none, which
is why slice 1 existed — and this survived it.

### D-1b · The engine choice is uniform, except for the experiment samplers

**Closed for `browser verify` and `proxy verify`.** `CommandDeps.makeRuntime` now
takes a second, optional parameter — `RuntimeRequest = { engine, profile }` —
rather than a widened first one, so every existing fake keeps compiling and keeps
meaning agent-browser, and the agent-browser branch provably never reads the
request. `defaultDeps` builds Playwright through
`buildRuntime(verificationSpec(config, request, <root>/verify-sessions), profile)`,
because `cli/` may not import `playwright-launch.ts`
([D-1](#d-1--the-layer-map-is-enforced-by-a-tool-now-and-it-has-already-earned-it))
and a second copy of the profile→context mapping is how a session starts claiming
Oslo and rendering Frankfurt. `browser verify` gained `--geo` and loads the
profile on **both** engines so a typo is refused either way, while the
agent-browser session config stays byte-identical to before — pinned by a test,
because changing the launch identity of the command that proves the primitives
would change what EXP-000 measured. `--engine playwrite` is now refused (exit 2)
instead of silently running agent-browser.

**CLOSED for the samplers too.** `ExperimentOptions` gained `engine` and
`verifyEndpoint`, and every runtime an experiment builds now goes through one
`runtimeFor(deps, options, profile, config)` helper rather than five call sites with
their own defaults — a per-site default is how EXP-003's two isolated sessions end
up on different engines while the sample reports one number. The three samplers that
delegate to `journeyRun` forward both fields, so `--engine` means the same thing
whether an experiment runs the journey or a human does. Absent still means
`DEFAULT_ENGINE`, so an experiment re-run without the flag measures what its stored
results measured.

EXP-000 is the one where this is not merely uniformity: its subject IS the adapter,
so taking its samples through an engine nobody asked about answered a different
question than the one printed at the top of the summary.

**Proven by running it.** EXP-002 had never produced a measurement through the
residential proxy, because the samplers were agent-browser-only and there is no
Chrome for that engine here — so the experiment could not execute at all. Through
Playwright and a live Decodo Bergen exit it now reports `ip-stability 100%` over a
30-second window across 3 reads, and the summary note still says plainly that the
PRD's ten minutes were not covered.

The original diagnosis, kept because it was accurate: the change was one field plus
five call sites — and it was the
same `ExperimentOptions` edit that
[C-1](#c-1--the-stability-window-is-a-parameter-and-a-flag-now-reaches-it) and
[A-3b](#a-3b--exp-007-exists-now-and-has-never-been-run) are waiting on. An option
nothing reads is the defect [B-1](#b-1--closed--every-key-in-the-example-is-honoured-at-the-call-site)
closed, so add the field and the call sites together or neither.

Consequence today: none. The engine choice is uniform across `browser verify`,
`proxy verify`, `journey run`, `matrix run` and all eight experiment samplers.

### D-1c · Closed: a trace carries its own format

`traceArtifactFormat(engine)` returns `trace.zip`/`application/zip` for Playwright
and `trace.json`/`application/json` for agent-browser, and `collectEvidence` uses
it for both the `traceStop` path and the artifact, overriding `describeExisting`'s
per-kind mime the way the screenshot `risk` is overridden. Confirmed the two
formats genuinely differ: agent-browser produces a Chrome trace
(`{"traceEvents": […]}`), Playwright's `tracing.stop` writes a ZIP.

The artifact **kind stays `trace`** on both engines: retention and completeness ask
whether a run kept a trace, not what container it came in, so `RETENTION`,
`missingArtifacts`, `completenessOf` and `tierFor` are untouched and no engine name
leaks below `run/` — `evidence/` never learns one. `path` and `mime` are the
authority on the format, and `Artifact`'s doc comment says so.

Residue: the e2e assertion was not updated, see
[B-10](#b-10--closed--the-e2e-derives-the-trace-filename).
`evidence/store.ts`'s `MIME` record keeps `trace: "application/json"` as the
per-kind default; the engine-specific value is applied at the `stages.ts` call
site, which is what keeps engine knowledge out of `evidence/`.

### D-2 · The in-process matrix runs; the durable one still cannot be started

**Closed for the in-process half.** `geoqa matrix run` expands the axes, validates
**every** profile and journey up front and refuses the whole matrix listing *all*
bad names — discovering a typo ninety browser launches in is not a report, it is a
bill — selects the provider once, seeds each scenario at
`scenarioSeed(base, scenario.key)` so scenarios differ from each other while the
whole matrix replays from one number, and puts the journey in the run id
(`newRunId(\`${profileId}-${journey}\`, now)`), without which two journeys on one
profile prepared in the same millisecond share an evidence directory and the second
overwrites the first's manifest. `--dry-run` returns `result: null` — not an empty
result with a green-looking verdict — plus the expansion and the write count.
`--allow-writes` is required when any selected journey declares `writes: true`,
because at matrix scale that is one real form per scenario and an announcement
alone arrives too late. Exit 1 on `FAIL`/`ERROR`, which deliberately includes an
executed matrix with zero scenarios: zero scenarios is zero evidence.

**Still open: the durable path.** `geoQaMatrixWorkflow` exists and is tested, and
**no client starts a workflow at all** — verified: nothing outside
`temporal/worker.ts` constructs a Temporal `Connection` or `Client`. Running the
matrix durably still means writing a client by hand, and that path is still
**sequential** (`workflows.ts:118-127`), so the two execution modes now disagree
about concurrency as well as about `--repeat`
([B-4](#b-4--finding-reproducibility-is-fed-the-durable-path-and-runjson-are-not)).
That divergence is the thing to watch: invariant 12 says two execution modes, one
implementation.

### D-3 · Closed: the JSON contract carries a version

`GEOQA_SCHEMA_VERSION = 1` lives in `evidence/manifest.ts` — the only placement
that adds no new import edges — and is stamped on **both** consumed artifacts:
`GeoQaRunResult.schemaVersion` (by `assembleResult`) and
`EvidenceManifest.schemaVersion` (inside `buildManifest`, never passed in by a
caller, because a caller-supplied version is how two writers diverge). The bump
rule is in the comment: bump on a removal, rename, type change or meaning change —
anything that makes a consumer written against the old shape wrong — and **not**
for a purely additive field, because a version that changes every commit trains
consumers to ignore it.

Both wire shapes are pinned by **key-set** tests rather than value snapshots: a
full snapshot would fail on any unrelated change (a new confidence note, a
different duration, one more finding), and a test that cries wolf every commit gets
deleted, taking the pin with it. The keys are what a consumer wrote code against.

Two deliberate omissions: `run.json` does not carry `schemaVersion` — the manifest
sits beside it in the same directory and versions the package as a whole — and an
experiment `summary.json` carries none either, because it is a record of one
measurement rather than an integration contract.

### D-4 · Closed: evidence has a shelf life now

`evidence/prune.ts` plus `geoqa evidence prune` decide how long a run is *kept*,
where retention tiers only ever decided what it *captured*. `planPrune` never
deletes; `executePrune` deletes only on `{apply: true}`, and there is **no
`--dry-run` flag to forget** because the dry run is the default — a destructive
default is how somebody loses the one trace that mattered. The dry run still
re-validates every path, so refusals surface before anyone types `--apply`.

Four policy decisions are worth recording here because they are judgement, not
mechanism:

- **Ages mirror the retention asymmetry, applied to time**: `pass: 7`,
  `warning: 30`, `fail: 180`, `investigation: 180`. A pass's artifacts are cheap to
  discard because they are cheap to *regenerate*; a failure's trace may be the only
  copy of a bug that never recurs.
- **Privacy shortens, never extends.** A run whose manifest carries a privacy note
  *or* any `risk: "review"` artifact — both sources, because trusting only the
  derived note lets a wording change silently un-flag runs — goes at
  `privacyMaxAgeDays` (14) rather than at its tier's ceiling. Flagged runs are also
  never selected by the size sweep: a disk-space job must not be the thing that
  quietly removes the only record of what was exposed.
- **The size sweep reports a shortfall rather than spending a failure.** It sweeps
  `pass` then `warning`, oldest first, stops the instant it is under the cap, and if
  it runs out of tiers it may spend it records `sizeShortfallBytes` — "could not get
  under the cap" must never read as "did". Exit 1 in that case, even on a dry run,
  so a scheduled prune goes red instead of looking fine.
- **An unidentifiable run is reported and left alone.** No readable manifest, an
  unrecognised tier or an unparseable `createdAt` lands in `plan.unknown` with a
  `why`; only `--delete-unreadable` removes it. An unparseable timestamp is
  deliberately neither age 0 (exempt forever) nor the epoch (deleted at once). Not
  knowing what something was is a reason to look, not a licence to delete.

Residue, small and worth fixing before the first `--apply` in anger: **two
legitimate non-run directories are reported as unknown runs.** `nodePruneFs.listRunDirs`
treats every directory under the evidence root as a run, and
`<root>/visitors/` (saved sessions, [B-7](#b-7--a-returning-visitor-is-restored-now-and-nothing-says-when-it-was-not))
and `<root>/verify-sessions/` (a Playwright `browser verify`, which always records
a HAR into `<evidenceRoot>/<runId>/`) both appear in `plan.unknown` as "no readable
manifest". They are left on disk, so nothing is lost — the report is just noisier
than it should be, and `--delete-unreadable` would take a visitor's session with
it. Fix in `prune.ts`: skip a known set of non-run directory names, or have
`planPrune` refuse them with a reason.

Nothing schedules a prune either; that is the same missing scheduler as
[A-3](#a-3--the-matrix-runs-in-process-now-nothing-schedules-it-and-the-bound-is-a-guess).

---

## Suggested order

The first is not a priority call — it is a red suite. After that the order is
"make the next phase honest rather than bigger".

1. ~~**B-10**~~ — DONE. The e2e derives the trace filename from
   `traceArtifactFormat`, so it cannot disagree with the collector again.
2. ~~**B-1's residue**~~ — DONE. `evidence.retention` reaches both the collector and
   the manifest, the cooldown store is reachable from the CLI at all for the first
   time, the browser caps reach `journey run`, the dead `ProviderOptions.cooldownMs`
   is gone and the `.gitignore` rationale is corrected.
3. ~~**One `ExperimentOptions` edit closes three entries**~~ — DONE. `engine`,
   `verifyEndpoint` and the stability knobs all reach the samplers through one
   `runtimeFor` helper; C-1 and D-1b are closed and EXP-002 has produced a real
   measurement through a live exit. Only A-3b's full run still waits on traffic.
4. ~~**B-8**~~ — DONE 2026-08-13. Placeholders are replaced with an inert token
   before parsing, so a template can start a run; the reasoning was wrong where it
   counted, since placeholders live in the USERNAME and the gateway host and port
   are literal.
5. **A-1 proper** (provision, or check the office address) — with B-8 fixed, the
   last thing standing between the code and the central claim. `infra/` makes it an
   afternoon and about $28/month rather than a project.
6. ~~**B-3's HAR residue**~~ — DONE. The collection reorder, the pass-tier delete and
   the privacy flag all landed together; `harStop` closes the context because on
   Playwright that is the flush, and fail-tier completeness is 100 rather than 88.
7. ~~**B-7's last half**~~ — DONE. The two-run e2e exists: `oslo-desktop-returning`
   against `/returning`, failing on the first run and passing on the second, and
   mutation-checked so it is sensitive to the restore branch it names. **With this,
   no code-closable item remains in this document** — everything below needs a
   decision, a live environment, or a Temporal worker.
8. ~~**C-8**~~ and ~~**C-15**~~ — both DONE, and in both cases the entry had framed a
   choice that turned out to be false. C-8: `isMobile` is the only descriptor option
   that costs viewport control, so a mobile identity needs neither emulation nor a
   descriptor. C-15: the declaration and the copy are separate claims, so the journey
   asserts both. Worth noting as a pattern — twice in one day, a gap recorded as
   "needs a decision" dissolved once somebody measured the thing it assumed.
9. **B-4's residue** — the attempt count is in `run.json` now and occurrences are
   keyed per step; what is left is giving the durable path the same repeat wiring the
   CLI has, which waits on D-2.
10. **D-2's durable half** — a Temporal client, and a decision about whether the
    matrix workflow adopts the in-process runner's bound. Worth doing after EXP-007
    has a number, not before.
11. **A-3's scheduler** — 96 scenarios exist, `matrix run` can execute them, and
    nothing runs it at 3am on a machine with a Norwegian address. That last clause
    is the constraint (`infra/README.md`), not the cron.
