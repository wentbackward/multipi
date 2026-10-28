# multipi Foundation (config + scripts + smoke harness) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and offline-test the deterministic core of multipi: the `.devloop.json` config layer, the heavy-job queue, the batch gate, the ordered merge train, and the doctor — all exercised by an offline smoke suite against a local bare origin with a fake `gh`.

**Architecture:** Near-verbatim port of `wentbackward/claude-dev-loop`'s bash scripts, renamed to the multipi namespace (env `MULTIPI_*`, state dir `~/.multipi/<repo>`, config `.devloop.json`), with identity-mode code removed (there is no `as-role.sh` in v1; every `gh`/`git` call runs under the user's own credentials). A single linear smoke test (`tests/smoke.sh`) drives real git against a throwaway repo + bare origin + `tests/fake-gh`, mirroring the reference's proven test design.

**Tech Stack:** bash (POSIX-ish, `set -u`), git ≥2.31, jq (with python3 fallback in config reading), flock, one local bare origin. No Node, no network.

**Spec:** `docs/superpowers/specs/2026-10-27-devloop-pi-design.md` (§2.3, §5, §10). Two refinements, noted for the record: (1) gate-train exit codes follow the reference exactly — `0` green, `1` red (incl. `gate_setup` failure), `2` usage/config, `3` rebase conflict (branch named in output); (2) merge-train codes — `0` all merged, `2` usage/config, `3` replay conflict, `4` tree differs (re-gate), `5` notes file missing, `6` branch changed since the gate, `7` PR not merged / gh failed, `8` not gated green.

---

## Renaming table (applies to ALL code in this plan)

| reference (claude-dev-loop) | multipi |
|---|---|
| `DEV_LOOP_CONFIG` / `DEV_LOOP_HOME` / `DEV_LOOP_LOCK_DIR` / `DEV_LOOP_HEAVY_SLOTS` / `DEV_LOOP_NO_JQ` / `DEV_LOOP_GH_SETTLE_SECONDS` / `DEV_LOOP_SLOT` | `MULTIPI_CONFIG` / `MULTIPI_HOME` / `MULTIPI_LOCK_DIR` / `MULTIPI_HEAVY_SLOTS` / `MULTIPI_NO_JQ` / `MULTIPI_GH_SETTLE_SECONDS` / `MULTIPI_SLOT` |
| `.dev-loop.json` | `.devloop.json` |
| `~/.dev-loop/<repo>` | `~/.multipi/<repo>` |
| `dev-loop-heavy-slots` | `multipi-heavy-slots` |
| `dev-loop: ...` messages | `multipi: ...` messages |
| `CLAUDE.md` | `AGENTS.md` |
| identity mode (`as-role.sh`, `lib/identity.sh`, statuses, approvals, exit 9) | **removed entirely** |

## File structure (locked in)

```
Makefile                     # check: shellcheck (warn+skip if absent) + tests/smoke.sh
.gitignore
README.md
templates/devloop.json       # skeleton config the setup skill fills in (Part 3)
templates/AGENTS.md          # project-instructions skeleton (Part 3)
templates/DECISIONS.md       # decisions-log skeleton (Part 3)
scripts/lib/common.sh        # config reading + path resolution (shared by every script)
scripts/paths.sh             # print resolved paths for prompts/notes
scripts/heavy.sh             # machine-wide heavy-job slot queue + memory cap + per-slot ports
scripts/gate-train.sh        # stack a train of branches, run all checks ONCE, record green train
scripts/open-pr.sh           # open a branch's PR from its notes file (idempotent)
scripts/merge-train.sh       # replay+verify+PR+squash-merge a green train in order
scripts/doctor.sh            # prerequisites + resolved-config report
tests/fake-gh                # offline gh stand-in (file-backed PR state, real squash merges)
tests/smoke.sh               # the offline suite
```

Responsibilities: `common.sh` is the only place that parses `.devloop.json`; scripts never touch JSON directly. `gate-train.sh` is the only writer of the green-train record (`$MULTIPI_HOME/<repo>/train-green.txt`); `merge-train.sh` is its only consumer. Nothing here knows about LLMs or pi.

Conventions: every script starts with `set -u` and sources `lib/common.sh` via its own location. Tests run `bash tests/smoke.sh`; a line `PASS <desc>` per assertion, exit 0 iff all pass.

---

### Task 1: Repository skeleton

**Files:**
- Create: `Makefile`, `.gitignore`, `README.md`, `templates/devloop.json`, `templates/AGENTS.md`, `templates/DECISIONS.md`

- [x] **Step 1: Create the files**

`Makefile`:

```make
SHELL := /bin/bash

SCRIPTS := $(wildcard scripts/*.sh scripts/lib/*.sh)

check: shellcheck smoke

shellcheck:
	@if command -v shellcheck >/dev/null 2>&1; then \
		shellcheck $(SCRIPTS) tests/fake-gh; \
	else \
		echo "WARNING: shellcheck not installed — skipping. Install it; the loop must not silently skip."; \
	fi

smoke:
	bash tests/smoke.sh

.PHONY: check shellcheck smoke
```

`.gitignore`:

```
node_modules/
*.log
.DS_Store
```

`README.md`:

```markdown
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
```

`templates/devloop.json`:

```json
{
  "base_branch": "main",
  "remote": "origin",
  "fast_check": "",
  "checks": [],
  "heavy": { "slots": 2 },
  "stop_gate": { "require_clean_tree": true, "max_blocks": 5 },
  "merge": { "method": "squash", "delete_branch": true }
}
```

`templates/AGENTS.md`:

```markdown
# AGENTS.md — {{PROJECT_NAME}}

{{ONE_PARAGRAPH_WHAT_THIS_PROJECT_IS}} The spec is `{{SPEC_PATH}}` and is the source of truth.

## Operating mode: autonomous (dev loop)

- Work end to end without asking for approval: plan, ticket, build, test, commit, review,
  gate, merge, run, verify. The workflow is the `devloop` skill of the multipi extension.
- Stop and ask only for the stop conditions below.
- When the spec is silent, choose the simplest option that fits it, record it in
  `docs/DECISIONS.md` (date, decision, reason, alternatives), and continue.
- Never wait idle on a long job: run it in the background, verify the first output, continue.

### Stop conditions (the only reasons to stop and ask)

1. A required credential or key is missing or rejected ({{CREDENTIALS_EXAMPLE}}).
2. A paid action would exceed the cost cap: {{COST_CAP_OR_NONE}}.
3. The spec contradicts itself and both readings change stored data or relied-upon behaviour.
4. Anything unsafe or irreversible: production data, real money or orders, deleting history,
   security settings, {{PROJECT_SPECIFIC_DANGERS}}.

## Workflow loop (repeat until the spec's Definition of Done is met)

1. One GitHub issue per work item: acceptance criteria, `Depends on #n`, labels.
2. One branch per ticket (`feat/<n>-<slug>` etc.), each in its own worktree.
3. Test first: failing tests from the acceptance criteria, then the code.
4. Targeted tests + fast check (`fast_check` in `.devloop.json`) only while implementing.
   The full checks run once per batch in the gate.
5. Small Conventional Commits, each referencing the ticket (`Refs #12`).
6. The independent code-reviewer on every branch; fix every must-fix; re-review until APPROVE.
7. Approved branches are gated as one train (`gate-train.sh` via `devloop.gate`); a green
   train merges in order (`merge-train.sh` via `devloop.merge`), one squash per ticket.
   A red train is never merged.
8. After a job ticket merges, run the job for real and verify its outputs.

### Parallel work

- At most 3 implementer agents, one ticket each, each in its own worktree.
- Heavy commands (full suite, e2e, long builds) only through `scripts/heavy.sh`.

## Secrets and safety

- Never read `.env` or credential files. Never write secrets or personal identifiers into
  code, tests, docs, commits, issues or PRs. Use role words and placeholders.
- Merges only through the merge train after a green gate.
```

`templates/DECISIONS.md`:

```markdown
# Decisions

Decisions the dev loop made where the spec was silent. Newest last.
One line each: `YYYY-MM-DD — decision — why — alternatives considered`.
```

- [x] **Step 2: Verify**

Run: `cd /home/code/hacking/multipi && ls Makefile .gitignore README.md templates/`
Expected: all five paths listed. `make check` will fail here (no `tests/smoke.sh` yet) — expected, not a stop.

- [x] **Step 3: Commit**

```bash
git add Makefile .gitignore README.md templates/
git commit -m "chore: repository skeleton (Makefile, templates, README)"
```

---

### Task 2: Config layer (`scripts/lib/common.sh`) + smoke harness

**Files:**
- Create: `scripts/lib/common.sh`, `tests/smoke.sh`

- [x] **Step 1: Write the failing tests (smoke harness + config tests)**

`tests/smoke.sh`:

```bash
#!/usr/bin/env bash
# Smoke test of the multipi scripts on a throwaway project with a local bare origin.
# No network, no real GitHub: `gh` is tests/fake-gh. Run: bash tests/smoke.sh
set -u
plugin=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/multipi-smoke.XXXXXX")
export MULTIPI_HOME="$work/home" MULTIPI_LOCK_DIR="$work/locks" MULTIPI_GH_SETTLE_SECONDS=0
export FAKE_GH_DIR="$work/gh" GIT_CONFIG_GLOBAL="$work/gitconfig"
git config --global user.name tester
git config --global user.email tester@example.invalid
git config --global init.defaultBranch main
mkdir -p "$work/bin" && ln -s "$plugin/tests/fake-gh" "$work/bin/gh"
export PATH="$work/bin:$PATH"

passed=0
failed=0
pass() { echo "PASS $*"; passed=$((passed + 1)); }
fail() { echo "FAIL $*"; failed=$((failed + 1)); }
expect() { # expect DESCRIPTION EXPECTED ACTUAL
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi
}

# The project: one source file, a check that fails when the source contains BROKEN.
git init -q --bare "$work/origin.git"
git clone -q "$work/origin.git" "$work/project" 2>/dev/null
cd "$work/project" || exit 1
cat >check.sh <<'EOF'
#!/usr/bin/env bash
echo "port=${SMOKE_PORT:-unset} slot=${MULTIPI_SLOT:-unset}"
! grep -q BROKEN src.txt && echo "3 passed"
EOF
chmod +x check.sh
echo "line one" >src.txt
git add . && git commit -q -m "chore: start" && git push -q origin main

# --- config layer -------------------------------------------------------------
cat >.devloop.json <<'EOF'
{
  "base_branch": "main",
  "fast_check": "test ! -e fast-fail",
  "format": "echo formatted {file} >> fmt.log",
  "format_extensions": [".txt"],
  "checks": [
    {"name": "unit", "command": "./check.sh", "summary": "passed|failed"},
    {"name": "lint", "command": "test -x check.sh", "heavy": false}
  ],
  "heavy": {"slots": 2, "port_env": "SMOKE_PORT", "port_base": 9100, "port_step": 10, "poll_seconds": 1}
}
EOF
echo "project instructions" >AGENTS.md
printf 'fmt.log\nfast-fail\n' >.gitignore
git add . && git commit -q -m "chore: dev-loop config" && git push -q origin main

cfg_out() { # evaluate common.sh in the fixture repo; args = shell expression
  bash -c ". \"$plugin/scripts/lib/common.sh\" && dl_load_config required && $1"
}
expect "cfg reads a plain value" "main" "$(cfg_out 'printf %s "$DL_BASE"')"
expect "cfg falls back to the default" "fallback" "$(cfg_out 'cfg no.such.key fallback')"
expect "cfg_len counts the checks array" "2" "$(cfg_out 'cfg_len checks')"
expect "json_get walks into an array object" "unit" "$(cfg_out 'json_get checks.0.name <"$DL_CONFIG"')"
expect "dl_note_file maps slashes to underscores" \
  "$work/home/project/notes/pr-feat_1-first.md" "$(cfg_out 'dl_note_file feat/1-first')"
expect "dl_gate_dir resolves the default relative to the main root" \
  "$work/project-gate" "$(cfg_out 'dl_gate_dir')"
expect "dl_state is under MULTIPI_HOME/<repo>" \
  "$work/home/project" "$(cfg_out 'printf %s "$DL_STATE"')"
cfg_out 'dl_die boom' >/dev/null 2>&1
expect "dl_die exits 2 with a message" "2" "$?"

echo "smoke: $passed passed, $failed failed (work dir $work)"
[ "$failed" -eq 0 ]
```

- [x] **Step 2: Run and verify it fails**

Run: `bash tests/smoke.sh`
Expected: FAIL lines for the config assertions; the first failure looks like `FAIL cfg reads a plain value (expected 'main', got '')` (sourcing a missing file errors). The suite still exits non-zero.

- [x] **Step 3: Write `scripts/lib/common.sh`**

Near-verbatim port of the reference with the renaming table applied:

```bash
# shellcheck shell=bash
# Shared helpers for the multipi (dev-loop) scripts: repository paths and the project config
# (.devloop.json). JSON is read with jq when it is installed, else with python3
# (MULTIPI_NO_JQ=1 forces python3).

dl_die() {
  echo "multipi: $*" >&2
  exit 2
}

dl_have_jq() {
  [ -z "${MULTIPI_NO_JQ:-}" ] && command -v jq >/dev/null 2>&1
}

dl_warn() {
  echo "multipi: $*" >&2
}

# json_get PATH < json  -> the value at a dotted path ("heavy.slots", "checks.0.name").
# Strings print raw, other values as JSON, missing or null values print nothing.
json_get() {
  local path=$1
  if dl_have_jq; then
    jq -r --arg p "$path" '
      ($p | if . == "" then [] else split(".") | map(tonumber? // .) end) as $k
      | (try getpath($k) catch null)
      | if . == null then empty elif type == "string" then . else tojson end' 2>/dev/null
  else
    python3 -I -c '
import json, sys
path = [p for p in sys.argv[1].split(".") if p]
try:
    value = json.load(sys.stdin)
    for key in path:
        if isinstance(value, list):
            value = value[int(key)]
        elif isinstance(value, dict):
            value = value[key]
        else:
            raise KeyError(key)
except (KeyError, IndexError, ValueError, TypeError):
    sys.exit(0)
if value is None:
    sys.exit(0)
print(value if isinstance(value, str) else json.dumps(value))
' "$path" 2>/dev/null
  fi
}

# json_len PATH < json  -> the length of the array at PATH (0 when missing or not an array).
json_len() {
  local value
  value=$(json_get "$1")
  if [ -z "$value" ]; then
    echo 0
  elif dl_have_jq; then
    printf '%s' "$value" | jq -r 'if type == "array" then length else 0 end' 2>/dev/null || echo 0
  else
    printf '%s' "$value" | python3 -I -c '
import json, sys
value = json.load(sys.stdin)
print(len(value) if isinstance(value, list) else 0)' 2>/dev/null || echo 0
  fi
}

# dl_main_root: the root of the main worktree (where .devloop.json lives), from any worktree.
dl_main_root() {
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  if [ "$(basename "$common")" = ".git" ]; then
    dirname "$common"
  else
    git rev-parse --show-toplevel 2>/dev/null
  fi
}

# dl_load_config [required]: sets DL_ROOT, DL_CONFIG, DL_REPO, DL_STATE and the common settings.
# With "required", a missing repository or config file is an error; otherwise defaults apply.
dl_load_config() {
  local required=${1:-}
  DL_ROOT=$(dl_main_root) || DL_ROOT=""
  if [ -z "$DL_ROOT" ] && [ "$required" = required ]; then
    dl_die "not inside a git repository"
  fi
  DL_CONFIG=${MULTIPI_CONFIG:-${DL_ROOT:+$DL_ROOT/.devloop.json}}
  if [ "$required" = required ] && [ ! -f "$DL_CONFIG" ]; then
    dl_die "no config at ${DL_CONFIG:-.devloop.json}; run the devloop setup skill or copy templates/devloop.json"
  fi
  DL_REPO=$(basename "${DL_ROOT:-$PWD}")
  DL_STATE=${MULTIPI_HOME:-$HOME/.multipi}/$DL_REPO
  DL_REMOTE=$(cfg remote origin)
  DL_BASE=$(cfg base_branch main)
}

# cfg PATH [DEFAULT]: a value from the project config, or DEFAULT.
cfg() {
  local value=""
  if [ -n "${DL_CONFIG:-}" ] && [ -f "$DL_CONFIG" ]; then
    value=$(json_get "$1" <"$DL_CONFIG")
  fi
  if [ -n "$value" ]; then printf '%s\n' "$value"; else printf '%s\n' "${2:-}"; fi
}

# cfg_len PATH: the length of an array in the project config.
cfg_len() {
  if [ -n "${DL_CONFIG:-}" ] && [ -f "$DL_CONFIG" ]; then json_len "$1" <"$DL_CONFIG"; else echo 0; fi
}

# dl_resolve PATH: an absolute path; relative paths resolve against the main worktree root.
dl_resolve() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    "~"/*) printf '%s\n' "$HOME/${1#"~/"}" ;;
    *) printf '%s\n' "${DL_ROOT:-$PWD}/$1" ;;
  esac
}

dl_notes_dir() {
  local configured
  configured=$(cfg notes_dir "")
  if [ -n "$configured" ]; then dl_resolve "$configured"; else printf '%s\n' "$DL_STATE/notes"; fi
}

dl_logs_dir() {
  local configured
  configured=$(cfg logs_dir "")
  if [ -n "$configured" ]; then dl_resolve "$configured"; else printf '%s\n' "$DL_STATE/logs"; fi
}

dl_gate_dir() {
  dl_resolve "$(cfg gate_worktree "../$DL_REPO-gate")"
}

# dl_note_file BRANCH: the PR notes file of a branch (slashes become underscores).
dl_note_file() {
  printf '%s/pr-%s.md\n' "$(dl_notes_dir)" "${1//\//_}"
}

# dl_train_file: where gate-train.sh records the last green train (branch, source head, gated head).
dl_train_file() {
  printf '%s/train-green.txt\n' "$DL_STATE"
}

# dl_ensure_gate_worktree: create the gate worktree (detached at the base) if it does not exist yet.
dl_ensure_gate_worktree() {
  local gate
  gate=$(dl_gate_dir)
  if [ -d "$gate" ]; then
    git -C "$gate" rev-parse --git-dir >/dev/null 2>&1 || dl_die "$gate exists but is not a git worktree"
    [ "$(cd "$gate" && dl_main_root)" = "$DL_ROOT" ] || dl_die "$gate is a worktree of another repository"
  else
    git -C "$DL_ROOT" fetch -q "$DL_REMOTE" || dl_die "git fetch $DL_REMOTE failed"
    git -C "$DL_ROOT" worktree add -q --detach "$gate" "$DL_REMOTE/$DL_BASE" >/dev/null ||
      dl_die "could not create the gate worktree at $gate"
  fi
  printf '%s\n' "$gate"
}
```

- [x] **Step 4: Run and verify it passes**

Run: `bash tests/smoke.sh`
Expected: all 8 `PASS` lines, final `smoke: 8 passed, 0 failed`, exit 0. (The `AGENTS.md` fixture file is committed with the config; later tasks' doctor test relies on it.)

Execution note (2026-10-27): the notes-path expectation above was corrected during execution — the state dir is `~/.multipi/<repo>/notes` (repo-scoped), and `dl_notes_dir`/`dl_logs_dir`/`dl_gate_dir` canonicalize configured/default paths via `realpath -m` (a deliberate improvement over the reference, whose `../repo-gate` path was uncanonicalized).

- [x] **Step 5: Commit**

```bash
git add scripts/lib/common.sh tests/smoke.sh
git commit -m "feat: config layer (common.sh) and smoke harness"
```

---

### Task 3: `scripts/paths.sh`

**Files:**
- Create: `scripts/paths.sh`
- Modify: `tests/smoke.sh` (append a section before the final summary — see Step 1)

- [x] **Step 1: Add the failing tests**

Append to `tests/smoke.sh`, immediately before the `echo "smoke: $passed passed..."` line:

```bash
# --- paths.sh -----------------------------------------------------------------
paths_run() { (cd "$work/project" && bash "$plugin/scripts/$@"); }
paths_run_rc() { (cd "$work/project" && bash "$plugin/scripts/$@" >/dev/null 2>&1); echo $?; }
expect "paths.sh root prints the main root" "$work/project" \
  "$(paths_run paths.sh root)"
expect "paths.sh config prints the config path" "$work/project/.devloop.json" \
  "$(paths_run paths.sh config)"
expect "paths.sh notes creates the notes dir and prints the file path" \
  "$work/home/project/notes/pr-feat_9-x.md" "$(paths_run paths.sh notes feat/9-x)"
[ -d "$work/home/project/notes" ] && pass "paths.sh notes created the notes directory" ||
  fail "paths.sh notes did not create the notes directory"
expect "paths.sh rejects a bad subcommand" "2" "$(paths_run_rc paths.sh bogus)"
```

- [x] **Step 2: Run and verify it fails**

Run: `bash tests/smoke.sh`
Expected: the 5 new assertions FAIL with `bash: .../scripts/paths.sh: No such file or directory` captured in the empty/`2` actuals; previous 9 still PASS.

- [x] **Step 3: Write `scripts/paths.sh`**

```bash
#!/usr/bin/env bash
# Print the multipi (dev-loop) paths of the current repository, so prompts and notes use
# absolute paths.
#
# Usage: paths.sh notes <branch> | notes-dir | logs | gate | state | config | root
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"

dl_load_config
[ -n "$DL_ROOT" ] || dl_die "not inside a git repository"
case "${1:-}" in
  notes)
    [ -n "${2:-}" ] || dl_die "usage: paths.sh notes <branch>"
    mkdir -p "$(dl_notes_dir)"
    dl_note_file "$2"
    ;;
  notes-dir) dl_notes_dir ;;
  logs) dl_logs_dir ;;
  gate) dl_gate_dir ;;
  state) printf '%s\n' "$DL_STATE" ;;
  config) printf '%s\n' "$DL_CONFIG" ;;
  root) printf '%s\n' "$DL_ROOT" ;;
  *) dl_die "usage: paths.sh notes <branch> | notes-dir | logs | gate | state | config | root" ;;
esac
```

- [x] **Step 4: Run and verify it passes**

Run: `bash tests/smoke.sh`
Expected: `smoke: 13 passed, 0 failed`, exit 0.

Execution note (2026-10-27): the plan's original `paths_run` helpers double-shelled the whole command as one filename; the failing run exposed it and the helpers were corrected to direct `bash "$plugin/scripts/$@"` invocation.

- [x] **Step 5: Commit**

```bash
git add scripts/paths.sh tests/smoke.sh
git commit -m "feat: paths.sh — resolved path printing for prompts and notes"
```

---

### Task 4: `scripts/heavy.sh` (machine-wide slot queue)

**Files:**
- Create: `scripts/heavy.sh`
- Modify: `tests/smoke.sh` (append a section before the final summary)

- [x] **Step 1: Add the failing tests**

Append before the final summary line:

```bash
# --- heavy.sh -----------------------------------------------------------------
expect "heavy.sh exports the slot port (base + slot*step)" "9110" \
  "$(bash "$plugin/scripts/heavy.sh" bash -c 'echo $SMOKE_PORT' 2>/dev/null)"
expect "heavy.sh passes through a zero exit" "0" \
  "$(bash "$plugin/scripts/heavy.sh" true >/dev/null 2>&1; echo $?)"
expect "heavy.sh passes through a non-zero exit" "1" \
  "$(bash "$plugin/scripts/heavy.sh" false >/dev/null 2>&1; echo $?)"

# Three 3-second jobs on two slots: the third must wait for a slot to free.
start=$(date +%s)
for n in 1 2 3; do
  bash "$plugin/scripts/heavy.sh" bash -c "echo start $n \$(date +%s) slot \$MULTIPI_SLOT; sleep 3; echo end $n \$(date +%s)" \
    >"$work/heavy-$n.out" 2>"$work/heavy-$n.err" &
  sleep 0.3
done
wait
cat "$work"/heavy-*.out
grep -q "all 2 slots busy" "$work/heavy-3.err" && pass "third heavy job reports that it waits" ||
  fail "third heavy job did not wait"
third_start=$(awk '/^start 3/ {print $3}' "$work/heavy-3.out")
first_end=$(awk '/^end 1/ {print $3}' "$work/heavy-1.out")
[ -n "$third_start" ] && [ "$third_start" -ge "$first_end" ] &&
  pass "third heavy job starts only after a slot frees" ||
  fail "third heavy job started at ${third_start:-?} before the first ended at ${first_end:-?}"
echo "heavy: 3x3s jobs on 2 slots took $(($(date +%s) - start))s"
```

- [x] **Step 2: Run and verify it fails**

Run: `bash tests/smoke.sh`
Expected: the 5 new heavy assertions FAIL (missing script); 14 previous PASS.

- [x] **Step 3: Write `scripts/heavy.sh`**

Port of the reference with the renaming table applied (`multipi-heavy-slots` lock dir, `MULTIPI_*` env, `MULTIPI_SLOT`):

```bash
#!/usr/bin/env bash
# Run a heavy command (full test suite, e2e, big build) in one of N machine-wide slots, under a memory cap.
#
# Usage: heavy.sh <command> [args...]      (blocks until a slot is free, exits with the command's status)
#
# The slots are shared by every repository, worktree and session of this user on this machine: the lock
# directory lives under the user's runtime (or temp) directory, not in a repository. Each slot exports its
# own port (heavy.port_env = heavy.port_base + slot * heavy.port_step) so two e2e servers never collide.
#
# Config (.devloop.json, all optional): heavy.slots (2), heavy.memory_max ("" = no cap, e.g. "8G"),
# heavy.port_env, heavy.port_base (8600), heavy.port_step (10), heavy.clean_temp (globs of stale temp
# entries to delete), heavy.clean_temp_minutes (120), heavy.poll_seconds (10).
# Environment: MULTIPI_LOCK_DIR overrides the lock directory, MULTIPI_HEAVY_SLOTS the slot count.
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"

[ $# -gt 0 ] || dl_die "usage: heavy.sh <command> [args...]"
dl_load_config

slots=${MULTIPI_HEAVY_SLOTS:-$(cfg heavy.slots 2)}
memory_max=$(cfg heavy.memory_max "")
port_env=$(cfg heavy.port_env "")
port_base=$(cfg heavy.port_base 8600)
port_step=$(cfg heavy.port_step 10)
poll_seconds=$(cfg heavy.poll_seconds 10)
clean_minutes=$(cfg heavy.clean_temp_minutes 120)
lock_dir=${MULTIPI_LOCK_DIR:-${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/multipi-heavy-slots}
[[ "$slots" =~ ^[1-9][0-9]*$ ]] || dl_die "heavy.slots must be a positive integer (got '$slots')"
mkdir -p "$lock_dir" || dl_die "cannot create $lock_dir"

# clean_stale_temp: delete temp entries this tool knows about once they are older than clean_minutes:
# the project's heavy.clean_temp globs, old pytest base directories (the 5 newest are kept), dead locks.
clean_stale_temp() {
  local count i pattern entry
  count=$(cfg_len heavy.clean_temp)
  for ((i = 0; i < count; i++)); do
    pattern=$(cfg "heavy.clean_temp.$i" "")
    [ -n "$pattern" ] || continue
    pattern=${pattern//\$USER/${USER:-$(id -un)}}
    # shellcheck disable=SC2086  # intentional glob expansion of the configured pattern
    for entry in $pattern; do
      [ -e "$entry" ] || continue
      if [ -n "$(find "$entry" -maxdepth 0 -mmin +"$clean_minutes" 2>/dev/null)" ]; then
        chmod -R u+w "$entry" 2>/dev/null
        rm -rf -- "$entry"
      fi
    done
  done
  local pytest_root=${TMPDIR:-/tmp}/pytest-of-${USER:-$(id -un)}
  if [ -d "$pytest_root" ]; then
    # shellcheck disable=SC2012  # names are pytest-<n>, no spaces
    ls -dt "$pytest_root"/pytest-[0-9]* 2>/dev/null | tail -n +6 | while read -r entry; do
      chmod -R u+w "$entry" 2>/dev/null
      rm -rf -- "$entry"
    done
  fi
  for entry in "$lock_dir"/slot*.d; do
    [ -d "$entry" ] || continue
    if ! kill -0 "$(cat "$entry/pid" 2>/dev/null || echo 0)" 2>/dev/null; then rm -rf -- "$entry"; fi
  done
}

# have_memory_cap: true when systemd can run a transient user scope with a memory limit.
have_memory_cap() {
  command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

# run_in_slot SLOT: run the command with the slot's port, under the memory cap when one is configured.
run_in_slot() {
  local slot=$1
  shift
  export MULTIPI_SLOT=$slot
  if [ -n "$port_env" ]; then
    export "$port_env=$((port_base + slot * port_step))"
  fi
  echo "[heavy.sh] slot $slot/$slots acquired: $*" >&2
  if [ -z "$memory_max" ]; then
    "$@"
  elif have_memory_cap; then
    systemd-run --user --scope --quiet -p MemoryMax="$memory_max" -- "$@"
  else
    dl_warn "heavy.sh: no systemd user manager; running without the $memory_max memory cap"
    "$@"
  fi
}

# try_slot_flock SLOT COMMAND...: if the slot is free, take it, run the command and set ran=yes.
# The lock is held by an open file descriptor, so the kernel frees it even if this script is killed.
try_slot_flock() {
  local slot=$1 fd rc=0
  shift
  exec {fd}>"$lock_dir/slot$slot.lock"
  if flock -n "$fd"; then
    ran=yes
    run_in_slot "$slot" "$@"
    rc=$?
    flock -u "$fd"
  fi
  exec {fd}>&-
  return "$rc"
}

# try_slot_mkdir SLOT COMMAND...: the same with a lock directory, for systems without flock (macOS).
try_slot_mkdir() {
  local slot=$1 rc=0
  shift
  if mkdir "$lock_dir/slot$slot.d" 2>/dev/null; then
    ran=yes
    echo $$ >"$lock_dir/slot$slot.d/pid"
    trap 'rm -rf -- "$lock_dir/slot$slot.d"' EXIT INT TERM
    run_in_slot "$slot" "$@"
    rc=$?
    rm -rf -- "$lock_dir/slot$slot.d"
    trap - EXIT INT TERM
  fi
  return "$rc"
}

clean_stale_temp
waiting_said=""
while true; do
  for ((slot = 1; slot <= slots; slot++)); do
    ran=""
    if command -v flock >/dev/null 2>&1; then
      try_slot_flock "$slot" "$@"
    else
      try_slot_mkdir "$slot" "$@"
    fi
    rc=$?
    [ -z "$ran" ] || exit "$rc"
  done
  if [ -z "$waiting_said" ]; then
    echo "[heavy.sh] all $slots slots busy, waiting: $*" >&2
    waiting_said=yes
  fi
  sleep "$poll_seconds"
done
```

- [x] **Step 4: Run and verify it passes**

Run: `bash tests/smoke.sh`
Expected: the heavy assertions PASS; `smoke: 18 passed, 0 failed`. The heavy section takes ~7s (3×3s on 2 slots + polls).

- [x] **Step 5: Commit**

```bash
git add scripts/heavy.sh tests/smoke.sh
git commit -m "feat: heavy.sh — machine-wide heavy-job slot queue with ports and memory cap"
```

---

### Task 5: `scripts/gate-train.sh` (the batch gate)

**Files:**
- Create: `scripts/gate-train.sh`
- Modify: `tests/smoke.sh` (append sections before the final summary)

- [x] **Step 1: Add the failing tests**

Append before the final summary line. These tests create the two branches later reused by the merge tests (Task 7) — keep the names:

```bash
# --- gate-train.sh ------------------------------------------------------------
git checkout -q -b feat/1-first
echo "line two" >>src.txt && git commit -q -am "feat: second line (Refs #1)" && git push -q -u origin feat/1-first
git checkout -q -b feat/2-second
echo "other" >other.txt && git add other.txt && git commit -q -m "feat: other file (Refs #2)" && git push -q -u origin feat/2-second
git checkout -q main
echo "README" >README && git add README && git commit -q -m "docs: readme" && git push -q origin main
notes_dir=$("$plugin/scripts/paths.sh" notes-dir)
mkdir -p "$notes_dir"
printf '# feat: second line (#1)\n\n## Summary\n- adds a line\n\nCloses #1\n' >"$("$plugin/scripts/paths.sh" notes feat/1-first)"
printf 'feat: other file (#2)\n\nCloses #2\n' >"$("$plugin/scripts/paths.sh" notes feat/2-second)"

out=$(bash "$plugin/scripts/gate-train.sh" 2>&1)
expect "gate-train with no branches is a usage error" "2" "$?"
echo "$out" | grep -q "usage: gate-train.sh" && pass "usage message printed" || fail "no usage message"

out=$(bash "$plugin/scripts/gate-train.sh" feat/1-first feat/2-second 2>&1)
rc=$?
echo "$out"
expect "gate-train is green for two good branches" "0" "$rc"
gate=$(bash "$plugin/scripts/paths.sh" gate)
expect "train-feat/2-second carries exactly the two branch commits on main" "2" \
  "$(git -C "$gate" rev-list --count origin/main..train-feat/2-second)"
echo "$out" | grep -q "^3 passed" && pass "gate prints the check summary" || fail "no check summary"
expect "the green train record was written" "2" "$(wc -l <"$work/home/project/train-green.txt" | tr -d ' ')"

# A red train: a branch whose content fails the check.
git checkout -q -B feat/3-broken origin/main
echo BROKEN >>src.txt && git commit -q -am "feat: break it (Refs #3)" && git push -q -u origin feat/3-broken
printf 'feat: break it (#3)\n\nCloses #3\n' >"$("$plugin/scripts/paths.sh" notes feat/3-broken)"
out=$(bash "$plugin/scripts/gate-train.sh" feat/3-broken 2>&1)
rc=$?
echo "$out"
expect "gate-train is red for a failing check" "1" "$rc"
echo "$out" | grep -q "TRAIN RED" && pass "red train announced" || fail "no TRAIN RED line"
[ ! -f "$work/home/project/train-green.txt" ] && pass "red train leaves no green record" ||
  fail "red train left a green record"
[ -f "$work/home/project/logs/train-unit.log" ] && pass "red train kept the check log" ||
  fail "red train lost the check log"

# A rebase conflict names the branch: two branches editing the same line.
git checkout -q -B feat/4-conflict origin/main
echo alpha >same.txt && git add same.txt && git commit -q -m "feat: alpha (Refs #4)" && git push -q -u origin feat/4-conflict
git checkout -q -B feat/5-conflict origin/main
echo beta >same.txt && git add same.txt && git commit -q -m "feat: beta (Refs #5)" && git push -q -u origin feat/5-conflict
out=$(bash "$plugin/scripts/gate-train.sh" feat/4-conflict feat/5-conflict 2>&1)
rc=$?
echo "$out"
expect "gate-train stops on a conflict and names the branch" "3 TRAIN rebase conflict at feat/5-conflict" \
  "$rc $(echo "$out" | tail -1)"
```

- [x] **Step 2: Run and verify it fails**

Run: `bash tests/smoke.sh`
Expected: the gate assertions FAIL (`bash: .../scripts/gate-train.sh: No such file or directory`, `wc` on the missing record fails); 19 previous PASS.

- [x] **Step 3: Write `scripts/gate-train.sh`**

Verbatim port (only the header comment name and the sourced library path change):

```bash
#!/usr/bin/env bash
# Gate a batch of ready branches with ONE full run of the project's checks (a merge train).
#
# Usage: gate-train.sh <branch> [<branch> ...]          (branches in merge order)
#
# In the gate worktree, stacks each <remote>/<branch> on the latest <remote>/<base> in order, keeping each
# branch's rebased head as train-<branch>. A branch already stacked on the previous one in the train replays
# only its own commits (rebase --onto), so no branch ever carries foreign commits. Then it runs every check
# of .devloop.json "checks" once on the top of the stack; heavy checks run through heavy.sh, so the
# machine-wide slot limit and memory cap apply.
#
# Exit: 0 TRAIN GREEN (recorded for merge-train.sh), 1 TRAIN RED (includes gate_setup failure),
# 2 usage/config, 3 rebase conflict (the output names the branch: drop it from the train,
# rebase it after the others merge).
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"

[ $# -gt 0 ] || dl_die "usage: gate-train.sh <branch> [<branch> ...]"
dl_load_config required
[ "$(cfg_len checks)" -gt 0 ] || dl_die "no \"checks\" in $DL_CONFIG"

gate=$(dl_ensure_gate_worktree) || exit 2
logs=$(dl_logs_dir)
mkdir -p "$logs" "$DL_STATE" || dl_die "cannot create $logs"
train_file=$(dl_train_file)
rm -f "$train_file"
cd "$gate" || exit 2

git fetch -q --prune "$DL_REMOTE" || dl_die "git fetch $DL_REMOTE failed"
git rebase --abort >/dev/null 2>&1
git checkout -q --detach "$DL_REMOTE/$DL_BASE" || dl_die "cannot check out $DL_REMOTE/$DL_BASE"

base_ref="$DL_REMOTE/$DL_BASE"
previous=""
records=""

# upstream_of BRANCH: the commit after which the branch's own commits start.
upstream_of() {
  if [ -n "$previous" ] && git merge-base --is-ancestor "$DL_REMOTE/$previous" "$DL_REMOTE/$1"; then
    git rev-parse "$DL_REMOTE/$previous"
  else
    git merge-base "$DL_REMOTE/$1" "$DL_REMOTE/$DL_BASE"
  fi
}

for branch in "$@"; do
  git rev-parse -q --verify "$DL_REMOTE/$branch^{commit}" >/dev/null ||
    dl_die "$DL_REMOTE/$branch does not exist (push the branch first)"
  source_head=$(git rev-parse "$DL_REMOTE/$branch")
  git branch -q -f "train-$branch" "$source_head"
  git checkout -q "train-$branch"
  if ! git rebase -q --onto "$base_ref" "$(upstream_of "$branch")" >/dev/null 2>&1; then
    git rebase --abort >/dev/null 2>&1
    git checkout -q --detach "$DL_REMOTE/$DL_BASE"
    echo "TRAIN rebase conflict at $branch"
    exit 3
  fi
  base_ref="train-$branch"
  previous=$branch
  records+="$branch $source_head $(git rev-parse HEAD) pending"$'\n'
  echo "stacked $branch -> $(git rev-parse --short HEAD)"
done

setup=$(cfg gate_setup "")
if [ -n "$setup" ]; then
  if ! bash -c "$setup" >"$logs/train-setup.log" 2>&1; then
    echo "gate_setup failed (log: $logs/train-setup.log)"
    echo "TRAIN RED"
    exit 1
  fi
fi

# check_field INDEX FIELD DEFAULT: a field of checks[INDEX]; a plain string entry is its own command.
check_field() {
  local entry
  entry=$(cfg "checks.$1" "")
  case "$entry" in
    "{"*) cfg "checks.$1.$2" "$3" ;;
    *) if [ "$2" = command ]; then printf '%s\n' "$entry"; else printf '%s\n' "$3"; fi ;;
  esac
}

all_green=yes
summary=""
count=$(cfg_len checks)
for ((i = 0; i < count; i++)); do
  name=$(check_field "$i" name "check-$((i + 1))")
  command=$(check_field "$i" command "")
  heavy=$(check_field "$i" heavy true)
  log="$logs/train-${name//[^A-Za-z0-9_.-]/_}.log"
  if [ "$heavy" = false ]; then
    bash -c "$command" >"$log" 2>&1
  else
    "$scripts_dir/heavy.sh" bash -c "$command" >"$log" 2>&1
  fi
  rc=$?
  echo "$name rc=$rc (log: $log)"
  [ "$rc" -eq 0 ] || all_green=""
  pattern=$(check_field "$i" summary "")
  if [ -n "$pattern" ]; then
    summary+="$(grep -E -- "$pattern" "$log" | tail -n 3)"$'\n'
  else
    summary+="$(tail -n 2 "$log")"$'\n'
  fi
done
printf '%s' "$summary" | sed '/^$/d'

git checkout -q --detach "$DL_REMOTE/$DL_BASE"
if [ -n "$all_green" ]; then
  printf '%s' "$records" >"$train_file"
  echo "TRAIN GREEN"
  exit 0
fi
echo "TRAIN RED"
exit 1
```

- [x] **Step 4: Run and verify it passes**

Run: `bash tests/smoke.sh`
Expected: all gate assertions PASS (`green for two good branches`, `summary`, `record written`, `red`, `no green record`, `log kept`, `conflict names the branch`); total `30 passed, 0 failed`.

- [x] **Step 5: Commit**

```bash
git add scripts/gate-train.sh tests/smoke.sh
git commit -m "feat: gate-train.sh — batch gate, one full check run per train"
```

---

### Task 6: `tests/fake-gh` + `scripts/open-pr.sh`

**Files:**
- Create: `tests/fake-gh`, `scripts/open-pr.sh`
- Modify: `tests/smoke.sh` (append a section before the final summary)

- [x] **Step 1: Add the failing tests**

Append before the final summary line:

```bash
git checkout -q main

# --- fake-gh + open-pr.sh -----------------------------------------------------
out=$(bash "$plugin/scripts/open-pr.sh" 2>&1)
expect "open-pr with no branch is a usage error" "2" "$?"
rm -f "$notes_dir/pr-feat_1-first.md"
out=$(bash "$plugin/scripts/open-pr.sh" feat/1-first 2>&1)
expect "open-pr without notes file (and no PR) exits 5" "5" "$?"
printf '# feat: second line (#1)\n\n## Summary\n- adds a line\n\nCloses #1\n' >"$("$plugin/scripts/paths.sh" notes feat/1-first)"
out=$(bash "$plugin/scripts/open-pr.sh" feat/1-first 2>&1)
expect "open-pr opens the PR from the notes file" "0" "$?"
expect "PR title has the leading '#' stripped" "feat: second line (#1)" \
  "$(cat "$FAKE_GH_DIR/feat_1-first.title")"
grep -q "Closes #1" "$FAKE_GH_DIR/feat_1-first.body" && pass "PR body is the rest of the notes file" ||
  fail "PR body missing Closes #1"
expect "open-pr is idempotent when the PR exists" "0" "$(bash "$plugin/scripts/open-pr.sh" feat/1-first >/dev/null 2>&1; echo $?)"
```

- [x] **Step 2: Run and verify it fails**

Run: `bash tests/smoke.sh`
Expected: the new assertions FAIL — first with `bash: .../open-pr.sh: No such file`, and after Step 3's open-pr alone would still fail because `gh` (fake) is missing; 27 previous PASS.

- [x] **Step 3: Write `tests/fake-gh`**

Port of the reference fake, identity code removed (`gh auth status` added for doctor.sh):

```bash
#!/usr/bin/env bash
# A stand-in for the GitHub CLI, for the smoke tests: PRs live in $FAKE_GH_DIR as flat files, a
# squash merge is a real squash commit pushed to the local bare origin. Every call is logged.
# Supports only what the multipi scripts call: auth status, pr create, pr view, pr merge.
set -u
dir=${FAKE_GH_DIR:?FAKE_GH_DIR not set}
mkdir -p "$dir"
echo "gh $*" >>"$dir/calls.log"
key() { printf '%s' "${1//\//_}"; }
case "${1:-} ${2:-}" in
  "auth status")
    exit 0
    ;;
  "pr view")
    branch=$3
    [ -f "$dir/$(key "$branch").state" ] || exit 1
    case "${5:-}" in
      state) cat "$dir/$(key "$branch").state" ;;
    esac
    ;;
  "pr create")
    shift 2
    head="" title="" body_file=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --head) head=$2; shift 2 ;;
        --title) title=$2; shift 2 ;;
        --body-file) body_file=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    printf '%s\n' "$title" >"$dir/$(key "$head").title"
    cp "$body_file" "$dir/$(key "$head").body"
    echo OPEN >"$dir/$(key "$head").state"
    ;;
  "pr merge")
    branch=$3
    origin=$(git remote get-url origin)
    expected=""
    [[ " $* " == *" --match-head-commit "* ]] && expected=$(printf '%s\n' "$@" | grep -A1 -- --match-head-commit | tail -1)
    work=$(mktemp -d)
    git clone -q "$origin" "$work/clone"
    (
      cd "$work/clone" || exit 1
      [ -z "$(git status --porcelain)" ] || { echo "fake gh: dirty clone" >&2; exit 1; }
      [ -z "$expected" ] || [ "$(git rev-parse "origin/$branch" 2>/dev/null)" = "$expected" ] ||
        { echo "fake gh: head moved" >&2; exit 1; }
      git merge -q --squash "origin/$branch" >/dev/null
      git commit -q -m "$(cat "$dir/$(key "$branch").title")"
      git push -q origin HEAD:main
    ) || { rm -rf "$work"; exit 1; }
    rm -rf "$work"
    echo MERGED >"$dir/$(key "$branch").state"
    ;;
  *) echo "fake gh: unsupported: $*" >&2; exit 1 ;;
esac
```

- [x] **Step 4: Write `scripts/open-pr.sh`**

```bash
#!/usr/bin/env bash
# Open the PR of a pushed branch from its notes file (first line the title, a leading "#"
# stripped, the rest the body). Does nothing when the PR already exists.
#
# Usage: open-pr.sh <branch>        Exit: 0 open (or already open), 2 usage, 5 notes file missing, 7 gh failed
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"

[ $# -eq 1 ] || dl_die "usage: open-pr.sh <branch>"
branch=$1
dl_load_config required
cd "$DL_ROOT" || exit 2
if gh pr view "$branch" >/dev/null 2>&1; then
  echo "PR for $branch exists"
  exit 0
fi
note=$(dl_note_file "$branch")
[ -f "$note" ] || { echo "missing notes file $note"; exit 5; }
title=$(head -n 1 "$note" | sed -E 's/^[[:space:]]*#+[[:space:]]*//')
[ -n "$title" ] || { echo "the first line of $note (the PR title) is empty"; exit 5; }
body_file=$(mktemp)
tail -n +2 "$note" | sed -e '/./,$!d' >"$body_file"
gh pr create --head "$branch" --base "$DL_BASE" --title "$title" --body-file "$body_file" >/dev/null
rc=$?
rm -f "$body_file"
[ "$rc" -eq 0 ] || { echo "could not create the PR for $branch"; exit 7; }
echo "opened PR for $branch: $title"
```

- [x] **Step 5: Run and verify it passes**

Run: `bash tests/smoke.sh`
Expected: all 6 open-pr assertions PASS; `smoke: 36 passed, 0 failed`.

- [x] **Step 6: Commit**

```bash
git add tests/fake-gh scripts/open-pr.sh tests/smoke.sh
git commit -m "feat: open-pr.sh + fake-gh (offline PR stand-in with real squash merges)"
```

---

### Task 7: `scripts/merge-train.sh` (ordered squash merges)

**Files:**
- Create: `scripts/merge-train.sh`
- Modify: `tests/smoke.sh` (append sections before the final summary)

- [x] **Step 1: Add the failing tests**

Append before the final summary line:

```bash
# --- merge-train.sh -----------------------------------------------------------
out=$(bash "$plugin/scripts/merge-train.sh" feat/1-first feat/2-second 2>&1)
expect "merge-train refuses a train that was not gated green" "8" "$?"
# NOTE: the record from the Task 5 green gate was consumed by the red/conflict gates above,
# so re-gate the good pair before merging.
out=$(bash "$plugin/scripts/gate-train.sh" feat/1-first feat/2-second 2>&1)
rc=$?
expect "re-gate of the good pair is green" "0" "$rc"
out=$(bash "$plugin/scripts/merge-train.sh" feat/2-second 2>&1)
expect "merge-train refuses a subset of the pending train" "8" "$?"
echo "$out" | grep -q "still to merge" && pass "subset refusal names the pending train" ||
  fail "subset refusal has no pending-train message"

out=$(bash "$plugin/scripts/merge-train.sh" feat/1-first feat/2-second 2>&1)
rc=$?
echo "$out"
expect "merge-train merges the green train in order" "0" "$rc"
git fetch -q origin
expect "origin main has both squash commits, in order" "feat: other file (#2)|feat: second line (#1)" \
  "$(git log --format=%s -2 origin/main | paste -sd'|')"
git ls-remote --exit-code origin feat/1-first >/dev/null 2>&1 && fail "merged branch not deleted" ||
  pass "merged branches are deleted on origin"
git ls-remote --exit-code origin feat/2-second >/dev/null 2>&1 && fail "merged branch 2 not deleted" ||
  pass "merged branch 2 deleted on origin"
[ ! -f "$work/home/project/train-green.txt" ] && pass "the green record is consumed" ||
  fail "green record still present after merge"
[ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ] && pass "main checkout fast-forwarded" ||
  fail "main checkout not fast-forwarded"
expect "fake gh reports the PR MERGED" "MERGED" "$(cat "$FAKE_GH_DIR/feat_1-first.state")"

# Missing notes file (and no PR) for a fresh gated branch.
git checkout -q -B feat/6-no-notes origin/main
echo six >six.txt && git add six.txt && git commit -q -m "feat: six (Refs #6)" && git push -q -u origin feat/6-no-notes
bash "$plugin/scripts/gate-train.sh" feat/6-no-notes >/dev/null 2>&1
expect "fresh branch gates green" "0" "$?"
out=$(bash "$plugin/scripts/merge-train.sh" feat/6-no-notes 2>&1)
expect "merge-train exits 5 on a missing notes file" "5" "$?"

# The branch changed after the gate.
git checkout -q -B feat/7-moved origin/main
echo seven >seven.txt && git add seven.txt && git commit -q -m "feat: seven (Refs #7)" && git push -q -u origin feat/7-moved
printf 'feat: seven (#7)\n\nCloses #7\n' >"$("$plugin/scripts/paths.sh" notes feat/7-moved)"
bash "$plugin/scripts/gate-train.sh" feat/7-moved >/dev/null 2>&1
git checkout -q feat/7-moved && echo more >>seven.txt && git commit -q -am "feat: more (Refs #7)" && git push -q origin feat/7-moved
out=$(bash "$plugin/scripts/merge-train.sh" feat/7-moved 2>&1)
rc=$?
echo "$out"
expect "merge-train refuses a branch that changed since the gate" "6" "$rc"

# The base moved after the gate (no conflict) -> tree differs -> re-gate.
git checkout -q -B feat/8-ok origin/main
echo ok >ok.txt && git add ok.txt && git commit -q -m "feat: ok (Refs #8)" && git push -q -u origin feat/8-ok
printf 'feat: ok (#8)\n\nCloses #8\n' >"$("$plugin/scripts/paths.sh" notes feat/8-ok)"
bash "$plugin/scripts/gate-train.sh" feat/8-ok >/dev/null 2>&1
expect "feat/8-ok gates green" "0" "$?"
git checkout -q -B side origin/main
echo moved >moved.txt && git add moved.txt && git commit -q -m "chore: main moved" && git push -q origin side:main
out=$(bash "$plugin/scripts/merge-train.sh" feat/8-ok 2>&1)
rc=$?
echo "$out"
expect "merge-train refuses when the tree differs from the gated one" "4" "$rc"

# The base moved AND conflicts -> replay conflict.
git checkout -q -B feat/9-clash origin/main
echo clash >clash.txt && git add clash.txt && git commit -q -m "feat: clash (Refs #9)" && git push -q -u origin feat/9-clash
printf 'feat: clash (#9)\n\nCloses #9\n' >"$("$plugin/scripts/paths.sh" notes feat/9-clash)"
bash "$plugin/scripts/gate-train.sh" feat/9-clash >/dev/null 2>&1
git checkout -q -B side2 origin/main
echo other-clash >clash.txt && git add clash.txt && git commit -q -m "chore: clash on main" && git push -q origin side2:main
out=$(bash "$plugin/scripts/merge-train.sh" feat/9-clash 2>&1)
rc=$?
echo "$out"
expect "merge-train refuses a replay conflict" "3" "$rc"
```

- [x] **Step 2: Run and verify it fails**

Run: `bash tests/smoke.sh`
Expected: all new merge assertions FAIL (missing script); 33 previous PASS.

- [x] **Step 3: Write `scripts/merge-train.sh`**

Port of the reference with identity mode removed (no `as-role.sh`, no status posting, no approval gate, no exit 9):

```bash
#!/usr/bin/env bash
# Merge a green train (gate-train.sh) in order, one squash merge per branch.
#
# Usage: merge-train.sh <branch> [<branch> ...]   (the gated branches in gate order; after a stop, the
#                                                  ones not merged yet, same order)
#
# Refuses unless the last gate-train.sh run was GREEN for these branches. For each branch: replay its own
# commits onto the current <remote>/<base>, verify the tree equals the gated train-<branch> tree, push it to
# the branch (with a lease on the head that was gated), create the PR if missing (title and body from the
# notes file), squash-merge exactly that head (--match-head-commit), confirm the PR is MERGED and delete
# the remote branch.
#
# Exit: 0 all merged, 2 usage/config, 3 replay conflict, 4 tree differs from the gated one (re-gate),
# 5 notes file missing, 6 branch changed since the gate, 7 PR not merged, 8 not gated green.
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"

[ $# -gt 0 ] || dl_die "usage: merge-train.sh <branch> [<branch> ...]"
dl_load_config required
command -v gh >/dev/null 2>&1 || dl_die "gh (GitHub CLI) is not installed"
gate=$(dl_gate_dir)
[ -d "$gate" ] || dl_die "no gate worktree at $gate (run gate-train.sh first)"
train_file=$(dl_train_file)
delete_branch=$(cfg merge.delete_branch true)
merge_method=$(cfg merge.method squash)

[ -f "$train_file" ] || { echo "MERGE refused: no green train recorded (run gate-train.sh)"; exit 8; }
pending=$(awk '$4 != "merged" {printf "%s ", $1}' "$train_file")
if [ "$pending" != "$* " ]; then
  echo "MERGE refused: the green train still to merge is: ${pending% }"
  exit 8
fi

# record BRANCH FIELD VALUE: update the train file (field 2 = pushed head, field 4 = state).
record() {
  awk -v b="$1" -v f="$2" -v v="$3" '$1 == b {$f = v} {print}' "$train_file" >"$train_file.tmp" &&
    mv "$train_file.tmp" "$train_file"
}

for branch in "$@"; do
  note=$(dl_note_file "$branch")
  if [ ! -f "$note" ] && ! (cd "$DL_ROOT" && gh pr view "$branch" >/dev/null 2>&1); then
    echo "MERGE missing notes file $note (and no PR exists for $branch)"
    exit 5
  fi
done

previous=$(awk '$4 == "merged" {b = $1} END {print b}' "$train_file")
for branch in "$@"; do
  read -r _ source_head gated _ <<<"$(awk -v b="$branch" '$1 == b' "$train_file")"
  cd "$gate" || exit 2
  git fetch -q --prune "$DL_REMOTE" || dl_die "git fetch $DL_REMOTE failed"
  [ "$(git rev-parse "train-$branch" 2>/dev/null)" = "$gated" ] ||
    { echo "MERGE refused: train-$branch is not the gated head"; exit 8; }
  if [ "$(git rev-parse "$DL_REMOTE/$branch" 2>/dev/null)" != "$source_head" ]; then
    echo "MERGE $branch changed on $DL_REMOTE since the gate: re-gate it"
    exit 6
  fi
  if [ -z "$previous" ]; then
    from=$(git merge-base "train-$branch" "$DL_REMOTE/$DL_BASE")
  else
    from="train-$previous"
  fi
  git checkout -q -B "replay-$branch" "train-$branch"
  if ! git rebase -q --onto "$DL_REMOTE/$DL_BASE" "$from" "replay-$branch" >/dev/null 2>&1; then
    git rebase --abort >/dev/null 2>&1
    git checkout -q --detach "$DL_REMOTE/$DL_BASE"
    echo "MERGE replay conflict at $branch"
    exit 3
  fi
  if ! git diff --quiet "$gated" HEAD; then
    git checkout -q --detach "$DL_REMOTE/$DL_BASE"
    echo "MERGE tree differs from the gated one at $branch ($DL_BASE moved): re-gate"
    exit 4
  fi
  head=$(git rev-parse HEAD)
  if [ "$head" != "$source_head" ]; then
    if ! git push -q --force-with-lease="$branch:$source_head" "$DL_REMOTE" "replay-$branch:$branch"; then
      git checkout -q --detach "$DL_REMOTE/$DL_BASE"
      echo "MERGE push rejected for $branch (changed since the gate?)"
      exit 6
    fi
    record "$branch" 2 "$head"
  fi
  git checkout -q --detach "$DL_REMOTE/$DL_BASE"
  git branch -q -D "replay-$branch"

  cd "$DL_ROOT" || exit 2
  "$scripts_dir/open-pr.sh" "$branch" >/dev/null || { echo "MERGE could not open the PR for $branch"; exit 7; }
  sleep "${MULTIPI_GH_SETTLE_SECONDS:-3}"
  gh pr merge "$branch" "--$merge_method" --match-head-commit "$head" >/dev/null 2>&1
  state=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    state=$(gh pr view "$branch" --json state --jq .state 2>/dev/null)
    [ "$state" = MERGED ] && break
    sleep "${MULTIPI_GH_SETTLE_SECONDS:-3}"
  done
  if [ "$state" != MERGED ]; then
    echo "MERGE PR for $branch is ${state:-unknown}, not MERGED"
    exit 7
  fi
  record "$branch" 4 merged
  [ "$delete_branch" = false ] || git push -q "$DL_REMOTE" --delete "$branch" >/dev/null 2>&1
  git fetch -q --prune "$DL_REMOTE"
  # Fast-forward the main checkout only when it is on the base branch and clean.
  if [ "$(git rev-parse --abbrev-ref HEAD)" = "$DL_BASE" ] && [ -z "$(git status --porcelain)" ]; then
    git merge -q --ff-only "$DL_REMOTE/$DL_BASE" >/dev/null 2>&1
  fi
  echo "merged $branch -> $(git log --oneline -1 "$DL_REMOTE/$DL_BASE")"
  previous=$branch
done
rm -f "$train_file"
echo "notes kept in $(dl_notes_dir)"
```

- [x] **Step 4: Run and verify it passes**

Run: `bash tests/smoke.sh`
Expected: all merge assertions PASS (refusal 8, subset 8, in-order double squash with correct subjects, branch deletion, record consumed, main ff, PR MERGED, notes 5, changed 6, tree 4, replay conflict 3). Total `52 passed, 0 failed`. Suite runtime ~30s.

- [x] **Step 5: Commit**

```bash
git add scripts/merge-train.sh tests/smoke.sh
git commit -m "feat: merge-train.sh — ordered squash merges with tree-equality verification"
```

---

### Task 8: `scripts/doctor.sh` + full `make check`

**Files:**
- Create: `scripts/doctor.sh`
- Modify: `tests/smoke.sh` (append a section before the final summary)

- [ ] **Step 1: Add the failing tests**

Append before the final summary line:

```bash
# --- doctor.sh ----------------------------------------------------------------
out=$(bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
expect "doctor is ready in a healthy fixture" "0" "$rc"
echo "$out" | grep -q "doctor: ready" && pass "doctor prints ready" || fail "doctor did not print ready"
mv .devloop.json .devloop.json.bak
out=$(bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
[ "$rc" -ne 0 ] && pass "doctor fails without config" || fail "doctor passed without config"
echo "$out" | grep -q "MISSING .*\.devloop.json" && pass "doctor names the missing config" ||
  fail "doctor did not name the missing config"
mv .devloop.json.bak .devloop.json
```

- [ ] **Step 2: Run and verify it fails**

Run: `bash tests/smoke.sh`
Expected: the 4 doctor assertions FAIL (missing script); 54 previous PASS.

- [ ] **Step 3: Write `scripts/doctor.sh`**

Port with `AGENTS.md` replacing `CLAUDE.md`:

```bash
#!/usr/bin/env bash
# Check that this machine and repository have what the dev loop needs, and print the resolved config.
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"

problems=0
ok() { echo "ok      $*"; }
missing() {
  echo "MISSING $*"
  problems=$((problems + 1))
}
optional() { echo "note    $*"; }

if command -v git >/dev/null 2>&1; then ok "git $(git --version | cut -d' ' -f3)"; else missing "git"; fi
if command -v jq >/dev/null 2>&1; then ok "jq"; elif command -v python3 >/dev/null 2>&1; then
  optional "jq not found: JSON is read with python3"
else missing "jq or python3 (to read .devloop.json)"; fi
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then ok "gh (authenticated)"; else missing "gh is not logged in (gh auth login)"; fi
else missing "gh (GitHub CLI) for issues and PRs"; fi
if command -v flock >/dev/null 2>&1; then ok "flock"; else optional "flock not found: heavy.sh uses lock directories"; fi
if command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  ok "systemd user scopes (heavy.memory_max is enforced)"
else optional "no systemd user manager: heavy.memory_max is not enforced"; fi

dl_load_config
if [ -z "$DL_ROOT" ]; then
  missing "a git repository (run inside the project)"
elif [ ! -f "$DL_CONFIG" ]; then
  missing "$DL_CONFIG (run the devloop setup skill)"
else
  ok "config $DL_CONFIG"
  if [ -n "$(json_get "" <"$DL_CONFIG")" ]; then ok "valid JSON"; else missing "valid JSON in $DL_CONFIG"; fi
  if [ "$(cfg_len checks)" -gt 0 ]; then ok "$(cfg_len checks) gate checks"; else missing "\"checks\" in $DL_CONFIG"; fi
  if git -C "$DL_ROOT" remote get-url "$DL_REMOTE" >/dev/null 2>&1; then ok "remote $DL_REMOTE"; else missing "git remote $DL_REMOTE"; fi
  echo "        base branch   $DL_BASE"
  echo "        gate worktree $(dl_gate_dir)"
  echo "        notes         $(dl_notes_dir)"
  echo "        logs          $(dl_logs_dir)"
  echo "        heavy slots   $(cfg heavy.slots 2), memory cap $(cfg heavy.memory_max none)"
  if [ -f "$DL_ROOT/AGENTS.md" ]; then ok "AGENTS.md"; else missing "AGENTS.md (run the devloop setup skill)"; fi
  if [ -f "$DL_ROOT/docs/DECISIONS.md" ]; then ok "docs/DECISIONS.md"; else optional "no docs/DECISIONS.md"; fi
fi
[ "$problems" -eq 0 ] && echo "doctor: ready" || echo "doctor: $problems problem(s)"
[ "$problems" -eq 0 ]
```

- [ ] **Step 4: Run the FULL suite via make**

Run: `make check`
Expected: shellcheck section (PASS clean if shellcheck is installed, or the documented WARNING if not), then `smoke: 58 passed, 0 failed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/doctor.sh tests/smoke.sh
git commit -m "feat: doctor.sh — prerequisites and resolved-config report; make check green"
```

---

## Plan completion criteria

- `make check` green (58 smoke assertions, no network).
- Every script passes shellcheck when the binary is present (Makefile warns loudly when absent).
- The green-train record is the single coupling point between gate and merge, and every refusal path (5, 6, 7, 8) is asserted by a test.
- Parts 2 (pi extension) and 3 (roles, skills, dogfood) build on this core unchanged; their plans reference these exact scripts and exit codes.
