# multipi

The autonomous multi-agent development loop for the [pi](https://pi.dev) coding agent.
The main pi session orchestrates; implementer and reviewer agents work in isolated git
worktrees; a batch gate proves each train of approved branches with one full check run;
approved trains are squash-merged in order; merged work is run for real and verified.

Derived from `wentbackward/claude-dev-loop` (Claude Code). See
`docs/superpowers/specs/2026-10-27-devloop-pi-design.md` for the design.

## Layout

- `scripts/` — the deterministic core: heavy-job queue (`heavy.sh`), batch gate
  (`gate-train.sh`), ordered merge (`merge-train.sh`), `open-pr.sh`, `paths.sh`, `doctor.sh`.
- `extension/` — the pi extension (tools + hooks). [Part 2 of the build.]
- `agents/`, `skills/` — role prompts and the orchestrator workflow. [Part 3.]
- `templates/` — skeletons the setup skill fills into a target project.
- `tests/` — offline smoke suite (local bare origin, fake `gh`, no network).

## Checks

    make check     # shellcheck (warns if not installed) + tests/smoke.sh

## Project config

A loop-managed project has a committed `.devloop.json` at its root: base branch,
remote, fast check, format command, the gate `checks`, heavy-queue tuning, stop-gate and
merge policy. State (notes, logs, the green-train record) lives under `~/.multipi/<repo>/`.
