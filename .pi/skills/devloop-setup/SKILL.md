---
name: devloop-setup
description: Bootstrap a repository for the multipi autonomous dev loop — inspect the toolchain, write .devloop.json, install the extension/agents/skills/scripts, verify with doctor. Use when the devloop tools are missing, when .devloop.json does not exist, or when asked to set up / enable the dev loop for this project.
---

# Dev loop setup

Make this repository loop-ready. Work through the steps in order; each leaves the repo in a runnable
state if you stop.

## 1. Locate the multipi plugin repo

The plugin (scripts, extension, agents, skills, templates) lives in the multipi repo. Find a checkout
(e.g. `~/src/multipi`, `~/hacking/multipi`), or clone it:
`git clone https://github.com/wentbackward/multipi`. Verify it has `scripts/install.sh` and
`extension/index.ts`. When THIS repository is multipi itself (dogfood), skip the clone — you are in it.

## 2. Inspect the target repository (do not guess)

- Language/toolchain: Makefile, package.json, pyproject.toml, go.mod, Cargo.toml — read the ones that
  exist, not a fixed list.
- The FAST check: the fastest command that fails when the working tree is broken (compile/lint/a small
  focused test set). It must finish in well under a minute; when unsure, time it.
- The GATE checks: the full suite(s) that must pass before merging (all tests, coverage gates, e2e).
  Mark `heavy: true` for anything that needs a slot (long tests, servers, big builds).
- FORMATTER: the project's canonical formatter command with a `{file}` placeholder, and the
  extensions it applies to. Plain suffix matching — list every distinct extension explicitly
  (".ts" does NOT cover ".tsx").
- PORTS: if servers run, pick `port_base`/`port_step` away from anything the project already binds;
  `port_env` is the variable the project's servers read (e.g. `PORT`) — leave it empty when the
  project has no configurable port.
- `memory_max`: a ceiling for one heavy job (e.g. "8G") when the machine is shared; empty = uncapped.
- `slots`: how many concurrent heavy jobs / implementers the machine comfortably runs.

## 3. Install

`<plugin>/scripts/install.sh <target-repo>`

It copies: `scripts/` (versioned in the target), `.pi/extensions/multipi-devloop/`,
`.pi/agents/`, `.pi/skills/devloop*/`. Re-runnable; it syncs from the plugin. Commit the copied
`scripts/` (they are part of the project now); `.pi/` follows the repo's existing policy for it.

Dependency note: the extension imports `typebox` and `@earendil-works/pi-coding-agent`. When the
target is not the multipi repo itself, add them as devDependencies so pi can resolve them from the
project: `npm i -D typebox @earendil-works/pi-coding-agent` (or the target's equivalent).

## 4. Write `.devloop.json` (committed)

Start from the installed template (`.pi/templates/devloop.json` or the plugin's `templates/`) and fill
only what differs. Required for a functioning gate: `base_branch`, `remote`, `fast_check`,
`checks[]` (at least the full test suite; each entry `{name, command, heavy, summary?}` or a plain
command string). Defaults worth knowing: gate worktree `../<repo>-gate`, notes/logs under
`~/.multipi/<repo>/`, `heavy.slots=2`, `stop_gate.{require_clean_tree=true,max_blocks=5}`,
`merge.method=squash`.

Label note: the `dl/*` labels (`dl/in-progress`, `dl/in-review`, `dl/approved`, `dl/gated`,
`dl/merged`, `dl/blocked`) are created automatically on first use — no manual pre-creation needed.

## 5. Wire the repo docs

- AGENTS.md: add a short "Dev loop" section pointing at `.devloop.json` and the `devloop` skill
  ("work through the open tickets with the devloop skill"). Keep it three lines — the skill carries
  the procedure.
- `docs/DECISIONS.md`: create from the plugin's template when absent; seed it with the setup
  decisions that matter later (chosen fast check and why, slots, ports, memory cap).

## 6. Verify

1. `<target>/scripts/doctor.sh` — must print `doctor: ready` with zero MISSING.
2. `bash <target>/tests/smoke.sh` when the plugin's own tests are present (dogfood) — offline proof.
3. In a fresh pi session in the target: `devloop.status` answers, and `devloop.dispatch` refuses a
   bogus role with the list of real ones. (Both are cheap; no tickets are created.)

Done. Hand back to the `devloop` skill: it creates the tickets from the spec and keeps the loop
turning.
