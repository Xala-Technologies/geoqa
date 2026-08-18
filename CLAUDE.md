# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read [`AGENTS.md`](AGENTS.md) first.** It is the working brief for this repo and
it is vendor-neutral, so there is one copy to keep correct rather than two. It
covers the commands, the layer map, the load-bearing invariants (41 of them at
the time of writing — count them there, not here), the testing and TypeScript
conventions, and the wiring checklists for adding a check, a step action, an
experiment, or an egress provider.

Depth, when the brief is not enough:

| Document | When to open it |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | why a seam is where it is, the full run lifecycle, the verdict/evidence/confidence models, the durability design |
| [`docs/prd.md`](docs/prd.md) | what the system is required to do (R-1…R-47), the acceptance thresholds, the deliberate design refusals |
| [`docs/gaps.md`](docs/gaps.md) | what is not built, what is unproven, and the open verified defects — check this before assuming a feature works |
| [`docs/audit-2026-08-18.md`](docs/audit-2026-08-18.md) | an independent pass over the tree: what is red now, what is latent, and where `gaps.md` itself is wrong |
| [`docs/milestone.md`](docs/milestone.md) | the 100-session run: what was actually measured against a live site, and which threshold it missed |
| [`docs/sla.md`](docs/sla.md) | the availability capability that does not exist yet, specified before it is promised |
| [`development-update.md`](development-update.md) | what has shipped and what it means, newest first — the human-facing record |
| [`README.md`](README.md) | the short pitch and the Phase 0 experiment results |

Worth knowing before you touch anything:

- **This repo's comments carry the reasoning.** Most non-obvious rules have a
  block comment naming the incident that produced them. Read the comment before
  changing the code it guards; a fair amount of what looks redundant is load-bearing.
- **`docs/gaps.md` drifts, so date it before you trust it.**
  `git log -1 --format='%h %ad %s' --date=short -- docs/gaps.md` tells you how
  fresh it is; its own header still pins itself to `9f10d48`, which is many
  commits back. If you fix something listed there, remove the entry in the same
  change — and if you find an entry already closed in the tree, close it in the
  document rather than leaving it for the next reader.
- **`gaps.md`'s own "one entry is red right now" pointer is stale.** Its header
  sends you to B-10 (the e2e trace filename); B-10 is marked CLOSED further down
  the same file, and the e2e derives the filename from `traceArtifactFormat`. Do
  not start there.
