# Loop: geoqa from single-target engine to multi-tenant SaaS

## Goal

Turn geoqa into a product other companies can use: close the remaining engine
gaps, make it multi-tenant, bring the digilist-specific agents in as generic
capability (keyword research, content, AEO/GEO/SEO analysis), and ship a
frontend — **one reviewable slice per run**, each landing on a green baseline.

`digilist.no` is **tenant zero**: the target we test against, not the shape of
the product.

## The decision that changes everything, and it comes first

Today geoqa is single-target in every layer:

| Concern | Today | A SaaS needs |
|---|---|---|
| Targets | one `--url` per run | tenant-owned sites |
| Profiles | YAML on disk in the repo | per-tenant, editable |
| Journeys | YAML on disk in the repo | per-tenant, editable |
| Evidence | `./evidence/<runId>/` | isolated per tenant, with retention |
| Credentials | one `.env`, one proxy account | per-tenant, never cross-readable |
| **Proxy traffic** | one shared 50 GB pool | **metered per tenant** |
| Findings | printed to stdout | persisted, queryable, per tenant |

**Multi-tenancy is slice 6, before any agent or UI.** Copying four agents and a
frontend onto a single-tenant core means retrofitting all five later. The gaps
before it are prerequisites, not detours: a SaaS built on an engine that invents
false defects under load is worse than no SaaS.

The proxy-metering row is the one with teeth, and it is a lesson from today: one
sweep consumed the entire trial and every subsequent run returned an opaque 407.
On a shared pool, one tenant's crawl silently breaks every other tenant's runs.
Per-tenant quota is a correctness requirement, not billing polish.

## What the agents become

Copied from `agent-fleet` and generalised — nothing digilist-specific survives
into the product:

- **keyword research** — target market and language become tenant config, not
  hardcoded Norwegian
- **content generation** — writes for a tenant's product and voice
- **AEO / GEO / SEO analysis** — measures a tenant's pages, in a tenant's markets

The division that must hold: **agents produce, geoqa verifies.** An agent that
grades its own output is the failure this engine exists to catch. Publish is
gated on a geoqa verdict, and the verdict comes from the measuring side.

Note what today's live findings already prove that pairing is worth: 6 of 430
pages reported broken and all 6 were geoqa's own load; `/en/blog` was a real soft
404 that Search Console and the sweep found independently; 36 pages Google
crawled and declined to index while the content itself was distinct. An agent
alone would have known none of that.

## Context

- `main`, and **a full day of work is uncommitted** — 104 changed files. Slice 0
  exists because a loop cannot run without a committed baseline.
- Gate today: lint clean · boundaries clean (94 modules) · **925 unit tests at
  100% lines/statements/functions** · 18 e2e against real Chromium.
- Live proxy: Decodo residential, 50 GB to 12 Sep, credentials in `.env`
  (gitignored, 600). The sub-account username is in `DECODO_PROXY_USER`, deliberately
  not written here — it identifies a billable account, which is the same reason
  `tenant/types.ts` stores a variable NAME rather than the value. `gate.decodo.com:7000`, `user-` prefix
  required. Rotation between sessions and stickiness within one both proven.
- `digilist.no` is 430/430 clean, so a red sweep now means a geoqa defect.

## Authoritative reading order for any run

1. `AGENTS.md` — the working brief and the 16 invariants
2. `docs/gaps.md` — the entry this slice closes
3. `docs/architecture.md` — why each seam is where it is
4. `verification.md` — the exact gate commands

## Slices, in order

One run does **only** the next unchecked box.

### The milestone gate

Everything after this waits on it. See `test-plan.md` for the full audit of the
owner's 12-category plan — **9 of the recommended first 15 are already proven.**

> Prove Decodo Residential + a browser engine can execute **100 repeatable
> geo-specific sessions** across Oslo, Stockholm and Berlin, with **≥98% country
> match, ≥90% city match, ≥95% journey completion**, evidence on every failure.

Decodo is now the **default** `networkProvider`, with `GeoNetworkProvider` kept
as the domain type so Bright Data or a custom exit needs no rewrite.
`one-journey-one-session` is invariant 16 and is enforced by `verifyEgressHeld`.

**Decide before the run:** does `city: unverified` count against the 90%? A
neighbouring exchange is reported `unverified`, not `mismatch`, by design — and
measured on 20 Norwegian cities that is 13 exact of 20. If `unverified` counts
against, 90% is likely unreachable and the threshold is wrong.

### Foundation

- [x] **0 · Commit the baseline.** 104 files, all green, zero commits. Split into
      coherent commits (Playwright engine · rotation/pools · proxy fixes ·
      profiles · docs · infra · loop). **Human go-ahead required.**
- [x] **1 · Truth up `docs/gaps.md`.** B-8 and B-10 are already fixed; there are
      two `### D-1c` headings. A gap list nobody trusts is worse than none.
- [x] **2 · CLI flags for plumbing that exists.** `--urls-file` for the matrix
      target axis (the axis landed, nothing reaches it, so a sweep is still a
      shell loop) and `--stability-window` reaching EXP-002 (C-1, T03/T04) — the
      only reason stickiness is still measured over 24s instead of the PRD's ten
      minutes. Also `--country`/`--city`/`--network` on the CLI as the owner spec'd.
- [x] **2b · T10: two IP-geo sources, disagreement flagged.** Already a live
      finding — one ISP exit resolved to São Paulo per Decodo's endpoint and New
      York per ipinfo. An engine whose job is proving *where* a visitor is cannot
      treat one lookup as ground truth. Second source, and a third verdict when
      they disagree.
- [x] **2c · J03 internal-search journey, and clicking.** No journey clicks
      anything — `browse.yaml` has zero click steps. J03 (search → results →
      filter → open result) and J05's "follow a contextual link" both need it.
- [x] **2d · J06 manual language override.** Oslo IP → Norwegian homepage →
      select English → navigate → English persists. Expressible with existing
      steps plus `storageState`; cheap, and it exposes bad geo-redirects.
- [x] **3 · D-1e: `proxy verify` honours `--engine`.** Already closed; the entry was stale. Runs on agent-browser
      regardless and hangs with no Chrome. Cost an hour during the Decodo work.
- [x] **4 · D-1b: experiment samplers honour the engine.**
- [x] **5 · B-7 + C-8 + C-5.** Say when a returning visitor was NOT restored;
      verify `emulate` actually applied (same class as the 1280px mobile bug);
      add `inp-below` with an interaction before the read.

### Multi-tenancy — the pivot

- [x] **6 · The tenant model.** `Tenant` as a first-class type: id, markets,
      targets, credentials reference, quota. Evidence root becomes
      `<root>/<tenantId>/<runId>`. **A path that can escape its tenant's root is
      a security defect, not a bug** — test it explicitly.
- [x] **7 · Per-tenant proxy metering.** Read Decodo's usage per sub-user, hold
      a per-tenant budget, and REFUSE a run that would exceed it rather than
      discovering it as a 407 mid-sweep. Today's failure mode, prevented.
- [x] **8 · Tenant-scoped profiles and journeys.** Loaded from tenant storage,
      not the repo. The YAML shape stays — it is data, it cannot reach the
      browser, and a non-engineer can edit it.
- [x] **9 · Run persistence.** Findings and verdicts queryable across runs. This
      is what trends, regression detection and any UI need.

### Search intelligence

- [x] **10 · A-2: the search provider (SerpApi, not Serper — that is the key we have).** Behind a seam shaped like
      `GeoNetworkProvider`, with a REAL `health()` probe. Read the DataForSEO
      warning in `network/types.ts` first: a credentials-present check let a
      zero-balance account pass for weeks.
- [x] **11 · A-2: wire `searchObservation`.** Three-state, and this is the whole
      point: no results at all is `null`; results but not us is a real low score;
      401/quota is `null` with a reason. Never a fabricated 0.
- [x] **12 · A-3b + C-1: run EXP-007 and EXP-002 for real.** Both run. The 100-session
      milestone is BLOCKED on B-12 — see progress.md. Both `unmeasured`.
      EXP-007 answers what the matrix concurrency bound should be, which is a
      guess today (A-3).

### The agents, generalised

- [ ] **13 · Copy the keyword-research agent.** Market and language from tenant
      config. Serper is the data source.
- [ ] **14 · Copy the content agent.** Tenant product and voice as inputs.
      **Publish gated on a geoqa verdict** — the producer never grades itself.
- [ ] **15 · AEO/GEO/SEO analysis.** Reuse what the sweep already detects: thin
      pages, orphans, soft 404s, near-duplicate cannibalisation, and (with
      Serper) whether a page ranks in the market it was written for.

### Product surface

- [ ] **16 · Frontend, read-only run browser.** Runs, verdicts, per-axis geo,
      vitals, findings, screenshots. Decide React vs Electron on one criterion —
      does it need filesystem access beyond a served directory? Record it.
- [ ] **17 · Frontend, the geographic view.** Per-market matrix with city
      verdicts and the TTFB spread. This is what makes "your local numbers are
      4–7× optimistic" legible at a glance.
- [ ] **18 · Frontend, trends.** Needs slice 9.
- [ ] **19 · Auth and tenant onboarding.** Only after the above works for one
      tenant end to end.

## Explicitly NOT in this loop

Keep these open in `gaps.md` with their reasons — not code-closable:

- **A-5** adaptive recovery — PRD §37, deliberately deferred
- **B-5** rotation only detectable when proven — an unreadable probe must not
  discard a good run
- **C-2** no e2e against the real agent-browser CLI — 179 MB download per run
- **C-3** agent-browser geolocation is inherently a stub
- **C-4** a city can be proven right, never wrong — by design
- **C-6** coverage proves lines ran, not that anything was asserted — closing it
  means mutation testing and much slower CI
- **C-7** one live target — until tenant two exists

**A-4** (findings sink) is reclassified: it becomes slice 9, because a SaaS
without persisted findings has nothing to show anyone.

## Stop conditions

1. Any gate red. Never build on a red baseline.
2. A slice needs a file outside its area — report the exact change wanted.
3. Coverage would drop below 100% lines/statements/functions.
4. `pnpm boundaries` fails. It has caught two real violations; not advisory.
5. Tenant isolation cannot be demonstrated by a test — stop, this is security.
6. Proxy required and unavailable — build behind the injectable probe as a
      dormant seam, and stop.
7. Scope grows past the slice.

## File allowlist per slice

A slice touches its own module plus its tests. Shared integration points —
`run/stages.ts`, `cli/commands.ts`, `network/types.ts`, `browser/types.ts` —
change only when the slice names them, never as a side effect.

## Approval gates

- **Slice 0** — commit the baseline.
- **Slice 6** — the tenant model shape, before anything is built on it.
- **Slice 16** — React vs Electron.
- Any live run spending more than ~1 GB of proxy traffic.
- Merging to `main`.
