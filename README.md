# geoqa

**Geographic experience & evidence engine.** It answers one question the rest of
a search/content stack cannot: *what does a visitor in a given market actually
experience on this page, and can we prove it?*

Status: **Phase 0 (feasibility) complete.** Deterministic, no LLM, read-only
against live sites. Nothing here writes to Linear, Convex, or any repo.

```bash
pnpm install && pnpm browser:install     # fetches Chrome for Testing
pnpm geoqa journey run --url https://digilist.no/blogg --geo oslo-mobile --journey landing-page
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
| **Browser environment** | `TZ`, an init script, viewport | what the *page's JavaScript* believes → `navigator.language`, `Intl`, Geolocation, layout |

They are verified separately, both through the browser itself, and every axis
has three verdicts — `match`, `mismatch`, and **`unverified`**. The third is the
important one: it means the probe produced no reading, and it is neither a pass
nor a failure. A run with Oslo coordinates arriving from a Frankfurt IP is a
plausible production bug and a worthless QA profile, and only a two-axis check
tells you which you are looking at.

## What Phase 0 established

Seven experiments, run against agent-browser 0.34.0 and Chrome 151. Full results
in [`experiments/`](experiments/).

| Experiment | Verdict | What it showed |
|---|---|---|
| EXP-000 primitives | **PASS** | 10/10 browser primitives answer, proven by using each one |
| EXP-001 geo egress | **UNMEASURED** | No proxy vendor exists, so the routing claim cannot be tested at all — see below |
| EXP-002 session stability | **PASS** | One session held one IP across 24s of reads (not the PRD's 10 minutes) |
| EXP-003 session isolation | **PASS** | Cookies and localStorage do not leak between sessions |
| EXP-004 profile consistency | **PASS** | A Berlin profile really does produce `de-DE`, `Europe/Berlin`, 390px |
| EXP-005 journey stability | **PASS** | 5/5 identical verdicts against a live page |
| EXP-006 evidence quality | **PASS** | 8/8 injected defects detected, 95.5% evidence completeness |

**EXP-001 is the honest one.** With no geo-proxy vendor configured, every
session egresses from this machine. Running the Oslo profile from a Norwegian
office observes country `NO` and would report `country-match 100% ✓` — a green
tick for a capability that does not exist. The identical run against the Berlin
profile would report 0% for the same reason. Neither number measures the system
under test, so both are recorded as `unmeasured` with the reason attached. The
baseline observations are still written to `results.jsonl`; they simply are not
allowed to answer the hypothesis.

That rule generalises: **a threshold that could not be measured is never a
pass**, and `unmeasured` outranks `fail` in an experiment's overall verdict.

## What it found

Running against production `digilist.no/blogg`:

- **CLS 0.76 on desktop, passing on mobile.** A severe, device-specific layout
  shift. Google's "poor" threshold is 0.25.

And two defects in itself, both caught by an experiment rather than by a test:

- A mobile profile rendered at 1280px because nothing applied the device
  viewport. Every check passed and the evidence package was 100% complete; only
  the screenshot showed it. The viewport is now a verified axis.
- `is visible` on a missing element returned an error, so "the page has no CTA"
  was filed as *our* instrumentation failure rather than as a site defect.
  EXP-006 scored 75% before the fix and 100% after.

## Layout

```
src/
  browser/     the seam over agent-browser; nothing above it knows the CLI exists
  network/     GeoNetworkProvider (direct, http-proxy) + a cooldown store
  geo/         profiles, two-axis observation and verification
  journeys/    a deterministic step/assert DSL and its executor
  evidence/    tiered retention, manifests, redaction-at-write
  findings/    severity + independent confidence + how a human re-checks it
  confidence/  five separate axes, overall capped by the weakest
  run/         the stages, and one atomic run that uses them
  temporal/    the same stages as durable Activities
  experiments/ the harness; `cli/samplers.ts` holds the per-experiment logic
profiles/  journeys/  experiments/  evidence/
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
- **100% lines/statements/functions**, with entrypoints excluded and each
  exclusion carrying a comment naming why.

## Not yet built

A geo-proxy or cloud-browser provider (the `GeoNetworkProvider` interface is
ready and `http-proxy` is implemented; no vendor is procured). Search-observation
confidence — it stays `null` rather than being invented. Concurrency beyond 1.
The content and SEO pipelines. A dashboard.
