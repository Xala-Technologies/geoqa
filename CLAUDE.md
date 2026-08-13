# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read [`AGENTS.md`](AGENTS.md) first.** It is the working brief for this repo and
it is vendor-neutral, so there is one copy to keep correct rather than two. It
covers the commands, the layer map, the twenty-six load-bearing invariants, the
testing and TypeScript conventions, and the wiring checklists for adding a check,
a step action, an experiment, or an egress provider.

Depth, when the brief is not enough:

| Document | When to open it |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | why a seam is where it is, the full run lifecycle, the verdict/evidence/confidence models, the durability design |
| [`docs/prd.md`](docs/prd.md) | what the system is required to do (R-1…R-47), the acceptance thresholds, the deliberate design refusals |
| [`docs/gaps.md`](docs/gaps.md) | what is not built, what is unproven, and four verified defects — check this before assuming a feature works |
| [`development-update.md`](development-update.md) | what has shipped and what it means, newest first — the human-facing record |
| [`README.md`](README.md) | the short pitch and the Phase 0 experiment results |

Two things worth knowing before you touch anything:

- **This repo's comments carry the reasoning.** Most non-obvious rules have a
  block comment naming the incident that produced them. Read the comment before
  changing the code it guards; a fair amount of what looks redundant is load-bearing.
- **`docs/gaps.md` is current as of `9f10d48`.** If you fix something listed
  there, remove the entry in the same change.
