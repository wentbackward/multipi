# multipi — dev-loop extension for pi (design spec)

Date: 2026-10-27
Status: proposed — awaiting owner review
Repo: `wentbackward/multipi` (this repository is both the product and the first loop-managed project)

## 1. Purpose

Port the autonomous multi-agent development loop from `wentbackward/claude-dev-loop` (a Claude Code
plugin) to the pi coding agent, as a pi extension + skills + deterministic scripts.

Core invariant, unchanged from the reference: **the model orchestrates; the machine decides.**
Reliability lives in deterministic scripts and structured tools; the LLM (the main pi session)
schedules, interprets and talks to the user. The loop *continues coding while there are open,
unblocked requirements*; it stops only for stop conditions.

### Philosophy carried over

- The reviewer is independent of the implementer.
- A red gate is never merged, not even for an apparent flake.
- The full check suite runs once per batch (the gate), never once per branch.
- Heavy jobs queue through a machine-wide slot queue so the machine never runs out of memory.
- Decisions the spec leaves open go into a log; the user hears results in plain language.

### Non-goals (v1)

| Item | Disposition |
|---|---|
| Per-role GitHub identities (apps, rulesets, `as-role.sh`) | Out. The loop works under the user's own `gh` login. Documented as a later addition. |
| `test-engineer` role | Out. The implementer writes failing tests first; the reviewer verifies each acceptance criterion has a behaviour test. Revisit only if weakened tests are observed in practice. |
| Local ticket folder / other ticketing backends | Out. GitHub issues are the ticket system in v1. The orchestrator's ticket vocabulary (list/create/comment/close/view/label) is kept narrow so a different backend is a later adapter, not a rewrite. |
| Live steering of running children (RPC mid-turn messaging) | Out. In-flight requirement changes go through: edit issue → `devloop.cancel` → re-dispatch. Documented as a v2 option (§8.4). |

## 2. Architecture

Three layers, each independently testable:

### 2.1 Skills (orchestrator brain)

- `.pi/skills/devloop/SKILL.md` — the orchestrator workflow: ticketing, scheduling (≤3 implementers,
  pair tickets that don't touch the same files), the review loop, gate/merge rules incl. red-train
  bisection, run-and-verify, decisions log discipline, stop conditions, plain-language reporting.
  Ported from the reference `dev-loop` skill, adapted to pi (no `CLAUDE_PLUGIN_ROOT`, no identity
  mode, pi tool names, this spec's report protocol).
- `.pi/skills/devloop-setup/SKILL.md` — bootstrap a project: inspect repo (language, toolchain,
  Makefile, CI, spec), ask once only for what cannot be inferred, write `.devloop.json`,
  AGENTS.md sections, `docs/DECISIONS.md`, missing Makefile targets. Never overwrites a file
  wholesale; merges and shows the delta.

### 2.2 Extension (`.pi/extensions/devloop/`, TypeScript)

Five tools, grouped in a `devloop` namespace:

| Tool | Parameters | Behaviour |
|---|---|---|
| `devloop.dispatch` | `{role: "implementer"|"code-reviewer"|"verifier", ticket?, branch?, worktree?, task?, notes?}` | Spawns the role as an isolated headless `pi -p --no-session --mode json` subprocess with the role's system prompt (`agents/<role>.md`) via `--append-system-prompt`, cwd = the ticket's worktree. Streams the child's tool calls and text via `onUpdate` (visible in the user's TUI). Returns the child's final report + usage. For `implementer`: deterministically computes the branch name (`<type>/<n>-<slug>`), creates the worktree on the latest base (or a dependency branch), allocates a port range outside the gate's range, resolves the notes file path, and assembles the full brief from the template + config. The orchestrator supplies the *ticket*, not the paths. Enforces ≤3 in-flight implementers via a state file (survives restarts): a fourth concurrent dispatch is **refused** with the list of in-flight tickets (the orchestrator re-issues once a report lands; children are blocking, so slots free as reports arrive). If the ticket's worktree/branch already exists (a re-dispatch after cancel or crash), dispatch reuses it instead of recreating it. |
| `devloop.cancel` | `{ticket}` | Kills one running child (SIGTERM, SIGKILL after 5s) recorded in the dispatch state file (pid + worktree per ticket), frees its slot. The worktree and its commits survive; re-dispatch resumes. |
| `devloop.gate` | `{branches: string[]}` (merge order) | Wraps `scripts/gate-train.sh`. Stacks the approved branches on the latest base in the gate worktree, runs every configured check once (heavy ones through `heavy.sh`). Structured result: `{status: "green"|"red"|"conflict", branch?, failures[{check, summary}], logs: <path>}`. Script exit codes: 0 green, 1 red (incl. `gate_setup` failure, log kept), 2 usage/config, 3 rebase conflict (branch named in output). |
| `devloop.merge` | `{branches: string[]}` (same order as the gate) | Wraps `scripts/merge-train.sh`. Replays each branch on the current base, verifies the replayed tree is *exactly* the gated tree, pushes, opens the PR from the notes file, squash-merges, deletes the branch. Structured per-branch outcome + exit-code meaning surfaced to the model. Script exit codes: 0 all merged, 2 usage/config, 3 replay conflict, 4 tree differs from the gated one (re-gate), 5 notes file missing, 6 branch changed since the gate, 7 PR not merged / gh failed, 8 not gated green. |
| `devloop.status` | — | Derived snapshot, for restart-recovery and user reporting: open issues with phase labels, worktrees, in-flight dispatches (from the state file), last gate result. Everything is derivable from GitHub + git + state file; nothing is stored that cannot be reconstructed. |

Two hooks:

- **Stop-gate** (`agent_before_settle`), active only when `.devloop.json` exists. Three checks:
  1. `fast_check` failing → force one continuation, feeding the failure tail to the model.
     Bounded by `stop_gate.max_blocks` (default 5), counted in `.git/devloop-stop-count`; the
     counter resets when green. An unfixable state cannot loop the session forever.
  2. Dirty tree (when `stop_gate.require_clean_tree`) → force one continuation (same bound).
  3. **Loop drive**: a *startable* ticket exists and a dispatch slot is free → force one
     continuation ("N tickets startable, slot free — start the next one"). *Unbounded*, because
     this is the loop's job. "Startable" = open, not labelled `dl/blocked`, and all dependencies
     either merged or stackable on an in-flight/`dl/in-review`+ branch — so a stalled dependency
     never spins the loop. Settles when no ticket is startable (all merged, all blocked, or all
     waiting on a blocked dependency). This makes "continues coding while there are requirements"
     a property of the harness, not of the model's discipline.
- **Format-on-edit** (`tool_result`): after a successful `write`/`edit`, if `format` is configured
  and the file matches `format_extensions`, run the format command on that file (`{file}` = path).

Extension hygiene: handlers report errors loudly (fail-closed where a safety decision is involved);
no long-lived processes started in the factory; state file writes atomic; cleanup idempotent.

### 2.3 Scripts (ported, shell, shellcheck-clean)

| Script | Job | Carried over from reference |
|---|---|---|
| `heavy.sh` | Machine-wide queue: `heavy.sh <cmd>` waits for one of `heavy.slots` (default 2) `flock`ed slots in `$XDG_RUNTIME_DIR/multipi-heavy-slots`, optional systemd user-scope memory cap (`heavy.memory_max`), per-slot port env (`port_env/base/step`), stale-temp cleanup. | Yes, near-verbatim. |
| `gate-train.sh b1 b2 ...` | Stack branches in the gate worktree, run configured checks once on top; heavy checks via `heavy.sh`; parse `summary` regexes; write log to `logs_dir`; post nothing (no identity mode). Exit: 0 green, 1 red (incl. gate_setup failure), 2 usage/config, 3 rebase conflict (branch named). | Yes, near-verbatim. |
| `merge-train.sh b1 b2 ...` | Replay each branch on current base; assert tree equality with the gated tree; push; open PR from notes file (leading `#` stripped); squash-merge exactly that head; delete branch. Exit: 0 ok, 2 usage/config, 3 replay conflict, 4 tree differs (re-gate), 5 notes missing, 6 branch changed since gate, 7 PR not merged / gh failed, 8 not gated green. | Yes, minus identity-mode status/approval code (no exit 9). |
| `paths.sh` | Resolve `notes <branch>` / `logs` paths (`~/.multipi/<repo>/{notes,logs}`, or configured). | Yes. |
| `doctor.sh` | Prerequisites (git ≥2.31, gh logged in, jq/python3, flock), resolved paths, config sanity. | Yes. |
| `lib/common.sh` | Shared config reading (jq with python3 fallback) and helpers. | Yes. |

## 3. Roles

Prompt files in `agents/`, each with YAML frontmatter (`name`, `description`, `tools`, optional
`model`) + system-prompt body, loaded by `dispatch` (project `.pi/agents/<role>.md` overrides the
bundled one).

| Role | Tools | Brief (ported, identity sections removed) |
|---|---|---|
| `implementer` | all defaults | One ticket, end to end, in its own worktree. Ground rules (work only in worktree; never base branch / force-push / PRs; no secrets or personal identifiers ever; fakes and sandboxes only, nothing that spends money or touches production). Test-first: every acceptance criterion → named test, confirmed failing for the right reason, then smallest implementation, small Conventional Commits `Refs #n`. Targeted tests + fast check only — never the full suite; one unavoidable heavy run goes through `heavy.sh`. Spec silence → simplest option + `docs/DECISIONS.md` entry, continue. Push when green; write the PR notes file (title line, Summary, `Closes #n`, Decisions, Test evidence). Resumes from `git status`/`git log` on re-dispatch. Report ends with `STATUS:` line (§6.3). |
| `code-reviewer` | read, grep, find, ls, bash | Strict, independent review of one branch diff vs base: read every changed file in full + callers; correctness vs every acceptance criterion (name each unmet); safety/data; tests check behaviour and are deterministic; clean code; simplicity. Reproduce suspected bugs with throwaway tests, record, delete — tree ends clean, never commits. Deeper safety checklist (guards + refusal tests, idempotency, validation, audit logging, boundary/refusal coverage) when the diff touches money, orders, auth, secrets, deletion, migrations. Runs targeted tests + fast check only. Output: Must fix / Should fix lists + `VERDICT: APPROVE|CHANGES REQUIRED`. |
| `verifier` | read, grep, find, ls, bash | Read-only audit of a real run's outputs against the ticket's expectation: spot-check data, invariants, logs; report anomalies with evidence. Never modifies anything. |

The review loop is mechanical: CHANGES REQUIRED → re-dispatch the same implementer with the
must-fix list verbatim → re-review until APPROVE. Never skipped because the implementer
self-reviewed; never merged on anything but a final APPROVE.

## 4. Loop & state

Phase is tracked **by GitHub issue labels** — the only loop state; no local ticket store:

```
open → dl/in-progress → dl/in-review → dl/approved → dl/gated → dl/merged (issue closed)
        └────────────── dl/blocked (any phase; with a comment explaining why and what unblocks it)
```

Flow (owned by the `devloop` skill):

1. **Tickets.** One issue per work item of the spec's breakdown: acceptance criteria as a
   checklist, `Depends on #n`, labels. Spec lives in git (e.g. `docs/spec/`), committed and pushed.
2. **Schedule.** ≤3 implementers at once, one ticket each; a ticket starts when its dependencies
   are merged (or may stack on a dependency's pushed branch). Pair tickets that touch different
   areas. After every merge or report, start the next ticket immediately — no pausing to report.
3. **Implement.** `devloop.dispatch {role: implementer, ticket}` (parallel tool calls give the
   concurrency; the tool enforces the cap).
4. **Review.** On green report + pushed branch: `devloop.dispatch {role: code-reviewer, branch}`.
   Loop to APPROVE per §3.
5. **Gate.** One or more approved → `devloop.gate [b1 b2 ...]` in merge order (heavy job; the
   orchestrator continues other work while it runs where practical).
   - GREEN → merge.
   - RED → never merge. Re-run once (flake vs failure). Still red → bisect the train (half, then
     rest), send the culprit's log excerpt to its implementer, gate the rest without it, issue for
     a real flake.
   - CONFLICT at bn → drop it, gate/merge the rest, implementer rebases on the new base, re-gate.
6. **Merge.** `devloop.merge [same branches, same order]`. Base moved (exit 4) → re-gate first.
   Afterwards: remove merged worktrees, comment on issues, close via `Closes #n`, start next tickets.
   Stacked branches rebase `--onto` after the lower merges, never carrying foreign commits.
7. **Run & verify.** A merged ticket that adds/changes a job: run it for real (background if long),
   record result on the issue, `devloop.dispatch {role: verifier}` on the outputs. Deploy only when
   the user is not actively using the system.
8. **Decide & stop.** Spec silence → decide, log, continue. Stop and ask Paul only for:
   missing/rejected credentials; a paid action above the project cost cap; a spec contradiction
   where both readings change stored data or relied-upon behaviour; anything unsafe or
   irreversible (production data, real money/orders, deleting history, security settings).
9. **Talk.** Plain language, lead with the result, no internal jargon. Ask only when the answer
   changes what happens; ask everything needed at once. No secrets or personal identifiers in repo,
   commits, issues, PRs or prompts.

Restart-recovery: on session start the skill reads AGENTS.md, the spec, `.devloop.json`,
`docs/DECISIONS.md`, runs `doctor.sh`, then `devloop.status` to find work in flight (labels,
worktrees, state file) before starting anything new.

## 5. Project config: `.devloop.json`

Repo root, committed. Same keys/defaults as the reference (state dir renamed to
`~/.multipi/<repo>/`): `base_branch` (main), `remote` (origin), `fast_check`, `format` +
`format_extensions`, `checks[]` (`{name, command, heavy, summary}` or plain string; required for
the gate), `gate_setup`, `gate_worktree` (default `../<repo>-gate`), `notes_dir`, `logs_dir`,
`heavy.{slots=2, memory_max, port_env, port_base=8600, port_step=10, clean_temp=[], clean_temp_minutes=120, poll_seconds=10}`,
`stop_gate.{require_clean_tree=true, max_blocks=5}`, `merge.{method=squash, delete_branch=true}`,
`github.repo` (default from remote URL), `deploy`.

## 6. Child-process protocol

### 6.1 Spawn

`pi -p --no-session --mode json [--model m] [--tools t,...] --append-system-prompt <role.md>`,
`Task: <brief>` as the prompt, cwd = worktree, `stdio` pipes; stdout consumed as newline-delimited
JSON events (`message_end`, `tool_result_end`) for streaming + usage aggregation. Model defaults to
the parent session's model and thinking level (overridable per agent frontmatter). Aborts:
`ctx.signal` (parent Ctrl+C or `devloop.cancel`) → SIGTERM, SIGKILL after 5s. Invocation resolution
follows the pi subagent example (re-execute `process.argv[1]` when it is the pi entry script).

### 6.2 Context a child builds from

Role system prompt + the worktree's AGENTS.md (injected by the child's own pi startup) + the ticket
(`gh issue view`) + spec sections it cites. Nothing about sibling tickets beyond what the brief says
(files other agents are editing — avoid them).

### 6.3 Report protocol

Every child's final message ends with:

```
STATUS: DONE
```
or
```
STATUS: BLOCKED — <one-line reason>
```
preceded by the role's report body; a `## Questions` section (may be empty) lists anything needing
the orchestrator or the user. `DONE` with open questions is allowed: the orchestrator re-dispatches
with answers embedded, or escalates. `BLOCKED` → ticket labelled `dl/blocked` + explanatory issue
comment; the stop-gate won't spin on it; the orchestrator reports to the user.

### 6.4 In-flight changes & interruption

- Global: Ctrl+C kills all running children (signal propagation).
- Selective: `devloop.cancel {ticket}`.
- Requirement change in flight: edit the issue (source of truth) → cancel → re-dispatch. The
  resumed child re-reads the ticket first; invalidated partial work is discarded per brief and the
  decision logged in `docs/DECISIONS.md`. Audit trail = issue history + commits + decisions log.
- The user watches children live (streamed tool calls/text) and can message the orchestrator
  mid-run; it reaches the orchestrator at the next tool boundary. Granularity is per-ticket.

## 7. Error handling summary

| Failure | Behaviour |
|---|---|
| Dispatch spawn/exec failure, `stopReason: error` | Structured error to orchestrator (stderr tail + exit code); slot freed; ticket stays `dl/in-progress` for re-dispatch. |
| Child reports BLOCKED | Label `dl/blocked`, comment issue, escalate if user input required (stop-condition path). |
| Gate red | Never merged; re-run once; bisect; issue for real flakes. Logs in `logs_dir` always kept. |
| Gate/merge conflict | Branch dropped from train; rest proceed; implementer rebases; re-gate. |
| Merge tree mismatch / base moved | Branch aborts cleanly (exit 2 / 4); nothing merges silently; re-gate required. |
| Stop-gate exhaustion | Gives up after `max_blocks` consecutive blocks, says so on stderr→model, allows the stop; expects an issue describing the blocker. |
| Extension handler errors | Reported by pi, fail-closed where a safety decision is involved (e.g. format hook failure does not corrupt the file; stop-gate failure → allow stop, report error). |
| Restart mid-loop | `devloop.status` reconstructs phase from labels + worktrees + state file; stale state-file entries (dead pids) are pruned on read. |

## 8. v2 options (documented, not built)

1. `test-engineer` role: tests authored blind from acceptance criteria before implementation;
   implementer commits them. Trigger to reconsider: reviewers finding weakened tests in practice.
2. Live steering: children kept as RPC sessions, mid-turn requirement deltas pushed to a running
   child. Trade-off: persistent state + more machinery vs the clean cancel/resume semantics of v1.
3. Other ticketing backends: adapter behind the orchestrator's narrow ticket vocabulary.
4. Per-role GitHub identities (apps/rulesets/status gates) from the reference.

## 9. Repository layout

```
extension/index.ts        # entry: registers tools, hooks
extension/src/config.ts   # .devloop.json parsing + defaults + validation
extension/src/dispatch.ts # child spawn, state file, concurrency cap, brief assembly
extension/src/gate.ts     # gate-train wrapper + result parsing
extension/src/merge.ts    # merge-train wrapper + result parsing
extension/src/status.ts   # derived snapshot
extension/src/stopgate.ts # agent_before_settle logic
extension/src/formatter.ts# format-on-edit hook
agents/                   # implementer.md, code-reviewer.md, verifier.md
skills/devloop/SKILL.md   # orchestrator workflow
skills/devloop-setup/SKILL.md
scripts/                  # heavy.sh gate-train.sh merge-train.sh paths.sh doctor.sh lib/
templates/                # devloop.json, AGENTS.md skeleton, DECISIONS.md
tests/                    # smoke.sh + fakes (fake-gh, fake-pi)
Makefile                  # check: tsc --noEmit, shellcheck (skip w/ notice if absent), tests/smoke.sh
README.md
```

Install into a target project: the extension + agents + scripts + skills (a small `install` step
or pi package; decided during implementation). This repo is its own first installed instance
(dogfood: the build-out tickets of multipi itself live as GitHub issues on this repo).

## 10. Testing

- **Type level**: `tsc --noEmit` over extension + src (types imported from
  `@earendil-works/pi-coding-agent`).
- **Shell**: shellcheck over all scripts (Make target degrades to a warning when the binary is
  absent — Paul installs it; the loop does not silently skip).
- **Smoke** (`tests/smoke.sh`, offline): throwaway repo + local bare origin + `fake-gh` (records
  issues/PRs/labels to a JSON file) + `fake-pi` (emits scripted JSON events: tool calls, final
  report with STATUS line, usage; honours SIGTERM; configurable failure modes). Covers:
  - worktree/branch/port/notes-path computation in `dispatch`;
  - concurrency cap: 4th simultaneous dispatch refused with the in-flight list; re-dispatch of a
    cancelled ticket reuses the existing worktree (no duplicate branch error); state-file staleness
    pruning (dead pids pruned on read);
  - cancel kills the fake child and frees the slot;
  - resume: re-dispatch after cancel produces a fresh child in the same worktree;
  - gate green / red (log kept) / conflict drop-out; heavy queue (3 jobs on 2 slots);
  - merge order + tree-equality rejection + base-moved (exit 4);
  - PR opened from notes file (fake-gh asserts title/body, `Closes #n`);
  - stop-gate: fast-check red forces continuation, exhaustion allows stop, blocked labels exempt
    from loop-drive.
- **Dogfood**: after the smoke suite passes, the remaining polish tickets of multipi itself are run
  through the loop on this repo.

## 11. Delivery sequence (informative; the implementation plan will refine)

1. Skeleton: repo layout, config module, `doctor.sh`, templates; `make check` green.
2. Scripts: `heavy.sh`, `gate-train.sh`, `merge-train.sh` + smoke tests with fakes.
3. Dispatch: spawn protocol, state file, cap, cancel, brief assembly + tests with fake-pi.
4. Gate/merge/status tools; hooks (stop-gate 3-way, format-on-edit) + tests.
5. Role prompts + skills; manual end-to-end pass on a trivial ticket in a scratch repo.
6. Dogfood bootstrap of this repo; loop-driven completion of remaining tickets.
