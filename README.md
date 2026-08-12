# geoqa

**Geographic experience & evidence engine.** It answers one question the rest of
a search/content stack cannot: *what does a visitor in a given market actually
experience on this page, and can we prove it?*

Deterministic, no LLM in the measurement path, read-only against the world unless
a journey says otherwise. Nothing here writes to Linear, Convex, or any repo.

```bash
pnpm install && pnpm browser:install     # fetches Chrome for Testing
pnpm geoqa journey run --url https://digilist.no/blogg --geo oslo-mobile --journey reader
pnpm geoqa matrix run  --url https://digilist.no --market oslo,berlin --journey reader,browse --dry-run
```

## Why it exists

A search intelligence platform can tell you a keyword is an opportunity, write
the article, and publish it. It cannot tell you that the page it just published
renders at the wrong width, shows the wrong currency, or takes five seconds to
settle for someone in Bergen. `geoqa` is the layer that goes and looks.

## The one idea worth understanding

**Geography is two axes, not one.**

| Axis | Set by | What it changes |
|---|---|---|
| **Network identity** | proxy / cloud-browser region | the IP the *server* sees → CDN edge, geo-redirects, currency, latency |
| **Browser environment** | locale, clock, coordinates, viewport | what the *page's JavaScript* believes → `navigator.language`, `Intl`, Geolocation, layout |

They are verified separately, both through the browser itself, and every axis
has three verdicts — `match`, `mismatch`, and **`unverified`**. The third is the
important one: it means the probe produced no reading, and it is neither a pass
nor a failure. A run with Oslo coordinates arriving from a Frankfurt IP is a
plausible production bug and a worthless QA profile, and only a two-axis check
tells you which you are looking at.

That rule runs through everything else. A threshold that could not be measured is
never a pass. A check whose reading never arrived is *our* defect, not the site's.
A gap in a matrix is recorded as unmeasured, never as a market that was fine.

## What it does now

- **Two engines** behind one seam: `agent-browser` (a CLI daemon, the default) and
  Playwright (`--engine playwright`, per-context proxy, real Geolocation
  permission, restored visitor sessions). Nothing above the seam knows which one
  served a run.
- **16 profiles** — 8 markets × {mobile, desktop} — and 6 journeys, as data rather
  than code. `geoqa matrix run` expands and executes the 96 scenarios under a
  bounded pool that records both its limit and the peak it reached.
- **Journeys behave like visitors.** They read and browse at human pace, and they
  exercise real functionality: search, registration, login, contact forms, CRUD. A
  journey that changes state declares `writes: true` and the run says so before
  starting. Pauses are drawn from a range and optional steps happen on a
  probability — all from a **seeded** generator, so a set of runs is representative
  and any single run replays exactly from its recorded seed.
- **Flakiness is measured, never hidden.** The journey does not retry; `--repeat N`
  runs it N times inside one browser and one network session, reports each step at
  the worst outcome any attempt saw, and tells you 1-of-3 from 3-of-3.
- **Evidence with a shelf life.** Tiered retention by verdict, redaction at write
  time, a manifest that names what is missing — and `geoqa evidence prune`, which
  plans without deleting and only deletes when asked.

## What Phase 0 established

Seven experiments, run against agent-browser 0.34.0 and Chrome 151. A historical
record: these numbers are not re-measured by later work.

| Experiment | Verdict | What it showed |
|---|---|---|
| EXP-000 primitives | **PASS** | 10/10 browser primitives answer, proven by using each one |
| EXP-001 geo egress | **UNMEASURED** | No exit IP exists, so the routing claim cannot be tested at all — see below |
| EXP-002 session stability | **PASS** | One session held one IP across 24s of reads (not the PRD's 10 minutes) |
| EXP-003 session isolation | **PASS** | Cookies and localStorage do not leak between sessions |
| EXP-004 profile consistency | **PASS** | A Berlin profile really does produce `de-DE`, `Europe/Berlin`, 390px |
| EXP-005 journey stability | **PASS** | 5/5 identical verdicts against a live page |
| EXP-006 evidence quality | **PASS** | 8/8 injected defects detected, 95.5% evidence completeness |

**EXP-001 is the honest one.** With no geo exit configured, every session
egresses from this machine. Running the Oslo profile from a Norwegian office
observes country `NO` and would report `country-match 100% ✓` — a green tick for
a capability that does not exist. The identical run against the Berlin profile
would report 0% for the same reason. Neither number measures the system under
test, so both are recorded as `unmeasured` with the reason attached. The baseline
observations are still written to `results.jsonl`; they simply are not allowed to
answer the hypothesis.

**What has moved since.** EXP-002's window is now a parameter rather than a
constant, so the PRD's ten minutes is expressible — the default is still 24s and
no flag reaches the parameter yet, so 24s is still what has been measured. EXP-007
(concurrency) now exists as a spec and a sampler and **has never been run**; one of
its five targets — peak memory across the browser process tree — is not observable
from this process at all, and is reported `unmeasured` rather than omitted. And
`infra/` now specifies EXP-001's missing piece: one small VM per market running a
forward proxy, about $7/month each, with the observation that for the home market
the office's own ISP address is both free and more realistic than anything
purchasable.

## What it found

Running against production `digilist.no/blogg`:

- **CLS 0.76 on desktop was the first live finding — and it is no longer true.**
  Re-measured 2026-08-12 across 14 pages: worst CLS is **0.025** on the homepage,
  zero on the other thirteen, with LCP 140–500ms against a 2500ms budget. Either
  it was fixed or the original number came from a different viewport. Recorded
  here because a stale headline finding is worse than none: it sends someone to
  hunt a defect that is already gone.


And two defects in itself, both caught by an experiment rather than by a test:

- A mobile profile rendered at 1280px because nothing applied the device
  viewport. Every check passed and the evidence package was 100% complete; only
  the screenshot showed it. The viewport is now a verified axis.
- `is visible` on a missing element returned an error, so "the page has no CTA"
  was filed as *our* instrumentation failure rather than as a site defect.
  EXP-006 scored 75% before the fix and 100% after.

Two more were caught later by the end-to-end suite, which drives a real Chromium —
an obsolete launch-level proxy placeholder that killed every navigation, and CLS
reported as unmeasured on a page that simply had no layout shift.

## Layout

```
src/
  browser/     the seam over two engines; nothing above it knows which one ran
  network/     GeoNetworkProvider (direct, http-proxy) + a cooldown store
  geo/         profiles, two-axis observation and verification
  journeys/    a deterministic step/assert DSL, its executor, and seeded variation
  evidence/    tiered retention, manifests, redaction-at-write, pruning
  findings/    severity + independent confidence + how a human re-checks it
  confidence/  five separate axes, overall capped by the weakest
  run/         the stages, one atomic run, and a bounded matrix over many
  config/      geoqa.config.json — schema, credential guard, imported defaults
  temporal/    the same stages as durable Activities
  experiments/ the harness; cli/samplers.ts holds the per-experiment logic
  fixtures/    a local server of deliberately broken pages
profiles/  journeys/  experiments/  evidence/  e2e/  infra/
```

## Rules this codebase holds itself to

- **Verify by execution, not inspection.** Response shapes are captured from the
  real CLI. Temporal workflows are tested inside a real test environment with a
  real worker — retry counts are assertions about executions that happened.
- **Transport garbage must never be parseable as a result.** Every browser call
  returns typed data or a named failure. There is no path returning success with
  absent data.
- **A failed assertion and a broken tool are different events.** A check that
  read the page and found it wrong is a site defect; a check whose reading never
  arrived is *ours*, categorised `instrumentation`, and never filed against the
  site.
- **A setting that nothing reads is worse than a hardcoded constant**, so an
  unknown config key is rejected and an unhonoured one is not offered.
- **100% lines/statements/functions**, with entrypoints excluded and each
  exclusion carrying a comment naming why. The layer map is enforced by
  `pnpm boundaries`, not by review.

## Not yet built

An exit IP for any market (`infra/` specifies it; nothing is provisioned).
Search-observation confidence — it stays `null` rather than being invented. A
scheduler: the matrix runs when a human types the command. Somewhere for a finding
to go. The content and SEO pipelines. A dashboard.

What is missing, what is unproven, and what is currently broken — including one
thing that is red on this tree right now — is tracked honestly in
[`docs/gaps.md`](docs/gaps.md).
