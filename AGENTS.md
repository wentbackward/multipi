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
  `gate.ts` / `merge.ts` / `issues.ts` / `policy.ts` / `approvals.ts` / `liveness.ts` / `polish.ts` are pure-node
  (testable without pi). Only `tools.ts` and `index.ts` import pi types.
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
- **Fork trap**: `dl_load_config` (scripts/lib/common.sh) pins and exports `GH_REPO` to the
  configured origin (github.com URLs only; scp/https/ssh forms, optional port and `.git`
  suffix; a caller-exported `GH_REPO` always wins — the same preset rule as the factory
  toggle), so bare `gh` calls in any loop script resolve against the fork's tracker, not
  the parent (the extension pins `--repo` the same way). Installed copies living in forks
  rely on the plugin source carrying this block: a local per-repo patch of it (as carried
  by the oneshot test repo and the crisis monitor repo) is redundant — drop it on the next
  `install.sh` upgrade.
- **Shim real-binary resolution (ticket #68)**: the policy shims never accept an
  INTERPRETED SCRIPT as the real binary — `shim_find_real` requires a compiled artifact
  (first bytes not `#!`) in addition to being outside the shim dir, and every shim→binary
  exec goes through `_shim_exec_real` (env counter `_POLICYSHIM_DEPTH`, hard-refused with
  exit 126 above depth 3). This is what keeps a dogfood-armed session (shims on PATH) from
  mutual-exec'ing under a double-wrapped fixture; the test fixtures (smoke's `git-bdshim`)
  must resolve real binaries through the SAME helper, never `command -v`. `_POLICYSHIM_DEPTH`
  is internal plumbing, not a `MULTIPI_*` operator seam.
- **Heavy-slot locks (ticket #68)**: a killed holder leaves its lock behind, and it is
  always read as FREE: the flock path's release is kernel-managed (a residual `slotN.lock`
  file occupies nothing), and the mkdir path sweeps a dead-OR-OWNERLESS `slotN.d` at every
  acquisition attempt (`try_slot_mkdir`, not only at startup) — no pid file, an unusable
  one, or a dead pid all classify dead, because the old `kill -0 0` fallback targeted the
  caller's own process group and answered "alive" for an ownerless lock. No-flock detection
  is behavioural (`have_flock`), so a dead `flock` stub emulates a flock-less system.
- Label vocabulary: `dl/in-progress` → `dl/in-review` → `dl/approved` → `dl/gated` → `dl/merged`
  (+ `dl/blocked`). The labels ARE the state; keep them truthful.
- **Operator console** (spec 2026-11-15): `scripts/multipi-status.sh` renders one line
  (state, in-flight tool + elapsed, heartbeat age, pid, tty, available RAM/swap-free) and
  exits per its pinned rc table (0 live · 1 idle · 2 STALE/wedge · 3 dead · 4 bad usage/
  unreadable sidecar; seams `MULTIPI_STATUS_STALE_MS`, `MULTIPI_STATUS_MEMINFO`,
  `MULTIPI_STATUS_PI_PAT`). `scripts/multipi-interrupt.sh [--dry-run] "message"` force-sends
  a message into a wedged session (rc 0 injected · 4 usage · 5 no live session · 6 no TTY —
  prints the kill-and-resume fallback; a TTY paste, not an RPC: a detached terminal is
  unreachable, that is the honest limit). Every `devloop_*` tool call is bounded by
  `orchestrator.tool_timeout_minutes` (default 45; `MULTIPI_TOOL_TIMEOUT_MS` overrides,
  0 = disabled) and resolves with the reconciliation text on expiry. The watchdog
  (`scripts/multipi-watch.sh --daemon`, auto-started by TUI sessions, single-instance
  pidfile, `MULTIPI_WATCH_TOOL_MS`/`MULTIPI_WATCH_NOW_MS` seams) wakes a tool in flight > 12 min
  or a heartbeat silent > 10 min — deduped to one wake per tool-seq and per 3600 s.
  A session that vanished mid-tool was very likely OOM-killed: the rc 3 line says so and
  points at `journalctl --since <start> | grep oom-kill` (the confirmed root cause of the
  "No result provided" deaths).
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
- `MULTIPI_APPROVE_NOW_MS` — ask-machinery (spec 2026-11-09 §6), NOT a child seam:
  the issuing-clock override (integer ms epoch) of the operator's
  `scripts/multipi-approve`; tests drive TTL/expiry without sleeping. The
  consumption-side clock is `attemptConsume`'s `now` parameter, not an env var.
- `MULTIPI_GATE_SCRUB_POLICY_SHIMS` — batch gate (ticket #70), NOT a child seam:
  `gate-train.sh` rebuilds PATH dropping every entry whose `git` or `gh` is an
  interpreted script (2-byte `#!` magic), so the gate's own git work and every
  check run unjudged by the dogfood policy shims (authority separation: the shims
  protect the loop's sessions, never its own verification). Default `1` (scrub);
  `0` restores the armed PATH for tests that exercise the armed posture.
- `MULTIPI_SHIM_REAL_GH` / `MULTIPI_SHIM_REAL_GIT` — policy-shim real-binary
  resolution (permission-policy spec §4-L2; ticket #72), NOT a child seam:
  the shims' `shim_find_real` consults the per-binary seam FIRST, then falls back
  to the compiled-on-PATH scan (the #68 rule, unchanged). A seam target is not
  required to be a compiled artifact — that is how an offline script stand-in
  serves a test environment, and its calls.log proves the real binary was never
  reached. Only processes the loop spawns should carry these; an operator shell
  must not. A SET-but-unusable target (missing/unreadable/not executable) fails
  closed with exit 127 and NEVER falls back to the PATH scan; an EMPTY value is
  unset. Like every env seam, the value is mutable by a descendant process's own
  environment: a grandchild an agent spawns could point the seam at a script of
  its own and steer its own process tree's resolution there — the named
  best-effort limit, and the decision layer (and the refusal audit lines) still
  run over whatever the shim resolved.

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
