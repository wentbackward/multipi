# AGENTS.md — multipi

multipi is an autonomous multi-agent development loop for the **pi** coding agent: an orchestrator
session, one-shot role children (implementer / code-reviewer / verifier) in isolated git worktrees,
one batched check gate per train of ready branches, and ordered squash merges. GitHub issues are
the tickets; labels are the loop state; the deterministic scripts + extension tools are the hands.

The design spec is `docs/superpowers/specs/2026-10-27-devloop-pi-design.md` and is the source of
truth. Implementation history: `docs/superpowers/plans/`.

## Project conventions

- **Shell**: bash 4+, `set -u` (no `-e` in long scripts — every rc is handled), shellcheck-clean.
  All `MULTIPI_*` env overrides are documented seams; never introduce undocumented ones.
- **TypeScript**: erasable-only syntax (no enums/namespaces/parameter properties), strict,
  `tsc --noEmit` (Node 24 type stripping runs the tests; there is no build step).
- **Dependency rule**: `config.ts` / `state.ts` / `brief.ts` / `stopgate.ts` / `formatter.ts` /
  `gate.ts` / `merge.ts` / `issues.ts` are pure-node (testable without pi). Only `tools.ts` and
  `index.ts` import pi types.
- **Contracts**: script exit codes are pinned in the design spec §2 and in each script's header;
  parsers in the extension key off them. Change a contract only in both places, with a DECISIONS.md
  entry.
- **Tests**: offline. `make check` must pass with no network and no real GitHub: `fake-gh` and
  `fake-pi` are the stand-ins. A test that needs the network is a design smell, not a flake.
- Commits: small Conventional Commits. When the work is ticket-driven, each commit ends
  `Refs #<n>`.

## Dev loop

This repository is its own first installed instance (dogfood): `.devloop.json` is committed, the
extension lives at `.pi/extensions/multipi-devloop/`, roles at `.pi/agents/`, skills at
`.pi/skills/`. To work through the open tickets autonomously, use the **`devloop` skill**; to
bootstrap another project, the **`devloop-setup` skill**.

- Fast check: `npx tsc --noEmit`. Full checks (unit, smoke, shellcheck) run once per train in the
  gate — never per branch while implementing.
- Label vocabulary: `dl/in-progress` → `dl/in-review` → `dl/approved` → `dl/gated` → `dl/merged`
  (+ `dl/blocked`). The labels ARE the state; keep them truthful.
- `scripts/doctor.sh` diagnoses; `scripts/install.sh <repo>` installs the loop into a project.

## Stop conditions (the only reasons to stop and ask)

1. A required credential or key is missing or rejected (Anthropic API access, `gh` auth).
2. A spec contradiction where both readings change pinned contracts (exit codes, config schema,
   state-file shape).
3. Anything unsafe or irreversible: pushing to the base branch of a project outside this repo,
   deleting git history, spending money, contacting real services.
