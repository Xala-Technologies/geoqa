# Proving 99.9%

A spec for the availability capability geoqa does not yet have. Written because
"we offer 99.9%" is a commercial promise, and a promise you cannot evidence is a
liability rather than a feature.

Related: [architecture](architecture.md) · [PRD](prd.md) · [gaps](gaps.md)

---

## 1. What the number actually is

| SLA | Downtime allowed / month | / year |
|---|---|---|
| 99.9% | **43 min 12 s** | 8 h 46 m |
| 99.95% | 21 min 36 s | 4 h 23 m |
| 99.99% | 4 min 19 s | 52 min |

99.9% is the right choice. It survives a bad deploy; 99.99% does not, and a
single 5-minute incident would breach it.

**Two things it does not mean, and both matter in a dispute.**

It is not measurable retrospectively. Availability exists only from the moment
monitoring starts; anything claimed about earlier months has no evidence behind
it. Start the clock, then quote the number.

It is not a single figure until you say what "up" means. 99.9% of *what* is the
whole contract, and §2 exists because that decision is not ours to guess.

## 2. Define "up" before building anything

The cheapest definition is the least defensible. A municipality does not care
that your marketing page returned 200 while nobody could book a hall.

| Definition | Detects | Misses |
|---|---|---|
| Homepage HTTP 200 | the host being down | every application failure |
| 200 + content marker | a blank or error page served with 200 | a broken booking flow |
| **200 + marker + latency ceiling** | brownouts — served, but unusably slow | logic failures |
| A real booking journey completing | what the customer actually needs | nothing, but costs far more per probe |

**Recommended:** the middle rows for the SLA clock, the last row hourly as
corroboration. Concretely, a run counts as UP when the target returns 2xx, the
page contains an agreed marker element, and TTFB is under an agreed ceiling.

Write the marker and the ceiling into the contract. "Available" without a latency
bound means a site taking 40 seconds per page is contractually perfect.

## 3. Two tiers, because one cadence cannot do both jobs

A geoqa journey is a real browser: 8–30 seconds and roughly 1 MB. At one per
minute across 8 markets that is 11,500 runs and 11 GB per day — absurd, and it
would measure the prober's own load as much as the site.

| Tier | Interval | What runs | Purpose |
|---|---|---|---|
| **Liveness** | 60 s | HTTP request, status + marker + TTFB | the SLA clock |
| **Experience** | hourly | Existing `sweep` journey, real browser | corroboration and defect detection |
| **Journey** | daily | `reader`, `contact-form` per market | does the product still work |

At 60 s the month has 43,200 samples per vantage — a denominator big enough that
one bad sample cannot move the figure, and fine enough to resolve a 43-minute
budget to the minute.

Liveness does **not** need residential egress. Availability is a property of the
service, so a cheap Norwegian datacentre IP is the honest vantage and it is free
of per-GB cost. Reserve residential for the experience tier, where the question is
what a real visitor in Bergen sees.

## 4. Quorum: one prober cannot make this claim

If the prober's own network breaks, that is indistinguishable from the site being
down — and a monitoring system that reports its own outage as your customer's
outage will lose you an argument you should have won.

**Three vantages, 2-of-3 quorum.** A sample counts as DOWN only when at least two
independent vantages agree in the same window. One vantage failing while two
succeed is recorded as that vantage's `unmeasured`, never as downtime.

Norway is the market that matters, so two Norwegian vantages on different networks
plus one outside the country, which is what distinguishes "digilist is down" from
"Norwegian transit is having a bad afternoon".

## 5. Three-state accounting is the whole point

This is where most uptime dashboards quietly lie, and where geoqa's existing
doctrine already has the answer. Every sample is one of:

- **up** — probe completed, definition satisfied
- **down** — probe completed, definition not satisfied
- **unmeasured** — the probe itself did not complete

`unmeasured` is **excluded from the denominator**, never counted as up:

```
availability = up / (up + down)
coverage     = (up + down) / (up + down + unmeasured)
```

Two numbers, always reported together. Availability without coverage is
meaningless — 100% availability at 4% coverage means the monitor was down all
month. A dashboard that folds monitor gaps into "up" is making exactly the mistake
this codebase refuses everywhere else: reporting its own blindness as good news.

Publish both. It is the difference between a number a customer can audit and a
number they can dispute.

## 6. Error budget, not a percentage

43 min 12 s per month is the budget. Report consumption, because a percentage
tells an engineer nothing actionable on the 9th of the month:

```
budget    43m12s
consumed  6m40s   (15%)
remaining 36m32s
burn rate 0.6× — on track
```

Two useful thresholds: 50% consumed before the month is half over, and any single
incident over 10 minutes. Both mean the same thing — stop shipping features and
fix reliability.

## 7. Incidents, not samples

A single failed sample is noise. An incident is **2+ consecutive DOWN windows at
quorum**, which at 60 s means a 2-minute floor on detection. That is well inside a
43-minute budget and it removes flapping.

Each incident gets an immutable record: first and last DOWN sample, duration,
which vantages agreed, the HTTP status and TTFB observed, and — because the
experience tier is running alongside — the evidence package from the nearest
browser run. That last part is what geoqa uniquely adds. Most monitors can tell a
customer *that* it was down; an evidence package with a screenshot, a HAR and a
console log tells them *what* was broken.

## 8. What geoqa has, and what is missing

**Already there, and most of the hard part:**

- `GeoNetworkProvider` — multiple vantages, per-market egress, real health probes
- The three-valued verdict discipline (`match` / `mismatch` / `unverified`) maps
  onto up / down / unmeasured with no reinterpretation
- Evidence packages with tiered retention, honest `missing`, write-time redaction
- The failed-vs-errored split — "the site was wrong" versus "we could not look" is
  precisely the up/down/unmeasured distinction
- Temporal Activities with per-stage retry policies

**Missing:**

1. **Continuous operation.** Runs are one-shot and the Temporal matrix has no
   entrypoint (gap D-2). This is the largest piece.
2. **A liveness prober.** A cheap non-browser probe: status, marker, TTFB. Must be
   a separate cadence from the browser runtime, not a journey.
3. **Time-series storage.** Append-only JSONL per vantage per day, with a monthly
   rollup. No database needed at this volume — 43,200 samples a day is a few MB.
4. **Quorum evaluation.** Windowed, across vantages, with the 2-of-3 rule.
5. **Error-budget reporting** and the two-number output of §5.
6. **Incident records** joining a DOWN span to the nearest evidence package.
7. **Alerting.** Out of scope here; the rollup is the artifact, alerting is plumbing.
8. **Somewhere to run.** A laptop cannot host an SLA claim. Two small always-on
   Norwegian boxes plus one abroad — `infra/` already provisions this shape.

## 9. What this will never prove

Stated plainly, because an SLA document that overclaims is worse than none.

- **Anything before monitoring started.** No retrospective claims.
- **That a specific customer could reach you.** We prove three vantages could.
  A customer's own ISP, DNS resolver or device is outside the measurement.
- **Availability of anything we do not probe.** The SLA covers the defined
  endpoints and definition of up, nothing else.
- **Cause.** A DOWN sample says the definition was not met, not why.

## 10. Order of work

1. Define "up" — the marker and the latency ceiling. Blocks everything, costs
   nothing, and is a contract decision rather than an engineering one.
2. The liveness prober plus JSONL storage, run from one vantage. Starts the clock,
   which matters because the earliest possible start date is the earliest possible
   claim.
3. A second and third vantage, then quorum.
4. The monthly rollup with availability, coverage and error budget.
5. Incident records joined to the experience tier's evidence.
6. Alerting.

Steps 1 and 2 are days, and they are the ones that stop the clock running with no
recorder. The rest can follow while data accumulates.
