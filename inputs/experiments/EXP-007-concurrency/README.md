# EXP-007-concurrency — NOT YET RUN

**Hypothesis.** N journeys can run at the same time and each one still measures what it measured alone: no instrumentation errors, the same verdict as a solo run, an egress identity that holds for the whole run, and a per-session cost that stays sub-linear.

**Run.** `geoqa experiment run EXP-007 --samples 5 --geo oslo-mobile --url https://digilist.no/blogg`
No samples yet. There are no `results.jsonl` and no `summary.json` in this directory because nothing has been measured — the verdict column below stays empty until the command above has been executed on a named machine, and `configuration.json` records which fields that run has to fill in.

| Metric | What it measures | Target | Verdict | Observed |
|---|---|---|---|---|
| `concurrent-completion` | Concurrent sessions that completed without an instrumentation error | ≥ 95% | *not run* | — |
| `verdict-agreement` | Concurrent sessions whose verdict matched the same journey run solo | ≥ 95% | *not run* | — |
| `egress-identity-held` | Concurrent sessions whose egress identity was verified to hold for the whole run | ≥ 100% | *not run* | — |
| `wall-clock-factor` | Mean wall clock per concurrent session, as a multiple of the same journey run solo | ≤ 2 | *not run* | — |
| `peak-memory-per-session` | Peak resident MB across the browser process tree, per concurrent session | ≤ 500 | *not run* | — |

## Why this exists, and why now

`temporal/workflows.ts` runs the market × device × journey matrix sequentially and justifies it by citing this experiment. For a while the citation pointed at nothing: no spec, no sampler, no directory — which reads as "measured elsewhere" and is worse than an admitted gap.

What changed is that concurrency became possible. Under agent-browser one profile is one Chrome process, so "N markets at once" was mostly a question about RAM. The Playwright engine gives each **context** its own proxy — proven end to end by an e2e case that puts one context behind a dead proxy and still reaches the page from another context in the same browser. So the question is no longer "can we?" but "does a concurrent session still measure the same thing a solo one did?", and that is a question only an experiment can answer.

## How a sample is built

One sample is **one solo control run, then a batch of N run at once**:

- The control runs **first and alone**. A baseline taken while the batch is running is not a baseline, and without a control at all "the batch agreed with itself" scores a meaningless 100% — the same reason EXP-006 keeps `/healthy` in its sample set.
- The control and the first batch session use the **same profile** on purpose: comparing a mobile solo run against a desktop concurrent one would blame concurrency for a difference the device caused.
- Every session in the batch gets a **different** profile. A run id is `run_<ms>_<profileId>`, and agent-browser's daemon is keyed by session name plus launch flags, so two sessions on one profile started in the same millisecond would silently share a browser and the batch would measure one browser twice while reporting two. Asking for more sessions than there are profiles refuses instead of wrapping into that collision.
- A session that throws is **recorded, not rethrown**. It counts against `concurrent-completion` and its message lands in the notes; the whole question is what happens to N at once, and the one that died is the interesting one.

## Reading the targets

- `verdict-agreement` is 95%, not 100%: the same journey run alone is only stable to 95% (EXP-005), so perfect agreement would file ordinary journey flakiness as a concurrency defect.
- `egress-identity-held` is 100%, because a swapped exit mid-run does not degrade a measurement, it invalidates it — LCP from one visitor and CLS from another cannot be attributed to anybody. A closing probe that could not be read is `unverified`: it stays out of the denominator rather than being counted as either a hold or a rotation.
- `wall-clock-factor` is relative on purpose. An absolute millisecond budget would mostly measure the site under test; the question is whether N at once made each session slower.
- `peak-memory-per-session` **cannot be evaluated by anything that exists today** and is declared anyway. The browser is out of process on both engines and nothing samples the process tree, so `process.memoryUsage()` measures the runner, not the browsers. It will report `unmeasured` with that reason — which means the overall verdict of this experiment will be `unmeasured` until a process-tree probe exists. OOM is the specific fear that keeps concurrency at 1; leaving the target out would turn "we have never measured the thing we are afraid of" back into an unstated assumption.

## What this does not measure

- **N contexts inside one browser.** The sampler runs N full runs, each with its own browser session, profile and evidence package — the shape a matrix scheduler would use. The per-context proxy is what makes concurrency possible, but nothing above `browser/` opens more than one context per run.
- **Per-session network identity, on direct egress.** With no proxy vendor every session leaves from the same machine, so the batch shares one egress IP. That is recorded as a note ("per-session network identity was not exercised"), never as a score: filing a missing vendor as a concurrency defect would be the EXP-001 mistake one experiment along.
- **A safe parallelism number.** Even a clean pass here says three at once behaved; it says nothing about nine. Raise `concurrency` and re-run rather than extrapolating.

## Files

- `hypothesis.json` — the claim and its acceptance targets, declared before the run.
- `configuration.json` — what is to be executed, and the fields the run must fill in.
- `results.jsonl` — one line per sample, written as it happens. Gitignored, and absent until the command above has been run.
- `summary.json` — the machine-readable verdict. Produced by the run; there is nothing to publish before then.
