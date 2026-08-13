# The 100-session milestone

> Prove Decodo Residential + a browser engine can execute **100 repeatable geo-specific
> browser sessions** across Oslo, Stockholm and Berlin, with **≥98% country match, ≥90% city
> match, ≥95% journey completion** and evidence attached to every failed run.

**102 sessions**, 17 real pages from `digilist.no`'s sitemap × 3 markets × 2 devices, one
`landing-page` journey each, through Decodo residential at concurrency 4. 153 seconds of wall
clock, ~0.1 GB of a 50 GB allowance. Base seed `20260813`, so the whole matrix replays.

## Result: three of four thresholds met

| Threshold | Target | Measured | |
|---|---|---|---|
| country match | ≥98% | **100.0%** (102/102) | ✅ |
| city match | ≥90% | **84.3%** (86/102) | ❌ short by 5.7 |
| journey completion | ≥95% | **98.0%** (100/102) | ✅ |
| evidence on every failed run | 100% | **3/3** | ✅ |
| egress held for the whole run | — | **100.0%** (102/102) | ✅ |

`unverified` city verdicts: **0**. Every session got a definite answer, which is the change
that makes the number above mean anything.

## Why the first measurement was unusable in both directions

The first run of this matrix reported city match as **72.5%** on exact names and **100%** if
you counted everything "not proven wrong". Both figures were true and neither was useful,
because `compareCity` compared STRINGS: it reported `unverified` for **Skui, 15 km from Oslo**
and for **Gällivare, 1100 km from Stockholm**. One is Oslo by any reasonable reading; the other
is a thousand kilometres of Sweden away.

28 of 102 sessions were non-exact and roughly half were genuinely the wrong city, so a rate
computed from that axis could be made to say almost anything.

`compareCity` now measures **distance**. `ipinfo` has always returned coordinates as `loc`; the
parser read them and threw them away. With them:

- `match` — within **50 km**. A differently-named exchange suburb stops mattering, because
  Kista is 12 km from Stockholm whatever it is called.
- `mismatch` — beyond it. **This verdict was previously unreachable**, and it should not have
  been: a proxy that sold Stockholm and delivered Uppsala has failed, and calling that
  "unproven" protected the vendor rather than the measurement.
- `unverified` — no coordinates from either side. Nothing to compute.

The 50 km radius comes from the data rather than from taste. Observed distances clustered at
**6, 12, 15 and 25 km** (Solna, Kista, Skui, Potsdam) and then **100, 200, 400, 500, 1100 km**
(Gjøvik, Linköping, Gothenburg, Munich, Gällivare). Nothing landed between 25 and 100.

## Where the 15.7% went

| Market | city match | delivered instead |
|---|---|---|
| Berlin | 88.2% | Munich ×2, Nuremberg, Würzburg |
| Oslo | 88.2% | Trondheim ×2, Tønsberg, Jaren |
| **Stockholm** | **76.5%** | **Uppsala ×3**, Örebro, Sundsvall, Gothenburg, Gislaved, Ängelholm |

Country targeting is perfect and city targeting is not. Stockholm is the weak market, and
Uppsala (70 km) is its most common substitution.

This is a **vendor** result, not an engine one. Every session held one egress identity for its
whole run, so the sessions were coherent; the exits simply were not always in the city asked
for.

## The two ERROR runs

`page.goto` timed out at 30 s, both in Stockholm. Reported as `ERROR` with category
`instrumentation` — geoqa said *we could not read the page*, not *the site is broken*. Both
retained evidence. That distinction is the point of the verdict model and it held under load.

## What this does and does not prove

**Proven.** 102 geo-specific sessions execute repeatably at concurrency 4 in under three
minutes. Country targeting is exact. One session holds one egress identity throughout. Failures
keep their evidence. The matrix replays from one seed.

**Not proven.** City targeting at ≥90%. On this evidence the bar is not currently met by the
vendor — which is a purchasing question rather than a code one. Options, in the order I would
consider them:

1. **Accept 84% and state it.** City is a bonus signal; country carries the geographic claim.
2. **Raise the radius.** At 75 km Uppsala becomes Stockholm and the figure clears 90%. Defensible
   for a commuter belt, and it would also make Gjøvik "Oslo", which is harder to defend.
3. **Pay for city-level targeting** where the vendor offers it per city, and re-measure.
4. **Drop the weak market** from city-level claims and keep it as country-only.

Option 2 is the tempting one and the one to be careful about: moving a threshold until the
measurement passes is how a metric stops meaning anything.
