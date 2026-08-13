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
`geoqa.config.json` was read by nothing ([B-1](#b-1--the-config-file-is-read-now--except-for-two-keys));
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
[B-10](#b-10--the-e2e-suite-still-asserts-tracejson-on-the-playwright-engine).
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
  [B-8](#b-8--a-proxy-url-with-any-placeholder-in-it-cannot-start-a-journey-run).
- **Bergen, Trondheim and Gothenburg city-level exits are not sold at any price.**
  Those three markets stay differentiated on the browser axis only, with the
  network axis reporting country-level, unless somebody runs a small always-on box
  on a home connection there. `geoqa` says which is which rather than claiming a
  city it cannot prove ([C-4](#c-4--a-wrong-city-cannot-be-distinguished-from-a-naming-artifact)).
- The sticky window must exceed the journey's wall clock. `runJourneyActivity`
  allows 10 minutes and a residential vendor session commonly defaults to about
  10 — an edge, not a margin. `--repeat N` narrows it further, because all N
  attempts run inside one session by design.

Where: `network/provider.ts`, `cli/samplers.ts` (`NO_VENDOR_NOTE`), `infra/`,
`experiments/EXP-001-geo-ip/summary.json`.

**Cannot be closed by code.** An exit IP is a purchase (or a colleague's spare
Pi). Everything the code can do about it is done.

### A-2 · No search/SERP observation

`ConfidenceReport.searchObservation` is hardcoded `null` and documented to stay
that way until a source is wired. Correct behaviour (R-36), but it means one of
the five confidence axes never contributes.

**Cannot be closed by code.** It needs a SERP data source — an API subscription
or a scraper with its own legal and rate-limit story. Inventing a number for it
is the one thing that is definitely wrong.

Where: `confidence/score.ts`.

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

- **The concurrency default is provisional and admits it.** `DEFAULT_MATRIX_CONCURRENCY = 2`,
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

### A-4 · Findings have nowhere to go

Read-only by design: no Linear, no Convex, no repo write, no dashboard, no
persistence beyond the on-disk evidence directory. A finding's lifecycle ends
when the process prints it. There is also no aggregation across runs — no trend,
no regression detection, no "this CLS was 0.31 last week".

**Cannot be closed by code here.** A findings sink is deferred to a later phase
by the owner. Noted so it is not mistaken for an oversight, and so nobody builds
half of one.

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
[B-10](#b-10--the-e2e-suite-still-asserts-tracejson-on-the-playwright-engine) fails
the e2e suite out loud. A defect a tool shouts about is a better defect than one a
document has to remember.

### B-1 · The config file is read now — except for two keys

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

**Two keys are still inert, and one of them is the exact defect this entry was
written about.** `grep -rn "cooldownMs\|\.retention" src/cli src/run` excluding
tests returns **nothing** — verified now:

| Config key | State |
|---|---|
| `evidence.retention` | parsed, defaulted, merged, deep-copied — and read by nobody. `stages.ts:214` still uses the module-level `RETENTION` |
| `network.cooldownMs` | parsed and defaulted; `ExecuteOptions` has no `cooldownMs` and nothing passes `cooldownPath` either, so `noteProviderOutcome` is a no-op from the CLI regardless |

`geoqa.config.example.json` says "Every key below is READ", which is now true of
the loader and false of the run. Either thread them or delete them from the
example — half a config surface is still worse than either whole one.

**A third key is honoured on only some commands.** `browser.commandTimeoutMs` /
`idleTimeoutMs` reach `CommandDeps.browserTimeouts` and therefore `browser verify`
and `proxy verify`, but **not** `journey run` or `matrix run`: `buildRuntime`
(`run/context.ts:98`) constructs `new AgentBrowserRuntime(config)` with no options.
`RunSpec` needs `commandTimeoutMs?`/`idleTimeoutMs?` — both JSON-serialisable, and
neither changes agent-browser's launch identity, so invariant 12 is safe.

Also still true: **`ProviderOptions.cooldownMs` (`network/provider.ts:149`) is
dead** — nothing in that file reads it. Passing the config value there would look
wired and do nothing, i.e. a fresh B-1. Delete the field or make
`httpProxyProvider` use it; the live path is `noteProviderOutcome`'s own options.

And the `.gitignore` rationale on line 21 is now wrong twice over:
`/geoqa.config.json` is ignored as "local config carries proxy credentials", but
credentials come from `GEOQA_PROXY_*` only (R-26) and the loader now **refuses
credential-shaped keys by name** with a message saying where they belong.

Where: `src/config/schema.ts`, `src/config/load.ts`, `cli/index.ts`,
`geoqa.config.example.json`, `.gitignore:21`.

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

### B-3 · HAR is recorded now, and still absent from every manifest

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

**Presence in the manifest: still open, and three consequences follow.**
`collectEvidence` runs *before* `runtime.close()`, so `describeExisting` sees 0
bytes and the manifest still reports `har` in `missing`. **Fail-tier completeness
is still 88%** — now because of ordering rather than because nothing records.
Verified: `stages.ts:269-272` calls `harStop` then `describeExisting` with no
close in between.

Two further consequences, both new and both real:

- **A pass-tier run now leaves an unlisted `network.har` on disk.** `harPath` is
  armed unconditionally (`run/context.ts:207`) and Playwright always flushes on
  close, so the asymmetric retention policy — the whole reason a green run keeps
  almost nothing — is bypassed for this one artifact. "Never call stop" was
  sufficient for the trace; for HAR the equivalent is a **delete** after
  collection for tiers that do not list `har`.
- **A HAR bypasses redact-at-write.** Bodies are omitted at creation, but request
  bodies and cookie headers are not, so a form or login journey's HAR can hold a
  filled value — the one thing R-63 says must never reach disk. It needs the same
  derived `risk` flag the screenshots get (`screenshotRisk({hadForm, authenticated})`),
  and `privacyNote`'s wording widened beyond screenshots. The alternative, if a new
  privacy surface is unwanted, is to arm `harPath` only for journeys declaring
  `writes: false` — which needs the journey, not just the spec, at
  `buildRuntime` time.

Fix for the presence half: do the live reads first, then `await runtime.close()`
for tiers containing `har`, then describe the file, then build the manifest. Note
`PlaywrightRuntime.close()` is called again from `executeRun`'s `finally`;
Playwright tolerates a double `context.close()` but agent-browser's path would
re-run, so that needs a guard.

Where: `browser/playwright.ts` (`harPendingDetail`, `HAR_NOT_ARMED`),
`browser/playwright-launch.ts`, `run/context.ts`, `run/stages.ts`.

### B-4 · Finding reproducibility is fed; the durable path and `run.json` are not

**Closed for `journey run`.** `--repeat N` runs the journey N times inside one
browser and one network session, `mergeAttempts` collapses the attempts taking the
**worst** outcome at each step index, and `executeRun` forwards `attempts` plus
per-label `occurrences` into `findingsFromSteps`. 3-of-3 lands near 99 and reports
`reproduced`; 1-of-3 lands far below the flat 92; a single-attempt run behaves
exactly as before.

Unchanged since the last revision, in three narrower places:

- **`run.json` cannot corroborate the count.** **Verified now**: `collectEvidence`
  records the journey's `seed`, `writes`, `touchedForm` and `steps`, and no attempt
  count. A `--repeat 3` run emits findings whose `reproducibility` says 3 while the
  evidence package holds no trace of the other two attempts — and R-24 makes "can we
  reproduce this?" a question the package itself must answer. `CollectInput` would
  need to carry it.
- **The durable path still runs one attempt.** `runJourneyActivity` calls
  `executeJourney` once and has no repeat path; `assemble` forwards neither
  `attempts` nor `occurrences`, so a Temporal run's findings are all `observed`.
  Two execution modes, one implementation — except here.
- **Occurrences are keyed by step label, and labels are not unique.** An
  unlabelled assert's label is its check kind, so two `text-present` asserts in one
  journey would share one count. No shipped journey does this — verified across all
  six — which makes it latent rather than active. A label unique per step index
  would close it.

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
[B-3](#b-3--har-is-recorded-now-and-still-absent-from-every-manifest) — the HAR is
a second artifact with the same problem and no flag yet.

### B-7 · A returning visitor is restored now, and nothing says when it was not

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

**Residual, and small: no e2e proves a real cookie survives.** The profile exists and
the path is exercised, but the two-run sequence — first run sets a cookie, second run
sees it — is not automated. It needs an e2e that runs the same profile twice against a
fixture that sets a cookie, which is a test-harness shape this suite does not have yet
(every existing case is a single run).

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

### C-4 · A wrong city cannot be distinguished from a naming artifact

`compareCity` returns `unverified`, never `mismatch`, for a non-matching city —
correct, because egress databases name the exchange's suburb (the real Norway
baseline reads "Lysaker"). The consequence is that a genuinely wrong city (a
Frankfurt exit sold as Oslo) and a correctly-routed session with an oddly-named
exchange produce **the same verdict**.

**Cannot be closed.** It is the design: a city can be proven right, never proven
wrong. City is a bonus signal and country carries the geographic claim alone. It
matters more now than it did, because three of the eight markets have no
purchasable city-level exit at all
([A-1](#a-1--the-core-claim-is-one-purchase-and-one-health-check-fix-away)).

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

**Cannot be closed by code.** It needs a second and third real site to point at,
which is a decision about scope and permission, not an implementation.
`fixtures/server.ts` covers *known* defects on purpose and cannot substitute: a
fixture we wrote cannot surprise us.

### C-8 · `emulate` is a Playwright descriptor name applied to two engines, and no axis checks it

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

**Also still open, and worth saying plainly:** because no mobile profile carries a
descriptor, geoqa's mobile profiles present a DESKTOP user agent. They are mobile by
viewport only. A site doing server-side device detection off the UA serves them its
desktop variant, and the new axis reports `unverified` rather than `mismatch` for
exactly the reason above — the profile never claimed a mobile UA. Closing that means
choosing between emulation (and losing viewport control) or an explicit `userAgent` per
mobile profile (and maintaining UA strings by hand).

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

### C-9 · A step whose selector a preceding check already proved absent still runs

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
a conditional step is a program. So the fix is not "skip the fill": the honest
options are a shorter timeout for input actions than for navigations, or letting a
`critical` visibility check be fatal for the steps that name the same selector.
Both are real design choices and neither should be made in a slice about clicking.

**Not a blocker for J03**, which is proven end to end against the fixtures
including a real click-through and a dead-link catch. It is a cost paid on any
journey whose target does not have the element the journey assumes.

Where: `journeys/engine.ts` (step execution, fatality), `browser/playwright.ts`
(action timeouts).

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

### C-11 · A comma-union selector is safe in an assertion and a hazard in a click

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

**Open, because the convention is not enforced.** Nothing stops the next journey
from using a broad union in a click step, and the failure is silent — it does not
error, it clicks something. A `click`/`fill`/`press` step could be required to
resolve to a single element, or to warn when its selector matches more than one, in
the way Playwright's own strict mode does. That is a real engine decision and
belongs with [C-9](#c-9--a-step-whose-selector-a-preceding-check-already-proved-absent-still-runs),
not in a journey.

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
[C-11](#c-11--a-comma-union-selector-is-safe-in-an-assertion-and-a-hazard-in-a-click).

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
nothing reads is the defect [B-1](#b-1--the-config-file-is-read-now--except-for-two-keys)
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
[B-10](#b-10--the-e2e-suite-still-asserts-tracejson-on-the-playwright-engine).
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

1. **B-10** (e2e asserts `trace.json`) — `pnpm test:e2e` fails. One filename, plus
   the manifest assertion that would have caught it.
2. **B-1's residue** — thread `evidence.retention` and `network.cooldownMs`, or
   delete them from the example. A config file that documents a key nothing reads
   is the defect this entry closed, reopened in two places. Same commit should fix
   the `.gitignore` rationale and delete or use the dead
   `ProviderOptions.cooldownMs`.
3. **One `ExperimentOptions` edit closes three entries** — `engine`,
   `verifyEndpoint`, `stabilityWindowMs`, `stabilityReads`, `concurrency`, plus the
   five `makeRuntime` call sites in `samplers.ts` and the flags in `index.ts`. That
   is [C-1](#c-1--the-stability-window-is-a-parameter-and-a-flag-now-reaches-it),
   [A-3b](#a-3b--exp-007-exists-now-and-has-never-been-run) and the remaining third
   of [D-1b](#d-1b--the-engine-choice-is-uniform-except-for-the-experiment-samplers).
   Do not substitute defaults at the CLI: `resolveStabilityWindow` and
   `resolveConcurrency` own the defaults and the refusals.
4. **B-8** (a placeholder URL cannot start a run) — a few lines, and it is the
   first thing a provisioned exit hits. Doing it afterwards means diagnosing "not
   configured" on a proxy that is configured, on day one.
5. **A-1 proper** (provision, or check the office address) — with B-8 fixed, the
   last thing standing between the code and the central claim. `infra/` makes it an
   afternoon and about $28/month rather than a project.
6. **B-3's HAR residue** — the collection reorder, the pass-tier delete, and the
   privacy flag. The delete is the urgent third: a green run is currently leaving an
   unlisted network log on disk, which is the one thing the asymmetric retention
   policy exists to prevent.
7. **B-7's honesty half** — surface the `unmet` warning and record the restored
   flag in `run.json`, then add one `returning` profile and an e2e case. The
   mechanism without the warning is a run that can claim a returning visitor it
   never was.
8. **C-8** (`emulate` unchecked) — one e2e assertion. Without it, "mobile" means a
   viewport width on the engine that serves every experiment.
9. **B-4's residue** — carry the attempt count into `run.json`, then give the
   durable path the same repeat wiring the CLI has.
10. **D-2's durable half** — a Temporal client, and a decision about whether the
    matrix workflow adopts the in-process runner's bound. Worth doing after EXP-007
    has a number, not before.
11. **A-3's scheduler** — 96 scenarios exist, `matrix run` can execute them, and
    nothing runs it at 3am on a machine with a Norwegian address. That last clause
    is the constraint (`infra/README.md`), not the cron.
