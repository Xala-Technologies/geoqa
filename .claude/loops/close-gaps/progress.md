# Progress

## Slice 0 · Commit the baseline — DONE (not as planned)

Something had already committed the work as `abbdc75`, titled
`refactor(config): update geoqa.config.example.json and package.json`, containing
117 files and +15,602 lines — the entire Phase 1 build. It was already on
`origin/main`, so the message cannot be corrected without rewriting published
history.

Handled by `998399f`, an empty-of-code commit that documents what `abbdc75`
actually contains, so the record is recoverable from history itself rather than
lost to a wrong subject line.

Working branch: `feat/phase-1-playwright-geo`.

Gate: lint clean · boundaries clean (94 modules) · 925 tests at 100% · e2e 18/18.

## Slice 1 · Truth up docs/gaps.md — DONE

- B-8 marked CLOSED. It was the consequential one: `health()` refused to probe
  any URL containing `{`, returned `unconfigured`, and `prepareRun` treats that as
  a hard refusal for a non-direct provider. A residential template could never
  start a run.
- B-10 marked CLOSED — the e2e now derives the trace filename from
  `traceArtifactFormat` rather than hardcoding `trace.json`.
- The duplicated `### D-1c` heading renumbered to `D-1e`.
- Header now states the file was verified against code on 2026-08-13.

Gate: green, unchanged (no source touched).

## Credentials landed this session

`.env` (gitignored, 600) now carries Decodo residential + ISP, and the search
stack copied from `/etc/xaheen-agent-fleet.env` on the fleet VPS: `SERPAPI_KEY`,
`DATAFORSEO_LOGIN/PASSWORD/LABS`, `GSC_CREDENTIALS`, `SEO_GSC_PROPERTY`.
`secrets/gsc-sa.json` pulled from the VPS and gitignored.

Verified live:

| Service | State |
|---|---|
| SerpApi | Developer Plan, 2585 of 5000 searches left |
| DataForSEO | authenticates, **balance −$0.0043** |
| Search Console | service account `gsc-seo-reader@digilist-496317`, property `sc-domain:digilist.no` |
| Decodo residential | 50 GB to 12 Sep, rotation and stickiness both proven |

**DataForSEO being overdrawn while still authenticating is the exact failure
`network/types.ts` warns about, live in the account right now.** It is the
strongest available argument for slice 10's real `health()` probe: the balance is
in `/v3/appendix/user_data`, so the provider can report `unusable` with a reason
instead of silently returning no keywords.

## Slice 2 · CLI flags for plumbing that exists — DONE

Three capabilities that were built and unreachable. Each one is now typeable, and
each refuses rather than defaults, because the failure mode in all three is the
same: a flag that had no effect and said nothing.

**`--urls-file` reaches the matrix page axis.** The axis had landed in
`run/matrix.ts` and nothing constructed it, so `matrixRun` built `axes` without
`targets` and every scenario visited `--url`. Two defects were hiding in that:
`plan` read `options.url` instead of `scenario.target`, so even a constructed axis
would have loaded one page N times and reported N clean pages; and the run-id slug
was `<profile>-<journey>`, which two pages share along with a millisecond under
concurrency, so the second would have overwritten the first's manifest. Index, not
URL, in the slug — a URL contains `/` and `:` and a run id becomes a directory
name.

**`--stability-window` / `--stability-reads` reach EXP-002 (closes C-1).** Parsed
in `samplers.ts`, not `args.ts`: the knob types belong to the sampler that reads
them, and `args.ts` cannot import them anyway (`samplers` → `commands` → `args`
already, and `pnpm boundaries` refuses the cycle). `parseDurationMs` takes
`10m`/`600s`/`600000` and **refuses** what it cannot read — a `10min` that fell
back to the default would have printed a summary measuring 24 seconds, and since
the note names the window it used, the reader would have got a confident answer to
a question they never asked. The stale `--stability-window-ms 600000` in the
summary note itself was a lie about a flag that never existed; fixed.

**`--country`/`--city`/`--device` name an identity by place.** Resolved against the
profiles that exist, so `--city Atlantis` refuses and lists the 16 places there
are. Both forms at once refuses rather than ranks. `matrix run` refuses the place
flags outright — before resolution, so the message names `--market` instead of
answering `--country NO` with "11 profiles match".

Also: `matrix run` with neither `--url` nor `--urls-file` now refuses, where before
an empty target reached the browser as a navigation to nothing, once per scenario.

Proven live, not just in unit tests — a real Playwright sweep through the fixture
server:

```
PASS — 3 scenario(s): 3 passed, 0 warned, 0 site-failed, 0 unmeasured
  concurrency limit 2, peak in flight 2, 4805ms
  3 page(s) from the URL axis
```

Three distinct targets in three distinct evidence directories, including
`/healthy` and `/healthy?a=1` — the same path with a different query, which is the
collision case. And the refusals were exercised through the real CLI: bad URL line,
two identities, unparseable duration and place flags on a matrix all exit 2.

Docs: C-1 closed in `gaps.md`; PRD gains **R-90…R-93** (sweep inside the pool,
list validated before launch, distinct run ids per page, identity by place).

Gate: lint clean · boundaries clean (94 modules / 371 deps) · **963 tests at 100%**
lines/statements/functions (was 925) · e2e 18/18.

**Not done, and it is worth naming:** EXP-002 still has no ten-minute measurement.
The flag is no longer the obstacle — the samplers build agent-browser regardless of
`--engine` (D-1b, slice 4), so a long stickiness run through Decodo waits on that.

## Next: slice 2b

T10 — two IP-geo sources with disagreement flagged. Already a live finding: one ISP
exit resolved to São Paulo per Decodo's own endpoint and New York per ipinfo, same
IP. An engine whose whole job is proving where a visitor is cannot treat one lookup
as ground truth.
