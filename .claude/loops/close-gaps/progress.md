# Progress

## Slice 0 · Commit the baseline — DONE (not as planned)

Something had already committed the work as `abbdc75`, titled
`refactor(config): update geoqa.config.example.json and package.json`, containing
117 files and +15,602 lines — the entire Phase 1 build. It was already on
`origin/main`, so the message cannot be corrected without rewriting published
history.

Handled by `998399f`, an empty-of-code commit that documents what `abbdc75`
actually contains, so the record is recoverable from history itself rather than
lost to a wrong subject line.

Working branch: `feat/phase-1-playwright-geo`.

Gate: lint clean · boundaries clean (94 modules) · 925 tests at 100% · e2e 18/18.

## Slice 1 · Truth up docs/gaps.md — DONE

- B-8 marked CLOSED. It was the consequential one: `health()` refused to probe
  any URL containing `{`, returned `unconfigured`, and `prepareRun` treats that as
  a hard refusal for a non-direct provider. A residential template could never
  start a run.
- B-10 marked CLOSED — the e2e now derives the trace filename from
  `traceArtifactFormat` rather than hardcoding `trace.json`.
- The duplicated `### D-1c` heading renumbered to `D-1e`.
- Header now states the file was verified against code on 2026-08-13.

Gate: green, unchanged (no source touched).

## Credentials landed this session

`.env` (gitignored, 600) now carries Decodo residential + ISP, and the search
stack copied from `/etc/xaheen-agent-fleet.env` on the fleet VPS: `SERPAPI_KEY`,
`DATAFORSEO_LOGIN/PASSWORD/LABS`, `GSC_CREDENTIALS`, `SEO_GSC_PROPERTY`.
`secrets/gsc-sa.json` pulled from the VPS and gitignored.

Verified live:

| Service | State |
|---|---|
| SerpApi | Developer Plan, 2585 of 5000 searches left |
| DataForSEO | authenticates, **balance −$0.0043** |
| Search Console | service account `gsc-seo-reader@digilist-496317`, property `sc-domain:digilist.no` |
| Decodo residential | 50 GB to 12 Sep, rotation and stickiness both proven |

**DataForSEO being overdrawn while still authenticating is the exact failure
`network/types.ts` warns about, live in the account right now.** It is the
strongest available argument for slice 10's real `health()` probe: the balance is
in `/v3/appendix/user_data`, so the provider can report `unusable` with a reason
instead of silently returning no keywords.

## Slice 2 · CLI flags for plumbing that exists — DONE

Three capabilities that were built and unreachable. Each one is now typeable, and
each refuses rather than defaults, because the failure mode in all three is the
same: a flag that had no effect and said nothing.

**`--urls-file` reaches the matrix page axis.** The axis had landed in
`run/matrix.ts` and nothing constructed it, so `matrixRun` built `axes` without
`targets` and every scenario visited `--url`. Two defects were hiding in that:
`plan` read `options.url` instead of `scenario.target`, so even a constructed axis
would have loaded one page N times and reported N clean pages; and the run-id slug
was `<profile>-<journey>`, which two pages share along with a millisecond under
concurrency, so the second would have overwritten the first's manifest. Index, not
URL, in the slug — a URL contains `/` and `:` and a run id becomes a directory
name.

**`--stability-window` / `--stability-reads` reach EXP-002 (closes C-1).** Parsed
in `samplers.ts`, not `args.ts`: the knob types belong to the sampler that reads
them, and `args.ts` cannot import them anyway (`samplers` → `commands` → `args`
already, and `pnpm boundaries` refuses the cycle). `parseDurationMs` takes
`10m`/`600s`/`600000` and **refuses** what it cannot read — a `10min` that fell
back to the default would have printed a summary measuring 24 seconds, and since
the note names the window it used, the reader would have got a confident answer to
a question they never asked. The stale `--stability-window-ms 600000` in the
summary note itself was a lie about a flag that never existed; fixed.

**`--country`/`--city`/`--device` name an identity by place.** Resolved against the
profiles that exist, so `--city Atlantis` refuses and lists the 16 places there
are. Both forms at once refuses rather than ranks. `matrix run` refuses the place
flags outright — before resolution, so the message names `--market` instead of
answering `--country NO` with "11 profiles match".

Also: `matrix run` with neither `--url` nor `--urls-file` now refuses, where before
an empty target reached the browser as a navigation to nothing, once per scenario.

Proven live, not just in unit tests — a real Playwright sweep through the fixture
server:

```
PASS — 3 scenario(s): 3 passed, 0 warned, 0 site-failed, 0 unmeasured
  concurrency limit 2, peak in flight 2, 4805ms
  3 page(s) from the URL axis
```

Three distinct targets in three distinct evidence directories, including
`/healthy` and `/healthy?a=1` — the same path with a different query, which is the
collision case. And the refusals were exercised through the real CLI: bad URL line,
two identities, unparseable duration and place flags on a matrix all exit 2.

Docs: C-1 closed in `gaps.md`; PRD gains **R-101…R-104** (sweep inside the pool,
list validated before launch, distinct run ids per page, identity by place). They
were first written as R-90…R-93, which **already existed** — the retention block
uses those numbers. Caught and renumbered in slice 2b; it is the same register
corruption slice 1 fixed in `gaps.md` for a duplicated `D-1c`.

Gate: lint clean · boundaries clean (94 modules / 371 deps) · **963 tests at 100%**
lines/statements/functions (was 925) · e2e 18/18.

**Not done, and it is worth naming:** EXP-002 still has no ten-minute measurement.
The flag is no longer the obstacle — the samplers build agent-browser regardless of
`--engine` (D-1b, slice 4), so a long stickiness run through Decodo waits on that.

## Slice 2b · T10, two IP-geo sources with disagreement flagged — DONE

`compareSources` + `withCorroboration` + a `NetworkSource` registry pairing an
endpoint with its own parser. `proxy verify` corroborates by default; runs opt in
with `--corroborate`, because a 430-page sweep is 430 extra probes and an engine
that exhausts its own corroborating source reports `unverified` forever — the shape
of failure an exhausted proxy already produced once.

Three decisions are the substance, and each came from a measurement rather than a
preference.

**The second source is pinned to IPv4, and the first choice was wrong.** `ipwho.is`
was picked for its richer payload, and a real Playwright run reported
`88.88.18.137` from ipinfo and `2001:4656:e2f2:...` from ipwho.is — same laptop, no
proxy. `ipinfo.io` publishes **no AAAA record**; a dual-stack corroborating host is
read over IPv6 while the primary is read over IPv4, so the axis could never
corroborate anything. Swapped to `ipv4.geojs.io`, which also has no AAAA. Both
reads now use one address.

**A different IP is never a disagreement.** It means a dual-stack route or a
rotation between the reads, so the two locations describe different visitors.
`unverified`, naming both possibilities.

**Only country is compared.** City divergence between databases is normal and
comparing it would fire on essentially every run — the engine manufacturing defects
out of its own instrumentation, which is the failure it exists to detect in others.

A country disagreement IS a `mismatch`, unlike a city mismatch elsewhere: the
proven fact is not "the country is X" but "this reading is unreliable", and that is
established rather than suspected. It caps `networkConfidence` at 0.4 — the same
multiplier as a proven country mismatch, though the resulting numbers differ (40 vs
10), because a mismatch also zeroes the country term while a disagreement leaves
both readings standing and only caps the confidence in them.

### Live results

Direct egress, and the guard firing correctly:

```
sources  agreement=match  ipinfo NO/Tønsberg  vs  geojs NO/Rykkin
         two independent sources agree the egress is in NO (cities differ — …
         which is normal between databases and is not a defect)
```

Six Decodo residential markets, all corroborated on country:

```
berlin-desktop      agreement=match   ipinfo DE/Berlin      geojs DE/Berlin
stockholm-desktop   agreement=match   ipinfo SE/Stockholm   geojs SE/Stockholm
london-desktop      agreement=match   ipinfo GB/London      geojs GB/London
copenhagen-desktop  agreement=match   ipinfo DK/Copenhagen  geojs DK/(none)
tromso-desktop      agreement=match   ipinfo NO/Stavanger   geojs NO/Bærum
bodo-desktop        agreement=match   ipinfo NO/Bodø        geojs NO/Bodø
```

**No country disagreement fired in six markets**, which is real good news about
Decodo residential and is reported as such. The São Paulo / New York case could not
be reproduced: it was on the ISP endpoint, whose plan is gone — that endpoint now
reads nothing at all, and both sources correctly report `unverified` with "primary
source read no country" rather than inventing a dispute out of a dead proxy.

### The finding that changes a pending decision

**`tromso-desktop`: ipinfo says Stavanger, geojs says Bærum — 400 km apart, same
IP.** Two independent databases cannot agree on the city of one address. A **≥90%
city-match bar measured against one database is measuring that database**, not the
proxy. The threshold question in `test-plan.md` should be settled knowing this: the
honest reading is that country is the measurable axis and city is corroborating
evidence, not a pass/fail gate. Recorded in `gaps.md` C-4.

Docs: C-4 extended with the measurement; PRD gains **R-105 / R-106**.

Gate: lint clean · boundaries clean (94 modules / 372 deps) · **997 tests at 100%**
lines/statements/functions · e2e 18/18.

## Slice 2c · J03 internal search, and clicking — DONE

`journeys/search.yaml` (26 steps) and a click added to `reader.yaml` at
`probability: 0.33`. Before this, **no journey clicked anything** — `runtime.click`
was exercised only by adapter tests against a fake, and a fake click always
succeeds: it cannot say whether the browser followed the link, whether the next
page loaded, or whether the checks after it ran against the page they were written
for.

New fixtures: `/search` (GETs to a different path, so results are a real
navigation), `/search-results` (three clickable results), `/search-result`,
`/search-empty`, `/search-dead` + `/search-dead-results`.

**The dead-link fixture is the proof.** Its `no-http-4xx` finding sits on a step
that runs AFTER the click, so it cannot appear unless the browser really
navigated. e2e asserts `FAIL`, category `http`, and zero instrumentation findings —
the site's defect, not ours. 25/25 e2e.

`/search-empty` covers the opposite error: an empty result set is a **correct**
answer to a query. A runner that reported every fruitless search as a finding
manufactures defects out of its own inputs, so the query is a `--var` and the
count check is only asserted when the caller knows the term matches.

### J03 found a real defect on its first live run

`digilist.no` renders its inline search input inside
`class="hidden md:flex lg:hidden"` — visible **only** between 768px and 1023px.
Confirmed by running J03 at both profile widths:

| Profile | Width | Search box |
|---|---|---|
| `oslo-desktop` | 1440px | not visible (`lg:hidden`) |
| `oslo-mobile` | 390px | not visible (base `hidden`) |

So on a phone and on a desktop — every width geoqa models — the search field is
unreachable. A `<kbd>` hint beside it suggests a keyboard palette is the intended
desktop affordance, which is not a substitute for a visible control on a touch
device. Recorded as **C-10**.

Note how it was found: **the markup contains a search input, so any check testing
presence rather than VISIBILITY would have passed this site.**

### And it exposed an engine limitation

The same run cost 30 seconds and its verdict. After `selector-visible` correctly
FAILED, the `fill` on the same selector still ran and timed out — so `ERROR`
outranked `FAIL` (R-19) and a clean, actionable finding was reported as "we could
not verify", which sends a reader hunting for a broken proxy.

Recorded as **C-9** rather than half-fixed. There is no step dependency in the
journey DSL, deliberately — steps are data and a conditional step is a program. The
honest options are a shorter timeout for input actions than for navigations, or
letting a critical visibility check be fatal for steps naming the same selector.
Both are real design choices and neither belongs in a slice about clicking.

### Two brittle tests rewritten

Both broke on a correct change, which is how a test stops being trusted:

- `spec.test.ts` asserted an exact journey roster. Now asserts CONTAINMENT of the
  journeys something else depends on, plus "nothing but YAML" — still catches a
  deletion, no longer fails on an addition. It had already broken twice in one day.
- The reader e2e hardcoded 20 steps. Now derives the count from the journey file,
  and additionally asserts a `skipped` step is present — which is the actual claim
  (optional steps are recorded, never dropped).

Docs: gaps C-9, C-10; PRD **R-107 / R-108**.

Gate: lint clean · boundaries clean (94 modules / 372 deps) · **1004 tests at 100%**
lines/statements/functions · e2e **25/25**.

## Slice 2d · J06 manual language override — DONE

`journeys/language-override.yaml`, and fixtures covering both real mechanisms:
**path prefix** (`/en/lang`, what digilist does) and **cookie** (`lang=en`, so an
unprefixed page also answers in English — the returning-visitor half, demonstrated
inside one run with no `storageState`). `fixtureBody` now takes the request cookie
and can return headers, which is what a stateless path-per-page server needed to
express a choice that survives a navigation. Same seam unlocks the cookie-banner
scenario later.

e2e asserts **both directions**: PASS when the choice survives, FAIL (critical,
`localization`) when a geo-redirect undoes it on the next click. 28/28.

This slice cost three wrong turns and each one is worth more than the journey.

### 1 · A negative assertion alone proved nothing

The first version asserted only `text-absent: Velkommen` after the override.
`Velkommen` is on the fixture's homepage and nowhere else, so one click later the
check was **trivially true on a page that never contained the word** — and a
deliberately broken override reported **PASS**. A vacuous check is worse than a
missing one: it occupies the place where a reader believes a claim is made. Fixed
with a paired positive `text-contains` on an arriving marker, and both markers moved
into site chrome present on every page of their language. **R-109**.

### 2 · A CSS comma is resolved in DOM order, not as a preference list

Even with both checks, the broken run still reported PASS. The onward click was
`#deeper, a[href^='/']`, and the nav precedes the content — so it clicked **Home**,
the journey never reached the page whose language it was checking, and both
assertions passed against the wrong page.

All three click journeys had it, two working only by accident of document order:

| Journey | Was | Now |
|---|---|---|
| `language-override` | `#deeper, a[href^='/']` | `main a[href^='/'], article a[href^='/'], #deeper` |
| `search` | `#results a, .result, [data-result], li a` | `#results a, .result, [data-result]` |
| `reader` | `a[href^='/']` | `main a[href^='/'], article a[href^='/']` |

`reader`'s is the one to note: a bare `a[href^='/']` clicks the **logo** on almost
every real site, so "follow a contextual link" would have gone home. Recorded as
**C-11**, open — nothing enforces the convention, and the failure is silent.

### 3 · Actions targeted the first DOM match, not the first visible one

`click` used `all.first()`. On digilist the switcher union
`[hreflang='en'], a[href*='/en']` resolves to the `<link hreflang="en">` in
`<head>` — invisible, unclickable, 30 seconds, reported as instrumentation. And
`fill`/`select`/`check` used the unnarrowed locator, so any multi-match selector
raised a strict-mode violation instead of filling the box the author meant. All four
now target the first visible match. **R-111**.

### And an evidence gap that made the investigation possible

The first live failure could not be attributed **at all**: a click recorded nothing,
so "the language did not survive" and "the marker was badly chosen" were
indistinguishable. A navigating step now records the URL it landed on — `click`,
`press`, `open`, `reload`, and deliberately not `fill`. **R-112**.

### The digilist result, recorded as UNRESOLVED

```
passed   land on the geo-chosen language     https://digilist.no/
passed   choose the other language           https://digilist.no/en
errored  navigate onward                     click failed: timeout — 30000ms
```

**And a correction: I filed a localization defect against digilist and it was
wrong.** It rested on `curl` output showing `lang="nb-NO"` and a Norwegian title on
`/en/leie`. The site is client-rendered — a real browser renders that page with
`lang="en"` and the English chrome intact. A finding taken from the pre-hydration
shell of an SPA is a finding about the framework. Withdrawn, and named in **C-12**,
because the mistake is the instructive part: this engine reads through a browser for
exactly this reason, and the one investigation that stepped outside the browser
produced a confident wrong answer within minutes.

Docs: gaps **C-11**, **C-12**; PRD **R-109 … R-112**.

Gate: lint clean · boundaries clean (94 modules / 372 deps) · **1013 tests at 100%**
lines/statements/functions · e2e **28/28**.

## Slice 3 · D-1e — already closed, and the entry was stale

`proxy verify` has honoured `--engine` since `RuntimeRequest` landed;
`cli/commands.ts` passes `{ engine, profile }` to `makeRuntime`. **The entry
contradicted D-1b in the same document**, which already said "closed for
`browser verify` and `proxy verify`".

Confirmed by running it rather than reading it: `proxy verify --geo bergen-desktop
--provider http-proxy --engine playwright` returns a full two-axis verification at
confidence 100 through a live Decodo exit, and did so repeatedly during the
corroboration work in slice 2b.

Kept in the register rather than deleted, because the failure it records is real and
it is about the register itself: two entries describing the same code disagreed, and
the pessimistic one was believed. Slice 1 existed to fix exactly this and this
survived it.

Slice 3 therefore cost no code, so slice 4 was taken in the same run.

## Slice 4 · D-1b — the experiment samplers honour the engine — DONE

`ExperimentOptions` gained `engine` and `verifyEndpoint`, and every runtime an
experiment builds now goes through one `runtimeFor(deps, options, profile, config)`
helper instead of five call sites with their own defaults. That consolidation is the
point, not tidiness: a per-site default is how EXP-003's **two** isolated sessions
end up on different engines while the sample reports one number. The three samplers
that delegate to `journeyRun` forward both fields, so `--engine` means the same thing
whether an experiment runs a journey or a human does.

Absent still means `DEFAULT_ENGINE`, so an experiment re-run without the flag
measures what its stored results measured — otherwise the new results and the old
ones are not comparable.

EXP-000 is the one where this is more than uniformity: its subject IS the adapter, so
taking its samples through an engine nobody asked about answered a different question
than the one printed at the top of its own summary.

### Proven by running it, and it unblocked something

**EXP-002 had never produced a measurement through the residential proxy at all.**
The samplers were agent-browser-only and there is no Chrome for that engine here, so
the experiment could not execute — which means C-1's flag work in slice 2 had landed
into a path that still could not run. Through Playwright and a live Decodo Bergen
exit:

```
EXP-002-sticky-session — PASS
  ✓ ip-stability   100.0% vs ≥ 95%
  · Each sample held ONE session for 30s across 3 reads (one every 15s).
    The PRD asks for a 10min window; that is NOT what this measured.
```

The note is doing its job: a cheap window cannot be read as the expensive claim. A
**10-minute, 5-read** run (T04, the PRD's actual window) was launched after this and
its result is recorded separately.

Docs: gaps **D-1b** and **D-1e** closed; PRD **R-113**.

Gate: lint clean · boundaries clean (94 modules / 374 deps) · **1019 tests at 100%**
lines/statements/functions · e2e **28/28**.

## T04 · The PRD's ten-minute stickiness window — MEASURED

Landed while slice 5 was in progress, and it closes the last of the owner's
first-15 pack that was a flag away:

```
EXP-002-sticky-session — PASS
  ✓ ip-stability   100.0% vs ≥ 95%
  · Each sample held ONE session for 10min across 5 reads (one every 2.5min).
    That covers the 10min window the PRD asks for.
```

One Decodo residential IP held for the full ten minutes. The note rendered its
"covers the PRD window" branch for the first time — that branch had existed since
the window became a parameter and had never been reachable.

## Slice 5 · B-7 + C-5 + C-8 — DONE

### B-7 · A returning visitor is now visible in the evidence, and exercised

`executeRun` logs the `unmet` sentence and `run.json` carries
`visitor: { declared, restored, unmet }` — additive, no schema bump. The declaration
is an intention; `restored` is an observation, and only one of them is evidence.

`profiles/oslo-desktop-returning.yaml` is the first profile to declare
`visitorType: returning`, so the restore branches are no longer dead in every real
run. Separate profile rather than a flipped flag: a returning visitor is a different
test subject, and the state file is keyed by profile id, so a shared id would have
the two kinds of run fighting over one session file.

**Adding it immediately broke `--country NO --city Oslo`** — two desktop profiles for
one place, so the ambiguity check refused. The check working correctly and the feature
becoming useless. `PlaceSelection` gained `visitor`, defaulting to `anonymous`: a
first-time visitor is the neutral subject and is what a place name means when nobody
says otherwise.

Residual: no e2e proves a real cookie survives two runs. It needs a two-run harness
shape this suite does not have — every existing case is a single run.

### C-5 · `inp-below` exists, and proving it took a new fixture

The check itself was small. The finding was not: **`inp` was `null` on every existing
fixture even after a real click.** Chromium reports event-timing entries only above a
threshold, so a click on a page whose handler does nothing expensive is genuinely too
fast to produce one — `inp: null` is a fact about the page, not a failed read.

`/slow-interaction` blocks the main thread ~120ms, above the threshold and below
Google's 200ms bar, so one page proves a measured pass AND a measured finding. Both
asserted against real Chromium, because a fake runtime returning a number proves the
comparison and never that an interaction was timed.

**`inp-below` is deliberately in NO shipped journey.** An unreadable check is
`instrumentation` and ERROR outranks FAIL, so asserting INP generally turns a clean run
into "we could not verify" on most simple pages — the engine blaming itself for a page
with nothing to measure.

One of my assertions was wrong and the engine was right: I expected `FAIL` at a missed
budget and got `PASS_WITH_WARNINGS`, because severity is declared per step and that
step declares `medium`. A responsiveness budget is a signal, not a gate. Asserting
FAIL would have been asserting a severity the journey never asked for.

Residual, recorded not answered: a null INP is a page property, and the verdict model
treats any unread check as our defect. Fixing that means letting a check declare that
its own null is a page fact — a real change to the verdict model.

### C-8 · An unknown descriptor now refuses, and a declared device is verified

The premise had gone stale: **no profile carries `emulate` any more**, all eight
mobile ones had it reverted for the measured viewport reason.

The bullet with teeth is closed. `openContext` dropped its `?? {}` fallback and
REFUSES an unrecognised name — the old form failed invisibly in every direction at
once: no descriptor applied, `setDevice` still answering `ok` (it compares the
requested name against the name the context was built with, the same string), and the
viewport matching anyway.

`compareDevice` is the missing axis: `navigator.userAgent` was observed on every run
and compared to nothing. Asymmetric on purpose — a profile declaring no `userAgent`
gets `unverified`, because a claim nobody made cannot be verified and inventing an
expectation from `device.kind` would mark every mobile profile in the repo mismatched.

**Still open and worth saying plainly: geoqa's mobile profiles present a DESKTOP user
agent.** They are mobile by viewport only. A site doing server-side device detection
serves them its desktop variant. Closing it means choosing between emulation (losing
viewport control) or hand-maintained `userAgent` strings per profile.

### Three more brittle tests rewritten

Each broke on a correct change, and each proxy assertion was wrong rather than the code:

- profile roster: `files.length % 2 === 0` stood in for "every market on both devices"
  and held only while every profile was a market×device pair. Now asserts R-67 directly.
- profile listing: "ids are sorted" stood in for adjacency and held only because
  filenames sort `-` before `.`. Now asserts adjacency.
- the `-(mobile|desktop)` filename split treated `oslo-desktop-returning` as a market
  and demanded a desktop file for it. Now enumerates pairs only.

Docs: gaps **B-7**, **C-5**, **C-8** closed with residuals named; PRD **R-114 … R-117**.

Gate: lint clean · boundaries clean (94 modules / 374 deps) · **1032 tests at 100%**
lines/statements/functions · e2e **30/30**.

## Slice 6 · The tenant model — DONE (approval gate cleared)

Two decisions taken with the owner:

- **YAML registry now** (`tenants/<id>.yaml`), database deferred to run persistence
  where queries across runs are the actual requirement.
- **A proxy sub-account per tenant**, so exhaustion is a 407 on that sub-user alone
  rather than everyone's runs. Provisioning is slice 7.

`Tenant` carries id, name, markets, targets, a credentials **reference**, quota and
retention. Evidence moves to `<root>/<tenantId>/<runId>`.

### Isolation demonstrated, not asserted

Two tenants, two real runs through Playwright, two disjoint trees:

```
<root>/digilist/run_1786611417809_oslo-desktop
<root>/acme/run_1786611421089_oslo-desktop
```

The security work is `containedPath`, extracted as a primitive rather than left
inline — slice 8 needs the same rule for tenant-scoped profiles and journeys, and a
containment check reimplemented per call site is one that is subtly different in one
of them. Three escapes refused:

- `..` climbing above the root;
- an **absolute** segment, which discards the root entirely —
  `path.resolve("/evidence", "/etc")` is `/etc`, the one most likely to surprise;
- a segment resolving to the root itself, which would hand one tenant the shared tree.

Containment is `path.relative`, never `startsWith`, because `/evidence/acme` starts
with `/evidence/ac` — a prefix test places tenant `acme` inside tenant `ac`'s root and
calls it contained.

### Two rules that look like style and are not

**A tenant id refuses uppercase.** macOS and Windows filesystems are case-insensitive
while Linux is not, so `Acme` and `acme` would be two tenants in CI and one tenant on a
developer's laptop — a cross-tenant read that reproduces only on the machine nobody
tests on.

**Target ownership is compared by ORIGIN, never by prefix.**
`https://digilist.no.evil.test` starts with `https://digilist.no` as a string, so a
prefix test would authorise an attacker's host. Exercised live: that URL is refused, as
is a market the tenant never declared, and a mistyped `--tenant` refuses rather than
creating a directory for a tenant that does not exist.

### One coverage decision worth recording

The resolved-path check was unreachable through the public API — the id pattern catches
every traversing value first. Rather than exclude the file or delete the check, the
containment logic became `containedPath`, which is independently testable and is the
primitive the next slice needs. Defence in depth kept, and now proven.

**Residual, named rather than left to be found:** quota is DECLARED and not enforced.
`trafficMb` and `runsPerDay` are parsed and validated and nothing reads them — exactly
the defect B-1 closed for the config file. Slice 7.

Docs: gaps **A-6**; PRD **R-118 … R-122**.

Gate: lint clean · boundaries clean (97 modules / 387 deps) · **1070 tests at 100%**
lines/statements/functions · e2e **30/30**.

## Slice 7 · Per-tenant proxy metering — DONE

Two numbers, two sources, deliberately not interchangeable. **Traffic** from the
vendor (`GET /v2/sub-users`, shape captured live) because bytes are counted at the
proxy and an estimate that drifted would be worse than none — it would be trusted.
**Run count** derived from the tenant's own evidence directories, because the vendor
has no idea what a run is. Derived rather than stored: a counter file can be deleted,
written twice or left by a crash, and every one of those makes the ceiling wrong in the
direction that lets work through.

A matrix is expanded FIRST so the check knows the real page count. Verified live:

```
this run is estimated at 202 MB and tenant "digilist" has 14 MB left of 700 MB —
refusing before anything launches.
```

The third state is the point: an unread traffic figure is `null`, **never `0`** — the
DataForSEO lesson, where a credentials-present check let a zero-balance account pass
for weeks. It warns and proceeds rather than blocking, deliberately: with a
vendor-enforced cap per sub-account, exhaustion is isolated to the tenant that caused
it, so refusing every tenant's work because a usage API is down causes more harm than
it prevents. The run ceiling still applies, because that number is ours.

### A live finding, about the isolation model rather than the code

**The account's only sub-user has `traffic_limit: null` — no vendor-side cap is set.**
The strong half of the chosen isolation is not in force, so geoqa's own check is
currently the only guard, and it says so on every metered run. `auto_disable` is
`false` too, so exhaustion will not stop the sub-account either.

**Owner action: set a per-sub-account traffic limit at Decodo.** A cap geoqa enforces
can be bypassed by a bug in geoqa; one the vendor enforces cannot. When one IS set, the
effective ceiling becomes the lower of the two — a tenant budget above the vendor's
limit is a budget that cannot be spent.

### Two shapes carried over deliberately

`usage-probe.ts` is coverage-excluded with a named reason, exactly like
`network/auth-probe.ts` and `browser/playwright-launch.ts`: one HTTP read and a
hand-off, with every judgement in `quota.ts` against injected data. And every failure
returns `null` rather than an empty list — an empty list is a real answer ("this
account has no sub-accounts") that refuses, and a timeout must not be able to
masquerade as it, because the two lead to opposite actions.

Docs: gaps **A-7**; PRD **R-123 … R-125**.

Gate: lint clean · boundaries clean (100 modules / 395 deps) · **1102 tests at 100%**
lines/statements/functions · e2e **30/30**.

## Slice 8 · Tenant-scoped profiles and journeys — DONE, and it found a traversal

`tenants/<id>/profiles/` and `tenants/<id>/journeys/`, resolved before the repo's set.
A tenant's file wins by name; everything it has not customised falls back — so one
custom journey does not mean maintaining all eight.

Proven live. `tenants/digilist/journeys/landing-page.yaml` tightens LCP from the shared
2500ms to 1200ms:

```
shared:  landing-page   13 steps  Landing page validation
tenant:  landing-page    8 steps  Landing page validation (digilist budgets)

$ geoqa journey run --tenant digilist … --journey landing-page
  ✓ fast for THIS tenant
PASS
```

### The security fix was not what the slice was for

`profilePath` and `journeyPath` joined a CLI-supplied id straight onto a directory:

```
$ geoqa proxy verify --geo ../../../../etc/hosts
profile "…": /Volumes/etc/hosts.yaml: ENOENT
```

Verified against the old code. Limited blast radius — only `.yaml` files were reachable
— but the id came from the command line, the resolved path was echoed back, and a YAML
parse error can quote the line it failed on. Closed by `DataIdSchema` plus
`containedPath` on every candidate. Recorded as **B-11**.

The honest story is that adding a second search root is what made anybody look at how
the first one was joined. The traversal had been there since before multi-tenancy.

### Two things the suite caught

**A regression I introduced:** making the path builders throw broke `matrix run`'s
"report every problem at once" contract — it aborted on the first bad name, turning
"these four names are wrong" into "this one is", once per run. Now resolves through
`resolveDataPath` and collects refusals like any other validation error. Verified:
three bad names, three messages.

**A process mistake of mine that had already shipped:** a live-verification step in
slice 7 used `git checkout tenants/digilist.yaml` to undo a temporary edit, and silently
discarded the `proxySubUser` field added minutes earlier in the same slice. Slice 7 was
committed describing a field the tenant file did not have. Restored, metering
re-verified against the live account. `git checkout` is not an undo for a file that has
other uncommitted work in it.

Docs: gaps **A-8**, **B-11**; PRD **R-126 … R-128**.

Gate: lint clean · boundaries clean (100 modules / 396 deps) · **1109 tests at 100%**
lines/statements/functions · e2e **30/30**.

## Slice 9 · Run persistence — DONE, and the database answer changed

`<evidenceRoot>/runs.jsonl`, one record per run, under the tenant's root when scoped —
so a tenant's history inherits the containment already proven in slice 6.

**The decision: the index is a DERIVED CACHE, not the truth.** Each run's `run.json` is
the authority on that run, so a corrupt, truncated, hand-edited or deleted index costs
nothing permanent and `runs rebuild` reconstructs it. A store that owned the record would
introduce exactly the failure this project exists to prevent — a confident answer about
runs that did not happen the way it says.

**Why not SQLite, which Node now ships.** I checked rather than assumed: `node:sqlite`
exists on Node 22.19 and prints `ExperimentalWarning: SQLite is an experimental feature
and might change at any time`. A CLI that emits that before every line of output is a
worse tool, and "may change at any time" is a poor foundation for the store trends and a
UI depend on. JSONL costs one line per run, is greppable, diffs in review, and cannot
lose a run because the run is still on disk. Recorded when SQLite *does* become right:
when a query needs an index rather than a scan — a tenant with 10,000 runs is a 10 MB
file scanned in milliseconds, but a hosted UI serving many tenants concurrently is a
different problem, and this shape imports into a table without a rewrite.

### Regression detection, proven live

A page loses its `h1` between two runs at a stable origin:

```
1 regression(s) — a check that used to pass and now does not:
  has a primary heading · oslo-desktop/h1 · last good …05.988Z → first bad …08.306Z
```

The first attempt at this demo did NOT produce a regression, and the engine was right: I
ran the two halves against ephemeral fixture ports, so they were genuinely different
targets. Fixed by binding a stable port.

Four narrowings, each preventing a specific false report:

- Scoped to one profile + journey + target — merging them averages a real regression into
  noise.
- Only the transition, so a check that broke on Monday is one entry, not one per day.
- A failure with no earlier pass is not a regression; it may never have worked.
- An **ERROR run is skipped**, not read as a failed check. `ERROR` means geoqa could not
  read the page, and reporting our own instrumentation failure as the site's regression
  is the one confusion this codebase is built to avoid.

`runs list` exits 1 when there is a regression, so a scheduled check goes red.

### Three honesty properties carried through

`meanConfidence` is `null` for an empty history, never 0. A `null` vital stays null
rather than becoming a zero that would show a page getting *faster* the moment it stopped
being measurable. And `--limit` truncates the printed list only — how many runs there
have been, and what broke, are questions about all of them.

**Appending can never fail a run.** A run that verified a site and wrote its evidence has
not failed at anything a user cares about if a cache line could not be written.

**Residual:** a rebuilt record is poorer than an appended one — `run.json` carries the
journey verdict and seed but not the assembled confidence report — and it says so rather
than filling gaps with defaults that would read as real readings.

Docs: gaps **A-4** closed; PRD **R-129 … R-131**.

Gate: lint clean · boundaries clean (102 modules / 402 deps) · **1151 tests at 100%**
lines/statements/functions · e2e **30/30**.

## Slices 10 + 11 · A real SERP source, and `searchObservation` wired — DONE

Taken together because 11 is meaningless without 10. `src/search/` with a SerpApi
adapter — named for the vendor we actually have credentials for; the register said
"Serper", the working account is SerpApi, and building against a key nobody has would
have produced an adapter nothing could prove.

**`health()` verified live in all three states:**

```
real key : usable       — SerpApi account Active, 2505 search(es) left
bad key  : unusable     — SerpApi rejected the credentials: Invalid API key…
no key   : unconfigured — SERPAPI_KEY is not set
```

The state a credentials check cannot see is the one that matters: valid credentials with
`total_searches_left: 0` is **unusable**, because empty results read as "nobody ranks".
That is the DataForSEO failure, and that account is still overdrawn while authenticating.

**The three-state observation:** provider could not answer → `null`; results came back and
we are not in them → a real low score of **2**; we rank → scored by position. A small
number rather than 0 for a measured absence, so it is distinguishable at a glance from an
unmeasured one. And it is deliberately **excluded from `overall`** — the other four axes
answer "can this run's readings be believed", this one answers "is this page visible in
search", and averaging them would let good visibility disguise a run that could not read
the page.

### Two bugs the first live queries found, both mine, both minutes old

**`hl=nb` is refused.** Google's interface language for Norwegian is the macrolanguage
`no`, not the correct BCP-47 tag a browser sends. My blind reduction to the primary subtag
was wrong for the first market this project was built for.

**`location=Oslo,NO` is refused.** The accepted form is a canonical name from the vendor's
gazetteer, shape not derivable: `Oslo,Oslo,Norway`, `Bergen,Vestland,Norway`,
`Stockholm,Stockholm Municipality,Stockholm County,Sweden`, `Berlin,Germany`. Cities are
now resolved via the free `/locations.json` **filtered by country code** — a search for
"Oslo" returns `Oslo,Minnesota,United States` in the same list, and taking the first match
would have run a Norwegian market's SERP from Minnesota and called it Oslo. An
unresolvable city **refuses** rather than quietly widening to the country.

Both were caught on the first live query *because* the adapter reports an unreadable
response as unmeasured rather than as an empty SERP. A client that returned `[]` would have
told me "digilist ranks nowhere in Norway", twice, confidently. The design caught my own
bug before it became a finding about the tenant.

### A live finding

For `leie lokaler`, digilist.no is absent from the top 10 in both markets — measured, score 2:

```
Oslo    9 results  | top3: booking.oslo.kommune.no, aktivioslo.no, selskapslokaler.no
Bergen 10 results  | top3: www.bergen.kommune.no, selskapslokaler.no, www.kulturhusetibergen.no
```

**Residual, named:** nothing in the run path calls `search()` yet — the axis accepts an
observation and no command produces one. That is the wiring for slices 13–15, and an
option nothing reads is the defect B-1 closed, so it is recorded rather than left.

Docs: gaps **A-2** closed; PRD **R-132 … R-135**.

Gate: lint clean · boundaries clean (107 modules / 418 deps) · **1202 tests at 100%**
lines/statements/functions · e2e **30/30**.

## Slice 12 · EXP-007 run for the first time — DONE. Milestone BLOCKED, deliberately.

EXP-007 had never executed: the samplers were agent-browser-only and there is no Chrome for
that engine here, which slice 4 fixed. It runs now.

### The concurrency bound is measured

14-core / 36 GB laptop, local fixture server, 100% completion + verdict agreement +
egress-held at every level:

```
concurrency  2 → wall clock x1.01     8 → x1.14
             4 → x1.01               12 → x1.09
                                     16 → x1.30
```

**`DEFAULT_MATRIX_CONCURRENCY` raised 2 → 4.** Not 16: the measurement covers ONE machine
and a default has to be safe on the smallest one that will run this — a 2-core CI runner is
worse at 16 than at 2. And `peak-memory-per-session` remains permanently unmeasurable from
this process, so the OOM risk that originally kept the bound at 1 is still unquantified. A
CPU-derived bound is the obvious next step and is deliberately NOT taken on one data point.

### And EXP-007 found a real defect I could not solve

Through Decodo at concurrency 3 and 4, reproduced three times: **profiles sharing a MARKET
share an egress IP.**

```
oslo-desktop        193.69.169.75
oslo-mobile         193.69.169.75    ← same market, same IP
porsgrunn-desktop   51.174.196.164
porsgrunn-mobile    51.174.196.164   ← same market, same IP
```

Each reports `egressHeld: match`, because holding an IP you share with somebody else still
looks like holding it. That is invariant 16 — one journey, one network session — failing
with nothing in the run contradicting it.

**Three hypotheses tested, all three wrong:**

1. Session-id collision. The id was `<market>-<epochMs>`, so same-market sessions in the same
   millisecond genuinely collided — **fixed**, now `<market>-<epochMs>-<n>`. Not the cause;
   the IPs still shared afterwards.
2. The vendor collapses same-city keys. **No** — four concurrent requests with four distinct
   keys in one city returned four distinct IPs, and re-using a key returned its IP again.
3. `sessionduration-30` changes the key's scope. **No** — distinct keys give distinct IPs
   with and without it.

Verified through the real run path that geoqa sends distinct usernames:
`oslo-…-1-sessionduration-30` vs `oslo-…-2-sessionduration-30`, different resolved URLs.

So the vendor honours distinct keys, geoqa sends distinct keys, and two same-market runs
still land on one IP. **I do not know the mechanism.** Recorded as **B-12** unresolved
rather than guessing — three plausible explanations were tested and all three were wrong,
which is precisely the point at which a fourth guess should not be written into a comment
as if it were a finding.

### Why the 100-session milestone was NOT run

It would measure the wrong thing. The milestone is country and city match across 100
sessions; if same-market concurrent sessions share an exit, a run at any concurrency inside
a market exercises fewer distinct exits than it reports, and the percentages would describe
the wrong denominator. Running it and publishing ≥98%/≥90% numbers I already know are
suspect would be the exact failure this engine exists to prevent.

It is runnable at concurrency 1 (sequential sessions are unaffected) at roughly 100× the
wall clock, or after B-12 is understood. That is a call worth making with the owner rather
than for them.

Docs: gaps **A-3** concurrency bullet closed, **B-12** opened.

Gate: lint clean · boundaries clean (107 modules / 418 deps) · **1203 tests at 100%**
lines/statements/functions · e2e **30/30**.

## B-12 · FIXED — and it was the most consequential defect yet

Not a concurrency bug. A residential vendor's username is a `-`-delimited parameter list, so
**a hyphenated session id is silently truncated at its first hyphen.** geoqa's id was
`<market>-<epochMs>`, so the effective sticky key was just `<market>`:

```
session-oslo-1 → 188.92.250.221     session-oslo1 → 84.210.158.133
session-oslo-2 → 188.92.250.221     session-oslo2 → 84.209.67.194
session-oslo-3 → 188.92.250.221     session-oslo3 → 212.89.117.129
session-oslo   → 188.92.250.221  ← the truncated value
```

**Every run in a market had always used the same exit IP** — sequential as well as
concurrent, across separate processes. The engine claimed a per-session network identity it
never had, and nothing contradicted it: `egressHeld` compares a run's opening and closing IP,
which genuinely matched, because it was the same address every time.

Fixed with a base-36 alphanumeric id plus hyphen-stripping in the substitution itself, so an
injected id or a hyphenated market id cannot reintroduce it. Verified: three concurrent Oslo
sessions → three distinct Oslo IPs.

The step that broke it open was noticing **every market has exactly two profiles**, so "same
market shares" and "adjacent launches share" were indistinguishable in my data. Four
concurrent runs across four different markets (4 distinct IPs) versus three across one market
(1 IP) separated them; three SEQUENTIAL same-market runs also sharing then removed concurrency
entirely.

**Invalidates** any earlier claim about per-session rotation *within* a market, including the
"5 sessions → 5 IPs" note, unless that used a hyphen-free key. Between-market rotation was
never affected. Not having run the 100-session milestone is now clearly right rather than
cautious.

## Slice 13 · The keyword agent, generalised — DONE

Copied in from `xala-agent-fleet` and stripped of everything company-specific. What arrived
was ~60 hardcoded Norwegian phrases in a TypeScript array and an intent taxonomy whose
values were **one tenant's market segments** (`municipal`, `private`, with a comment about
kommune framing). None of that survives into the engine:

- Seed terms, audiences and per-term markets are **tenant data** (`tenants/<id>/keywords.yaml`).
- `intent` is a generic five-value vocabulary — properties of a QUERY, not of a market.
- `audience` is free text the engine carries through and never interprets. That is where
  "municipal" and "private" belong; a tenant selling to hospitals would have had to pick
  the wrong intent.

**Agents produce, geoqa verifies.** This module measures nothing itself — it asks the SERP
and the answer comes from `search/`, with the same three states as every other reading.

Three refusals, all before spending a credit: an unusable provider refuses the run (else an
exhausted account yields N unmeasured rows that read like a tenant nobody can find); a run
exceeding the budget or remaining quota is refused with the number it would have spent; and
a duplicate seed is refused rather than de-duplicated, because each query is a real credit.

`meanScore` averages the **measured** rows only. Averaging in the failures would let a
broken account read as poor visibility.

### Live, 8 real queries

```
absent      oslo   leie lokaler                  booking.oslo.kommune.no
absent      oslo   leie selskapslokaler          selskapslokaler.no
#7          oslo   booking av idrettshall        www.bookup.no
#3          oslo   kommunale lokaler             booking.oslo.kommune.no
#2          oslo   bookingsystem kommune         www.multisoft.se
absent      oslo   utleiesystem                  infobric.com
#4          oslo   hva koster det å leie lokale  eventum.no
#1          oslo   digilist                      digilist.no
mean visibility 56 over the measured queries
```

The `tromso` warning fired correctly — that term names a market this tenant does not
declare, and it was skipped and said so rather than silently dropped.

Also fixed on the way: `keywordsResearch` was declared as returning a promise while throwing
synchronously, so a caller using `.catch()` would have got an uncaught exception. The
refusals are the whole value of the function, so they must arrive the way a caller waits for
them.

Docs: PRD **R-137 … R-140**.

Gate: lint clean · boundaries clean (111 modules / 441 deps) · **1228 tests at 100%**
lines/statements/functions · e2e **30/30**.

## Slice 14 · The publish gate — DONE, and the slice was deliberately narrowed

The slice said "copy the content agent". **Generation does not come here, and that is the
point rather than a shortcut.** The division the whole loop rests on is *agents produce,
geoqa verifies* — so putting a content generator inside the verifier would collapse exactly
the separation it exists to enforce. The first time an LLM in this repo wrote a page that
this repo then approved, the approval would be worth nothing.

Publishing stays in `agent-fleet` for a plainer reason: it is OAuth tokens, LinkedIn and X
API calls and blog markdown writes. None of that is geographic QA.

What geoqa owes the pipeline is a verdict it cannot argue with, and that is what landed.

**Three states, and the middle one is where gates usually go wrong:**

```
allow    measured, and clean by the declared thresholds
block    the page has a problem we MEASURED        → fix the page
unknown  we could NOT measure — a geoqa defect     → fix the instrumentation
```

`unknown` still prevents publishing. It is a different SENTENCE from `block`, not a different
outcome: telling an author their page is broken when the truth is that our browser could not
read it wastes their time and costs the gate its credibility.

**Default deny throughout.** No run, a thrown error, an errored run, one unread step — every
one blocks, and `gateExitCode` returns 0 only for `allow`. The one way this could have gone
wrong is a publisher wrapping the call in a try/catch and treating an exception as
permission, so a throw becomes `unknown` rather than propagating.

Verified live against the fixture server, all three states:

```
ALLOW   — measured clean: verdict PASS, overall confidence 100
BLOCK   — blocked by 1 measured problem(s) at severity high or above
          ✗ [critical] has a primary heading — expected h1 is visible, observed not visible
UNKNOWN — cannot decide: 1 step(s) could not be read — this is a geoqa defect, not a
          problem with the page
```

Lower-severity findings are recorded as warnings rather than discarded, so the floor stays
visible to whoever set it, and `actionableFindings` hands a producer the structured findings
worst-first while excluding instrumentation ones — a producer cannot fix our browser.

Docs: PRD **R-141 … R-143**.

Gate: lint clean · boundaries clean (113 modules / 447 deps) · **1248 tests at 100%**
lines/statements/functions · e2e **30/30**.

## Slice 15 · Site analysis across markets — DONE, with an honest hole named

The slice named thin pages, orphans, soft 404s and near-duplicate cannibalisation. I checked
what the evidence actually carries before writing anything: **a run stores verdicts,
findings, vitals, geography and confidence, and nothing else.** The journey's `getText`
result is compared by a check and discarded; `selector-count-min` counts links without
recording their targets.

So three of those four **cannot be computed**, and they are not approximated. A thin-page
report built on a guess about page length is worse than no thin-page report, because somebody
would rewrite a page over it. Recorded as **A-9** with the exact evidence change that would
close each one — a small additive artifact, not a new subsystem. (Soft 404s are largely
expressible with existing checks, which is how `/en/blog` was caught.)

**What IS built is the half no other tool has**, because no other tool measures from inside
the market. Verified live over a real 2-page × 3-market matrix through Decodo:

```
2 page(s) across 3 market(s): berlin, bodo, oslo
  widest latency gaps between markets — a crawler from one datacentre sees none of this:
    https://digilist.no/faq:    TTFB 467ms in berlin vs 596ms in bodo — 1.3x
    https://digilist.no/priser: TTFB 541ms in oslo   vs 662ms in bodo — 1.2x
```

Three outputs: **verdict divergence** (one URL, one set of HTML, different outcomes — exits
1 so a scheduled check need not read the output), **latency spread** with the factor, and
**coverage gaps**, because a page nobody measured in Bodø is not a page that works in Bodø.

`ERROR` runs are excluded from every comparison and counted in a warning instead — including
them would make our own instrumentation failure look like a market where the site behaves
differently.

Two smaller properties worth keeping: a spread is `null` rather than `0` with fewer than two
readings, and a market's figure is the MEDIAN across repeats rather than the latest, because
a single slow run is noise and "latest" means whichever finished last.

Also fixed: TTFB printed as `467.19999998807907ms`. Sub-millisecond precision in a network
measurement is noise dressed as rigour, and it makes a report look like nobody read it.

Docs: gaps **A-9** opened with its closing conditions, **A-10** closed; PRD **R-144 … R-146**.

Gate: lint clean · boundaries clean (115 modules / 452 deps) · **1269 tests at 100%**
lines/statements/functions · e2e **30/30**.

## Next

Slices 16–19, the frontend. Slice 16 was an approval gate on React vs Electron; the criterion
recorded in `task.md` is whether it needs filesystem access beyond a served directory, and it
does not — evidence is files under a root, and a static app can read them over HTTP. React,
and the reasoning goes in the commit. The milestone is unblocked and
worth running now that per-session identity actually works. Then slices 13–15 (the agents, generalised) and
16–19 (frontend), neither of which depends on it.

## Earlier plan for slices 10–12 (search intelligence)

A-2 Serper with a REAL `health()`; wire `searchObservation` three-state; then run EXP-007
and the 100-session milestone. Read the DataForSEO warning in `network/types.ts` first —
a credentials-present check let a zero-balance account pass for weeks, and that account is
still overdrawn.
