# Test plan, audited against the code

The owner's 12-category plan, mapped onto what exists on
`feat/phase-1-playwright-geo` as of 2026-08-13. Audited by reading the source,
not from memory.

Legend: **DONE** proven live · **FLAG** plumbing exists, nothing reaches it ·
**NEW** does not exist · **PARTIAL** exists, incomplete.

## Milestone (the gate everything else waits on)

> Prove Decodo Residential + a browser engine can execute **100 repeatable
> geo-specific sessions** across Oslo, Stockholm and Berlin, with **≥98% country
> match, ≥90% city match, ≥95% journey completion**, and evidence attached to
> every failed run.

Affordable now: 50 GB to 12 Sep, ~1 MB per page. 100 sessions ≈ 0.1 GB.

Two of those thresholds are already declared in `EXP-001` (`country-match ≥98`,
`city-match ≥90`) and one in `EXP-005` (`journey-completion ≥95`). The milestone
is therefore not a new metric set — it is **EXP-001 and EXP-005 re-run at n=100
through Decodo instead of direct egress**, which is what made them `unmeasured`.

**City match at ≥90% is the threshold to watch.** Measured on 20 Norwegian
cities: 13 exact, 7 neighbouring exchange. That is 65%. Across Oslo/Stockholm/
Berlin specifically it looked better (6 of 8 markets matched), but a 90% bar over
100 sessions is not obviously reachable, and `compareCity` reports a neighbouring
exchange as `unverified` rather than `mismatch` by design. **Decide before the run
whether `unverified` counts against the 90%** — if it does, the threshold is
probably wrong; if it does not, say so explicitly in the experiment.

## Decodo as the default provider

Agreed, with the abstraction preserved: `GeoNetworkProvider` stays the domain
type, `decodo` becomes the default `networkProvider`. The interface already has
`createSession(market, nowMs)` / `close(session)`; the proposed shape adds
`verify(session)`, which geoqa already performs as a *stage*
(`verifyEnvironment` + `verifyEgressHeld`) rather than a provider method — and
that is the better split, because verification happens **through the browser**,
which the provider has no access to. Keep it in `run/stages.ts`.

`one-journey-one-session` is already invariant 16 and is enforced by
`verifyEgressHeld`. `sessionDuration: 10m` is already expressible; `.env` sets 30
so a 10-minute journey cannot outlive its own IP.

## 1 · Decodo network feasibility

| | Scenario | State | Notes |
|---|---|---|---|
| T01 | Country targeting | **DONE** | 20/20 Norwegian requests returned NO |
| T02 | City targeting | **DONE** | 13/20 exact; 6/8 markets `city: match` |
| T03 | Sticky 5 min | **FLAG** | EXP-002 window is a parameter, no flag reaches it → still 24s |
| T04 | Sticky 10 min | **FLAG** | same. PRD asks 10m; this is gap C-1 |
| T05 | Session rotation | **DONE** | 5 sessions → 5 IPs, 3 ISPs, all Bergen |
| T06 | Parallel geo isolation | **PARTIAL** | EXP-007 defined, never run. EXP-003 covers cookie/storage isolation but not distinct egress under load |
| T07 | Proxy failure recovery | **DONE** | proven by accident: cap hit mid-sweep → `ERROR` + `instrumentation`, evidence retained, site never blamed |
| T08 | Latency baseline | **DONE** | TTFB 148ms direct vs 353–1923ms by market |
| T09 | 100-session reliability | **NEW** | the milestone itself |
| T10 | IP verification disagreement | **NEW** | **already a live finding**: for one ISP IP, Decodo's endpoint said São Paulo, ipinfo said New York. Two sources, flag disagreement |

## 2 · Browser profile consistency

| | Scenario | State | Notes |
|---|---|---|---|
| T11 | Oslo desktop | **DONE** | `nb-NO`, Europe/Oslo, 1440×900, all `match` |
| T12 | Oslo mobile | **PARTIAL** | 390×844 verified; `emulate` reverted (see C-8) |
| T13 | Stockholm `sv-SE` | **DONE** | `overall 100` |
| T14 | Berlin `de-DE` | **DONE** | `overall 100` |
| T15 | Incorrect profile detection | **PARTIAL** | `compareLanguage` returns `mismatch` for NO IP + `de-DE`; no test asserts the *combination* |
| T16 | Session isolation | **DONE** | EXP-003, 100% |
| T17 | Fresh visitor | **DONE** | default |
| T18 | Returning visitor | **PARTIAL** | `storageState` landed; nothing reports when it was NOT restored (gap B-7) |

## 3 · Journeys

| | Journey | State |
|---|---|---|
| J01 | Landing page | **DONE** — `landing-page.yaml`, ran live on 430 pages |
| J02 | Browse | **DONE** — `browse.yaml`, though it contains **no click step** |
| J03 | Internal search | **NEW** — no search journey exists |
| J04 | Conversion probe | **DONE** — `conversion-probe.yaml` stops before submit; `contact-form.yaml` submits for real with `writes: true` |
| J05 | Content journey | **DONE** — `reader.yaml`, human pacing |

**None of J01–J03 or J05 clicks anything.** `browse.yaml` has zero click steps.
"Follow an internal contextual link" (J05) and "open result" (J03) both need
clicks, and clicking is barely exercised anywhere.

## 4 · Failure detection

Existing fixtures: `/status-404` `/status-500` `/broken-image` `/missing-cta`
`/js-error` `/console-error` `/no-links` `/slow-heading`.

| | Scenario | State |
|---|---|---|
| T19 | HTTP 404 | **DONE** |
| T20 | HTTP 500 | **DONE** |
| T21 | API call fails | **PARTIAL** — `no-http-5xx` catches it; no fixture for an XHR failing while the page renders |
| T22 | JS exception | **DONE** |
| T23 | Broken image | **DONE** |
| T24 | Missing CTA | **DONE** |
| T25 | Button exists but does nothing | **NEW** — needs a check for "state changed after click" |
| T26 | Infinite spinner | **NEW** — needs `selector-absent-within` (a spinner that never leaves) |
| T27 | Unexpected redirect | **PARTIAL** — `url-matches` can catch it |
| T28 | Redirect loop | **NEW** |
| T29 | Cookie banner blocks interaction | **NEW** — the highest-value one for real sites |
| T30 | Modal cannot be closed | **NEW** |
| T31 | Mobile menu fails | **NEW** |
| T32 | Form validation incorrect | **NEW** |
| T33 | Success message, backend failed | **NEW** — needs asserting on a *named* request's status, not just "no 5xx" |
| T34 | Renders but critical API errors | **PARTIAL** — `no-http-5xx` covers it if the API is on the same page load |

Evidence assertions per failure (screenshot, step, URL, timestamp, console,
failed requests, trace, expected, observed, confidence): **all present today**
except `trace` on the pass tier, by design, and `har` (gap B-3).

## 5 · Localization

`localization.yaml` exists and covers language marker + forbidden currency.

| Scenario | State |
|---|---|
| NO/SE/DE visitor gets matching content | **PARTIAL** — checked via `text-contains`, not per-market asserted |
| Currency correct per market | **DONE** — `text-absent` on a foreign currency |
| Date/time format | **NEW** |
| Phone/contact format | **NEW** |
| Regional CTA text | **NEW** |
| Localized canonical | **NEW** — needs a `canonical-is` check |
| `hreflang` | **NEW** |
| No mixed-language components | **NEW** — the hardest; needs per-block language detection |
| Geo redirect target | **PARTIAL** — `url-matches` |
| Manual override beats geo | **NEW** — needs the multi-step journey below |
| Returning visitor keeps choice | **NEW** — needs `storageState` + the same journey |

The named scenario — *Oslo IP → Norwegian homepage → select English → navigate
internally → English persists* — is expressible **today** with existing steps
(`open`, `click`, `assert url-matches`, `assert text-contains`) plus
`storageState` for the returning half. Worth writing as J06 early; it is cheap
and it exposes bad geo-redirect implementations.

## 7 · Performance

DNS/proxy setup, TTFB, load, LCP, failed resources, API times: **TTFB/LCP/CLS/FCP
DONE**; `inp` measured but nothing asserts (C-5); per-request API timing **NEW**.

The comparison table the owner wants is already producible — today's real numbers:

```
                Tønsberg(direct)   Oslo    Bergen   Bodø
TTFB                148ms          363ms   531ms   1923ms
LCP                 240ms          428ms   620ms   2208ms
```

**Flag anomalies, do not set universal thresholds** — agreed, and note Bodø at
2208ms LCP is 88% of the 2500ms budget. A universal threshold would either pass
everything or fail the Arctic.

## 8 · Evidence

| | Scenario | State |
|---|---|---|
| E01 | Successful run artifacts | **DONE** |
| E02 | Failed run artifacts | **DONE** |
| E03 | Reproduction with same seed | **DONE** — `--seed`, recorded in `run.json` |
| E04 | One `runId` per artifact | **PARTIAL** — true in practice, no test asserts it |
| E05 | Missing evidence lowers confidence | **DONE** — `completeness` feeds the evidence axis |
| E06 | Retention by verdict | **DONE** — pass/warning/fail/investigation tiers |

## 9 · Confidence

*"Never allow one successful run → 99"* is **already enforced**: `confidenceFor`
starts a read-the-page failure at 92 and only repetition moves it toward 99;
`attempts: 1` can never reach it. `overall` is additionally **capped by the
weakest axis**, so a perfect journey from the wrong country cannot score high.

**NEW**: a test asserting the two worked examples end to end, and a
**Decodo Network Confidence Score** — a provider-level score distinct from a
run's `geo` axis, aggregating country/city accuracy, premature rotations,
connection failures and latency across n sessions.

## 10 · Agent integration

All **NEW**. Needs an event seam: `content.published`, `ranking.changed`,
`geoqa.finding`. A01–A07 are the payoff of the whole build.

**A03 is the one to build first.** Storing *successful* evidence as a golden
baseline is what makes later regressions detectable, and it costs nothing extra —
the evidence is already written on every PASS.

## 11 · Regression scenarios

**NEW**, and cheap: a regression journey is just a journey file plus a fixture.
The pattern — confirmed production bug becomes a permanent journey — is how this
gets smarter without any learning machinery. Needs a convention:
`journeys/regressions/<ticket>.yaml`.

## 12 · Scalability

1/3/5/10/20 parallel: **this is EXP-007**, defined and never run. It answers what
the matrix concurrency bound should be, which is a guess today (default 2).

Do not fix the bound before the data — already recorded as gap A-3.

## The first 15, re-ordered by what is actually left

Of the owner's 15-test pack, **9 are already proven**. The remaining work:

1. **T03/T04** stickiness at 5 and 10 minutes — a flag (slice 2)
2. **T06** parallel isolation across three markets — run EXP-007
3. **T09** 100 sessions with accuracy maths — the milestone
4. **J03** an internal-search journey — new file, needs `click`
5. **T10** two IP-geo sources, flag disagreement — new, and already known to fire

Then the milestone gate, then agent events.
