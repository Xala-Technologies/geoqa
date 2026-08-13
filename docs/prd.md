# Product requirements

> **Provenance.** This document is **reconstructed from the codebase** — from the
> implemented behaviour, the acceptance thresholds declared in
> `src/experiments/definitions.ts`, and the rationale recorded in the source
> comments. It is not the original PRD. An external PRD exists and is cited by
> section number in a few places (`PRD §24`, `PRD §37`, and a 10-minute session
> stickiness target); those anchors are listed in
> [§8](#8-external-prd-anchors) and are the only places where a requirement is
> known to exist that this document cannot fully state.
>
> Treat this as the authoritative *implemented* contract. Where it disagrees with
> the external PRD, the external PRD wins on intent and this file should be
> corrected.

---

## 1. Problem

A search-intelligence platform can tell you a keyword is an opportunity, write
the article, and publish it. It cannot tell you that the page it just published
renders at the wrong width, shows the wrong currency, or takes five seconds to
settle for someone in Bergen.

`geoqa` is the layer that goes and looks. It answers one question the rest of a
search/content stack cannot: **what does a visitor in a given market actually
experience on this page, and can we prove it?**

## 2. Scope

**In scope**

- Drive a real browser against a live page under a declared market + device
  identity.
- Verify that identity on both axes — network egress and browser environment —
  and report per-axis verdicts.
- Execute a deterministic journey of actions and checks, and distinguish "the
  page is wrong" from "we could not look".
- Write an evidence package sufficient to reproduce or re-check a finding months
  later.
- Score confidence on separate axes, and refuse to score what was not measured.
- Emit a machine-readable result that another agent can consume.
- Expand and execute a market × device × journey matrix under a bounded
  concurrency limit, in one process.
- Keep the evidence tree bounded in time and size without ever quietly discarding
  the record of a failure.

**Out of scope**

- Writing to any external system: Linear, Convex, a repo, a dashboard. Runs are
  read-only against the world — and structurally so, which is why it is not a
  setting: there is no `readOnly: false` for a code path that does not exist.
- Any LLM in the measurement pipeline. Adaptive/natural-language journeys are
  explicitly deferred (see [§8](#8-external-prd-anchors)).
- Search/SERP observation.
- Fixing anything it finds.
- Scheduling. A matrix is a command a human types; nothing runs on a clock.

Concurrency **left** this list. It was out of scope for Phase 0 because one
profile was one whole Chrome; the per-context proxy made it possible and the
bounded matrix runner spends it (R-84…R-89). The bound itself is still an
unmeasured guess until EXP-007 runs.

## 3. Functional requirements

### Geographic identity

- **R-1** Geography is treated as **two independent axes**: network identity (the
  IP the server sees) and browser environment (what the page's JavaScript
  believes). They are configured by different mechanisms and verified separately.
- **R-2** Both axes are observed **through the browser under test**, never
  through the host's own HTTP client.
- **R-3** Every axis yields one of exactly three verdicts: `match`, `mismatch`,
  `unverified`. `unverified` means no reading was obtained and is neither a pass
  nor a failure.
- **R-4** A geo profile is **self-contained** — it embeds its market rather than
  referencing one by id — so an evidence package can answer "what was this run's
  identity?" from one artifact, without also needing the config file as it stood
  that day.
- **R-5** Verified axes: egress country, egress city, `navigator.language`, `Intl`
  timezone, rendered viewport width.
  - Country is compared case-insensitively on ISO-3166 alpha-2.
  - City comparison is **loose and asymmetric**: a city can be proven right, not
    proven wrong. Egress databases name the exchange's suburb, not the city a
    human would say, so a non-matching city is `unverified`.
  - Language is compared on the primary BCP-47 subtag (`nb-NO` and `nb` agree).
  - Timezone is exact — a wrong clock changes rendered dates and opening hours.
  - Viewport is compared on **width only**; height varies with browser chrome and
    no responsive breakpoint keys off it.
- **R-6** The device profile is applied **before** any observation, and the
  applied viewport is **read back** rather than assumed.
- **R-7** Geo verification runs **before** the journey, so a wrong-market run is
  not paid for in wall clock and then dressed in an authoritative evidence
  package.
- **R-8** A provider that cannot serve the requested market fails the run. There
  is no silent fallback to direct egress.
- **R-9** Direct (non-geographic) egress always emits an explicit warning that
  geographic claims are unproven.
- **R-66** The market matrix is **data, not code**: one profile file per market ×
  device, with its `id` equal to its filename, so `geoqa profile list` *is* the
  matrix and a market covered on only one device is visible at a glance. Adding a
  market is two files and no commit to `src/`.
- **R-67** Every market is declared on **both** device kinds. A device-specific
  defect is the class the first live run hit — CLS 0.76 on desktop, passing on
  mobile — so a market tested on one device is not a covered market.
- **R-68** A device identity is more than a box. The mobile user agent, device
  scale factor, touch support and `isMobile` come from a **named device
  descriptor** (`device.emulate`), because a hardcoded user-agent string goes stale
  the next time Chrome ships. The profile's own `viewport` is applied **after** the
  descriptor, so the declared box always wins over the descriptor's — the viewport
  is a verified axis (R-5) and must mean what the profile says.

- **R-105** Egress geography is corroborated by a **second, independent IP-geo
  database**, and a disagreement about the COUNTRY caps the run's network-identity
  confidence. Measured: one Decodo ISP exit resolved to São Paulo per Decodo's own
  endpoint and New York per ipinfo, for the same IP. Either reading alone is
  confident and coherent, and one is wrong — a wrong database looks exactly like a
  wrong proxy, and the two need opposite fixes. A different vendor, never a mirror:
  two endpoints reading one MaxMind snapshot would agree about being wrong.
- **R-106** Corroboration compares **country only**, and never compares two
  readings taken from **different IPs**. Both restrictions exist to stop the engine
  manufacturing findings out of its own instrumentation, which is the failure mode
  it exists to detect in others. Cities diverge between databases as a matter of
  course — one live Norwegian exit was placed in Stavanger and Bærum by two
  sources, 400 km apart — so city divergence is recorded and never a verdict. And
  because `ipinfo.io` publishes no AAAA record, a dual-stack corroborating host is
  read over IPv6 while the primary is read over IPv4: two addresses, two visitors,
  nothing comparable. The corroborating host is pinned to IPv4 for that reason,
  which was measured after a real run reported two different addresses.

### Journeys

- **R-10** A journey is a YAML list of actions and checks. It is **deterministic**:
  the same file against the same page produces the same steps in the same order.
  No natural-language steps, no LLM.
- **R-11** Steps support variable substitution (`{target}`, plus `--var k=v`). An
  unknown placeholder is left intact rather than replaced with an empty string —
  `open ""` would navigate somewhere meaningless and report a page failure for
  what is really a config typo.
- **R-12** Severity is declared **per step**. A missing CTA on a conversion probe
  and an LCP 200 ms over budget are different kinds of news; forcing both to fail
  the run equally trains the owner to ignore it.
- **R-13** A step may override the finding category derived from its check kind —
  the same `text-absent` check catches a content bug in one journey and a leaked
  foreign currency in another, and those go to different people.
- **R-14** A check reads only what it needs. Vitals and a11y each cost a real
  round-trip and are not fetched for journeys that do not assert on them.
- **R-15** State-changing steps are fatal: after one fails, subsequent steps are
  `skipped`, never executed-and-passed. Observations (assert, screenshot,
  snapshot) never halt the run, so one pass collects every failure.
- **R-16** A negative or absent reading is **confirmed after a settle** before
  being reported — an element mid-animation and an asynchronously emitted LCP
  otherwise produce defects that do not exist.

- **R-107** At least one journey **clicks**, and its click is verified by a real
  navigation rather than by a successful call. A fake click always succeeds: it
  cannot say whether the browser followed the link, whether the next page loaded,
  or whether the checks after it ran against the page they were written for. The
  proof is a results page whose links are dead — a 4xx finding on a step that runs
  after the click cannot appear unless the browser really navigated.
- **R-109** A persistence claim is asserted **positively as well as negatively**. A
  `text-absent` check is trivially true on a page that never contained the word, so
  a negative assertion alone cannot prove that a language, a session or a choice
  survived — measured: an override journey asserting only the absence of a
  Norwegian marker reported PASS against a deliberately broken override, because the
  marker existed on the landing page and nowhere else. A vacuous check is worse than
  a missing one: it occupies the place where a reader believes a claim is made.
- **R-111** Every ACTION resolves to the first **visible** match, not the first
  match in document order. Nobody writes a click step for an element the visitor
  cannot see, and a union like `[hreflang='en']` otherwise resolves to a `<link>` in
  `<head>`: invisible, unclickable, thirty seconds of actionability timeout, and an
  instrumentation failure standing where a real reading should be. The same applies
  to `fill`, `select` and `check`, which additionally raised a strict-mode violation
  on any selector matching more than one element.
- **R-154** Page content is captured as **measurements, never prose**. A page can contain
  personal data, and an evidence tree accumulating the rendered text of every page on a
  customer's site would be a data-protection liability created for a word count. A word count,
  shingles, headings and link targets answer every content question without any of it being
  readable.
- **R-155** A content signal states **what it is scoped to**. An orphan within a sweep is a much
  weaker claim than an orphan on the site, and a report that blurred the two would send somebody
  hunting for links that exist.
- **R-151** A trend **never interpolates**. A run that did not measure a metric contributes a
  gap, not an estimated value, because drawing through it fabricates the one thing the reader is
  looking at. Gaps are counted and reported, so a trend computed from six of forty runs cannot
  read as a trend over forty.
- **R-152** A direction is **refused below a minimum sample** and below BOTH a relative and an
  absolute floor. "Getting worse" from three runs is noise with a narrative; a 14% move on a
  1ms reading is 0.15ms, which nobody has ever acted on. A dashboard that cries wolf is one
  nobody opens.
- **R-153** A metric where **higher is better** does not share the comparison with metrics where
  lower is. Confidence rising is an improvement, and reporting it as "worsening" would be the
  kind of inversion a boolean argument at a call site makes inevitable.
- **R-147** The UI is **static** and read-only: one JSON file written beside the evidence,
  fetched by an app that is a directory. No server means no port, no auth surface and nothing
  to keep running. Electron was declined on the recorded criterion — nothing needs filesystem
  access beyond a served directory, since evidence is files a browser reads over HTTP.
- **R-148** Every value a UI displays arrives as a **`Measured<T>`**: a reading with its
  formatted text, or an explicit absence carrying the reason. A renderer cannot show a
  missing metric as a value, because an absence is a different TYPE from a reading — and a
  dashboard is exactly where a number gets believed, so "we could not look" must not arrive
  as `0` at the last step.
- **R-149** Zero is a **real reading** where zero is meaningful. A CLS of 0 means nothing
  moved, which is the best possible answer; a truthy check instead of a null check would hide
  every perfect score.
- **R-150** `ERROR` and `unverified` get their **own tone**, never the failure tone. An ERROR
  is our defect and a site failure is the site's; an unverified city is unproven rather than
  wrong. Colouring either like a failure would put back the conflation the verdict model
  removed.
- **R-144** Site analysis answers the question a crawler from one datacentre cannot: does
  this page behave differently **depending on where the visitor is**? Verdict divergence
  across markets, the latency spread with its factor, and pages measured in some markets but
  not all — because a page nobody measured in a market is not a page that works there.
- **R-145** A signal that cannot be computed from the evidence is **not approximated**. Thin
  pages, orphans and near-duplicate cannibalisation need page text and the link graph, and a
  run records neither; a thin-page report built on a guess about page length is worse than
  none, because somebody would rewrite a page over it. The evidence change that would close
  it is recorded instead.
- **R-146** An `ERROR` run is **excluded from every cross-market comparison** and counted in
  a warning. Including it would make our own instrumentation failure look like a market where
  the site behaves differently.
- **R-141** Publishing is **gated on a verdict the producer did not compute**, and geoqa's
  half of that pipeline is the gate alone. Generation and publishing stay outside: a
  generator living inside the verifier would collapse the separation that makes the verdict
  worth anything, and the first time an LLM in this repo wrote a page this repo then
  approved, the approval would mean nothing.
- **R-142** The gate has **three** states and `unknown` still blocks. `block` means a
  measured problem with the page; `unknown` means geoqa could not measure and is OUR defect.
  They are different sentences, not different outcomes — telling an author their page is
  broken when the truth is that our browser could not read it wastes their time and costs
  the gate its credibility.
- **R-143** The gate is **default deny**. No run, a thrown error, an errored run, an unread
  step — every one blocks, and the exit code is 0 only for `allow`. A gate that opens when
  it cannot see is not a gate, and the absence of a verdict is not a verdict.
- **R-137** Keyword research is a **capability, not a company's spreadsheet**. Seed terms,
  their audiences and their per-term markets are tenant data; the engine holds a generic
  intent vocabulary and knows only a market's country, city and language. An intent
  taxonomy naming one tenant's market segments would be wrong for the second tenant.
- **R-138** The keyword agent **produces; geoqa verifies**. It asks the SERP where a tenant
  stands and the answer comes from the measuring side, with the same three states as every
  other reading. An agent that scored its own output would be the failure this system
  exists to catch.
- **R-139** A research run is **refused before it spends anything** when it would exceed
  the search budget or the provider's remaining quota, and the provider's health is probed
  FIRST. An account exhausted halfway through leaves the second half of a report silently
  unmeasured, and a report with a hole in it that averages the rest is worse than no
  report. A duplicate seed is refused for the same reason: each query is a real credit, so
  a repeat is a doubled bill rather than a harmless typo.
- **R-140** A "things to fix" list contains only **measured** absences. Including queries
  nobody managed to run would send somebody to rewrite a page over a billing problem — and
  it is exactly the kind of list that gets acted on without being read closely.
- **R-136** A session key placed inside a vendor's username contains **no separator the
  vendor parses**. A residential proxy username is a `-`-delimited parameter list, so a
  hyphenated session value is silently truncated at its first hyphen — which collapsed every
  run in a market onto one sticky exit while `egressHeld` reported `match`, because the IP
  genuinely did hold: it was the same one every time. A guard that asks "did this run hold
  its IP" cannot see "this run holds the IP every other run also holds".
- **R-132** A search source's `health()` is a **real probe** distinguishing bad
  credentials from an exhausted account. Valid credentials with no quota left is
  `unusable`, not usable: a search source that cannot answer is worse than an absent one,
  because empty results read as "nobody ranks". A missing quota figure is "does not say",
  never zero.
- **R-133** `searchObservation` has **three** states. The provider could not answer →
  `null`. Results came back and we are not in them → a real low score, expressed as a
  small number rather than 0 so a measured absence is distinguishable from an unmeasured
  one. Results came back and we rank → scored by position. "No results at all" is `null`,
  because an exhausted account, an unparsed response and a genuinely empty SERP are
  indistinguishable, and "your site is invisible" is too alarming a claim to make on that.
- **R-134** Search visibility is **not folded into `overall`**. The other axes answer
  whether a run's readings can be believed; this one answers whether a page is visible in
  search. Averaging them would let good search visibility disguise a run that could not
  read the page.
- **R-135** A city-scoped search **resolves** the city against the provider's own
  gazetteer, filtered by country, and REFUSES when it cannot. `Oslo` matches
  `Oslo,Minnesota,United States` as well as `Oslo,Oslo,Norway`, so an unfiltered first
  match would run a Norwegian market's SERP from Minnesota. Dropping an unresolvable city
  and searching the whole country would be worse still: the caller asked what a visitor in
  that city sees.
- **R-129** Runs are queryable across time, and the index is a **derived cache** over
  the evidence tree rather than the record itself. Each run's own artifact is the
  authority on that run, so a corrupt or deleted index costs nothing permanent and is
  rebuildable. A store that owned the record would introduce the failure this system
  exists to prevent — a confident answer about runs that did not happen the way it says.
- **R-130** Appending to the index can **never fail a run**. A run that verified a site
  correctly and wrote its evidence has not failed at anything a user cares about if a
  cache line could not be written.
- **R-131** A regression is a check that **used to pass** in the same
  profile + journey + target, reported once at the transition. A failure with no earlier
  pass is not a regression; it may never have worked. An `ERROR` run is skipped rather
  than counted as a failed check, because `ERROR` means geoqa could not read the page,
  and reporting our own instrumentation failure as the site's regression is the one
  confusion this system refuses to make.
- **R-126** A profile or journey id is **not a path**. It becomes a filename, so it is
  constrained to lowercase letters, digits and inner hyphens, and every resolved
  candidate is re-checked to be inside the directory it belongs to. Before this,
  `--geo ../../../../etc/hosts` resolved outside the profiles directory and tried to
  read it: only `.yaml` files were reachable, but the id came from the command line, the
  resolved path was echoed back, and a YAML parse error can quote the line it failed on.
- **R-127** A tenant may carry its **own** profiles and journeys, resolved before the
  shared set and overriding by name, with fallback for everything it has not customised
  — so a tenant tightens one budget without forking the engine. A listing shows the
  override INSTEAD of the shared entry, never both: a listing that disagreed with the
  resolver would be worse than no listing.
- **R-128** A name that matches nothing says **where it looked**. The loader's ENOENT
  tells a reader about the filesystem; the operator's mistake was a typo.
- **R-123** A tenant's proxy budget is enforced **before anything launches**, not
  discovered as a 407 mid-sweep. A matrix is expanded first so the check knows the real
  page count: a 430-page sweep against a tenant with 100 MB left is refused before the
  browser starts, rather than dying at page 90 and leaving 340 pages unmeasured while
  an operator debugs a proxy that is fine.
- **R-124** Traffic is read from the **vendor** and the run count is derived from **our
  own evidence tree**, and the two are not interchangeable. Bytes are counted at the
  proxy, so an estimate that drifted would be worse than none because it would be
  trusted; and the vendor has no idea what a run is. The run count is derived rather
  than stored, because a counter file can be deleted, written twice or left behind by a
  crash, and every one of those makes a ceiling wrong in the direction that lets work
  through.
- **R-125** A usage figure that could not be read is **unmeasured, never zero** — the
  same rule as every other reading in this system. It warns and proceeds rather than
  blocking, because with a vendor-enforced cap per sub-account exhaustion is isolated to
  the tenant that caused it, and refusing every tenant's work because a usage API is
  down would cause more harm than it prevents. The warning states that the guard is not
  in force. When the vendor enforces no cap of its own, that is said out loud too: a cap
  geoqa enforces can be bypassed by a bug in geoqa, and one the vendor enforces cannot.
- **R-118** A tenant is **data**, in `tenants/<id>.yaml`, with the same reasoning as a
  profile: it cannot reach the browser, a non-engineer can edit it, and it diffs in a
  review. Unknown keys are an error — a misspelled `retentionDay` that silently became
  the default is a retention policy somebody set on purpose and never got.
- **R-119** A tenant file holds the **NAME** of an environment variable for its proxy
  credentials, never a credential. A registry holding secrets is the `.env` mistake
  moved somewhere with worse odds.
- **R-120** Evidence is written under `<root>/<tenantId>/<runId>`, and **a path that
  can escape its tenant's root is a security defect, not a bug.** The id is
  constrained by pattern AND the resolved path is re-checked, because one line of
  defence against traversal is a line somebody eventually finds a way round.
  Containment is tested by `path.relative`, never by `startsWith`: `/evidence/acme`
  starts with `/evidence/ac`, so a prefix test places tenant `acme` inside tenant
  `ac`'s root and calls it contained. An absolute segment is refused too — 
  `path.resolve("/evidence", "/etc")` is `/etc`, which discards the root entirely.
- **R-121** A tenant id is lowercase, because macOS and Windows filesystems are
  case-INSENSITIVE while Linux is not. `Acme` and `acme` would be two tenants in CI
  and one tenant on a developer's laptop — a cross-tenant read that only reproduces on
  the machine nobody tests on.
- **R-122** A tenant declares the sites it **owns** and the markets it asked for, and
  both are refused before anything launches. Ownership is compared by **origin**, never
  by prefix: `https://acme.no.evil.test` starts with `https://acme.no` as a string, and
  a prefix test would authorise an attacker's host. This is not bureaucracy — the
  engine drives a real browser from residential IPs on a schedule, so a target
  allowlist is the difference between a QA runner and something that looks like
  distributed traffic aimed at whoever the URL names.
- **R-114** `run.json` records what kind of visitor a run ACTUALLY was, not what its
  profile declared. A profile saying `returning` and a run that restored nothing were
  indistinguishable in the evidence, which is the same class of lie as an unmeasured
  metric reported as fine. The declaration is an intention; `restored` is an
  observation, and only one of them is evidence.
- **R-115** An unknown device descriptor **refuses the launch**. The alternative fails
  invisibly in every direction at once: no descriptor applied, so no mobile user
  agent, no touch and no device scale factor; `setDevice` still answering `ok`, because
  it compares the requested name against the name the context was built with; and the
  profile's own viewport matching regardless. The run then reports a clean mobile
  verification while presenting a desktop identity to any site doing UA detection.
- **R-116** A DECLARED device identity is a **verified axis**. `navigator.userAgent`
  was observed on every run and compared to nothing. A profile that declares no user
  agent gets `unverified` rather than a pass — a claim nobody made cannot be verified,
  and inventing an expectation from the device kind would report a mismatch on every
  mobile profile that deliberately carries no descriptor.
- **R-117** A responsiveness budget may only be asserted **after an interaction**, and
  an unmeasurable INP is neither a pass nor the site's fault. INP does not exist until
  something has been clicked, pressed, filled or scrolled — and even then a page whose
  handler does nothing expensive responds faster than the browser reports, so `null` is
  a fact about the page. A budget met by never touching anything is the emptiest green
  tick available; blaming the site for the journey's step ordering is the opposite
  error.
- **R-113** `--engine` and the configured verify endpoint reach **every** command
  that opens a browser, experiments included. An experiment whose samples are taken
  through an engine nobody asked about answers a different question than the one
  printed at the top of its summary — and for EXP-000, whose subject IS the adapter,
  it answers no question at all. Absent means the default engine, so an experiment
  re-run without the flag stays comparable with its own stored results.
- **R-112** A step that can NAVIGATE records the URL it landed on. Without it a
  click records nothing, and any check that fails afterwards cannot be attributed —
  a live run failed a language-persistence check and the evidence could not say
  which page had been reached, so a site defect and a badly chosen marker were
  indistinguishable. Evidence that cannot answer "where were we" cannot answer the
  question it was collected for.
- **R-110** A selector in a **click, fill or press** step names ONE element, not a
  family. A CSS comma is a union resolved in document order rather than a preference
  list, so a broad union clicks whichever element appears first in the page — which
  is a logo on most sites, and was the nav's Home link on the fixture that exposed
  it. The same union is correct in an ASSERTION, where "does this site have
  navigation" is answered by any match.
- **R-108** An empty result set is a **correct answer**, not a defect. A search for
  a term a site does not contain returns nothing, so a journey may only assert a
  minimum result count when the caller supplies a term known to match — which is why
  the query is a variable. A runner that reported every fruitless search as a
  finding would be manufacturing defects out of its own inputs.

### Honest verdicts

- **R-17** A failed assertion (read the page, it was wrong) and a broken tool
  (the reading never arrived) are **different events**, counted separately.
- **R-18** An unreadable step is categorised `instrumentation`, its severity is
  forced to `high`, and it is **never filed against the site**.
- **R-19** `ERROR` outranks `FAIL` in the run verdict, because "we do not know"
  and "the page is broken" lead a human to different next actions.
- **R-20** No code path may return success with absent data. Every browser call
  returns typed data or a named failure kind.

### Evidence

- **R-21** Retention is tiered by verdict: a passing run keeps almost nothing, a
  failure keeps everything (including HAR and trace), and an `ERROR` keeps the
  most because that is when we know least and need most.
- **R-22** A required artifact that could not be produced is still **described**,
  at zero bytes, and listed in `missing`. A package that quietly omits the
  console log on a JavaScript failure must not look identical to one where the
  console was clean.
- **R-23** `completeness` is the share of required artifact **kinds** present, not
  a file count.
- **R-24** An evidence package must answer: what happened, where, when, in which
  market, on which device, at which journey step, can we reproduce it, and what
  technical evidence exists. (Encoded as `REQUIRED_QUESTIONS`.)
- **R-158** "Can we reproduce it?" is answered by the **package**, not only by the
  result. A finding's `reproducibility` and the evidence's attempt count are derived
  once and written to both, because two derivations of one number are two chances to
  disagree — and a finding claiming 3-of-3 beside evidence recording something else
  leaves no way to tell which is lying. A single-attempt run records nothing rather
  than a `1`, which would read as a decision not to repeat.
- **R-159** An occurrence count is keyed per **step**, not per label. Labels are not
  unique — an unlabelled assert's label is its check kind — so a label-only key merges
  two steps into one count and can report `reproduced` for a step never seen to fail
  twice. Sound because a journey is deterministic (R-10): index N is the same step in
  every attempt.
- **R-25** Redaction happens **at write time**, not on export: URL credentials,
  sensitive query parameters, emails, and Norwegian national ID numbers.
- **R-26** Proxy credentials are resolved from environment variables only, never
  from a config file, and are masked anywhere they could reach a human — log, run
  summary, or manifest.
- **R-160** An artifact that can only be flushed by ending the session is collected
  **last**, and the primitive that flushes it does the ending rather than refusing.
  Refusing accurately is not the same as being right: the manifest reported a HAR
  missing on every fail-tier run, for a file that appeared seconds later when the run
  closed the same context. `close` is idempotent so the flush and the run's own
  teardown do not double-save a visitor session.
- **R-161** An artifact armed on every run but retained by only some tiers is
  **deleted** after the flush when the manifest does not list it, and the deletion is
  logged. Pruning walks the manifest, so an unlisted file is one nothing would ever
  remove — the asymmetric retention policy bypassed for exactly the artifact carrying
  the most personal data.
- **R-27** Screenshot personal data is **not** claimed to be solved. It is
  *bounded*: any page with a form or an authenticated session is flagged
  `review`, and the manifest carries a privacy note naming those artifacts. The flag
  is per ARTIFACT, not per screenshot: a HAR omits response bodies at creation but not
  request bodies or `Cookie` headers, so it can hold a filled credential — and unlike
  an image it is grep-able. The note says "artifact(s)" for that reason.

### Findings

- **R-28** One finding per non-passing, non-skipped step. A skipped step is not a
  finding — filing it would double-count the failure that halted the run.
- **R-29** Every finding carries a `validationMethod`: the concrete steps a human
  takes to re-check it by hand. For an instrumentation finding, that text says it
  is *our* defect until it reproduces with a working browser.
- **R-30** Finding confidence is independent of run confidence, and reflects the
  strength of the claim: a check that read the page starts high, an
  instrumentation failure starts much lower, and repetition across attempts moves
  it.
- **R-31** Findings are ranked most-severe first, then most-confident.
- **R-32** The share of findings that are about the *site* rather than about *us*
  is itself reportable (`siteFindingShare`).

### Confidence

- **R-33** Confidence is **five separate axes** — network identity, browser
  environment, journey execution, evidence completeness, search observation — not
  one vague score.
- **R-34** `overall` is a weighted combination **capped by the weakest axis**. A
  run that executed perfectly from the wrong country is not a high-confidence run.
- **R-35** Unreadable steps depress the journey axis far harder than failed ones.
- **R-36** An unmeasured axis reports `null`, never a number. `searchObservation`
  stays `null` until a SERP source exists.
- **R-37** Confidence carries `notes` stating in words why the number is what it
  is.

### Orchestration

- **R-38** One run is **one atomic unit of work, start to finish**. No persisted
  intermediate state that a separate scheduled process must later pick up, so
  there is nothing to orphan when a process dies.
- **R-39** The same stage implementations serve both the in-process CLI and the
  durable Temporal path. Stages take dependencies as arguments and may not import
  the workflow engine.
- **R-40** Retry policy is **per stage**, and the journey stage does **not**
  retry: a silent second attempt would convert a real intermittent site failure
  into a pass. Flakiness is measured by running the journey N times on purpose.
- **R-41** Cleanup runs even when the run has already failed.
- **R-42** A durable run's execution history is the audit trail — a run that
  dropped its work must not look identical to an idle one.
- **R-43** Matrix runs (market × device × journey) are child workflows, so one
  market failing does not take the matrix with it and each run keeps its own
  retry budget and inspectable history.
- **R-44** A provider failure freezes that provider for a cooldown period, and a
  subsequent success **clears** it.

### Measuring flakiness instead of hiding it

- **R-69** Repetition is **asked for explicitly** (`--repeat N`, default 1) and is
  the only mechanism by which a journey runs more than once. It is the measured
  alternative to the retry R-40 forbids: every attempt is kept and reported, and
  none of them is a second chance at a green result.
- **R-70** All N attempts run inside **one** browser and **one** network session,
  so a repeated run is still one visitor (R-48). A session per attempt would take
  LCP from one visitor and CLS from another, and nothing measured could be
  attributed.
- **R-71** Attempt *k* runs at `seed + k`. Attempts that made identical choices
  would measure the site's behaviour under one pacing N times rather than measuring
  variability, and deriving the per-attempt seeds from the base one keeps the whole
  set replayable from a single number (R-60).
- **R-72** A merged result takes the **worst** outcome seen at each step index, and
  keeps that attempt's detail, expected and observed. Reporting the last attempt
  would file **no** finding for a check that failed once and passed twice — hiding
  the exact event the repetition exists to surface, which is the damage of a silent
  retry arrived at from the other end. Keeping the whole record means a finding
  quotes a reading that actually happened rather than a blend of two attempts.
- **R-73** Every finding states in how many attempts it appeared. All of them is
  `reproduced` and near-certain; one of several is filed at markedly lower
  confidence, because "we saw it once and could not repeat it" is a weaker claim
  than "it failed every time" and the report must say which one it is. Occurrences
  are counted once per attempt, so they can never exceed the attempt count and
  `reproduced` never becomes unreachable.
- **R-74** A whole-set measurement counts as seen in **every** attempt. The closing
  egress check (R-49) is measured once for the set, not once per attempt;
  discounting it as "1 of 3" would understate the only reading there was.
- **R-75** A journey declaring `writes: true` under `--repeat N` changes state on
  the target N times, and the run announces the count before the first attempt.
  Three contact forms is a different act from one, and the operator learns that
  before it happens (R-64).

### Behaving like a visitor

- **R-57** Journeys exercise **functionality**, not only reading: search,
  registration, login, contact forms and CRUD. The DSL therefore carries input
  actions (`fill`, `press`, `select`, `check`) alongside navigation.
- **R-58** Pacing is **human and bounded**: a `pause` declares a range and the
  length is drawn from it, because a runner that acts every 500ms produces a load
  pattern and a set of timings no visitor produces — and never lets a page finish
  settling.
- **R-59** Optional behaviour is expressed as a per-step `probability`, so a set of
  runs is representative rather than eleven identical robots.
- **R-60** All variation is **seeded**. The seed is part of the run's identity,
  recorded in the evidence, and settable, so a failing varied run can be repeated
  exactly. Unseeded realism is not acceptable: it trades away the reproducibility
  the evidence package exists to provide.
- **R-61** An optional step that did not happen is reported `skipped`, never
  omitted — a check that did not run must stay distinguishable from one that
  passed, and the step indices must not shift.
- **R-62** Variation is for REALISM, never for evading detection. No fingerprint
  spoofing, no CAPTCHA circumvention, no synthetic mouse telemetry, nothing whose
  purpose is to convince a third party that automation is a person.

### Handling what a visitor types

- **R-63** A `fill` or `select` value is a **secret**. It is supplied at run time
  (never committed to a journey file) and must not reach a step record, a log
  line, a command string, or any evidence artifact. What is recorded is which
  selector was filled.
- **R-64** A journey that changes state on the target declares `writes: true`. The
  run announces it before starting and records it in the evidence, so a run that
  created records can never look identical to one that only read pages.
- **R-65** When a run touched a form or declared writes, its screenshots are
  flagged for review. Personal data in an image cannot be detected, so the only
  honest response is to bound it and say so.

### Network sessions

- **R-48** **One journey is one network session.** A run opens one egress
  identity and keeps it from first navigation to last. Rotation *between* runs is
  wanted — it stops a single anomalous exit standing in for a market — but
  rotation *within* a run makes the measurement incoherent, because one metric
  then describes one visitor and another describes a different one.
- **R-49** Session stickiness is **verified, not trusted**: the egress identity is
  re-read after the journey and compared to the opening reading. A proven
  rotation is an `instrumentation` failure that takes the run to `ERROR`; an
  unreadable closing probe is `unverified` and does not discard the run.
- **R-50** The stability check must not disturb the page under test. Evidence is
  collected after the journey, so a check that navigated away would make vitals,
  console, network and the a11y tree describe the probe endpoint instead of the
  site.
- **R-51** A provider's session identity is **expressible in the proxy URL**
  (`{session}`), because residential vendors offer no API for stickiness and encode
  the key in the proxy username. Substitution applies to whichever env source
  supplied the URL, not to the template alone: a URL pinned to one market is
  precisely the case that most wants a sticky key. The session id is minted before
  the URL is resolved, so the key in the username and the key reported on the
  session are the same string — a run must never claim a stickiness it did not ask
  the vendor for.
- **R-76** Placeholder substitution must not corrupt credentials. An unknown
  placeholder is left **verbatim** rather than blanked, because emptying part of a
  username authenticates as somebody else instead of failing; and the URL is
  validated **after** substitution, so a vendor shape that only parses with the key
  in place is accepted while a key that cannot live in a URL refuses the run.
- **R-52** The vendor's sticky window must exceed the journey's wall-clock
  allowance, or the retry policy and the vendor disagree about how long a run may
  last. Under `--repeat N` the window must exceed **N** journeys, since all N run
  inside the one session (R-70).

### Browser engines

- **R-53** The engine is replaceable behind `BrowserRuntime`, and is part of a
  run's identity (`RunSpec.engine`) because two runs of the same journey on
  different engines are not the same run.
- **R-54** An engine that throws must have its throws mapped onto the shared
  failure kinds. No engine-specific failure kind may reach above the seam.
- **R-55** A capability an engine cannot provide at that point in a session is
  **refused with a named failure**, never silently no-opped — so the manifest
  records the artifact as missing rather than the package merely looking complete.
- **R-56** Constructing a runtime must not launch a browser. Sessions open on
  first use, so a stateless Activity can rebuild a runtime from a serialisable
  spec.

### Interface

- **R-45** Every command supports `--json`, and the JSON shape is the integration
  contract. Agent-to-agent use must never depend on parsing human-readable
  output.
- **R-46** Exit codes are meaningful: a `FAIL`/`ERROR` run exits non-zero; an
  experiment exits non-zero only on a measured `fail`, never on `unmeasured`.
- **R-47** The process exits only once stdout and stderr have drained — a bare
  `process.exit()` discards queued pipe output, which is the one place anybody
  debugs from.

### Configuration

- **R-77** Project-level defaults live in **one** optional file,
  `geoqa.config.json` in the repo root. Precedence is **flag > config file >
  built-in default**, uniformly, with no per-command exceptions — a precedence
  order that varies by command is one nobody can predict from the help text.
- **R-78** A key that appears in the example file must be **honoured**, and a key
  the design will not honour must be **absent**. Half a config surface is worse
  than either whole one: a documented setting that has no effect is indetectable
  from the outside, because nothing ever contradicts the person who set it.
- **R-79** Every default is **imported from the constant the code already uses**,
  never retyped. A hand-copied default is a second source of truth whose drift is
  invisible: the config keeps serving the old number after the constant moves.
  Where a constant is legitimately private to its module, the config key is left
  *unset* rather than duplicated, and "unset" means "that module decides".
- **R-80** An **unknown key is rejected**, not ignored. A silently dropped
  `verifyEndoint` typo is the same failure as R-78 arrived at by accident.
- **R-81** An **absent file is not an error**, and the run states which of the two
  it used. A run on defaults because the file sits one directory up must not look
  identical to a run that honoured it.
- **R-82** A malformed, schema-violating, credential-bearing or
  **unreadable-but-present** file **stops the run**. Falling back to defaults for a
  file somebody edited on purpose is precisely the defect the config surface exists
  to close. "File not found" is the only condition that means "no config".
- **R-83** Credential-shaped keys are **refused by name**, with a message naming
  where the value belongs (R-26), rather than as a generic unknown key — which
  invites the reader to conclude the feature does not exist yet and try harder. A
  config file is committed, backed up and diffed by people who never intended to
  handle a password.

### The market matrix

- **R-84** The expansion of market × device × journey is a function of the axis
  **set**, not of argument order: axes are deduplicated and sorted, so two
  orderings of the same request produce byte-identical output and one scenario key
  always means the same scenario.
- **R-85** **Every** profile and journey the expansion needs is validated before
  anything launches, and one bad name refuses the whole matrix, listing all of
  them. Discovering a typo ninety browser launches in is not a report, it is a
  bill.
- **R-86** One scenario failing never ends the matrix, and a scenario that could
  not be executed **at all** is recorded as `unmeasured` with its reason — never
  dropped, and never absent. A gap in the results must not read as a market that
  was fine. This includes a *preparation* that refused (R-8): a refusal to
  downgrade arrives here as data.
- **R-87** Concurrency is **bounded, declared and measured**: the result records
  both the limit applied and the peak actually reached. The default is documented
  as provisional against EXP-007, because each in-flight scenario costs a browser
  context and, on the daemon engine, a whole Chrome — and picking a parallelism
  number before measuring is how the first OOM happens.
- **R-88** A per-scenario seed is **derived from one base seed** and the scenario's
  own key, so scenarios differ from each other (R-71's argument, at matrix scale)
  while the whole matrix replays exactly from a single number (R-60).
- **R-89** At matrix scale a write is **counted and consented to in advance**, not
  merely announced: a run of state-changing journeys across the matrix is one real
  form, registration or booking per scenario, and the operator is told the number
  and must pass an explicit flag before anything launches. A dry run states the
  count for free.
- **R-101** A site-wide sweep runs **inside the bounded pool**, as a page axis on the
  matrix (`--urls-file`), never as a shell loop around the CLI. The first sweep was
  430 pages driven from a loop alongside three other browser fleets, and it made a
  `selector-visible` check report a missing `h1` on six pages that demonstrably had
  one — all six passed re-run alone. An engine whose own load can manufacture a
  site defect is worse than no engine, so the URL list belongs where the
  concurrency bound, the per-scenario seed and the write consent already apply.
- **R-102** A URL list is **fully validated before anything launches**, with the line
  number of every bad entry, and one bad line refuses the whole matrix — the same
  rule as a mistyped `--market` (R-84). A non-http scheme is refused by name: a
  `file:` URL would let a matrix pass against local disk while claiming to have
  visited a site. Order and duplicates are preserved, because sitemap order is
  meaningful to whoever reads the results and a repeated URL is a legitimate second
  sample.
- **R-103** Two pages sharing a profile, a journey and a millisecond get **distinct
  run ids**. A run id is `run_<ms>_<slug>` and becomes an evidence directory name,
  so without this the second page overwrites the first page's manifest — a sweep
  losing runs while reporting a full count. The scenario's index disambiguates, not
  its URL: a URL contains `/` and `:`.
- **R-104** An identity may be named by **place** (`--country`, `--city`, `--device`)
  and not only by profile id, and the place is **resolved against the profiles that
  exist** — a place with no profile refuses and lists the ones there are. Naming
  both a profile and a place refuses rather than ranking them: two identities have
  no correct answer, and silently picking either produces a run reporting a city
  nobody asked about, which is the single worst failure this engine can have. A
  matrix names its identities with `--market`, and refuses the place flags rather
  than resolving one it would never read.

### Evidence has a shelf life

- **R-90** Retention tiers (R-21) decide what a run **captures**; a separate
  policy decides how long it is **kept**. Neither can substitute for the other, and
  unbounded local accumulation of packages that "may contain personal data" (R-27)
  is a liability rather than a disk-space question.
- **R-91** Planning never deletes and the **default is a dry run**. There is no
  flag to forget: destruction is opt-in, because a destructive default is how
  somebody loses the one trace that mattered.
- **R-92** Age ceilings are **asymmetric in the same direction as retention**: a
  passing run's artifacts are cheap to discard because they are cheap to
  *regenerate*, while a failure's trace may be the only copy of a bug that never
  recurs.
- **R-93** A privacy flag **shortens** a ceiling and never extends it, and a
  flagged run is never selected to free disk space. A disk-space job must not be
  the thing that quietly removes the only record of what was exposed.
- **R-94** A cap that could not be met is **reported as a shortfall**, and a run
  whose identity cannot be established is reported and **left in place**. "Could
  not get under the cap" must never read as "did", and not knowing what something
  was is a reason to look, not a licence to delete.

### The wire contract

- **R-95** The machine-readable outputs a consumer integrates against carry a
  **schema version from a single constant**, stamped by the writer and defaulted
  nowhere. Two writers with two versions is the failure this prevents.
- **R-96** The version bumps on a removal, rename, type change or meaning change —
  anything that makes a consumer written against the old shape wrong — and **not**
  on a purely additive field. A version that changes every commit trains consumers
  to ignore it, which is worse than having none.

### Visitor identity across runs

- **R-97** `visitorType: returning` means a **real restored session**: the browser
  state is saved before the context closes and loaded on the next run of that
  profile. The saved state is a credential, not evidence — it holds live cookies —
  so it lives outside any run directory and outlives one run by design.
- **R-98** A run that **could not** meet its declared visitor type says so. A
  `returning` profile with no saved session has tested a first-time visitor, and
  the evidence still records the declaration either way; without a statement of
  which actually happened the two are indistinguishable, which is R-3's failure in
  a different costume. An `anonymous` profile saves nothing, because saving would
  silently make the next run returning.

### Interaction timing

- **R-99** An interaction observer is **armed before the page's own scripts**, not
  read at the end. The browser's default event-timing buffer retains only slow
  entries, so a read-time observer reports a *fast* page as never interacted with
  and understates the metric by up to the buffer's threshold. Arming bounds the
  residual error at one frame, and the bound is stated where the number is
  produced.
- **R-100** A metric with no interaction to measure reports `null`, and `null`
  means "there was nothing to measure" rather than zero — the same rule as R-3, at
  the level of a single number. An artifact that can only be produced at
  context-creation time is likewise **armed always and kept selectively**; it can
  never be started retroactively for the run that turned out to need it.
- **R-156** An **action** step and a **navigation** step get different timeout
  budgets. A cold page behind a residential proxy legitimately takes ten seconds,
  so shortening a navigation would invent timeouts on healthy sites; but the
  element an action names either resolved during that load or is not coming, and
  spending the navigation budget on it converts a clean site finding into thirty
  seconds of nothing. Worse than the wasted time: `ERROR` outranks `FAIL`
  ([R-19](#honest-verdicts)), so the long wait ends by relabelling *the search box
  is not visible* as *we could not verify*.
- **R-157** A step whose selector could have matched **more than one visible
  element** says so in its own detail. It is not refused: a union that takes the
  first of three search results is what that journey means, and a strict-mode
  engine would error on a correct journey. What is refused is the report that
  cannot tell that step from one which clicked whichever element happened to come
  first in the document. The count is of **visible** elements only, it is silent at
  one, and an engine that cannot count says nothing rather than guessing.

## 4. Quality requirements

- **Q-1** Verify by execution, not inspection. Response shapes are captured from
  the real CLI; workflows are tested against a real worker, so retry counts are
  assertions about executions that happened.
- **Q-2** 100% lines/statements/functions coverage, with entrypoints excluded and
  **every exclusion carrying a comment naming why**. An exclusion without a
  reason is how "the agent never runs at all" becomes invisible to a green suite.
- **Q-3** The **unit** suite requires no browser, no network, and no open socket.
  It is the CI gate.
- **Q-3b** Claims about what a *browser* does are settled by an **end-to-end**
  suite driving a real browser through the real run path — because a unit test
  that injects a fake runtime proves the judgement is right about a reading it was
  handed, and can never prove the reading is real. It runs offline, against local
  fixtures.
- **Q-4** A threshold that could not be measured is never a pass. `unmeasured`
  outranks `fail` in an experiment's overall verdict.
- **Q-5** A rate over an empty denominator is `null`, not 0 and not 100.
- **Q-6** Experiments never run in CI. They need the real world; CI must stay
  deterministic.
- **Q-7** Defect fixtures are served locally. Breaking production to test the
  tester is not an acceptable trade, and a real bug that exists today cannot be
  relied on to exist tomorrow.
- **Q-8** The **layering rules are enforced by a tool**, not by review. Every rule
  carries the failure it prevents in its own text, so a CI log explains the
  invariant rather than naming a rule; and every rule is proven to fire against a
  deliberate violation, because a rule with a mistyped pattern is a silent no-op —
  the same class of defect as an unread config key (R-78). Type-only imports count:
  changing `import` to `import type` must not be a way to cross a boundary
  unnoticed.

## 5. Acceptance targets

Declared in `src/experiments/definitions.ts`. Thresholds are **our** acceptance
targets, not vendor guarantees. A target that cannot be evaluated with today's
infrastructure is still declared — declaring it and reporting `unmeasured` turns
"we have no proxy vendor" from an unstated assumption into a recorded fact with a
number attached.

| Experiment | Metric | Target | Phase 0 result |
|---|---|---|---|
| **EXP-000** primitives | primitive-success | ≥ 100% | **pass** — 100% |
| | browser-launch | ≥ 98% | pass — 100% |
| **EXP-001** geo egress | connection-success | ≥ 97% | pass — 100% |
| | country-match | ≥ 98% | **unmeasured** |
| | city-match | ≥ 90% | **unmeasured** |
| | latency (mean TTFB) | ≤ 3000 ms | pass — 2303 ms |
| **EXP-002** sticky session | ip-stability | ≥ 95% | **pass** — 100%, but see caveat |
| **EXP-003** session isolation | cookie-isolation | ≥ 100% | **pass** — 100% |
| | storage-isolation | ≥ 100% | pass — 100% |
| **EXP-004** profile consistency | language / timezone / viewport | ≥ 100% each | **pass** — 100% each |
| **EXP-005** journey stability | journey-completion | ≥ 95% | **pass** — 100% |
| | verdict-stability | ≥ 95% | pass — 100% (PASS ×5) |
| **EXP-006** evidence quality | defect-detection | ≥ 100% | **pass** — 8/8 |
| | evidence-completeness | ≥ 95% | pass — 95.5% |
| **EXP-007** concurrency | concurrent-completion | ≥ 95% | **not run** |
| | verdict-agreement | ≥ 95% | not run |
| | egress-identity-held | ≥ 100% | not run |
| | wall-clock-factor | ≤ 2× solo | not run |
| | peak-memory-per-session | ≤ 500 MB | **unmeasurable today** |

Three caveats are part of the result, not footnotes to it:

**EXP-001 is `unmeasured`, and that is the honest verdict.** With no geo-proxy
vendor configured, every session egresses from this machine. Running the Oslo
profile from a Norwegian office observes country `NO` and *would* report
`country-match 100% ✓` — a green tick for a capability that does not exist. The
identical run against the Berlin profile would report 0% for the same reason.
Neither number measures the system under test, so both are `unmeasured` with the
reason attached. The baseline observations are still written to `results.jsonl`;
they are simply not allowed to answer the hypothesis. (20 samples, 1 distinct
egress IP, observed `NO` / Lysaker.)

**EXP-002 measured 24 seconds, not ten minutes.** Each sample held one session
across 5 reads at 6-second intervals. The external PRD asks for a 10-minute
window; that is not what was measured. A short window can prove instability but
cannot prove stability over a long journey. The window is now a **parameter**
rather than a constant, with the reads spread across whatever window is asked for
(101 requests at the old fixed spacing would measure ipinfo's rate limiter instead
of the vendor's stickiness), and the note the summary carries states the window
actually used. 24 seconds remains the default on purpose — ten minutes × 10
samples is 100 minutes, and a killed feasibility run leaves a half-written
`results.jsonl` with no summary. `--stability-window 10m --samples 3` now reaches
it ([gaps C-1](gaps.md#c-1--the-stability-window-is-a-parameter-and-a-flag-now-reaches-it)),
and a duration it cannot parse is refused rather than defaulted — a summary
measuring 24 seconds under a caller who believes they asked for ten minutes is
worse than no measurement. The number in `experiments/` is still 24 seconds until
the ten-minute run is taken, and that run waits on the samplers honouring
`--engine` ([gaps D-1b](gaps.md#d-1b--the-engine-choice-is-uniform-except-for-the-experiment-samplers)).

**EXP-007 is declared and has not been run**, and one of its targets cannot be
evaluated at all: peak memory across the browser process tree is not observable
from the runner, because the browser is a separate daemon on one engine and an
unsampled child on the other. That target is still declared, because OOM is the
reason concurrency was 1 — reporting it `unmeasured` with the reason attached turns
"we never looked at memory" from an unstated assumption into a recorded fact
(Q-4). The consequence is that EXP-007's overall verdict will be `unmeasured` until
a process-tree probe exists, and `unmeasured` is not a failed run (R-46).

## 6. What Phase 0 found

Against production `digilist.no/blogg`:

- **CLS 0.76 on desktop, passing on mobile** — a severe, device-specific layout
  shift, and the finding that motivated the viewport axis. **Superseded:**
  re-measured 2026-08-12, worst CLS across 14 pages is 0.025. Kept as the reason
  the axis exists, not as a current defect.

And two defects in `geoqa` itself, both caught by an experiment rather than a
test:

- A mobile profile rendered at 1280 px because nothing applied the device
  viewport. Every check passed and the evidence package was 100% complete; only
  the screenshot showed it. The viewport is now a verified axis (R-6).
- `is visible` on a missing element returned an error, so "the page has no CTA"
  was filed as *our* instrumentation failure rather than as a site defect.
  EXP-006 scored 75% before the fix and 100% after.

Both are the argument for R-17/R-18 and for treating experiments as a distinct
mechanism from tests.

## 7. Non-goals, restated as design refusals

These are things the system deliberately will not do, each because doing it
destroys the signal:

- Retry a journey to get a green result.
- Report the last of several attempts as *the* result, or average them — the worst
  reading is the one a repeated run exists to find.
- Average an unverified axis into a pass.
- Report a number for an axis with no data source.
- Fall back to direct egress when a market's proxy is unavailable.
- Put an LLM anywhere in the measurement path while journeys must be
  reproducible.
- Score an experiment threshold it could not evaluate.
- Ship an evidence package that looks complete when it is not.
- Offer a setting that nothing reads. A knob with no effect is worse than a
  hardcoded constant, because the constant is at least discoverable.
- Delete anything by default, or delete something whose identity it could not
  establish.
- Fill a gap in a matrix with a passing scenario, a zero, or silence.

## 8. External PRD anchors

Requirements known to exist in the external PRD, cited from the source:

| Anchor | Where cited | Status |
|---|---|---|
| **§24** — the questions an evidence package must answer | `evidence/manifest.ts` (`REQUIRED_QUESTIONS`) | implemented as R-24 |
| **§37** — adaptive recovery in journeys | `journeys/spec.ts` | **deferred by design.** Belongs on top of the deterministic path, and only once that path is reliable enough to have a baseline worth deviating from |
| 10-minute session stickiness | `cli/samplers.ts` (`PRD_STABILITY_WINDOW_MS`, `resolveStabilityWindow`), EXP-002 notes | **expressible, not yet measured** — the window is a parameter and the PRD's value is a named constant; the default is still 24 s and no flag reaches the parameter. See [§5](#5-acceptance-targets) |
| "do not create one vague AI-generated score" | `confidence/score.ts` | implemented as R-33/R-34 |

## 9. Phase boundary

**Phase 0 (feasibility) is complete**: deterministic, no LLM, read-only against
live sites, 7 experiments run against agent-browser 0.34.0 and Chrome 151. Its
results in [§5](#5-acceptance-targets) are a historical record and are not
re-measured by later work.

**Phase 1 has landed as capability, not yet as evidence.** A second engine
(Playwright, per-context proxy, real geolocation, restored visitor sessions), a
16-profile market matrix, human-paced journeys with seeded variation, journeys that
fill forms and change state, a bounded in-process matrix runner, a config file that
is read, evidence pruning, an enforced layer map and a versioned wire contract all
exist. What has *not* happened is the measurement: EXP-007 has never run, the
matrix has never been executed end to end against a live site, and the central
geographic claim still has no exit IP behind it — that last one is a purchase
(`infra/`), and everything the code can do about it is done.

Everything not built — and everything built but unproven, including one thing that
is red on the current tree — is tracked in [`gaps.md`](gaps.md).
