# Verification gates

Discovered from `package.json` and `.github/workflows/ci.yml` — not assumed.
Every slice runs all four before it is done. A red gate stops the loop.

## The gates

```bash
pnpm lint            # tsc --noEmit. The whole linter; there is no ESLint.
pnpm boundaries      # dependency-cruiser. Has caught 2 real violations. NOT advisory.
pnpm test:coverage   # vitest + 100% lines/statements/functions. CI's gate.
pnpm test:e2e        # real Chromium against the local fixture server.
```

Current baseline, all green:

| Gate | Result |
|---|---|
| `pnpm lint` | clean |
| `pnpm boundaries` | no violations, 107 modules / 418 deps |
| `pnpm test:coverage` | **1203 tests, 100%** lines/statements/functions |
| `pnpm test:e2e` | **30/30** |

Single file, while iterating:

```bash
pnpm vitest run src/<area>/__tests__/<file>.test.ts
pnpm vitest run src/<area>/__tests__/<file>.test.ts -t "part of the name"
```

## Rules that are not negotiable

**Coverage is 100% lines/statements/functions**, not "high". Branch coverage is
not gated (currently ~97%). A file that is genuinely all I/O may be added to the
`exclude` list in `vitest.config.ts` — **only with a comment naming why**, in the
style of `playwright-launch.ts` and `network/auth-probe.ts`. An exclusion without
a reason is how "the agent never runs at all" becomes invisible to a green suite.

**The unit suite launches no browser, opens no socket, hits no network.** Every
boundary is injectable: `CommandDeps.makeRuntime`, `ExecOptions.spawnFn`,
`ProviderOptions.probe`, `ProviderOptions.auth`, `loadJourney`'s `read`.

**e2e is for claims about what a browser does.** A unit test with a fake runtime
proves the judgement is right about a reading it was handed; it can never prove
the reading is real. Two defects this week were only findable there: the
`per-context` proxy placeholder that killed every navigation, and CLS reported as
unmeasured on a stable page.

## Live verification, when a slice needs the real world

Credentials come from `.env` (gitignored, mode 600). Never commit them, never
paste them into a doc.

```bash
set -a; source .env; set +a

# Egress identity for one market — a few KB.
pnpm geoqa proxy verify --geo bergen-desktop --provider http-proxy

# One journey through residential.
pnpm geoqa journey run --url https://digilist.no/faq --geo bergen-desktop \
  --journey sweep --engine playwright --provider http-proxy

# Proxy budget before and after anything large.
curl -sS -H "Authorization: $DECODO_API_KEY" https://api.decodo.com/v2/subscriptions
```

**Budget discipline.** 50 GB to 12 Sep, ~1 MB per page load. A 430-page sweep is
~0.5 GB. Check usage before a run over ~1 GB and stop for approval. Today's
lesson: one sweep exhausted a 100 MB allowance and every later run returned an
opaque 407 that looked like a broken proxy.

## Acceptance per slice type

**Engine gap** — the gap's own failure reproduced by a test that fails before the
fix. A fix with no failing-first test is not a closed gap.

**Multi-tenancy** — isolation demonstrated, not asserted. A path that escapes a
tenant's evidence root is a security defect; test it explicitly. Quota must
REFUSE a run that would exceed budget, not discover it mid-sweep.

**Provider (Serper, DataForSEO, Search Console)** — `health()` performs a REAL
probe, never a credentials-present check. Read the DataForSEO note in
`network/types.ts`: a sibling project shipped exactly that and a zero-balance
account satisfied it for weeks. Empty results read as "we rank nowhere"; here
they would read as "the page is fine everywhere". Three states throughout —
result, no result, and could-not-measure — with `null` for the third.

**Agent** — the producer never grades its own output. Publish gates on a geoqa
verdict computed by the measuring side.

**Frontend** — no fabricated data. An axis with no reading renders as "not
measured", visually distinct from zero. The whole engine refuses to conflate
those; a UI that does undoes it.

## External services and where their credentials live

Per the owner: **SerpApi, DataForSEO and the Google Search Console API keys are
on the VPS that runs `agent-fleet`.** They are not in this repo and must not be
copied into it.

That shapes slice 10 and later. Each provider needs:

1. An injectable seam, so the unit suite never calls the service.
2. Credentials from the environment only (R-26) — the VPS provides them.
3. A real `health()` that distinguishes *no credit* from *bad credentials*.
   Decodo proved the value: it returns `x-error-message` on a 407, and reading it
   turns an opaque failure into "top up the account" versus "fix the username".
4. A recorded decision on which provider answers which question. SerpApi and
   DataForSEO overlap; Search Console is different in kind — it is the only one
   that reports what Google actually did with a page (`Crawled – currently not
   indexed`, soft 404s), which no SERP scrape can tell you.

Search Console is OAuth, not an API key, and its property is per tenant. That is
a tenant-credential problem, so it belongs after slice 6, not before.
