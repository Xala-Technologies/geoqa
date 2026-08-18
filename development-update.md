# Development update

A running record of what has shipped and what it means, newest first. Written for
someone who was not in the room.

This is deliberately **not** a changelog. A changelog says what changed; this says
what is now *true of the system* that was not true before, and — because several
entries exist only because a defect was found — what the system used to get wrong.
Where a change closed a known gap, the gap's id is named so
[`docs/gaps.md`](docs/gaps.md) and this file cannot drift apart.

Three companion documents, each answering a different question:

| Document | Question |
|---|---|
| [`docs/gaps.md`](docs/gaps.md) | what is *not* built, unproven, or defective |
| [`docs/prd.md`](docs/prd.md) | what the system is *required* to do |
| [`docs/milestone.md`](docs/milestone.md) | what the live measurements actually say |

---

## 2026-08-19 — Production login via AgentMail

A real email login on `dashboard.digilist.no` is now a sidecar cell, not a
fourth URL in the 102-cell pulse. `login-reachable` opens the form and
stops. `login` requests a code, polls `digilist-e2e@agentmail.to`, types
`#otp`, and never writes the digits to evidence. The pulse stays
`allowWrites: false`; extras may write without flipping that flag.

`AGENTMAIL_API_KEY` and `GEOQA_LOGIN_EMAIL` come from the environment
only. Demo emails / `123456` stay unused — that path is production-blocked.

Where: `mail/`, `journeys` `receive-otp`, `inputs/tenants/digilist/journeys/login*.yaml`, `watch.extras`.

---

## 2026-08-19 — Watch pulse is 180 minutes

The Norway desktop pulse is every 180 minutes, not 90. Same 102 cells
(34 cities × 3 sites × desktop × one seeded journey), now 8 sweeps/day
→ 816 runs and ~24 GB/month. The clock file was left alone, so the
in-flight sweep keeps its start time and the next tick is
`lastStarted + 180m`. `watch.yaml` is deploy-excluded, so the VPS copy
was written directly.

Where: `inputs/tenants/digilist/watch.yaml`.

---

## 2026-08-19 — Repair always starts from origin

A repair clones the site repo, then `git fetch origin <base>` and
checks out `origin/<base>` before Claude runs. After the commit it
fetches again and rebases, so a 20-minute edit does not open a PR
against yesterday's tip. `git` talks to GitHub through `gh auth
git-credential` — `GH_TOKEN` is enough for `gh clone` and was being
ignored by `git push`, which is why four local commits never became PRs.

Where: `packages/engine/src/assist/repair.ts`.

---

## 2026-08-18 — Fix from the Findings page

`#/findings` has a Fix button (and a per-row Fix). It starts the same
Claude repair the sweep does, without waiting for the next pulse. Tickets
with a PR are counted as Fixed and struck out. The dashboard rebuilds
after each successful PR so the strike-through appears while the rest
are still running.

Where: `server/repair-control.ts`, `apps/ui/src/views/Findings.tsx`.

---

## 2026-08-18 — The Findings page is the ticket board

`#/findings` is the same grouping as GitHub: one row per check × host,
with the issue and the PR as `Measured` values. Not filed is an
absence, not a blank. `dashboard build` reads `filed-issues.json` and
`repaired-issues.json`, and a file or repair rebuilds the dashboard so
the console does not stay on yesterday's tickets.

Where: `report/tickets.ts`, `report/view.ts`, `apps/ui/src/views/Findings.tsx`.

---

## 2026-08-18 — Findings tag the site and open a PR

A finding now carries `site:<host>` so the GitHub filter is the page the
visitor saw. Tenant `repositories:` send a site check to that host's
repo — [booking-brilliance](https://github.com/Xala-Technologies/booking-brilliance)
for digilist.no, [Digilist](https://github.com/Xala-Technologies/Digilist)
for app.digilist.no (PRs from `dev`), [xala-web-cloner](https://github.com/xalatechnologies/xala-web-cloner)
for xala.no. Instrumentation stays on geoqa.

After a new issue is filed, `geoqa findings repair` clones the
destination, runs `claude -p` on the operator Max login, and opens a PR
with auto-merge asked for. Already-repaired keys live in
`repaired-issues.json`. A missing token still does not fail a sweep.

Where: `findings/tickets.ts`, `findings/repos.ts`, `findings/github.ts`,
`assist/repair.ts`, `cli/commands.ts` (`findingsRepair`),
`server/watch-loop.ts`, `inputs/tenants/digilist.yaml`.

---

## 2026-08-18 — The watch files its own GitHub issues

Findings are no longer a page you have to remember to read. After a
sweep the watch groups the run index and opens GitHub issues:
instrumentation, a hung navigate, and a Decodo city miss get `urgent`;
a site check is one issue per host, not one per city. Already-filed
keys live in `filed-issues.json` under the tenant evidence root, so a
second sweep does not open the same ticket again.

`geoqa findings file --dry-run` prints the drafts. Token and repo come
from `GEOQA_GITHUB_TOKEN` and `GEOQA_GITHUB_REPO` only — a missing
token is not a failed sweep.

Where: `findings/tickets.ts`, `findings/github.ts`, `cli/commands.ts`
(`findingsFile`), `server/watch-loop.ts`.

---

## 2026-08-18 — The watch reports its own failures

Live looking busy is not the same as a sweep that is moving. Chromium
dropping proxy credentials left two sessions on "preparing" until the
command timeout, and the only record was journalctl. The watch now
assesses itself every tick: a session with no step, frame or phase
change for 90 seconds is `stalled`; a sweep in flight with an empty
board is `hung`; a throw is `failed`. Those findings go to
`watch-log.jsonl` under the tenant evidence root — newest 400 lines,
survives a restart — and to Watch and Live as a health reading.

`GET /api/watch` carries `health` and `log`. `GET /api/watch/log` is
the same ring for a machine client. `/health` stays `{ok:true}` so
Caddy does not take the console down when a browser hangs.

Where: `watch/health.ts`, `watch/log.ts`, `server/watch-loop.ts`,
Watch and Live in `apps/ui`.

---

## 2026-08-18 — The VPS ships from a GitHub Action

The console on `geoqa.srv1212925.hstgr.cloud` can be updated without SSHing
from a laptop. `.github/workflows/deploy.yml` rsyncs the tree to `/opt/geoqa`
and runs `infra/remote-release.sh` (install, UI build, systemd, `/health`).
It is `workflow_dispatch` only so a commit of the workflow cannot overwrite
machine-local watch state or inputs that are not on `main` yet.

`.env`, `geoqa.config.json`, `var/`, and every `watch.yaml` are excluded.
Credentials stay in GitHub secrets (`DEPLOY_KEY` is an ed25519 key on the
box, not the VPS password).

Where: `.github/workflows/deploy.yml`, `infra/remote-release.sh`,
`infra/geoqa.service`, `infra/geoqa-bridge.service`.

---

## 2026-08-18 — Periodic watch draws one seeded journey per city × URL

A periodic sweep used to launch every ticked journey on every cell. Five
read-only journeys × 26 cities × 2 URLs is 260 residential sessions an
hour. The VPS pulse is 52: one journey per cell, drawn from the read-only
pool (`landing-page`, `browse`, `search`, `reader`, `returning-visitor`).

The draw is `seedFrom(UTC-hour + market + url)` over the sorted pool — the
same hasher the journey harness already uses. Same hour, same city, same
URL, same journey. Device is not in the seed, so a two-device watch still
does one journey per city × URL. `Math.random` is refused: an unseeded
pick cannot answer "why did Oslo get search at 14:00?"

`journeyPick: all | seeded` on the watch spec, default `all`, so an old
file still means the cartesian product. Continuous still walks a cursor
and ignores the flag. Digilist's `watch.yaml` is the hourly pulse
(26 cities, mobile, two URLs, seeded, writes off) and stays disarmed
until Decodo and the quota are ready. `contact-form` and `explore` are
off the list.

Where: `watch/journey-pick.ts`, `watch/spec.ts`, `server/watch-loop.ts`,
`inputs/tenants/digilist/watch.yaml`, Watch view.

---

## 2026-08-15 — The console can arm a watch, and you can see the session while it runs

The matrix used to start when a human typed `geoqa matrix run`. That is still
true, and it is no longer the only way. `geoqa server` now ticks a watch file
and launches the same `matrixRun` the CLI uses — periodic (from the last start)
or continuous (from the last finish). Each sweep mints a new run id, which
becomes a new proxy session id, so the residential pool hands back a different
exit. That is the rotation. There is no second provider.

The operator surface is a new Watch view, not an editable Settings page.
Settings stays a readout of the files the engine already reads. Watch writes
`tenants/<id>/watch.yaml`, so the tenant file's comments survive and the
allowlist the operator typed is the one the sweep hits. Brand URLs
(`app.digilist.no`, `dev.digilist.no`, `xala.no`) are added there. A writes
journey still needs an explicit allow.

Live is a screening feed, not a remote control. While a session is in flight
the console shows the market, the URL, the current step, and the latest
frame. You watch it. You do not drive it — an operator in the middle of a
seeded journey would make the evidence unreproducible.

Fourteen Norwegian cities joined the matrix as profile pairs (Drammen,
Fredrikstad, Sandnes, Skien, Tønsberg, Haugesund, Sandefjord, Lillehammer,
Hamar, Molde, Harstad, Alta, Narvik, Kongsberg), each with a unique header
comment. Digilist's tenant now lists every Norwegian market we have a
profile for; the default watch starts with five of them, paused, so opening
the server does not spend the proxy allowance until somebody arms it.

`geoqa run` is the control-plane entry an external console can spawn. It is
`journeyRun` with a JSONL stream — `observedIp`, `liveUrl`
(`http://127.0.0.1:4848` on agent-browser), `confidence` — not a second
browser stack. `--locale` / `--timezone` must match the profile.
`--rotate-ip` and `--evidence` cannot be turned off. Continuous watch now
walks a cursor (`maxConcurrent`, default 2) instead of launching the
cartesian product every tick. Svolvær joined the Norwegian set.

The clock itself is now a file under the evidence root, not a pair of
in-memory numbers. A restarted server that used to look like a first sweep
(and fire immediately if armed) now waits out the remaining interval. The
live board carries the scenario the planner already knew — market, device,
journey, URL — instead of guessing them from the run id. Watch checkboxes
are the tenant's markets that have a profile, not every city on disk.
`--help` documents `geoqa server`.

Closes the clock half of [A-3](docs/gaps.md#a-3--the-matrix-runs-in-process-now-nothing-schedules-it-and-the-bound-is-a-guess).
Residue: no Temporal cron, and a process that dies mid-sweep loses the live
board (the evidence packages remain).

## 2026-08-14 — The console could not load through the server it ships with

[PR #38](https://github.com/Xala-Technologies/geoqa/pull/38). Served through `geoqa server`,
the dashboard was a **blank white page** — not a missing feature, the app could not boot, and
had not been able to since the server was added. Found by opening it in a browser. Every
router test passed the whole time.

### What was wrong

The router authenticated **every** path, so `/assets/index-*.js` and the stylesheet redirected
to `/login` like any other document. The JS request followed the redirect, received
`index.html`, reported **200**, and failed to execute as a module. Nothing was logged: from
the browser's point of view every request had succeeded.

Underneath sat a circle nobody could have clicked out of — `/login` serves the app shell, the
login form lives inside the bundle, and the bundle was behind the session the form exists to
obtain. **Adding a login screen alone would not have fixed it.**

And `/dashboard.json` had no route at all. The asset reader is rooted at the UI bundle; the
dashboard is written into the evidence tree. Even with a valid session it would have 404ed.

### Why the tests did not see it

Each router test asserted on a path in isolation. None asserted that the application could
*start*. `router.ts` was at 100% coverage before the fix and is at 100% after it — the number
was never the problem. The test this change replaced asserted the redirect, with a comment
explaining why redirecting was friendlier than a 401. The reasoning was sound and the
conclusion was wrong, because it never accounted for what `/login` would then need to load.

### The line that moved

**The UI root is public; everything carrying a reading is not.** The bundle is the same bytes
for every visitor and names no tenant, run or credential. That makes it a rule about the
directory rather than about the router — nothing may be placed in the UI root that is not
meant for every browser that asks — and it is build output, so that was already true.

`/dashboard.json` now has a route: evidence tree, behind the session, `no-store`, read per
request because `dashboard build` runs while the server does. **401 rather than a redirect** —
it is fetched by script, and a 302 to a page hands the caller HTML with a 200 attached, which
is precisely the failure above.

### What the console gained

A sign-in screen. An `api.ts` whose result type has **three** cases — a value, a sign-in
prompt, a real failure — because "not signed in" is the ordinary state of a freshly opened
browser and rendering it as an error would be both wrong and alarming. That is the same
three-valued discipline the engine applies to every reading. A settings view over the existing
`/api/settings`: tenants, domains, quotas, journeys, and credentials as **set** or **not set**,
with no credential value sent because none is ever read (R-26).

Static hosting still works unchanged — the app makes one request and lets the answer tell it
which mode it is in.

The console now has its own gate: 14 tests at 100% on `api.ts`, the module that makes
decisions, rather than a percentage over a directory of markup. CI runs it and the console
build, because a UI that does not compile is a server serving a stale bundle — which is how a
fixed bug appears to still be there, and a stale bundle is what started this investigation.

### One I got wrong on the way

That gate first reported 95% branches, blaming a phantom on a bare
`export async function getJson<T>(` line. I called it a source-map artifact, wrote a comment
explaining that, and lowered the threshold to match. It was not: `@vitest/coverage-v8` was a
major version behind the `vitest` running it, which prints a quiet "make sure the versions
match" and then miscounts. I had read past that line. Matching the versions gave a true 100%.

**I wrote a plausible explanation for an inconvenient measurement and then changed the gate to
agree with it.** The comment made it look considered. Recorded here because the next phantom
branch should send someone to check versions, not to write prose.

---

## 2026-08-14 — Branch coverage found dead code, and one comment that argued for it

Two merged PRs ([#33](https://github.com/Xala-Technologies/geoqa/pull/33),
[#34](https://github.com/Xala-Technologies/geoqa/pull/34)). Branch coverage went
**96.62% → 97.40%** and the ratchet moved with it, but the number is not the result. What
the number *found* is the result.

### Some of what was "uncovered" was unreachable

`opportunities()` and `meanScore` both wrote `?? 0` against a field the preceding filter had
already proved non-null. One carried a comment stating the fallback was reachable. It was
not — `observeSearch` returns a null `examined` only where it also returns a null `score`,
and both callers filter on `score !== null` first. I had already tried to delete that
fallback once, seen TypeScript reject it, and concluded the branch was live. The type is
wide; the value never is.

A comment asserting the opposite of the truth is worse than no comment, because the next
person to change that sort will believe it. Both sites now share one `isMeasured` type guard
that narrows `score` and `examined` together and states the coupling once. The rule it
protects is the one the whole console rests on: **a keyword nobody could search for must not
average in as a score of zero, and must not sort above one that was genuinely measured.**

### Ten copies of one idea became one tested function

`e instanceof Error ? e.message : String(e)` appeared ten times in ten files. It is now
`describeThrown` in `src/errors.ts` — zero imports, so `browser/` and the Temporal workflow
sandbox can both use it. Consolidating fixed two things every copy had wrong:

- `String(undefined)` is `"undefined"` — correct, and indistinguishable from a real message
  that says so. `could not append to the run index: undefined` sends a reader after the
  reporter instead of the disk. Both null-ish cases are now named.
- `String(value)` can itself throw. This runs *inside catch blocks*, so a reporter that
  fails while reporting turns a diagnosable problem into an undiagnosable one.

Five copies of `deps.historyFs ?? nodeHistoryFs` became one for the same reason: five copies
is five chances for one subcommand to read a different tree from the `runs rebuild` that
filled it, and that presents as data loss.

### Newly asserted behaviour

A thrown string from a history append or rebuild read. A vendor sub-account row whose
`status` is not a string, which would otherwise render `[object Object]` as an account state.
A step `probability` outside 0..1, rejected at the envelope before its action is considered.
A median over an even number of runs — where picking one of the middle pair makes the
reported centre depend on sort stability. A gate that returns **`unknown`**, not allow, when
the run throws.

### Three of my own mistakes, kept in the record

- Two tests asserted things that were not true: that an empty page of search results leaves
  a keyword unmeasured (it scores as **absent** — a reading, and an actionable one), and that
  a failed query sorts last in the opportunity list (it is excluded entirely, which is
  better). The code was right both times.
- A blanket find-and-replace rewrote the new `historyFsOf` helper into a call to itself. It
  **type-checks perfectly** and would have infinitely recursed on the first `runs list`. No
  gate caught it; reading the diff did.
- A test used `as GateCheckResult` to skip filling in two required fields. Removing the cast
  revealed it asserted on gate decisions `"pass"` and `"fail"` — which do not exist; the real
  ones are allow/block/unknown. The cast would have shipped a test that could never fail.

The through-line, and the same one as the `$`-in-the-password-hash incident earlier this
week: **100% line coverage says every line ran, not that every line does something.** The
branch ratchet is the part that finds dead code. A type assertion in a test is a request for
the compiler to stop checking the thing the test exists to check.

---

## 2026-08-14 — The coverage sweep found a live geographic bug

Branch coverage was never enforced — the gate had lines, statements and functions at 100 and
no `branches` entry at all, so "100% coverage" was true of three metrics and quietly untrue
of the fourth: **95.25% across 167 sites, none of which ever failed a build.**

Closing them is producing findings rather than tests, which is why it is worth doing by hand.

### A truncated coordinate placed an exit on the prime meridian (C-20)

`Number("")` is **0**, not `NaN`. So `parseLoc("59.9139,")` — a latitude with the longitude
truncated — passed every guard: 0 is finite, and `|0| <= 180`. It returned `[59.9139, 0]`, a
point in the North Sea about 600km west of Oslo.

Those coordinates decide the **city verdict by distance**, so a vendor sending a truncated
field would have produced a proven city MISMATCH against a correctly-routed exit.

The function's own comment described this exact hazard — *"`Number("")` is 0 … the prime
meridian, which is a confident wrong answer of exactly the kind a distance check must not
produce"* — and the guard was never added. Reading the code agreed with itself; writing a
case per guard did not.

### What else the sweep turned up

- a **duplicate guard** in `executeRun`, unreachable because `loadInputs` already threw
- a **fixture drifted from the profiles**: every test in the suite carried a device mismatch
  after the mobile profiles gained a real user agent, so `trustworthy` was false everywhere
- **no test of a fully-verified run**, because the default fixture is faithful to a case where
  one axis is genuinely unprovable
- **`browser verify` never tested for reporting a failure** — the command's entire purpose
- a `?? 0` that would have **scored a confidence axis at zero**, producing a figure computed
  from part of its evidence

Roughly half the branches are being **deleted** rather than tested, which is what this
codebase's own doctrine predicts: a guard with no reachable failure is a claim that the check
above it might not hold.

**95.25% → 96.62%**, ratcheted so it can only improve.

---

## 2026-08-13 — The console answers "what should I fix" now

The dashboard could count problems and could not name one. `RunRecord` has always kept the
LABELS of the checks that produced a finding — the one piece of per-finding detail the run
index keeps, because it is what makes regression detection possible — and `toRunView` threw
them away. So the UI showed `2 findings` and nothing about *which* check, *where*, or *how
often*.

### Findings — the page a QA product exists to have

Aggregated by the check that produced them, because that is the unit somebody fixes.
Against 32 real runs it says, immediately:

| Check | Rate | Meaning |
|---|---|---|
| `has a search box` | **100%** | fails every run of its journey — a standing defect |
| `type the query` | **100%** | the cascade from it |
| `page carries the market's language marker` | 50% | intermittent |

Seven distinct problems, three that always fail, four intermittent. The rate's denominator
is runs of the **same journey** — a check that only exists in `search` did not "fail 4 of 32
times", it failed 4 of the 4 times it ran, which is a different claim and the one a reader
would act on.

### Run detail — every run is addressable

`#/run/<id>`, linked from every row in every table. Every confidence axis rather than the
overall, both geography axes with **requested beside observed**, the failing checks with
whether they failed elsewhere, and a copy-pasteable command with the seed: a run that
cannot be repeated is a claim rather than a measurement.

The overall confidence figure now names the axis that capped it. A run at 39 is not "39%
good" — it is one axis at 0 dragging four at 100, and printing the number without the rule
leaves most readers assuming an average.

### Interaction

Rows navigate. Columns sort. **Absences sort last in both directions** — ordering an
unmeasured LCP as `0` would put every run the engine could not read at the top of
"fastest", which is the conflation this whole system refuses, at the exact moment somebody
is looking for the fastest page.

### A React bug the testing caught

Sorting descending worked; clicking the same column again did nothing. `Th` was defined
*inside* the render function, so React saw a new component type every render and remounted
the header — the second click landed on a node that had already been replaced. A component
defined during render is one that cannot hold state or receive a second event.

---

## 2026-08-13 — The dashboard became an application, and running it found a bug

Asked to run the app, I did — against 32 real runs across `xala.no` and `digilist.no` —
and it immediately showed something no unit test could.

### The dashboard computed coverage gaps and rendered none of them (C-19)

`analyseSite` has computed `coverageGaps` since it was written, with a comment saying
exactly why: *a page nobody measured in Bodø is not a page that works in Bodø, and a
report that silently omitted it would read as full coverage.*

`App.tsx` rendered `regressions`, `geographicallyDivergent`, `trends` and
`widestLatencyGaps` — and not that one. **Both live sites had never been measured in
`porsgrunn`, and the dashboard showed a clean bill of health.** The field written to
prevent exactly that outcome was the field being dropped.

Every unit test passed, because each asserted what the component does.

### And it is a real application now

Five routed views behind a fixed chassis — header carrying the three global truths, left
rail for wayfinding with counts that mean *somebody has to look at this*:

- **Overview** — gauges, a verdict split encoded as form as well as number, and a "needs
  attention" list ranked by how badly a reader would be misled by missing it
- **Runs** — filterable by market, journey, verdict and free text
- **Geography** — divergence and the latency spread, with per-market bars
- **Coverage** — the page × market matrix that fixes C-19
- **Trends** — every series including the ones that did not qualify for a direction

Designed as an *instrument* rather than a dashboard, because that is what the product is:
the reading is the brightest thing on the panel, and `--void` — which carries ERROR,
`unverified` and "not measured" alike — is deliberately the dimmest colour in the palette.
Our blindness must never out-shout a measurement.

Three signals separate a reading from an absence: colour, slant and a dotted underline.
Each survives a different degradation — colour fails a colourblind reader, slant survives
greyscale, the underline survives both.

The trend trace draws a gap as a hollow slot rather than closing over it or drawing it at
zero, which would fabricate exactly the thing the reader came to look at.

---

## 2026-08-13 — A durable run was split across four browsers, and its evidence described none of them

Last entry ended with *"no durable sweep has run against a real browser and a real site."*
So I wrote that test. It found this within minutes.

`playwrightOpener` launches a **new browser on every use**, and the workflow built one
runtime per activity — so geo verification, the journey, the egress check and evidence
collection each got a *different* browser. Measured against a real Chromium:

| Reading | Durable (before) | Local | Why |
|---|---|---|---|
| `egressHeld` | `unverified` | `match` | the closing probe ran in a context that never visited the site |
| `vitals.lcp` | **null** | a real number | evidence was collected from a blank context |

The second is the serious one. **A durable run wrote an evidence package describing a
browser that had never been anywhere — and reported `PASS` while doing it.** That is the
exact shape of claim this engine exists to refuse, produced by the engine itself.

### The cause was a comment, and it was accurate when written

`activities.ts` said: *rebuilding the runtime per activity is not a workaround, it is the
correct model here — agent-browser is a daemon, so the browser survives between activities
and is addressed by its launch flags rather than held as a handle.*

True of agent-browser. **False of Playwright**, which launches a browser per opener call.
The browser seam makes the two look identical from above — that is its entire purpose — so
a fact about one engine was recorded as a fact about the model, and the engine it was
false for is the one that serves every experiment.

### Closed by making the run one activity, and that activity is `executeRun`

Not a re-sequencing of it: the same function the CLI calls. This also makes yesterday's
six-way drift structurally impossible — there is no second copy of the run left to
diverge. The six retired activities were **deleted** rather than left exported, because
re-wiring them would rebuild the defect.

The cost is per-step retry granularity: a flaky geo read used to retry alone and now
restarts the run. That granularity was never sound — a retried step ran in a fresh
browser, which *is* this defect — so what looked like fine-grained durability was
fine-grained incorrectness.

### What this says about the last two days

Neither a unit test nor the structural parity guard could see this. The guard compares
which *functions* each mode calls, and both called the same ones; what differed was what
the runtime handed to them had **seen**.

Every finding today came from something written down — a stale comment, a stale default, a
constraint that outlived its evidence. This one came from a *test that did not exist*, and
the sentence that prompted writing it was one I had written the entry before, admitting
what was unproven.

---

## 2026-08-13 — The durable path was doing six fewer things, and one of them was my fault

Closing D-2 made a durable run startable for the first time. The immediate next question
was what it actually *does* — and diffing `executeRun` against `geoQaRunWorkflow` found
**six** divergences. Two were recorded. **Four were not.**

| Behaviour | Local | Durable (before) | Consequence |
|---|---|---|---|
| journey `--repeat` and merge | ✓ | ✗ | every durable finding `observed`; `reproduced` unreachable |
| provider cooldown **write** | ✓ | ✗ | a vendor that failed a durable sweep was never frozen |
| **egress-held check** | ✓ | ✗ | a durable run never verified *one journey is one network session* |
| **visitor state recorded** | ✓ | ✗ | evidence said `returning` whether or not a session was restored |
| **history append** | ✓ | ✗ | durable runs invisible to `geoqa runs`, trends, regressions |
| **unlisted HAR pruned** | ✓ | ✗ | a passing durable run leaked a full network recording |

The egress one matters most on its own: a rotating exit mid-run was invisible, so the
durable path reported a clean verdict for observations it could not attribute to the
site — the exact failure this engine exists to refuse.

### The last row was introduced by this morning's fix

The B-3 work added `pruneUnlistedHar` to `executeRun`'s teardown and **not** to
`closeSession`. Nothing caught it, because nothing could start a durable run — so the
omission was never executed.

That is the whole mechanism: **a mode nobody can run is a mode nobody can notice is
wrong**, and every improvement to the other one quietly widens the gap. Six behaviours
had accumulated that way since Phase 0.

### Closed by removing the copies, not by adding six more

`repeatJourney` and `closeEgress` moved into `run/stages.ts` and **both** modes call
them — the repeat loop and the egress fold had been written longhand in `executeRun` and
hand-mirrored, badly, on the durable side. The activities are thin wrappers again, which
is what their coverage exclusion has always claimed.

### And a guard, because a behavioural test cannot catch this class

Both modes pass their own tests *precisely because* each is asserted against what it
does. So the guard is structural: `parity.test.ts` names the shared functions and
requires both callers to reach them, and asserts neither mode re-implements the merge. A
seventh behaviour added to one side now fails there rather than in somebody's overnight
sweep.

**Still not proven:** no durable sweep has run against a real browser and a real site.
The parity is structural and unit-level.

---

## 2026-08-13 — The durable path can finally be started, and refuses to pretend

`geoQaRunWorkflow` and `geoQaMatrixWorkflow` had been written and tested since Phase 0,
and `worker.ts` could poll for them — but **nothing ever constructed a Temporal client**.
The durable execution mode was reachable only by writing one by hand, which meant it was
reachable by nobody.

`geoqa matrix run --durable` now starts the sweep as a workflow and renders the result
through the **same `MatrixResult` shape** the in-process path uses, so a reader cannot
tell the modes apart. That is the point of offering both — and it is also exactly what
makes the next rule necessary.

### A durable run that cannot reach Temporal FAILS

It never falls back to running locally. Because the two modes produce identical output, a
silent fallback would report a durable sweep with none of the durability: **a lie that
looks exactly like success**, which is the hardest kind to notice. Proven against an
absent server:

```
could not reach Temporal at 127.0.0.1:7233: Failed to connect before the deadline.
A durable run does NOT fall back to the in-process runner — it would report a durable
sweep that never was. Start a server with `temporal server start-dev` and a worker with
`pnpm worker`, or drop --durable to run in this process.
```

### The happy path is proven too, which was not expected to be possible

There is no Temporal CLI on this machine, so the plan was to ship the client as a
dormant seam. But `@temporalio/testing` provides a **real** server — so the test suite
now drives `durableMatrix`, the same function the CLI calls, against a real worker and a
real task queue.

The queue name is the detail that would otherwise have bitten: a client polling a queue
nobody serves does not fail, it waits forever and says nothing.

### Two decisions worth keeping

The connector is injected, and the real one lives in its own file so
`@temporalio/client` stays out of every other caller's import graph while the client
itself stays fully covered — the same split `network/auth-probe.ts` already uses.

The durable path sends **base** specs and lets the `prepare` activity resolve the proxy
inside the workflow, so the exit selection is part of the durable history rather than a
decision this process made and forgot.

### What is NOT proven, said plainly

No durable sweep has run against a real browser and a real site. The client, the queue,
the workflow and the refusal are all exercised; what a full durable run does to the
evidence tree is not.

---

## 2026-08-13 — The durable path stops disagreeing with the local one

The Temporal matrix workflow ran its children **sequentially**, with a comment explaining
why: concurrency was unmeasured (EXP-007), each profile costs its own Chrome process,
and picking a parallelism number before measuring is how the first OOM happens.

All of that was true when it was written. **EXP-007 has since run** — 100% completion,
verdict agreement and egress-held at 2, 4, 8, 12 and 16 — and the in-process runner
adopted `DEFAULT_MATRIX_CONCURRENCY = 4` on the strength of it. The durable path kept
obeying a caution whose reason no longer existed, and would have run a sweep four times
slower than the local one for no stated reason: a divergence discovered as a mystery
rather than read as a decision.

Invariant 12 says *two execution modes, one implementation*. Both now share
`run/pool.ts`, which holds the bound, the resolver and the loop — and **has no imports
at all**. That is the design constraint rather than a tidiness preference: workflow code
runs in a deterministic sandbox and cannot pull in the graph `run/matrix.ts` reaches
through `executeRun`, so the shared part has to be the part that touches nothing.
`runMatrix` lost its hand-rolled worker loop to it.

Two properties are asserted rather than assumed:

- **Concurrency, proven by interleaving** rather than by wall clock — with a bound above
  1 the second child starts before the first finishes, so the activity log is not two
  clean blocks.
- **`concurrency: 1` restores the old sequential shape exactly**, which is what makes the
  bound real rather than decorative. A pool that silently ran everything at once would
  still produce the right results.

The pool returns results in *completion* order and the workflow sorts them back, because
a matrix whose output shuffled by timing would make two identical sweeps look different
and neither of them wrong.

**Still open on the durable path:** nothing constructs a Temporal client, so running the
matrix durably still means writing one by hand. That is what B-4's last residue (the
durable path runs one attempt) and B-1's (it reads cooldowns and never writes one) are
also waiting on — all three want a durable run exercised end to end.

---

## 2026-08-13 — Mobile profiles are finally mobile, and a second false choice dissolves

**C-8 is closed, and like C-15 before it, the entry had framed a choice that was not
real.**

The gap said: mobile profiles are mobile by *viewport only* and present a desktop user
agent, so a site doing server-side device detection serves them the desktop variant.
Closing it meant choosing between emulation — which costs viewport control — and
hand-maintained user-agent strings.

Playwright treats `isMobile`, `hasTouch`, `deviceScaleFactor` and `userAgent` as
**independent** context options, and only `isMobile` introduces the layout viewport.
Measured against a page with no viewport meta tag:

| context | `innerWidth` | `maxTouchPoints` | mobile UA |
|---|---|---|---|
| viewport only (the old state) | 390 | 0 | no |
| **viewport + `userAgent` + `hasTouch`** | **390** | **1** | **yes** |
| full `Pixel 5` descriptor | **980** | 1 | yes |

All eight mobile profiles now declare a mobile identity, and `isMobile` is never set.
Verified from inside a page: `navigator.maxTouchPoints` is 1, `"ontouchstart" in
window` is true, and `matchMedia("(pointer: coarse)")` matches — the three ways a site
actually detects touch — while `window.innerWidth` stays 390. The device axis reports
`match` now rather than `unverified`, because the profile finally makes a claim there
is something to check.

The mobile UA reaches **both** engines — `toSessionConfig` passes it as agent-browser's
`--user-agent`, and that is the half server-side device detection reads. `hasTouch` and
`deviceScaleFactor` are Playwright-only, so on the default engine a mobile profile is
mobile UA, mobile viewport, no touch. Stated in `gaps.md` rather than left to be
discovered.

### Why the user agent is written out

Playwright's own device descriptors keep their Chrome version **in sync with the
shipped browser** — `151.0.7922.34` in both, checked — so deriving the UA from one
would never go stale. It was still the wrong choice.

**A profile is a declaration of a test subject.** One that changed under you with a
dependency upgrade would make yesterday's run and today's run different subjects
wearing the same name — the same reasoning that puts the seed on the `RunSpec`. A real
Android device in the wild lags the newest Chrome anyway, so a pinned version is
arguably the more representative choice as well as the more reproducible one.

### A pattern worth naming

Twice in one day a gap recorded as *needs a decision* dissolved once somebody measured
the thing it assumed. C-15 assumed the attribute check and the copy check were
alternatives; they are separate claims and the journey asserts both. C-8 assumed a
mobile identity required a device descriptor; it required three independent options,
one of which is the one nobody wanted.

Both entries were written carefully and both were wrong in the same way — **a
constraint recorded from reasoning rather than from measurement outlives the reason it
was recorded.**

---

## 2026-08-13 — A language marker read where it lives, and a claim of mine withdrawn

### The localization journey can finally detect what it is named for (C-15)

Its central check read `innerText` and looked for a marker living in `<html lang>`.
`innerText` never returns attributes, so **the check could not pass on any site**,
correctly localised or not.

The gap listed two options — an attribute check, or a marker in visible copy — and they
turned out not to be alternatives. Declaring a language is not writing it, so the
journey now asserts **both**:

| Fixture | `<html lang>` | Prose | Old journey | New journey |
|---|---|---|---|---|
| `/wrong-lang-attr` | `en` | Norwegian | passed | **fails** on the declaration |
| `/wrong-copy` | `nb-NO` | English | passed | **fails** on the copy and the currency |

Plus a control that passes on a page getting both right — without one, a journey that
failed everything would look like it worked.

Read through `evaluate` rather than a new seam primitive: both engines have it, so this
needs no `BrowserRuntime` method and no refusal on the engine that lacks one. `""` is an
*absent* attribute, `null` is *we could not look*, and only the second refuses.

### A claim of mine, withdrawn (C-18)

While building that check I asserted — in `gaps.md`, a journey comment, a schema comment
and two test comments — that **digilist.no serves `<html lang="en">` over Norwegian
prose**. A concrete, named, checkable claim about somebody's live site.

**It is false.** The probe that produced it created a browser context with no `locale`,
so it asked in `en-US`. digilist serves `lang` by `Accept-Language`, and English is the
correct answer to an English request:

| Context locale | `<html lang>` |
|---|---|
| default (`en-US`) | `en` |
| `nb-NO` | `nb-NO` |

Run under the `oslo-desktop` profile, which sets the locale the market implies, the
journey passes. The site is not defective; the measurement was.

**This is the third time this exact mistake has been made** — a localization defect
filed from `curl` output and withdrawn; an `innerText` hypothesis from a read taken
before hydration; now a language claim from a browser that never said what language it
wanted. Every one is the same error: *a measurement taken under conditions that do not
match the claim is not a weaker version of the right answer, it is a confident wrong
one.*

The engine already knows this — it is why profiles carry a locale, why absence is
confirmed before it is reported, and why this project exists rather than trusting a
datacentre crawler. **The instrument built to avoid this mistake does not protect an
investigator who steps outside it.**

The C-15 defect itself was real and independently verified, and the fixtures that prove
it are constructed rather than copied from a real site — and say so.

---

## 2026-08-13 — A real cookie proven to survive, and the last code-closable gap closed

**B-7 is closed, and with it there is no code-closable item left in `docs/gaps.md`.**

The mechanism had been finished for a while — a Playwright context saves its session
before closing, `resolveVisitorState` decides what a run's visitor actually is, and
`run.json` records `{declared, restored, unmet}` so a first-time visit and a returning
one are distinguishable in the evidence. What was missing was proof that a real cookie
survives, and that is **not a claim one run can make about itself**: `storageState` is
written when the browser closes.

So the suite gained the shape it did not have — two runs of one profile:

| Run | Verdict | `run.json` visitor |
|---|---|---|
| first | **FAIL**, correctly — the site has never seen this browser | `restored: false`, `unmet` naming the seeded session |
| second | **PASS** | `restored: true`, `unmet: null` |

Three details carry the proof. The marker is `<p id="visitor">`, not translated copy —
a word like "tilbake" could legitimately appear on a first visit. The cookie is the
**only** difference between the fixture's two branches, both 200 with a heading and
links, so nothing else in the journey can account for a passing second run. And
`Max-Age` is a year rather than a session cookie, because `storageState` persists
cookies with an expiry and drops session ones — a session cookie would have failed at
the wrong layer for the wrong reason.

**Checked by mutation, not only by passing.** Disabling the restore branch makes the
second run fail and the first still pass. That is the shape a real proof has: sensitive
to exactly the mechanism it names. Worth doing because C-6 records that this project's
coverage gate proves *execution*, not *assertion* — and a brand-new test for a
previously-dead path is precisely where that distinction bites.

---

## 2026-08-13 — Fixing what the second site found, and a fourth defect the fix exposed

C-13 and C-14 are closed, and writing the test for them surfaced C-17.

### An empty text read is confirmed, then refused rather than blamed on the page (C-13)

Fixed in **two** places, because one was not enough.

`PlaywrightRuntime.getText` re-reads once after a settle when the first read is empty —
the same shape as `isVisible`, sharing the same budget. **Only the empty read is
retried**: a non-empty read that simply lacks the value is a real reading of a real
page, and re-reading it would be the silent retry this engine refuses everywhere else,
turning an intermittent site defect into a green run.

A settle is not a guarantee, so `assertions.ts` does not treat it as one. Text still
empty afterwards is **unreadable**, never failed — and that closes the same hole on
`text-absent`, where an empty page trivially lacks every string and the check went
green.

Both engines confirm, not just Playwright — agent-browser is the *default*, and
leaving the retry to the other adapter would have given the default the weaker
protection.

Proven three ways: unit tests on both halves, a `/hydrates-late` fixture reproducing
the shape at 300ms, and the live site. **The same journey against the same xala.no
page now reads 6,000 characters and passes**, where an hour earlier it filed a
high-severity defect against a correctly-localised page.

Worth noting: `agent-browser.ts`'s `isVisible` comment *already* names xala.no, whose
`h1` has an entrance fade and read `opacity: 0` for the first second — 4 failures of 4
runs. The same site produced this defect through a second primitive, a month apart. A
page slower than the engine breaks every read the engine does not settle, one at a
time.

### An unfilled `{placeholder}` is our defect, not a verdict (C-14)

`evaluateCheck` now refuses any check whose value still carries a `{word}`, and names
the missing variable: *"the journey variable {forbiddenCurrency} was never supplied …
pass --var forbiddenCurrency=<value>"*. A value that merely contains braces — a JSON
blob, a template literal in copy — is not caught by accident.

Live, the same journey went from **one false FAIL plus one silent green PASS** to two
named refusals telling the operator exactly what to pass.

### An errored step was filed under the category the journey declared (C-17)

Found by writing the e2e assertion for C-13 — it stated the intended rule and failed.

`categoryFor` read the step's declared category *before* the errored check, while
`classify.ts` opens by stating the opposite: *a step we could not read never becomes a
site finding.* `localization.yaml` declares `category: localization` on both text
checks, so a run where the engine looked too early produced a pile of **localization
defects** titled "Could not verify: …". Somebody investigates the site; our defect
stays invisible — in the journey this project is named for.

The inconsistency that gave it away sits one function below: `severityFor` has always
overridden a declared severity for an errored step, with a comment saying why.

---

## 2026-08-13 — A second live target, and three defects it found in an hour

`xala.no` was named as the second real site, which was the whole of what
[C-7](docs/gaps.md#c-7--one-live-target) was blocked on — it needed permission and a
name, not an implementation. The journeys were pointed at it the same day.

**It found three defects in geoqa within the hour, which is the entire argument for a
second site.** `fixtures/server.ts` covers *known* defects on purpose and cannot do
this: a fixture we wrote cannot surprise us.

### A text check has no settle (C-13)

`getText` is `innerText`, and Playwright auto-waits only for the element to be
**attached**. On a client-rendered site the shell's `<html>` and `<body>` are attached
immediately, so the read returns `""` before hydration and every text check compares
against an empty string — then files the result as a **site** finding.

| Moment | `body.innerText` | `body.innerHTML` |
|---|---|---|
| `load` | **0 chars** | 1,404 |
| +1s | 6,077 | 80,534 |

The engine reported `page carries the market's language marker — 0 chars read`
against a site whose `<html lang>` is `nb-NO` and correct.

This is a lesson the engine **already learned once and never generalised**: a negative
*visibility* reading has confirmed itself since `d7a4700`, because an element
mid-animation reads as absent. A text read has the same failure mode and none of the
protection.

### An unsubstituted `{placeholder}` can pass a check green (C-14)

`text-absent` with `value: "{forbiddenCurrency}"` asks whether the page lacks the
literal string `{forbiddenCurrency}`. Every page does. **The check passes, having
verified nothing** — the exact conflation of *we could not measure* with *it is fine*
that this engine exists to refuse, and invisible, because the run reports PASS and
nobody looks.

### The localization journey looks for an attribute in rendered text (C-15)

Its central check reads `innerText` and searches for a language marker that lives in
`<html lang="nb-NO">`. `innerText` never returns attributes, so the check cannot
detect the thing it is named for — on any site, correctly localised or not.

### What the site itself showed (C-16)

`landing-page` and `reader` pass. `search` correctly fails and there is genuinely no
search input at either width — verified directly, unlike digilist where the input
exists and a breakpoint hides it. And the `h1` **rotates between reads**, which makes
any headline text assertion a coin flip.

### One hypothesis the data killed, kept because the method is the point

The first probe read `innerText` at `load`, got 0 characters, and produced a
confident hypothesis that `locator("html").innerText()` was broken. The same probe
against `digilist.no` returned 11,542 characters and killed it in one line.

A measurement taken at the wrong moment is not a weaker version of the right answer.
It is a different and confident wrong one — and the only thing that caught it was
checking a second subject before believing the first.

---

## 2026-08-13 — Closing the gaps that could be closed by code

Seven merges. The through-line: the engine already refused to confuse *we could not
measure* with *it is fine*, and each of these found somewhere it was still doing
exactly that.

### Every documented config key now does something (#14, gap B-1)

`geoqa.config.json` documented four keys that were parsed, validated, defaulted,
deep-copied — and then read by nobody. That is worse than not offering them: you
edit the file, nothing contradicts you, and you believe the setting took.

| Key | Was | Now |
|---|---|---|
| `evidence.retention` | inert | decides what a run collects **and** what its manifest calls required |
| `network.cooldownMs` | inert; the cooldown store was unreachable from the CLI entirely | read and write halves wired, scoped per tenant |
| `browser.*TimeoutMs` | reached `browser verify` / `proxy verify` only | reaches `journey run` and `matrix run` |
| `ProviderOptions.cooldownMs` | dead field | deleted |

The retention key needed both halves or neither. Honouring a narrowed tier in the
collector alone would make every run report the kinds the config told it not to keep
as `missing` — completeness falling as a punishment for setting the option.

The cooldown store had **never** been reachable. Nothing passed `cooldownPath`, so a
vendor that failed mid-sweep was retried on every scenario — precisely what that
store was ported from agent-fleet to prevent, where it earned its shape on a
provider that ran out of credit.

*Not* claimed closed: the durable path reads cooldowns and never writes one. Recorded
against D-2, because nothing starts a Temporal worker to exercise it.

### The HAR is listed, flagged, and deleted when unretained (#13, gap B-3)

Three defects around one artifact, and the middle one was a privacy leak rather than
a number.

- **`harStop` now closes the context, because on Playwright that *is* the flush.** It
  used to refuse, accurately — and refusing accurately turned out not to be the same
  as being right. The manifest reported `har` missing on every fail-tier run, holding
  completeness at **88%**, for a file that landed on disk seconds later when the run's
  own teardown closed the same context. Fail-tier completeness is **100%** now.
- **A passing run no longer leaves an unlisted network log on disk.** The recording is
  armed on every run — it cannot be started retroactively for the run that turns out
  to need one — and Playwright flushes it at close regardless. So the asymmetric
  retention policy was bypassed for exactly the artifact carrying the most personal
  data, and *unlisted* was the worse half: pruning walks the manifest, so nothing
  would ever have removed it.
- **The HAR carries a review flag, and needs it more than a screenshot does.** Response
  bodies are omitted at creation; request bodies and `Cookie` headers are not. Unlike
  an image, a HAR is grep-able.

### Evidence that can corroborate its own reproducibility claim (#12, gap B-4)

A `--repeat 3` run emitted findings whose `reproducibility` said 3 while the package
held no trace of the other two attempts — and answering *can we reproduce this?* is
something the package itself is required to do (R-24). Both numbers are derived once
and written to both places, because two derivations are two chances to disagree.

Occurrence counts are now keyed per step rather than per label. An unlabelled assert's
label is its check kind, so a journey with two `text-present` asserts had two steps
sharing one count: one failing every attempt beside one failing never would have read
as **both** failing every attempt.

### Action timeouts, and ambiguity recorded rather than refused (#11, gaps C-9, C-11)

An action step no longer spends a navigation's budget on an element that is not there.
The 30 seconds this replaced were not merely slow — `ERROR` outranks `FAIL`, so
waiting them out relabelled *the search box is not visible* as *we could not verify*.

A step whose selector matched more than one visible element now says so. Deliberately
**not** refused: `#results a, .result` taking the first of three results is what that
journey means, and a strict-mode engine would error on a correct journey. The defect
was a report that read identically whether the click hit the first search result or
the nav link that happened to come first in the document.

### Content-level SEO signals (#10, gap A-9)

Thin pages, orphans and near-duplicate cannibalisation, computed from a page artifact
**designed not to hold prose**: a word count, a hash, and 5-word shingles, never the
text. A page can contain a name in a testimonial or an address in a footer, and an
evidence tree accumulating the rendered text of a customer's whole site would be a
data-protection liability created for a word count.

### The 102-session milestone, and city match measured by distance (#8, #9, gap C-4)

The sentence this project had rested on — *a city can be proven right, never proven
wrong* — was true of a **string comparison** and of nothing else. Measured by
great-circle distance, a proxy that sold Stockholm and delivered Uppsala has failed,
and calling that unproven protected the vendor rather than the measurement.

The old axis produced two numbers that were both true and neither usable: 72.5%
counting exact names, 100% counting everything not proven wrong. By distance the
answer is **84.3%**, with **zero** `unverified`, and the failures are named —
Uppsala, Munich, Trondheim. Against a ≥90% bar. See
[`docs/milestone.md`](docs/milestone.md); the threshold decision is open.

### Two source files were invisible to grep (#7)

Literal NUL bytes used as map-key separators made `trends.ts` and `history/store.ts`
register as **binary**, so searching them silently returned nothing. Found when a
review of the PR that introduced them came back empty. Replaced with JSON tuples,
with a regression test — a file nobody can grep is a file whose next bug takes longer
to find.

### Earlier the same day

- **#6 — metric trends,** and the discipline not to invent one. A direction is refused
  below six points and must clear *both* a relative and an absolute floor: a TTFB
  moving 1.05ms → 0.9ms is 14%, and the dashboard called it "improving" until the
  absolute floor existed.
- **#5 — a static read-only run browser,** with a `Measured<T>` type that makes an
  absence a different *type* from a reading, so a UI cannot render `0` for a null.
- **#4 — the same page compared across markets,** which is the half of SEO no crawler
  running from one datacentre can answer — and an explicit refusal to approximate the
  signals the evidence could not support.
- **#3 — a publish gate the producer cannot argue with.** Default deny; `unknown` is a
  different *sentence* from `block`, not a different outcome.
- **#2 — the keyword agent,** generalised out of one company's spreadsheet.

### Phase 1 — multi-tenancy, and the bug that invalidated a headline claim

The most consequential defect found so far: **every run in a market had always shared
one exit IP**, because a hyphenated session key was truncated by the vendor's username
parser. Three hypotheses were tested and eliminated before the real cause was found.
It invalidated the earlier "5 sessions → 5 IPs" rotation claim, which is why the
milestone above was re-run afterwards.

Also: a path-traversal defect (`--geo ../../../../etc/hosts` escaped the profiles
directory), predating multi-tenancy and fixed with containment by `path.relative`
rather than `startsWith`.

---

## 2026-08-12 — Phase 0 and the honesty fixes

The engine itself: browser, network and geo-verification layers; geo profiles and the
deterministic journey engine; findings, evidence packages and per-axis confidence; one
atomic run on Temporal; the CLI and the experiment harness; all seven Phase 0
experiments run, and the two bugs they found fixed.

Then three fixes that set the tone for everything above:

- **The engine was inventing site defects under its own load.** An element
  mid-entrance-animation reads as not-visible, so absence is now *confirmed* before it
  is reported — and confirmed for **any** negative reading, not only a not-found error.
- **A vitals metric that came back null is re-read** before being called unmeasured.
- A bare `evidence/` line in `.gitignore` had been excluding the entire
  `src/evidence` module from the repository.

---

## Keeping this file current

Add an entry when something ships that changes what is true of the system — a merged
PR that closes a gap, a live measurement, a defect found and fixed. Name the gap id so
this file and [`docs/gaps.md`](docs/gaps.md) cannot drift apart, and say what the
system used to get wrong, not only what it does now. A reader who was not here learns
more from the second.
