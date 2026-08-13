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

## Next: slice 2d

J06, manual language override: Oslo IP → Norwegian homepage → select English →
navigate internally → English persists. Expressible with existing steps plus
`storageState` for the returning half.
