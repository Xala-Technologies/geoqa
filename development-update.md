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
