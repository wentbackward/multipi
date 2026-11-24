# multipi — system specification (living spec, current state)

Status: live. This document is the **rebuild source of truth** for multipi: the single
human- and agent-readable description of what the system IS today — enough to rebuild it from
scratch. It consolidates the four dated design specs, the post-shipping addenda and the
`docs/DECISIONS.md` learnings into one coherent current-state document.

Relationship to the other documents:

- `docs/superpowers/specs/*.md` — **history**: the four dated specs are the audit trail of
  *why* the system became this (design, dark factory, permission policy, orchestrator liveness).
  They are superseded here descriptively, not destructively — never rewritten except by a
  documented drift fix.
- `docs/LEARNINGS.md` — the operational lessons (symptom → root cause → prevention → pin).
- `docs/DECISIONS.md` — the decision log (spec-silent choices).
- `AGENTS.md` — how to work in this repo (conventions, seams, guard limits).

**Freshness discipline (pinned):** if a change alters a contract surface — a control-plane tool,
a loop label, a script exit code, a `.devloop.json` key, or the child protocol — update this
document in the same change. The freshness check (`tests/unit/spec-freshness.test.ts`, part of
the `unit` check that the batch gate runs) asserts this document against the code on the
already-pinned surfaces (tool names, label vocabulary, exit tables, config keys, the dispatch
parameter cell, the roles' tool sets, the environment-seams inventory) and is red on drift. Grow it: a new pinned surface joins the test as it gains
ground truth.

## 1. What multipi is

multipi is an autonomous multi-agent development loop for the **pi** coding agent: one
orchestrator pi session drives one-shot role children (implementer / code-reviewer / verifier /
analyst / scenario-writer) in isolated git worktrees, plus the stage-spawned scenario-judge
of the dark-factory gate (no worktree); the dispatched children's branches are reviewed
independently, gated in batches, and squash-merged in order. GitHub issues are the tickets;
issue labels are the loop state; the deterministic scripts and structured extension tools are
the hands.

Core invariant: **the model orchestrates; the machine decides.** Reliability lives in
deterministic scripts and structured tools; the LLM schedules, interprets and reports. The loop
*continues coding while there are open, unblocked requirements* and stops only for the stop
conditions (credentials, spec contradictions that change pinned contracts, unsafe/irreversible
actions).

Operating modes: `"factory": "collaborative"` (default — a human reviews outcomes) and
`"dark"` (dark factory — holdout scenario gates plus a role guard stand in for human diff
review; spec `2026-11-01-multipi-dark-factory.md`). This repository is its own first installed
instance (dogfood): `.devloop.json` is committed and the loop runs on this repo's own tickets.

## 2. Architecture

Three layers, each independently testable, plus the operator console:

| Layer | Where | Job |
|---|---|---|
| Skills | `skills/` (installed to `.pi/skills/`) | `devloop` — the orchestrator workflow (ticketing, scheduling, review, gate, merge, verify, stop conditions); `devloop-setup` — bootstrap a project. |
| Extension | `extension/` (installed to `.pi/extensions/multipi-devloop/`) | TypeScript, erasable-only syntax, `tsc --noEmit`, no build step (Node 24 type stripping). Registers the six control-plane tools and the hooks (§3, §4). Only `tools.ts` and `index.ts` import pi types; every `src/` module they delegate to is pure node (testable without pi). |
| Scripts | `scripts/` (bash 4+, `set -u`, shellcheck-clean) | The deterministic hands: heavy queue, gate/merge trains, cleanup, scenario stage, doctor, install, operator console, policy shims. Exit codes are pinned contracts (§12). |
| Roles | `agents/` (installed to `.pi/agents/`) | System-prompt files per role (frontmatter: `name`, `description`, `tools`, optional `model`); project layer shadows the bundled copy. |
| Console | `scripts/multipi` (dispatcher) + `scripts/multipi-*.sh` | Operator surfaces: status, board, interrupt, watch daemon, doctor (§11). |

Install layout: `scripts/install.sh <repo>` copies scripts/, the extension (self-contained, with
its own `agents/` fallback copy), roles and skills into the target's `.pi/` tree; targets become
self-contained and re-install is a sync. In THIS repo the installed `.pi/` copies are
byte-identical mirrors of their sources, pinned by `tests/unit/installsync.test.ts`.

Where state lives (everything is derivable; nothing is stored that cannot be reconstructed):

- Issue tracker: tickets, labels (the phase), comments (the audit trail).
- `$MULTIPI_HOME/<repo>/` (default `~/.multipi/<repo>`, seam `MULTIPI_HOME`): `dispatch.json`
  (dispatch-state entries), `reports/<key>.md` (child report files), `notes/`, `logs/`,
  `worktrees/<repo>/` (issue worktrees `<dir>/issue-<n>` + the gate worktree), `scenarios/`
  (scenario store, dark mode).
- Repo git common dir: `devloop-stop-count` (stop-gate counter, never committed).
- Runtime dir (`$XDG_RUNTIME_DIR/multipi-heavy-slots`): machine-wide heavy-job slot locks.

Testing: fully offline — `make check` (tsc + unit tests, smoke, hygiene, shellcheck) runs with
no network and no real GitHub; `tests/fake-gh` and `tests/fake-pi` are the stand-ins. A test
that needs the network is a design smell, not a flake.

## 3. Control-plane tools

Six tools, underscored names (no dots: the OpenAI function-name grammar rejects a dot —
see `docs/LEARNINGS.md`, Kimi). The names live in one place —
`TOOL_NAMES`/`REGISTERED_TOOL_NAMES` in `extension/src/toolnames.ts` — shared by the
registration, the bounded-run labels, the provider grammar probe and the pins below.

| Tool | Parameters | Behaviour |
|---|---|---|
| `devloop_dispatch` | `{role: "implementer"|"code-reviewer"|"verifier"|"analyst"|"scenario-writer", ticket?, branch?, worktree?, task?, spec?, focus?}` | Spawns the role as an isolated headless child with its role prompt; **fire-and-poll**: returns a receipt immediately (key, branch, worktree, notes/report paths, duration hint) and the child runs in the background — the report lands on the next `devloop_status` late-report ledger (presented exactly once) and the watchdog wakes the session when a report lands. Capacity: at most `heavy.slots` in-flight implementers (state file; a further dispatch is refused with the in-flight list). Branch, worktree, port range, notes path and brief are computed deterministically from the ticket. Local refusals (busy ticket, capacity, startability with the scenario store on) precede any remote call. The `orchestrator.tool_timeout_minutes` bound remains as the preflight safety net only. |
| `devloop_cancel` | `{ticket}` | Kills one running child (SIGTERM to its process group, SIGKILL after the grace); the worktree and branch survive, a re-dispatch resumes. |
| `devloop_pause` | — | Operator checkpoint: terminates every running child (bounded 15 s kill-wait, laggards reported), writes `HANDOFF.md` to the notes dir (per-child positions + open-board snapshot), comments each interrupted ticket. Resume = fresh session reading the handoff. |
| `devloop_gate` | `{branches: string[]}` (merge order) | Wraps `scripts/gate-train.sh`: stacks the branches on the latest base in the gate worktree, runs every configured check once (heavy ones through `heavy.sh`), then the scenario stage (store on). Result: green / red (failing tail) / conflict (branch named) / error. |
| `devloop_merge` | `{branches: string[]}` (same order as the gate) | Wraps `scripts/merge-train.sh`: replays each branch on the current base, asserts the replayed tree is exactly the gated tree, opens the PR from the notes file, squash-merges, deletes branches and worktrees (clean ones). Refusals: replay-conflict / tree-differs / notes-missing / branch-changed / pr-not-merged / not-gated-green. |
| `devloop_status` | — | Derived snapshot for recovery and reporting: in-flight children, late reports (terminals since the last status, acked into the ledger), open tickets with `dl/` labels, dependencies, polish depth, last green gate record. Reclaims orphaned children (dead pid → `crashed`, slot freed) as it runs. |

Every `devloop_*` call is bounded by `orchestrator.tool_timeout_minutes` (default 45 min;
`MULTIPI_TOOL_TIMEOUT_MS` overrides, 0 disables): on expiry the call RESOLVES with a
reconciliation error text — it never rejects and never hangs; abandoned side effects (a spawned
child, a pushed branch) continue, and the text tells the operator how to reconcile.

## 4. Hooks and guards

- **Stop-gate** (`agent_before_settle`, active only when `.devloop.json` exists): (1)
  `fast_check` failing → one forced continuation with the failure tail; (2) dirty tree (when
  `stop_gate.require_clean_tree`) → one forced continuation; (1) and (2) are bounded by
  `stop_gate.max_blocks` (counter in the git common dir, resets when green). (3) **Loop drive**:
  a startable ticket exists and an implementer slot is free → one forced continuation —
  *unbounded*, because that is the loop's job. A delivered (done) branch whose ticket still sits
  in the review window with no running review also drives (the late-report drive). With the
  scenario store on, "startable" additionally requires a valid `t<n>-` scenario in the store
  (unreadable store covers nothing — fail-closed). A broken gate never wedges the session: it
  fails open, reporting the error.
- **Format-on-edit** (`tool_result`): after a successful write/edit, if `format` is configured
  and the file matches `format_extensions` (plain suffix matching — list every distinct
  extension), run the format command with `{file}` substituted.
- **Child isolation**: `spawnPi` stamps `MULTIPI_CHILD=1` in the child env; the extension
  registers NOTHING (no tools, no hooks) for such a process. Children are executors; only the
  orchestrator drives (an isolated child that loaded the loop sat in the stop-gate continue loop
  for 30+ minutes — learned the hard way, `docs/LEARNINGS.md`).
- **Role guard** (dark factory): a child of a guarded role (`implementer`, `code-reviewer`,
  `verifier`) loads a guard-ONLY extension — one block-capable `tool_call` hook that refuses any
  tool call naming a path inside the scenario store, nothing else — keyed on
  `MULTIPI_CHILD_ROLE`. `analyst`, `scenario-writer` and `scenario-judge` are not guarded. The
  store path is resolved from the committed config at load (no env seam carries it);
  missing/unparseable config fails CLOSED. Honest limits: the guard reads the command line, not
  what runs — a script the child writes, a runtime-assembled path, and a recursive ancestor
  search are not caught; the default store location (outside every worktree) is the cheap first
  defence, and an OS user without read access is the documented escalation.

## 5. Loop and label state machine

Phase is tracked **by GitHub issue labels — the only loop state**; no local ticket store:

```
open → dl/in-progress → dl/in-review → dl/approved → dl/gated → dl/merged (issue closed)
        └────────────── dl/blocked (any phase; a comment explains what unblocks it)
```

| Label | Meaning | Set by |
|---|---|---|
| `dl/in-progress` | a child is working the ticket | automatically on implementer dispatch |
| `dl/in-review` | branch pushed, PR open, review may run | automatically on a green implementer report (with the PR open) |
| `dl/approved` | `VERDICT: APPROVE` received (after the polish budget, §8) | the orchestrator |
| `dl/gated` | included in a green gate train | the orchestrator, after `devloop_gate` green |
| `dl/merged` | squash-merged into the base | the orchestrator, after `devloop_merge` |
| `dl/blocked` | needs a human decision; the body/comment states the question | the orchestrator (triage) or on a `STATUS: BLOCKED` report |

Closing is MANUAL: once the squash merge is confirmed the orchestrator runs
`gh issue close <n> --comment …`. The PR's `Closes #n` body is not the close mechanism (the
keyword only fires on MERGE), and the delete-then-push rebase path is a trap: **deleting a
branch with an open, unmerged PR closes that PR without merging** — an already-merged PR is
unaffected by branch deletion. A PR closed that way must be reopened (or re-created) and
re-merged before its issue is closed (observed on #55; `docs/LEARNINGS.md`).

Restart-recovery: every session start reads AGENTS.md, the spec, `.devloop.json`,
`docs/DECISIONS.md`, then `devloop_status` — labels, worktrees and the dispatch state say where
every ticket stands; interrupted children re-dispatch into the same worktree.

## 6. Configuration

Repo-root `.devloop.json`, committed. The schema has ONE source of truth:
`DEVLOOP_CONFIG_KEYS` in `extension/src/config.ts` (next to the parser that consumes it).
This table asserts against that list — a key the parser (or a loop script reading the same
file) accepts but the table lacks, and a table row the loop does not accept, both make the
freshness check red. Add the key to `DEVLOOP_CONFIG_KEYS` first, then here.

Unknown keys are ignored; malformed values coerce to the default (config-layer discipline), and
a present-but-invalid `review.max_followup_depth` falls back WITH a console warning.

| key | type | default | notes |
|---|---|---|---|
| `base_branch` | string | `main` | the base the loop builds and merges onto |
| `remote` | string | `origin` | the git remote gh/git address |
| `fast_check` | string | (unset) | cheap check the stop-gate and children run after edits |
| `format` | string \| null | (unset) | format command, `{file}` = path |
| `format_extensions` | string[] | (unset) | plain suffixes (list every distinct extension) |
| `checks` | array | `[]` | the gate's check set; required for the gate; read from the MAIN repo root (a gated branch cannot redefine the checks validating it) |
| `checks[].name` | string | `check-<n>` | check label |
| `checks[].command` | string | — | what to run (a plain-string entry sets only this) |
| `checks[].heavy` | boolean | `true` | route through `heavy.sh` (machine-wide slots) |
| `checks[].summary` | string | — | regex that extracts the one-line summary from the check output |
| `gate_setup` | string | (unset) | run in the gate worktree before the checks |
| `gate_worktree` | path | `<worktree_dir>/gate` | absolute, `~/`, or relative to the repo parent |
| `worktree_dir` | path | `<state_dir>/worktrees/<repo>` | one dir holds every issue worktree + the gate worktree; relative resolves against the repo PARENT |
| `factory` | `"collaborative"` \| `"dark"` | `collaborative` | operating-mode preset: only sets defaults; any explicit option wins; any other value coerces to collaborative |
| `scenarios` | object \| false | (absent) | the scenario store: the block's presence turns it ON in any mode; `false` is the only off-switch; absent, `dark` turns it on |
| `scenarios.dir` | path | `<state_dir>/scenarios` | resolves like `worktree_dir` (can never live inside the repo) |
| `scenarios.run` | string | (unset) | shell snippet that starts the system under test; its first printed line is the target |
| `scenarios.run_seconds` | number | `120` | run cap |
| `scenarios.judge` | string | (unset) | shell snippet judging one scenario (default: headless `scenario-judge` child) |
| `scenarios.judge_seconds` | number | `600` | judge cap |
| `scenarios.pass` | number | `0.8` | satisfied-ratio floor |
| `scenarios.min_satisfaction` | number | `0.9` | per-scenario average floor |
| `scenarios.sealed` | number | `0.2` | sealed fraction (deterministic checksum rule hides some ids from the writer) |
| `child_silence_minutes` | number | `30` | child stream-silence watchdog (wall time is not the metric) |
| `notes_dir` | path | `<state_dir>/notes` | PR notes / handoff / plan files |
| `logs_dir` | path | `<state_dir>/logs` | gate and check logs |
| `heavy` | object | — | heavy-job queue settings |
| `heavy.slots` | number | `2` | machine-wide concurrent heavy jobs; also the implementer capacity |
| `heavy.memory_max` | string | (unset) | optional systemd user-scope memory cap for jobs |
| `heavy.port_env` | string | (unset) | env var each slot's port is exported into |
| `heavy.port_base` | number | `8600` | per-slot port allocation base |
| `heavy.port_step` | number | `10` | per-slot port step |
| `heavy.clean_temp` | string[] | `[]` | temp prefixes the poller may clean |
| `heavy.clean_temp_minutes` | number | `120` | stale-temp age threshold |
| `heavy.poll_seconds` | number | `10` | slot poll interval |
| `stop_gate` | object | — | stop-gate bounds |
| `stop_gate.require_clean_tree` | boolean | `true` | dirty tree forces a continuation |
| `stop_gate.max_blocks` | number | `5` | consecutive blocks before the gate concedes |
| `merge` | object | — | merge-train behaviour |
| `merge.method` | string | `squash` | merge style |
| `merge.delete_branch` | boolean | `true` | delete merged branches (note the §5 PR-close nuance: it closes an open, unmerged PR — a merged PR is unaffected) |
| `policy` | object | — | permission-policy posture; the rule ARRAYS live in the sibling `permissions.json` |
| `policy.posture` | `"allow"` \| `"ask"` | `allow` | what an unmatched call does |
| `policy.repos` | string[] | `["self"]` | repo allowlist: `self` or absolute MAIN-repo roots; one untrusted entry invalidates the list to `["self"]` |
| `policy.secondaries` | string[] | `[]` | foreign main roots where a mutation ASKS instead of denying |
| `policy.token_ttl_minutes` | number | `10` | ask-token lifetime |
| `orchestrator` | object | — | orchestrator-side bounds |
| `orchestrator.tool_timeout_minutes` | number | `45` | devloop_* tool-call bound (preflight safety net after #133) |
| `review` | object | — | review-loop budget |
| `review.max_followup_depth` | number | `2` | per-ticket should-fix re-dispatch rounds before the tail is accepted (must-fix rounds never count) |
| `cleanup` | object | — | worktree-collection settings (shell-side) |
| `cleanup.stale_days` | number | `14` | read by `scripts/cleanup-worktrees.sh` (shared `cfg` reader) — the STALE bucket's idle window |
| `deploy` | string | (unset) | deploy command (used only when a ticket ships a job and the user is away) |

## 7. Child protocol

**Spawn.** `pi -p --no-session --mode json [--model m] [--tools …] --append-system-prompt
<role.md>` with the role brief as the prompt, cwd = the child's worktree (repo root for
analyst / scenario-writer / judge). Model: a role may pin its own via frontmatter; otherwise
the child inherits the PARENT SESSION's model (the settings default is only the final fallback).
The child runs `detached` in its own process group; `MULTIPI_CHILD=1` is stamped, and any
inherited `MULTIPI_CHILD_ROLE` is deleted unconditionally, before the stamp — the stamp is
then applied to every spawned child that carries a role (an explicit `MULTIPI_CHILD_ROLE` is
never inherited from the orchestrator's env; a stale role must never leak into a role-less
child). The guard-only extension is loaded only for guarded roles (§4).

**Streaming.** The child's NDJSON events stream turns/tokens/cost/current-activity to the
dispatch tool output (per completed turn + heartbeat, rate-limited) and feed the in-process
visibility registry (widget bar, agents panel). The process-group contract: cancel/pause/
watchdog kill the GROUP; every child exit sweeps survivors (SIGTERM → SIGKILL); settlement is
driven by the child's `exit` event, not `close` (a leaked grandchild can hold the pipes open);
an orchestrator `exit` hook SIGKILLs still-live child trees.

**Watchdog.** A child emitting no OUTPUT for `child_silence_minutes` is killed as a whole
process group, recorded crashed with `WATCHDOG: …` and exitCode 124, and re-dispatched by the
ordinary crashed-entry recovery.

**Report.** Every dispatched child's final message ends with exactly one terminal line — the
LAST non-empty line, checked against the role's contract (mid-body marker quotes never decide):
implementer / scenario-writer / analyst / verifier end `STATUS: DONE` or
`STATUS: BLOCKED — <reason>`; code-reviewer ends `VERDICT: APPROVE` or
`VERDICT: CHANGES [REQUIRED]`. No terminal marker → `crashed` (a crashed child opens no PR).
Preceded by the role's report body and a `## Questions` section (may say "none").

**scenario-judge** (spawned by the stage script, never dispatched) is different: it ends with
a single JSON verdict line on the last line — `{"id","satisfied","required","evidence","missing"}`
(id must match the judged scenario; `satisfied` a number in 0..1; `required` a boolean; evidence
and missing strings) — parsed by `scripts/scenario-stage.sh` (via `foldJudgeRun`), which decides
green/red, never the agent. An invalid verdict, a non-zero judge exit or a spawn failure both
score 0.

**In-flight changes.** Edit the issue (source of truth) → `devloop_cancel` → re-dispatch; the
resumed child re-reads the ticket first, discards invalidated partial work per brief and logs
the decision. `MULTIPI_LIST_LAG_RETRY_MS` bounds the one GitHub list-lag retry of the
open-ticket lookup (default 1500 ms).

## 8. Roles

| Role | Tools | Disposition | Contract |
|---|---|---|---|
| `implementer` | pi defaults | own worktree per ticket, consumes an implementer slot | one ticket end to end: tests first (each acceptance criterion a named test, failing for the right reason), small Conventional Commits ending `Refs #n`, targeted tests + fast check only, push when green, notes file, terminal `STATUS:` line |
| `code-reviewer` | `read, grep, find, ls, bash` | the ticket's worktree | independent strict review of the branch diff vs base; must-fix / should-fix lists; terminal `VERDICT:` line; CHANGES REQUIRED re-dispatches until APPROVE |
| `verifier` | `read, grep, find, ls, bash` | repo root, free-form task | read-only audit of real run outputs against expectations; terminal `STATUS:` line; the post-merge train verifier ends `VERIFICATION: PASS\|FAIL` |
| `analyst` | `read, grep, find, ls, bash` (inspection only) | repo root, no slot | decompose a spec (`spec`) or operator feedback (`focus`) into an ordered ticket plan; the ORCHESTRATOR raises the issues — a child never creates scope |
| `scenario-writer` | `read, write, edit, ls, bash` | repo root, no slot; reads the ticket + spec, NEVER the code | writes the ticket's holdout scenarios to the store; report lists the scenario titles and posts them as a review comment |
| `scenario-judge` | `read, grep, find, ls, bash` (spawned by the stage script, never dispatched) | per-scenario headless run | judges ONE scenario (`MULTIPI_SCENARIO_FILE/ID/TARGET`); the script decides green/red, never the agent |

Guarded roles (the role guard, §4): `implementer`, `code-reviewer`, `verifier`.

**The review loop** is mechanical and bounded: CHANGES REQUIRED → comment the must-fix list
verbatim → re-dispatch the same implementer → re-review. Must-fix rounds never count toward the
budget; at/over `review.max_followup_depth` the should-fix tail is ACCEPTED and parked verbatim
in the per-area `Polish backlog — <area>` ticket (`scripts/polish-tail.sh`), the ticket proceeds
as `dl/approved`. Terminus: the backlog is where polish converges (see `docs/LEARNINGS.md`).

## 9. Dark factory: scenario store, stage, guard

The **store** is a directory of Markdown scenario files (any depth, nothing under `.git`):
`id` frontmatter (`[A-Za-z0-9._-]+`), `required` flag, user/goal + preconditions + steps +
`Satisfied when` in the USER'S terms. Duplicate ids: first file in path-sorted order wins.
Sealed ids (the deterministic checksum fraction) stay hidden from the writer. A `t<ticket>-`
prefix is the ticket-coverage grammar (exact prefix: `t12-` covers 12, never 123). With the
store on, a ticket is startable only when a valid scenario covers it.

The **stage** (`scripts/scenario-stage.sh`) runs in the gate AFTER the checks, on the train top:
it starts the system under test (`scenarios.run`, first printed line = target), runs every
valid scenario through a judge, scores against `pass` / `min_satisfaction`, and folds its
verdict into the gate's UNCHANGED exit contract (red stage → the gate is TRAIN RED exit 1 with
no train record; stage usage/config → exit 2 without the TRAIN RED word; store off → the gate
prints `scenarios skipped` and its pre-stage behaviour). Judges are one-shot headless children
spawned by the script itself (own process group, TERM→KILL); a non-zero judge exit scores 0
even with a well-formed verdict line. **Log hygiene (pinned):** `train-scenario-results.jsonl`,
`train-scenario-judge/` and `train-scenarios-run.log` hold judge evidence and sealed ids — they
are NEVER forwarded to an implementer/reviewer/verifier; only the `missing` text of
unsatisfied scenarios travels back.

## 10. Permission model

Policy: default-ALLOW with curated deny/ask classes (the `"ask"` posture is the strict flip;
confirmed operator default: `allow`, self-only, 10-min TTL). Actions are classified along
three dimensions (transport/program, class, direction); verdicts are allow / deny / ask with
an audit record for every non-default verdict. Two enforcement layers:

1. **The extension hook** (pi `tool_call`): judges the session's own tool calls, redacts
   action summaries, appends audit lines.
2. **The policy shims** (`scripts/policy-shims/git`, `…/gh`, PATH-prepended at session start):
   the child's shell-level escape hatch. A shim never accepts an interpreted SCRIPT as the real
   binary (`shim_find_real` requires a compiled artifact outside the shim dir), consults
   `MULTIPI_SHIM_REAL_GH` / `MULTIPI_SHIM_REAL_GIT` first (a SET-but-unusable target fails
   closed with exit 127, never falling back), and refuses mutual-exec with itself
   (`_POLICYSHIM_DEPTH` > 3 → exit 126). Denied/asked calls and the recursion-depth guard
   all exit 126 (nothing executed); anything else is the real binary's own exit.

Trusted programs (loop scripts in a checkout of THIS repo, verified by a `/proc` PPID-chain
identity walk) are exempted from ONLY the base-branch/force-push denials and the
`gh pr merge` ask; the tag asks are never lifted. The gate scrubs the shims off its own PATH
(`MULTIPI_GATE_SCRUB_POLICY_SHIMS`, default on) — authority separation: the shims protect the
loop's sessions, never the loop's verification. `scripts/multipi-approve` mints
single-use ask-tokens (TTL from `policy.token_ttl_minutes`; `MULTIPI_APPROVE_NOW_MS` is the
issuing-clock test seam). Honest limits are documented in the permission-policy spec §9.

## 11. Liveness and operator console

The **sidecar** (per-TUI-session heartbeat document) records session liveness, the in-flight
devloop tool + elapsed, and the watchdog's wake watermarks. One command dispatches the
operator surfaces: `scripts/multipi` → `status | board | interrupt | watch | doctor`, rc
passthrough; `multipi help` shows the rc contracts; an unknown subcommand is the dispatcher's
own rc 2. The named scripts remain fully standalone.

- `multipi-status.sh` — one line (state, in-flight tool + elapsed, heartbeat age, pid, tty,
  RAM/swap). rc 0 live · 1 idle · 2 STALE/wedge · 3 dead (the line says OOM-kill is the
  likely cause and points at `journalctl --since <start> | grep oom-kill`) · 4 bad usage /
  unreadable sidecar.
- `multipi-interrupt.sh [--dry-run] "msg"` — force-sends a message into a wedged session by
  PASTING into its TTY (not an RPC: a wedged event loop may never poll). rc 0 injected · 4
  usage · 5 no live session · 6 no TTY (prints the kill-and-resume fallback — a detached
  terminal is unreachable, the honest limit).
- `multipi-watch.sh` — the watchdog. As a one-shot it checks: a tool in flight > 12 min
  (`MULTIPI_WATCH_TOOL_MS`) → WAKE; a heartbeat silent > 10 min → WEDGE (outranks the WAKE);
  a child that turned terminal in `dispatch.json` with an uncollected report → one `REPORT
  LANDED` append per report; an open `dl/blocked` ticket past 4 h (`MULTIPI_WATCH_BLOCKED_MS`)
  → at most one nudge per ticket per 24 h, naming the ticket and its question, with
  "now resumable" wording only when every `Depends on #k` is verifiably CLOSED. Deduped: one
  wake per tool-seq AND per 3600 s on the wall axis; blocked and report ledgers are the watch
  log itself. As `--daemon` (auto-started by TUI sessions, single-instance pidfile) it ticks
  on a cadence (`MULTIPI_WATCH_NOW_MS` seam). The one-shot rc table is untouched by all of
  this.
- `multipi-board.sh` — the one-glance dashboard for a human product owner: pure-read,
  offline-friendly (gh degrades to a local-only render). rc 0 nothing needs the human · 1 ≥1
  `dl/blocked` (rendered first, with its question) · 2 last gate RED or an over-bound child
  (shadows 1) · 4 bad usage / unreadable state.

## 12. Exit-code contracts

Pinned in each script's header and the design spec §2.3; a contract change is a spec change in
BOTH places plus this table (the freshness check scans it).

| Script | Exit codes |
|---|---|
| `scripts/gate-train.sh` | 0 green (train recorded) · 1 red (incl. `gate_setup` failure; log kept) · 2 usage/config · 3 rebase conflict (branch named) |
| `scripts/merge-train.sh` | 0 all merged · 2 usage/config · 3 replay conflict · 4 tree differs from the gated one (re-gate) · 5 notes file missing · 6 branch changed since the gate · 7 PR not merged / gh failed · 8 not gated green |
| `scripts/scenario-stage.sh` | 0 green (store off: `scenarios skipped`, still 0) · 1 red (invalid/empty store, failing scenarios) · 2 usage/config |
| `scripts/cleanup-worktrees.sh` | 0 done (dry-run or `--apply`; idempotent) · 2 usage/config. Default DRYRUN; open issues always win; tracker failures keep the worktree (`cannot classify`) |
| `scripts/multipi-status.sh` | 0 live · 1 idle · 2 STALE/wedge · 3 dead · 4 bad usage / unreadable sidecar |
| `scripts/multipi-interrupt.sh` | 0 message injected · 4 bad usage · 5 no live session · 6 no TTY (kill-and-resume fallback printed) |
| `scripts/multipi-board.sh` | 0 nothing needs the human · 1 ≥1 dl/blocked · 2 last gate red or over-bound child · 4 bad usage / unreadable state |
| `scripts/policy-shims/{git,gh}` | 126 denied, asked or the recursion-depth guard (mutual-exec refusal) · 127 real binary unlocatable (or seam target unusable) · anything else the real binary's own exit |
| child watchdog | 124 the child was killed for stream silence (`WATCHDOG: …` recorded) |

## 13. Environment seams

Every `MULTIPI_*` variable is a documented seam; never introduce undocumented ones. Authoritative
detail lives in AGENTS.md; the table is the inventory (child = set for one-shot children,
operator = set for the operator's own sessions/checks):

| Seam | Who | Meaning |
|---|---|---|
| `MULTIPI_HOME` | all | state-dir root (default `~/.multipi`) |
| `MULTIPI_CONFIG` | all | alternate `.devloop.json` path (test seam the guard also inherits) |
| `MULTIPI_PI_BIN` | all | which `pi` binary to spawn |
| `MULTIPI_AGENTS_DIR` | all | bundled role-prompts dir override |
| `MULTIPI_LOCK_DIR` | all | heavy-slot lock dir override |
| `MULTIPI_HEAVY_SLOTS` | loop-spawned processes | heavy.sh slot-count override (defaults to `heavy.slots`, 2) |
| `MULTIPI_NO_JQ` | all | force the python3 fallback in the shared JSON readers (`jq` first when installed) |
| `MULTIPI_CHILD` | child | child isolation marker (extension registers nothing) |
| `MULTIPI_CHILD_ROLE` | child | guarded-role marker (guard-only extension loads) |
| `MULTIPI_SCENARIO_FILE` / `MULTIPI_SCENARIO_ID` / `MULTIPI_SCENARIO_TARGET` | child (judge) | the scenario a judge run judges; the target's first printed line |
| `MULTIPI_LIST_LAG_RETRY_MS` | all | the one open-ticket list-lag retry delay (default 1500 ms) |
| `MULTIPI_TOOL_TIMEOUT_MS` | all | devloop_* tool-call bound override (0 disables) |
| `MULTIPI_APPROVE_NOW_MS` | operator | ask-machinery issuing-clock override (tests drive TTL without sleeping) |
| `MULTIPI_GATE_SCRUB_POLICY_SHIMS` | gate | `1` (default) scrubs policy shims from the gate's PATH; `0` restores the armed PATH for tests |
| `MULTIPI_SHIM_REAL_GH` / `MULTIPI_SHIM_REAL_GIT` | loop-spawned processes | shim real-binary resolution override (fail closed, never a PATH fallback) |
| `MULTIPI_STATUS_STALE_MS` / `MULTIPI_STATUS_MEMINFO` / `MULTIPI_STATUS_PI_PAT` | operator | status-script test seams |
| `MULTIPI_WATCH_TOOL_MS` / `MULTIPI_WATCH_NOW_MS` / `MULTIPI_WATCH_BLOCKED_MS` | operator | watchdog cadence/threshold overrides |
| `MULTIPI_BOARD_REPO` / `MULTIPI_BOARD_CHILD_BOUND_MIN` | operator | board tracker-slug override; over-bound child threshold (default 480 min) |
| `MULTIPI_INTERRUPT_TTY` | operator | interrupt-paste target override, shared with multipi-watch.sh (smoke tests; trusted — bypasses the /dev/tty or /dev/pts check) |
| `MULTIPI_GH_SETTLE_SECONDS` | loop-spawned processes | merge-train: sleep between PR open and the merge-wait poll (default 3 s) |
| `MULTIPI_PROVIDER` / `MULTIPI_PROBE_TOOL_NAMES` | operator | provider tool-name grammar probe (what-if rename without shipping) |

`_POLICYSHIM_DEPTH` is internal plumbing, not a `MULTIPI_*` operator seam. The fake stand-ins
carry their own seams (`FAKE_PI_*`, `FAKE_GH_*`) — test infrastructure, not loop contracts.
The smoke launcher's own seams are test-only, not operator contracts: `MULTIPI_TRUSTED` (the
trusted-programs forgery probe — answered with rc 126), `MULTIPI_PLUGIN_DIR` (the module-path
override for the smoke's node one-shots) and `MULTIPI_SLOT` (heavy.sh's per-slot export, read
back by the smoke).

## 14. Checks, gate and freshness

`make check` (offline, this repo) runs four Makefile targets: `ts` (`npm run check` —
`tsc --noEmit` then `node --test tests/unit/*.test.ts`, INCLUDING the freshness pins) · `smoke`
(`tests/smoke.sh`: throwaway repo + local bare origin + `fake-gh` + `fake-pi`) · `hygiene`
(`tests/hygiene.sh`: shellcheck-clean corpus, gate wiring, `fake-gh` contract) · `shellcheck`.
The five named checks — `ts`, `unit` (`node --test tests/unit/*.test.ts`, INCLUDING the
freshness pins), `smoke`, `hygiene`, `shellcheck` — live in the repo's `.devloop.json` and are
what the batch gate runs.

The **batch gate** (`devloop_gate` / `gate-train.sh`) runs the checks from the MAIN repo's
`.devloop.json` ONCE per train — never per branch — in the gate worktree, heavy checks through
`heavy.sh`, the scenario stage last (store on). Green writes the train record the merge-train
verifies against. A branch that ADDs a check gets it at the gate only after it lands on main.

**Post-merge verification** (default ON): `scripts/verify-brief.sh <pre>..<post> [exercise]`
classifies a merged train against the shared contracts (extension incl. its `.pi` mirror,
scripts, agents, skills, the config schema, the verifier brief template, the historical
spec docs under `docs/superpowers/specs/`) —
rc 0 `VERIFY DISPATCH` (contract-touching → dispatch the verifier with the rendered brief) or
rc 10 `VERIFY SKIP` (docs/test-only; the one sanctioned skip — note a train touching only
`docs/SPEC.md` itself is docs/test-only and skips, verify-brief.sh classifies only the
historical spec docs). The verifier ends
`VERIFICATION: PASS|FAIL`; the report attaches to each covered ticket.

## 15. Learnings and history

- `docs/LEARNINGS.md` — the operational lessons distilled (wedge + OOM deaths, shim
  mutual-exec, resume-bias, the should-fix cascade and its terminus, tool-name portability,
  the flake class and the `wait_for` idiom, the delete-then-push PR nuance, …) — the
  rebuild-from-scratch institutional memory.
- Dated specs (the audit trail of why): `2026-10-27-devloop-pi-design.md` (architecture, tools,
  loop, config, child protocol + the self-seeding and pause/watchdog addenda),
  `2026-11-01-multipi-dark-factory.md`, `2026-11-09-multipi-permission-policy.md`,
  `2026-11-15-orchestrator-liveness.md`.
- `docs/DECISIONS.md` — every spec-silent decision (one line: date, decision, reason,
  alternatives). `docs/superpowers/plans/` — implementation history.
