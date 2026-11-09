# AGENTS.md — multipi

multipi is an autonomous multi-agent development loop for the **pi** coding agent: an orchestrator
session, one-shot role children (implementer / code-reviewer / verifier) in isolated git worktrees,
one batched check gate per train of ready branches, and ordered squash merges. GitHub issues are
the tickets; labels are the loop state; the deterministic scripts + extension tools are the hands.

The design spec is `docs/superpowers/specs/2026-10-27-devloop-pi-design.md` and is the source of
truth; the dark-factory mode (the `"factory"` toggle, holdout scenarios, the role guard) is
specified in `docs/superpowers/specs/2026-11-01-multipi-dark-factory.md`. Implementation history: `docs/superpowers/plans/`.

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

## Dark factory (seams and guard limits)

The dark-factory mode's documented env seams and config keys — every `MULTIPI_*` variable
is a seam; never introduce undocumented ones.

**Env seams (set for one-shot children, all documented in the spec §3/§5/§7):**

- `MULTIPI_CHILD_ROLE=<role>` — set by `spawnPi` next to `MULTIPI_CHILD=1`. A child of a
  **guarded** role (`implementer`, `code-reviewer`, `verifier`) loads a guard-only extension:
  one block-capable `tool_call` hook that refuses any tool call naming a path inside the
  scenario store, nothing else (no tools, no stop-gate — a guarded child still cannot drive
  the loop). `analyst`, `scenario-writer` and `scenario-judge` are not guarded.
- `MULTIPI_SCENARIO_FILE` — the scenario file a judge run judges (one headless
  `scenario-judge` per scenario; the script decides green/red, never the agent).
- `MULTIPI_SCENARIO_ID` — the scenario's id (the verdict's `id` must match it).
- `MULTIPI_SCENARIO_TARGET` — the system-under-test's first printed line (its URL/command),
  passed to every judge of the gate run.
- `MULTIPI_LIST_LAG_RETRY_MS` — the one bounded GitHub list-lag retry delay of
  `findOpenTicket` (default 1500 ms; tests drive dispatch without the wall-clock wait).

**Config keys (`.devloop.json`):** `"factory"` (`"collaborative"` | `"dark"`, default
`"collaborative"` — a preset that only sets defaults; an explicit option always wins), the
`"scenarios"` block (its mere presence turns the store on in any mode; `false` is the only
off-switch), and `cleanup.stale_days` (default 14 — the idle window of the STALE
worktree-cleanup bucket).

**The guard's honest limits** (it reads the command line, not what runs — best effort by
design): a script the agent writes that opens the store, a path assembled at run time, and
a recursive search of an ancestor directory are **not** caught. The default store location
(outside every worktree and the repo) is the cheap first defence; the strong-isolation
escalation is an OS user without read access to the store (documented escalation, not v1).

**Log hygiene:** the stage's `train-scenario-results.jsonl`, `train-scenario-judge/` and
`train-scenarios-run.log` hold judge evidence and sealed ids — they are never forwarded to
an implementer, reviewer or verifier; only the `missing` text of unsatisfied scenarios
travels back.

## Stop conditions (the only reasons to stop and ask)

1. A required credential or key is missing or rejected (Anthropic API access, `gh` auth).
2. A spec contradiction where both readings change pinned contracts (exit codes, config schema,
   state-file shape).
3. Anything unsafe or irreversible: pushing to the base branch of a project outside this repo,
   deleting git history, spending money, contacting real services.
