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

# Hygiene: the dogfood extension mirror must track extension/ byte-for-byte (the unit
# installsync test asserts the same invariant; this line catches drift the instant the
# smoke runs instead of at review — the mirror IS what this repo's own sessions load).
for m in extension/src/*.ts extension/index.ts; do
  if ! cmp -s "$plugin/$m" "$plugin/${m/extension/.pi\/extensions\/multipi-devloop}"; then
    fail "dogfood mirror drift: .pi/extensions/multipi-devloop/${m#extension/} != $m"
  fi
done
pass "the dogfood extension mirror tracks extension/ byte-for-byte"
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

# Worktrees: one consolidated dir per project (under state), gate inside it.
expect "worktree dir defaults under state, not beside the repo" \
  "$work/home/project/worktrees/project" "$(cfg_out 'dl_worktree_dir')"
expect "gate dir defaults inside the worktree dir" \
  "$work/home/project/worktrees/project/gate" "$(cfg_out 'dl_gate_dir')"
cp .devloop.json "$work/.smoke-devloop-backup"
printf '{"worktree_dir":"/tmp/elsewhere"}' > .devloop.json
expect "worktree dir honours an explicit worktree_dir" \
  "/tmp/elsewhere" "$(bash -c ". \"$plugin/scripts/lib/common.sh\" && dl_load_config required && dl_worktree_dir")"
printf '{"worktree_dir":"~/wt-home"}' > .devloop.json
expect "worktree dir ~/ expands against HOME" \
  "$work/home2/wt-home" "$(cd "$work/project" && HOME="$work/home2" bash -c ". \"$plugin/scripts/lib/common.sh\" && dl_load_config required && dl_worktree_dir")"
mv "$work/.smoke-devloop-backup" .devloop.json

# Scenario store (dark-factory spec §2): defaults under state, sibling of the worktrees dir.
expect "scenarios dir defaults under state, sibling of the worktrees dir" \
  "$work/home/project/scenarios" "$(cfg_out 'dl_scenarios_dir')"
cp .devloop.json "$work/.smoke-devloop-backup"
printf '{"scenarios":{"dir":"store-rel"}}' > .devloop.json
expect "scenarios dir relative resolves against the repo PARENT (worktree_dir rule)" \
  "$work/store-rel" "$(cfg_out 'dl_scenarios_dir')"
printf '{"scenarios":{"dir":"~/scen-home"}}' > .devloop.json
expect "scenarios dir ~/ expands against HOME" \
  "$work/home2/scen-home" "$(cd "$work/project" && HOME="$work/home2" bash -c ". \"$plugin/scripts/lib/common.sh\" && dl_load_config required && dl_scenarios_dir")"
mv "$work/.smoke-devloop-backup" .devloop.json
expect "json_get walks into an array object" "unit" "$(cfg_out 'json_get checks.0.name <"$DL_CONFIG"')"
expect "dl_note_file maps slashes to underscores" \
  "$work/home/project/notes/pr-feat_1-first.md" "$(cfg_out 'dl_note_file feat/1-first')"
expect "dl_gate_dir defaults inside the worktree dir" \
  "$work/home/project/worktrees/project/gate" "$(cfg_out 'dl_gate_dir')"
expect "dl_state is under MULTIPI_HOME/<repo>" \
  "$work/home/project" "$(cfg_out 'printf %s "$DL_STATE"')"
cfg_out 'dl_die boom' >/dev/null 2>&1
expect "dl_die exits 2 with a message" "2" "$?"

# --- GH_REPO pin (fork trap): a fork-shaped fixture ------------------------------
# In a FORK the origin URL points at the fork, not the parent tracker, and a bare
# `gh` call guesses from the git remote — it can resolve against the parent.
# dl_load_config must pin GH_REPO to the configured origin (github.com URLs only,
# scp/https/ssh forms, .git stripped); a caller-exported GH_REPO wins (preset rule).
# fake-gh records the effective repo of every call in calls.log, so "the pin lands"
# is proved on the repo a bare gh call would actually hit.
github_repo_save="${GH_REPO+x}"; github_repo_val="${GH_REPO:-}"
unset GH_REPO
git init -q --bare "$work/fork-origin.git"
git clone -q "$work/fork-origin.git" "$work/forkproj" 2>/dev/null
( cd "$work/forkproj" && echo fork >fork.txt && git add . && git commit -qm "chore: start" && git push -q origin main )
echo '{}' >"$work/forkproj/.devloop.json"
fork_cfg() { bash -c "cd \"$work/forkproj\" && . \"$plugin/scripts/lib/common.sh\" && dl_load_config required && $1"; }
fork_gh() { FAKE_GH_DIR="$work/gh-fork" bash -c "cd \"$work/forkproj\" && . \"$plugin/scripts/lib/common.sh\" && dl_load_config required && $1"; }
set_fork_origin() { git -C "$work/forkproj" remote set-url origin "$1"; }
fork_form() { case $1 in http://*) echo http ;; https://*) echo https ;; ssh://*) echo ssh ;; git@*) echo "scp (git@)" ;; esac; }
set_fork_origin "https://github.com/example-owner/example-fork.git"
expect "a fork-shaped https origin pins GH_REPO to the fork slug (.git stripped)" \
  "example-owner/example-fork" "$(fork_cfg 'printf %s "${GH_REPO:-}"')"
for url in "git@github.com:example-owner/example-fork.git" \
           "ssh://git@github.com/example-owner/example-fork" \
           "http://github.com/example-owner/example-fork.git" \
           "ssh://git@github.com:22/example-owner/example-fork.git"; do
  set_fork_origin "$url"
  expect "GH_REPO derives from the $(fork_form "$url") origin form ($url)" \
    "example-owner/example-fork" "$(fork_cfg 'printf %s "${GH_REPO:-}"')"
done
set_fork_origin "https://git.example/group/project.git"
expect "GH_REPO is not pinned for a non-github.com origin" "" "$(fork_cfg 'printf %s "${GH_REPO:-}"')"
# Host-anchored negatives (the rationale the DECISIONS entry names): a lookalike
# host must not pin, and a github.com-suffix domain is not github.com.
set_fork_origin "git@notgithub.com:example-owner/example-fork"
expect "GH_REPO is not pinned for a git@notgithub.com origin" "" "$(fork_cfg 'printf %s "${GH_REPO:-}"')"
set_fork_origin "https://github.com.example.com/example-owner/example-fork"
expect "GH_REPO is not pinned for a github.com.example.com origin" "" "$(fork_cfg 'printf %s "${GH_REPO:-}"')"
set_fork_origin "https://github.com/example-owner/example-fork.git"
fork_gh 'gh issue list --state open --json number' >/dev/null
[ "$(tail -1 "$work/gh-fork/calls.log")" = "gh repo=example-owner/example-fork issue list --state open --json number" ] &&
  pass "a bare gh call after dl_load_config resolves against the fork, not the parent" ||
  fail "the pin did not land on the gh call (logged: $(tail -1 "$work/gh-fork/calls.log"))"
GH_REPO=example-owner/upstream fork_gh 'gh issue list --state open --json number' >/dev/null
[ "$(tail -1 "$work/gh-fork/calls.log")" = "gh repo=example-owner/upstream issue list --state open --json number" ] &&
  pass "an explicitly exported GH_REPO beats the derived pin (on the gh call)" ||
  fail "explicit GH_REPO lost to the derived pin (logged: $(tail -1 "$work/gh-fork/calls.log"))"
expect "an explicitly exported GH_REPO survives dl_load_config" "example-owner/upstream" \
  "$(GH_REPO=example-owner/upstream fork_cfg 'printf %s "${GH_REPO:-}"')"
grep -qF "GH_REPO" "$plugin/AGENTS.md" && grep -qFi "fork trap" "$plugin/AGENTS.md" &&
  pass "AGENTS.md documents the GH_REPO fork-trap pin" ||
  fail "AGENTS.md does not document the GH_REPO fork-trap pin"
if [ -n "$github_repo_save" ]; then export GH_REPO="$github_repo_val"; fi

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

git checkout -q main

# --- gate-train.sh x scenario stage (dark-factory spec §5) ----------------------
# Store OFF: the train behaves exactly as before and the stage is never invoked.
[ ! -f "$work/home/project/logs/train-scenarios.log" ] &&
  pass "a store-off train produces no stage log (stage not invoked)" ||
  fail "a store-off train produced a stage log"

# The stage config must be COMMITTED on the gated branch: all three config readers (the
# gate's on/off call, the stage, the doctor) resolve .devloop.json from the MAIN
# worktree — the same single main-root config, whatever is checked out at the train top —
# and the fixture checks the gated branch out in the main worktree. The store (outside
# the repo) is seeded once; a canned bash judge decides, as in the stage section below.
gate_store="$work/home/project/scenarios"
rm -rf "$gate_store" && mkdir -p "$gate_store" "$work/gate-rules"
printf -- '---\nid: t10-a\ntitle: Gate stage scenario\nrequired: true\n---\n## Steps\ndo the SENTINEL-SCENE-13 thing\n' >"$gate_store/t10-a.md"
cat >"$work/grun.sh" <<'EOF'
#!/bin/sh
echo "target-gate-13"
exec sleep 30
EOF
cat >"$work/gjudge.sh" <<EOF
#!/bin/sh
touch "$work/gjudge-ran"
rule=\$(cat "$work/gate-rules/t10-a" 2>/dev/null || echo pass)
case "\$rule" in
  fail) printf '{"id":"t10-a","satisfied":0.2,"required":true,"evidence":"SENTINEL-EVID-13","missing":"the gate scenario did not fire"}\n' ;;
  *)    printf '{"id":"t10-a","satisfied":0.95,"required":true,"evidence":"SENTINEL-EVID-13 ok","missing":""}\n' ;;
esac
exit 0
EOF
chmod +x "$work/grun.sh" "$work/gjudge.sh"
gate_store_cfg() { # store-on project config, the base unit check kept
  cat >.devloop.json <<EOF
{
  "base_branch": "main",
  "fast_check": "test ! -e fast-fail",
  "checks": [{"name": "unit", "command": "./check.sh", "summary": "passed|failed"}],
  "heavy": {"slots": 2, "port_env": "SMOKE_PORT", "port_base": 9100, "port_step": 10, "poll_seconds": 1},
  "scenarios": {"run_seconds": 5, "judge_seconds": 5, "pass": 0.8, "min_satisfaction": 0.9, "sealed": 0, "run": "$work/grun.sh", "judge": "bash $work/gjudge.sh"}
}
EOF
}

# The candidate probe must check the SAME three files the stage requires (config.ts +
# scenarios.ts + scenario-run.ts). Run the gate from a SCRIPTS COPY whose fallback
# candidate ($scripts_dir/../extension/src) is absent, leaving one INCOMPLETE candidate
# (config.ts only) in the project: a probe that accepts config.ts alone reads it as
# runnable and dies inside the stage (exit 2); the symmetric probe degrades to
# pre-stage behaviour and the train still gates green.
git checkout -q -B feat/11-probe origin/main
gate_store_cfg
git add -A && git commit -q -m "feat: store on, probe pin (Refs #11)" && git push -q -u origin feat/11-probe
rm -rf "$work/scriptscopy" && cp -r "$plugin/scripts" "$work/scriptscopy"
probe_ext="$work/project/.pi/extensions/multipi-devloop/src"
mkdir -p "$probe_ext"
cp "$plugin/extension/src/config.ts" "$probe_ext/config.ts"
rm -f "$work/gjudge-ran" "$work/home/project/train-green.txt"
out=$(bash "$work/scriptscopy/gate-train.sh" feat/11-probe 2>&1)
rc=$?
echo "$out"
expect "the gate candidate probe requires all three stage modules" "0" "$rc"
[ ! -f "$work/home/project/logs/train-scenarios.log" ] &&
  pass "an incomplete candidate never runs the stage" || fail "the incomplete candidate ran the stage"
printf '%s' "$out" | grep -qi "scenario" &&
  fail "the degraded probe leaked scenario talk onto the gate output" ||
  pass "the degraded probe keeps the exact pre-stage output"
git -C "$gate" branch -q -D train-feat/11-probe
rm -rf "$work/scriptscopy" "$work/project/.pi" "$work/home/project/train-green.txt"

# Store on + failing check: scenarios skipped + TRAIN RED, exit 1, the stage never runs.
git checkout -q -B feat/12-redcheck origin/main
echo BROKEN >>src.txt
gate_store_cfg
git add -A && git commit -q -m "feat: broken content, store on (Refs #12)" && git push -q -u origin feat/12-redcheck
rm -f "$work/gjudge-ran"
out=$(bash "$plugin/scripts/gate-train.sh" feat/12-redcheck 2>&1)
rc=$?
echo "$out"
expect "store-on train with a failing check is red" "1" "$rc"
echo "$out" | grep -q "TRAIN RED" && pass "red train announced (failed check)" || fail "no TRAIN RED line"
echo "$out" | grep -q "scenarios skipped" &&
  pass "a failing check prints scenarios skipped" || fail "no scenarios skipped line"
[ ! -f "$work/gjudge-ran" ] && pass "the stage was not invoked (the judge never ran)" ||
  fail "the stage ran despite the failing check"
[ ! -f "$work/home/project/logs/train-scenarios.log" ] &&
  pass "the stage left no stage log" || fail "a stage log exists although the check failed"

# Store on + green checks + red stage: TRAIN RED, exit 1, NO train record; the gate's
# red output carries only the stage's safe lines (leak sentinels never appear).
git checkout -q -B feat/13-redstage origin/main
gate_store_cfg
git add -A && git commit -q -m "feat: store on, healthy content (Refs #13)" && git push -q -u origin feat/13-redstage
echo fail >"$work/gate-rules/t10-a"
rm -f "$work/gjudge-ran" "$work/home/project/train-green.txt"
out=$(bash "$plugin/scripts/gate-train.sh" feat/13-redstage 2>&1)
rc=$?
echo "$out"
expect "store-on train with a red scenario stage is red" "1" "$rc"
echo "$out" | grep -q "TRAIN RED" && pass "red train announced (red stage)" || fail "no TRAIN RED line"
[ -f "$work/gjudge-ran" ] && pass "the stage ran after the green checks" || fail "the stage did not run"
[ ! -f "$work/home/project/train-green.txt" ] &&
  pass "a red stage leaves no train record" || fail "a red stage wrote the train record"
echo "$out" | grep -qF "scenario t10-a unsatisfied (0.20, required): the gate scenario did not fire" &&
  pass "the unsatisfied line is relayed into the gate output" || fail "no unsatisfied line in the gate output"
echo "$out" | grep -q "^scenarios red: mean" &&
  pass "the red aggregate line is relayed" || fail "no red aggregate line"
printf '%s' "$out" | grep -q "SENTINEL-SCENE-13" &&
  fail "scenario text leaked onto the gate output" || pass "no scenario text on the gate output"
printf '%s' "$out" | grep -q "SENTINEL-EVID-13" &&
  fail "judge evidence leaked onto the gate output" || pass "no judge evidence on the gate output"
printf '%s' "$out" | grep -qF "$gate_store" &&
  fail "the store path leaked onto the gate output" || pass "no store path on the gate output"

# Store on + green checks + green stage: TRAIN GREEN, exit 0, the record IS written.
echo pass >"$work/gate-rules/t10-a"
rm -f "$work/gjudge-ran" "$work/home/project/train-green.txt"
out=$(bash "$plugin/scripts/gate-train.sh" feat/13-redstage 2>&1)
rc=$?
echo "$out"
expect "store-on train with a green scenario stage is green" "0" "$rc"
expect "the stage's green line is relayed" "scenarios green: mean 0.95 (1 judged, 0 unsatisfied)" \
  "$(printf '%s\n' "$out" | grep 'scenarios green')"
[ -f "$work/home/project/train-green.txt" ] &&
  pass "the green train record was written" || fail "no train record after a green stage"
rm -f "$work/home/project/train-green.txt" # the merge-train cases below expect no gated train
git checkout -q main # the merge-train cases expect the main checkout on main

# Leave the doctor/stage sections their pristine expectations: no store dir, no rules.
rm -rf "$gate_store" "$work/gate-rules"

# The co-train #32 probe pin (gate candidate-probe symmetry) leaves its feat/11-probe
# fixture branch behind (local + origin): sweep both copies at the end of the section
# so the fixture never accumulates, and pin the absence.
git branch -q -D feat/11-probe >/dev/null 2>&1 || true
git push -q origin --delete feat/11-probe >/dev/null 2>&1 || true
[ -z "$(git branch --list feat/11-probe)" ] &&
  pass "the probe pin's feat/11-probe fixture is swept (local)" ||
  fail "the probe pin's feat/11-probe fixture survives locally"
git ls-remote --exit-code origin feat/11-probe >/dev/null 2>&1 &&
  fail "the probe pin's feat/11-probe fixture survives on origin" ||
  pass "the probe pin's feat/11-probe fixture is swept (origin)"

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
expect "open-pr is idempotent when the PR exists" "0" \
  "$(bash "$plugin/scripts/open-pr.sh" feat/1-first >/dev/null 2>&1; echo $?)"

# --- merge-train.sh -----------------------------------------------------------
out=$(bash "$plugin/scripts/merge-train.sh" feat/1-first feat/2-second 2>&1)
expect "merge-train refuses a train that was not gated green" "8" "$?"
# The record from the Task 5 green gate was consumed by the red/conflict gates above,
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

# --- merge-train.sh: train-ref cleanup (#26) ----------------------------------
# The aborted gates above (feat/3..9) each left their train-<branch> ref behind:
# the cleanup below may only delete the refs of the train it just fully merged.
tref() { git -C "$gate" rev-parse -q --verify "refs/heads/train-$1" 2>/dev/null; }
stage_branch() { # stage_branch BRANCH FILE CONTENT: a branch on origin/main with one new file + notes
  git checkout -q -B "$1" origin/main
  echo "$3" >"$2" && git add "$2" && git commit -q -m "feat: $2 (Refs #10)" && git push -q -u origin "$1"
  printf 'feat: %s (#10)\n\nCloses #10\n' "$2" >"$("$plugin/scripts/paths.sh" notes "$1")"
}
stage_branch feat/10-a a10.txt alpha
stage_branch feat/10-b b10.txt bravo
bash "$plugin/scripts/gate-train.sh" feat/10-a feat/10-b >/dev/null 2>&1
expect "a two-branch train gates green" "0" "$?"

# Mid-train stop: the second PR is blocked (fake-gh merge hold) -> exit 7 with the
# first branch already merged; BOTH train refs must survive for the resume.
touch "$FAKE_GH_DIR/feat_10-b.merge-hold"
out=$(bash "$plugin/scripts/merge-train.sh" feat/10-a feat/10-b 2>&1)
rc=$?
echo "$out"
expect "merge-train stops at the blocked PR with exit 7" "7" "$rc"
echo "$out" | grep -q "PR for feat/10-b is OPEN" && pass "blocked PR is named with its state" ||
  fail "blocked PR state line missing"
expect "first row merged, second still pending" \
  "feat/10-a|merged;feat/10-b|pending" \
  "$(awk '{print $1"|"$4}' "$work/home/project/train-green.txt" | paste -sd';')"
expect "the pending branch's train ref survived the interruption" \
  "$(awk '$1 == "feat/10-b" {print $3}' "$work/home/project/train-green.txt")" "$(tref feat/10-b)"
[ -n "$(tref feat/10-a)" ] && pass "the lower branch's train ref is still load-bearing" ||
  fail "the lower branch's train ref was deleted although stacked branches were pending"
git fetch -q origin
expect "the first branch really reached origin/main" "feat: a10.txt (#10)" \
  "$(git log --format=%s -1 origin/main)"

# Resume WITHOUT re-gating: only the pending branch, same order.
rm -f "$FAKE_GH_DIR/feat_10-b.merge-hold"
out=$(bash "$plugin/scripts/merge-train.sh" feat/10-b 2>&1)
rc=$?
echo "$out"
expect "an interrupted train resumes without re-gating" "0" "$rc"
expect "origin main carries both squashes, in gate order" "feat: b10.txt (#10)|feat: a10.txt (#10)" \
  "$(git log --format=%s -2 origin/main | paste -sd'|')"
[ ! -f "$work/home/project/train-green.txt" ] && pass "the resume consumed the green record" ||
  fail "green record still present after the resumed merge"
expect "a fully merged train leaves no train refs" "" \
  "$(git -C "$gate" for-each-ref refs/heads/train-feat/10-a refs/heads/train-feat/10-b)"
[ -n "$(tref feat/6-no-notes)" ] && pass "foreign train refs (aborted gates) are untouched" ||
  fail "cleanup deleted train refs outside its own train"

# Same invariants for a straightforward single-branch train.
stage_branch feat/10-c c10.txt charlie
bash "$plugin/scripts/gate-train.sh" feat/10-c >/dev/null 2>&1
expect "a single-branch train gates green" "0" "$?"
bash "$plugin/scripts/merge-train.sh" feat/10-c >/dev/null 2>&1
expect "the single-branch train merges" "0" "$?"
expect "the single-branch train's ref is gone" "" "$(tref feat/10-c)"
out=$(bash "$plugin/scripts/merge-train.sh" feat/10-c 2>&1)
expect "re-running after the train is gone refuses with exit 8 (refs absent)" "8" "$?"
echo "$out" | grep -q "no green train recorded" && pass "the refusal names the missing green train" ||
  fail "refusal line missing"

# A recorded green train whose train ref vanished (manual deletion) still refuses,
# via the rev-parse fallback: exit 8, not a crash and not a proceed.
stage_branch feat/10-d d10.txt delta
bash "$plugin/scripts/gate-train.sh" feat/10-d >/dev/null 2>&1
expect "feat/10-d gates green" "0" "$?"
git -C "$gate" branch -q -D train-feat/10-d
out=$(bash "$plugin/scripts/merge-train.sh" feat/10-d 2>&1)
rc=$?
echo "$out"
expect "a vanished train ref is refused with exit 8" "8" "$rc"
echo "$out" | grep -q "not the gated head" && pass "the refusal names the vanished ref" ||
  fail "vanished-ref refusal line missing"

# A REFUSED train-ref delete (e.g. the ref is checked out elsewhere) is printed, not
# silently tolerated — the residue must be diagnosable, not a silent permanent leak.
# A git shim refuses only `branch -q -D train-*` deletions.
bdshim_dir="$work/git-bdshim"
bdshim_real=$(command -v git)
mkdir -p "$bdshim_dir"
cat >"$bdshim_dir/git" <<EOF
#!/usr/bin/env bash
args=("\$@")
bd=0
for a in "\${args[@]}"; do
  case "\$a" in
    branch) bd=1 ;;
    train-*) [ "\$bd" = 1 ] && { echo "error: simulated refusal to delete a train ref" >&2; exit 1; } ;;
  esac
done
exec "$bdshim_real" "\$@"
EOF
chmod +x "$bdshim_dir/git"
stage_branch feat/10-e e10.txt echo
bash "$plugin/scripts/gate-train.sh" feat/10-e >/dev/null 2>&1
expect "feat/10-e gates green" "0" "$?"
out=$(PATH="$bdshim_dir:$PATH" bash "$plugin/scripts/merge-train.sh" feat/10-e 2>&1)
rc=$?
echo "$out"
expect "a refused train-ref delete does not change the merge's exit" "0" "$rc"
printf '%s\n' "$out" | grep -qF "KEPT train-feat/10-e (delete refused: error: simulated refusal to delete a train ref)" &&
  pass "the refused train-ref delete is printed with its reason" ||
  fail "no KEPT line carrying the refusal reason (a silent residue?)"
[ -n "$(tref feat/10-e)" ] &&
  pass "the refused ref really survives the merge run" ||
  fail "the sim-refused ref vanished anyway"
git -C "$gate" branch -q -D train-feat/10-e
# --- merge-train.sh: fail-closed dirty probe (absorbed from the #32 review) ----
# A ticket worktree whose `git status` CANNOT RUN must be KEPT with a loud note —
# empty-on-failure is never read as clean (the merge-time analogue of
# cleanup-worktrees.sh's "status probe failed" rule). A git shim fails only `status`;
# the merge itself completes, and the worktree + branch must survive.
git checkout -q -B feat/16-mp origin/main
echo m16 >m16.txt && git add m16.txt && git commit -q -m "feat: m16 (Refs #16)" &&
  git push -q -u origin feat/16-mp
git checkout -q main
printf 'feat: m16 (#16)\n\nCloses #16\n' >"$("$plugin/scripts/paths.sh" notes feat/16-mp)"
bash "$plugin/scripts/gate-train.sh" feat/16-mp >/dev/null 2>&1
expect "the dirty-probe branch gates green" "0" "$?"
mwd="$work/home/project/worktrees/project"
git worktree add -q "$mwd/issue-16-mp" feat/16-mp
statusshim_dir="$work/git-status-shim"
statusshim_real=$(command -v git)
mkdir -p "$statusshim_dir"
cat >"$statusshim_dir/git" <<EOF
#!/usr/bin/env bash
# Fail ONLY top-level git status (plain, or with a leading -C <dir> arg); every
# other invocation passes through to the real git, arguments untouched.
# (No command-substitution metachars in this comment: it lives in an unquoted
# heredoc, so they would be executed when the shim file is generated.)
args=("\$@")
subcmd="\${args[0]:-}"
[ "\$subcmd" = "-C" ] && subcmd="\${args[2]:-}"
if [ "\$subcmd" = "status" ]; then
  echo "fatal: simulated status probe failure" >&2
  exit 1
fi
exec "$statusshim_real" "\$@"
EOF
chmod +x "$statusshim_dir/git"
out=$(PATH="$statusshim_dir:$PATH" bash "$plugin/scripts/merge-train.sh" feat/16-mp 2>&1)
rc=$?
echo "$out"
expect "the merge completes despite a failing status probe" "0" "$rc"
printf '%s\n' "$out" | grep -qF "KEPT worktree $mwd/issue-16-mp — status probe failed" &&
  pass "a failing status probe keeps the worktree with a loud note" ||
  fail "no status-probe-failed keep line (the probe read the failure as clean?)"
[ -d "$mwd/issue-16-mp" ] &&
  pass "the unclassifiable worktree survives the merge" ||
  fail "the unclassifiable worktree was destroyed at merge time"
[ -n "$(git branch --list feat/16-mp)" ] &&
  pass "the unclassifiable worktree's branch survives" ||
  fail "the unclassifiable worktree's branch was deleted"
# Tidy the fixture (smoke's own worktree; this is test-cleanup, not a deletion of
# anything the script owns). No -q: git 2.53's `worktree remove` takes no -q, and the
# next section's kept-count pins would break on the leak.
git worktree remove "$mwd/issue-16-mp"
git branch -q -D feat/16-mp
git checkout -q main


# --- doctor.sh ----------------------------------------------------------------
out=$(bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
expect "doctor is ready in a healthy fixture" "0" "$rc"
echo "$out" | grep -q "doctor: ready" && pass "doctor prints ready" || fail "doctor did not print ready"
echo "$out" | grep -q "extension runtime" &&
  fail "doctor probed the extension runtime without an installed extension" ||
  pass "doctor silently skips the extension runtime check"

# Orphaned local branch (a failed `git branch -D` after a worktree removal): a NOTE that
# names the branch, never a problem count — the run stays ready.
git branch dl-orphan-pin
out=$(bash "$plugin/scripts/doctor.sh" 2>&1); rc=$?
expect "doctor stays ready with an orphaned local branch" "0" "$rc"
echo "$out" | grep -q "note    orphaned local branch dl-orphan-pin" &&
  pass "orphaned local branch is noted" || fail "orphaned local branch not noted (want: 'note    orphaned local branch dl-orphan-pin')"
echo "$out" | grep -q "problem(s)" &&
  fail "the orphan note was counted as a problem" || pass "the orphan note is not a problem"

# An ABSENT remote must not read as "every branch not on origin": with no resolvable
# remote the orphan scan is skipped (it cannot classify), not faked.
git remote rename origin origin-moved
out=$(bash "$plugin/scripts/doctor.sh" 2>&1); rc=$?
echo "$out"
[ "$rc" -ne 0 ] && pass "an absent remote is still a named problem" ||
  fail "the absent remote went unnoticed"
printf '%s' "$out" | grep -q "orphaned local branch dl-orphan-pin" &&
  fail "an absent remote was read as 'every branch not on origin'" ||
  pass "the orphan scan is skipped when the remote is absent"
git remote rename origin-moved origin

git branch -q -D dl-orphan-pin
mv .devloop.json .devloop.json.bak
out=$(bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
[ "$rc" -ne 0 ] && pass "doctor fails without config" || fail "doctor passed without config"
echo "$out" | grep -q "MISSING .*\.devloop.json" && pass "doctor names the missing config" ||
  fail "doctor did not name the missing config"
mv .devloop.json.bak .devloop.json

# --- doctor.sh: factory mode and store health (dark-factory spec §2) ---------
# Splice factory/scenarios keys into the fixture config (keeping checks/remote/
# AGENTS.md intact, so the assertions are about the factory lines alone).
mkcfg() { # mkcfg [EXTRA-JSON]  — base fixture config plus EXTRA before the closing brace
  local sep=,  # the heavy line ends with a comma only when EXTRA follows it
  [ -n "$1" ] || sep=''
  cat >.devloop.json <<EOF
{
  "base_branch": "main",
  "fast_check": "test ! -e fast-fail",
  "format": "echo formatted {file} >> fmt.log",
  "format_extensions": [".txt"],
  "checks": [
    {"name": "unit", "command": "./check.sh", "summary": "passed|failed"},
    {"name": "lint", "command": "test -x check.sh", "heavy": false}
  ],
  "heavy": {"slots": 2, "port_env": "SMOKE_PORT", "port_base": 9100, "port_step": 10, "poll_seconds": 1}$sep
$1
}
EOF
}
doct() { bash "$plugin/scripts/doctor.sh" 2>&1; }
store_dir="$work/home/project/scenarios"
write_scen() { # write_scen FILE ID TITLE REQUIRED
  printf -- '---\nid: %s\ntitle: %s\nrequired: %s\n---\n## User and goal\ndo it\n' "$2" "$3" "$4" >"$store_dir/$1"
}

# Collaborative with no keys: the default line, healthy, no store line.
out=$(doct); rc=$?
expect "collaborative default stays healthy" "0" "$rc"
echo "$out" | grep -qF "factory collaborative, scenarios off (default)" &&
  pass "doctor prints the default factory line" || fail "no default factory line"
echo "$out" | grep -q "store" &&
  fail "a store line was printed while scenarios are off" || pass "no store line while scenarios are off"

# "factory":"dark" alone: the preset turns the store on; a missing dir is a note, not a miss.
mkcfg '"factory": "dark"'
out=$(doct); rc=$?
expect "dark preset with a missing store dir stays healthy" "0" "$rc"
echo "$out" | grep -qF "factory dark, scenarios on (preset)" &&
  pass "doctor prints the dark preset line" || fail "no dark preset line"
echo "$out" | grep -qF "note    scenario store not created yet: $store_dir" &&
  pass "missing store dir is a note naming the resolved path" || fail "no note line for the missing store dir"
echo "$out" | grep -q "^MISSING" &&
  fail "a missing store dir was counted as a problem" || pass "missing store dir adds no problems"

# dark + explicit "scenarios": false: the explicit off wins even in a dark factory.
mkcfg '"factory": "dark", "scenarios": false'
out=$(doct); rc=$?
expect "dark with an explicit scenarios:false stays healthy" "0" "$rc"
echo "$out" | grep -qF "factory dark, scenarios off (explicit)" &&
  pass "doctor prints the explicit-off line" || fail "no explicit-off line"
echo "$out" | grep -q "store" &&
  fail "a store line was printed although scenarios are off" || pass "no store line for an explicit off"

# collaborative + a scenarios block: the block turns the store on in any mode.
mkcfg '"scenarios": {}'
out=$(doct); rc=$?
expect "collaborative with a scenarios block stays healthy" "0" "$rc"
echo "$out" | grep -qF "factory collaborative, scenarios on (explicit)" &&
  pass "doctor prints the collaborative explicit-on line" || fail "no collaborative explicit-on line"
echo "$out" | grep -qF "$store_dir (0 scenarios, 0 required)" &&
  pass "store line carries the resolved path and zero counts" || fail "store line missing or miscounted"

# Seeded store (3 valid: 2 required, 1 not), dark: path, counts, healthy.
mkdir -p "$store_dir"
write_scen t1-alpha.md t1-alpha "Alpha works" true
write_scen t2-beta.md t2-beta "Beta works" false
write_scen t3-gamma.md t3-gamma "Gamma works" true
mkcfg '"factory": "dark"'
out=$(doct); rc=$?
expect "doctor is healthy with a seeded store" "0" "$rc"
echo "$out" | grep -qF "$store_dir (3 scenarios, 2 required)" &&
  pass "doctor prints the store path with the scenario and required counts" ||
  fail "store counts line wrong (want: $store_dir (3 scenarios, 2 required))"

# One malformed file: exactly that file is named as a MISSING, exit 1.
printf -- '---\nid: t4-bad\n' >"$store_dir/t4-bad.md" # unclosed frontmatter
out=$(doct); rc=$?
expect "doctor fails on a malformed scenario file" "1" "$rc"
echo "$out" | grep -q "^MISSING scenario t4-bad.md: " &&
  pass "the malformed file is named with its reason" || fail "malformed file not named"
[ "$(echo "$out" | grep -c "^MISSING scenario")" = 1 ] &&
  pass "only the malformed file is named" || fail "more than one scenario file was named"
echo "$out" | grep -q "doctor: 1 problem(s)" &&
  pass "the malformed file counts in the problem tally" || fail "problem tally missed the malformed file"

# Dark with zero VALID REQUIRED scenarios: MISSING factory dark (plus the bad file).
rm -rf "$store_dir"
mkdir -p "$store_dir"
write_scen t5-nr.md t5-nr "Not required" false
printf -- '---\nid: t6-bad\n' >"$store_dir/t6-bad.md" # unclosed frontmatter
out=$(doct); rc=$?
expect "dark with zero valid required scenarios fails" "1" "$rc"
echo "$out" | grep -q "^MISSING factory dark:" &&
  pass "the unseeded dark factory is flagged MISSING" || fail "no MISSING factory dark line"
echo "$out" | grep -q "^MISSING scenario t6-bad.md: " &&
  pass "the malformed file is named beside the dark flag" || fail "malformed file lost beside the dark flag"
echo "$out" | grep -q "doctor: 2 problem(s)" &&
  pass "both problems are tallied" || fail "problem tally wrong for dark + malformed"

# Dark with an EMPTY store dir: the dark flag stands on its own.
rm -rf "$store_dir"
mkdir -p "$store_dir"
out=$(doct); rc=$?
expect "dark with an empty store dir fails" "1" "$rc"
echo "$out" | grep -q "^MISSING factory dark:" &&
  pass "empty store dir trips the dark flag" || fail "empty store dir did not trip the dark flag"
echo "$out" | grep -q "^MISSING scenario" &&
  fail "an empty store dir named phantom files" || pass "no phantom file lines for an empty store dir"

# Store path exists as a REGULAR FILE: the scan yields a named error, doctor reports a
# MISSING line (defect class + resolved path) — never a crash, never the "not created
# yet" note for a path that IS there.
rm -rf "$store_dir"
printf 'not a dir\n' >"$store_dir"
out=$(doct); rc=$?
expect "doctor fails when the store path is a regular file" "1" "$rc"
echo "$out" | grep -qF "MISSING scenario store: store path is not a directory (ENOTDIR) ($store_dir)" &&
  pass "the file-store is named with its defect class and resolved path" ||
  fail "file-store MISSING line wrong (want: MISSING scenario store: store path is not a directory (ENOTDIR) ($store_dir))"
echo "$out" | grep -q "not created yet" &&
  fail "a file store was misreported as not created yet" || pass "no not-created-yet note for a file store"
rm -f "$store_dir"

mkcfg '' # restore the base fixture config
rm -rf "$store_dir"

# --- doctor.sh: the factory one-shot names the import failure (#37) ---------
# Reproduces the incident: the INSTALLED extension dir with the real src copy
# and a stale type:commonjs manifest (an npm-init'd leftover to host the
# runtime probe's node_modules). The CJS declaration forces CJS parsing of the
# ESM .ts sources, the import rejects, and node prints the reason to stderr,
# which doctor used to swallow (2>/dev/null) — the failure surfaced as "import
# failed" with no reason. The note must carry the FIRST line of node's stderr.
# (Stub node_modules keep the runtime probe quiet, isolating the factory lines.)
BROKEN_EXT=".pi/extensions/multipi-devloop"
mkdir -p "$BROKEN_EXT" node_modules
cp -R "$plugin/extension/src" "$BROKEN_EXT/src"
printf '{\n  "name": "multipi-devloop",\n  "type": "commonjs"\n}\n' >"$BROKEN_EXT/package.json"
stub_runtime_deps() { # minimal importable stand-ins (pattern of the runtime section below)
  mkdir -p node_modules/typebox node_modules/@earendil-works/pi-coding-agent
  printf '{"name":"typebox","version":"0.0.0","main":"index.js"}' >node_modules/typebox/package.json
  echo 'module.exports = {}; ' >node_modules/typebox/index.js
  printf '{"name":"@earendil-works/pi-coding-agent","version":"0.0.0","main":"index.js"}' >node_modules/@earendil-works/pi-coding-agent/package.json
  echo 'module.exports = {}; ' >node_modules/@earendil-works/pi-coding-agent/index.js
}
stub_runtime_deps
out=$(doct); rc=$?
expect "a broken factory import stays a note, not a problem" "0" "$rc"
echo "$out" | grep -q "^note    factory report unavailable (node import failed: " &&
  pass "the broken import is noted WITH its reason" ||
  fail "no reason-carrying import-failed note (got: $(echo "$out" | grep -F 'factory report unavailable' || echo '<no factory note at all>'))"
echo "$out" | grep -q "Failed to load the ES module" &&
  pass "the note carries node's first error line (the module-type cause)" ||
  fail "node's error line is missing from the note (still the bare 'import failed'?"
echo "$out" | grep -qF "factory collaborative, scenarios off" &&
  fail "a factory line was printed although the import failed" ||
  pass "no factory line beside a failed import"
printf '{\n  "name": "multipi-devloop",\n  "type": "module"\n}\n' >"$BROKEN_EXT/package.json"
out=$(doct)
echo "$out" | grep -qF "factory collaborative, scenarios off (default)" &&
  pass "the factory line returns when the manifest is fixed" ||
  fail "factory line lost after fixing the manifest"
rm -rf "$BROKEN_EXT" node_modules

# --- policy: doctor section + policy.sh (permission-policy spec §8, #42) ------
# The doctor and policy.sh share ONE evaluator: both import loadPolicy/evaluate from
# the plugin's extension/src (doctor's second candidate), so the fixture needs no .pi
# install — only the config, a permissions.json, and FAITHFUL fake shims (forwarders
# that drop the shim dir from PATH, the P3 idiom) inside the fixture's own tree.
polcfg() { # fixture config WITH an explicit policy block
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
  "heavy": {"slots": 2, "port_env": "SMOKE_PORT", "port_base": 9100, "port_step": 10, "poll_seconds": 1},
  "policy": {"posture": "allow", "repos": ["self"], "secondaries": [], "token_ttl_minutes": 10}
}
EOF
}
seed_perms() { # one rule per class, so the counts and the explain pins are exact
  cat >permissions.json <<'EOF'
{
  "permissions": {
    "deny": ["Bash(sudo:*)"],
    "ask": ["Bash(gh pr merge:*)"],
    "allow": ["Bash(ls:*)"]
  }
}
EOF
}
shim_dir="$work/project/scripts/policy-shims"
mkfake_shims() { # faithful forwarders: the shim dir drops out of PATH for the exec
  mkdir -p "$shim_dir"
  local b
  for b in git gh; do
    cat >"$shim_dir/$b" <<EOS
#!/usr/bin/env bash
rest=\${PATH#"$shim_dir":}
exec env PATH="\$rest" $b "\$@"
EOS
    chmod +x "$shim_dir/$b"
  done
}
tok_dir="$work/home/project/dev-loop-tokens"
audit_log="$work/home/project/logs/policy-audit.jsonl"
POLS="$plugin/scripts/policy.sh"

# Absent by design (no policy block, no permissions.json): a NOTE, never a problem.
mkcfg ''
rm -f permissions.json
out=$(doct); rc=$?
expect "doctor stays ready with the policy absent by design" "0" "$rc"
echo "$out" | grep -qF "note    policy not configured (no policy block, no permissions.json — inactive by design)" &&
  pass "absent policy is noted as inactive by design" || fail "no absent-by-design note"
echo "$out" | grep -q "doctor: ready" && pass "the absent-policy note is not a problem" ||
  fail "the absent-policy note was counted as a problem"

# Present + valid + shims on PATH + no token dir yet: the healthy policy section.
polcfg; seed_perms; mkfake_shims
out=$(PATH="$shim_dir:$PATH" doct); rc=$?
expect "doctor is ready with a valid policy and shims on PATH" "0" "$rc"
echo "$out" | grep -qF "ok      policy loaded (posture allow; rules: 1 deny, 1 ask, 1 allow)" &&
  pass "doctor renders posture and the rule counts per verdict" ||
  fail "policy loaded line wrong (want: ok      policy loaded (posture allow; rules: 1 deny, 1 ask, 1 allow))"
echo "$out" | grep -qF "ok      policy shims on PATH (git, gh)" &&
  pass "shims on PATH are ok" || fail "no shims-ok line"
echo "$out" | grep -qF "note    policy token dir not created yet ($tok_dir — phase 2)" &&
  pass "the missing token dir is a phase-1 note" || fail "no token-dir note"

# Token dir present: loose perms are a NOTE (the 0700 pin lands in P6), tight is ok.
mkdir -p "$tok_dir" && chmod 0755 "$tok_dir"
out=$(PATH="$shim_dir:$PATH" doct); rc=$?
expect "doctor stays ready with a loose token dir" "0" "$rc"
echo "$out" | grep -qF "policy token dir is 755" &&
  pass "the loose token dir mode is noted" || fail "loose token dir not noted"
chmod 0700 "$tok_dir"
out=$(PATH="$shim_dir:$PATH" doct); rc=$?
expect "doctor is ready with a 0700 token dir" "0" "$rc"
echo "$out" | grep -qF "ok      policy token dir ($tok_dir, 0700)" &&
  pass "the tight token dir is ok" || fail "no token-dir ok line"

# Active policy but shims OFF PATH: MISSING, fail closed (spec §8), one problem.
out=$(doct); rc=$?
expect "doctor fails when the policy is active but the shims are off PATH" "1" "$rc"
echo "$out" | grep -qF "MISSING policy shims on PATH (git, gh) — policy is active but the Layer-2 guarantee is absent (rerun scripts/install.sh)" &&
  pass "the missing shims are MISSING with the repair line" ||
  fail "wrong shim-MISSING line (got: $(echo "$out" | grep -F 'policy shims' || echo '<none>'))"
echo "$out" | grep -qF "doctor: 1 problem(s)" && pass "the shim miss counts once" || fail "shim miss not tallied"

# Partial shim set: only the absent binary is named.
rm -f "$shim_dir/gh"
out=$(PATH="$shim_dir:$PATH" doct); rc=$?
expect "doctor fails with only the gh shim absent" "1" "$rc"
echo "$out" | grep -qF "MISSING policy shims on PATH (gh)" &&
  pass "only the absent shim is named" || fail "the absent shim is not named precisely"

# Broken PRESENT file: MISSING with the fail-closed repair line, exact load error.
printf 'not { json\n' >permissions.json
out=$(PATH="$shim_dir:$PATH" doct); rc=$?
expect "doctor fails on a broken present permissions.json" "1" "$rc"
echo "$out" | grep -qF "MISSING policy: permissions.json is not valid JSON" &&
  pass "the broken file is MISSING with the loader's error" ||
  fail "broken policy not MISSING (got: $(echo "$out" | grep -F 'MISSING policy' || echo '<none>'))"
echo "$out" | grep -qF "FAILS CLOSED" &&
  pass "the repair line says the policy fails closed" || fail "no fail-closed text on the broken-policy line"

# A valid JSON file with an invalid RULE is broken too — the rule is named.
printf '{"permissions":{"deny":["not-a-rule"]}}\n' >permissions.json
out=$(PATH="$shim_dir:$PATH" doct); rc=$?
expect "doctor fails on an invalid rule" "1" "$rc"
echo "$out" | grep -qF 'rule "not-a-rule" is not Tool(pattern)' &&
  pass "the invalid rule is named" || fail "invalid rule not named"

# Knobs only (explicit policy block, no permissions.json): posture-only policy —
# still ACTIVE (the block carries the structural repo rules), so shims are still required.
rm -f permissions.json
mkfake_shims # restore the full shim set (the partial-shim test removed the gh shim)
out=$(PATH="$shim_dir:$PATH" doct); rc=$?
expect "a knobs-only policy stays ready with the shims on PATH" "0" "$rc"
echo "$out" | grep -qF "ok      policy posture allow (knobs only — no permissions.json)" &&
  pass "the knobs-only policy is reported as posture-only" || fail "no knobs-only line"
out=$(doct); rc=$?
expect "the knobs-only policy still demands the shims (active means active)" "1" "$rc"
echo "$out" | grep -qF "MISSING policy shims on PATH (git, gh)" &&
  pass "a knobs-only policy still trips the shim MISSING" || fail "knobs-only skipped the shim check"

# --- policy.sh: usage pins ------------------------------------------------------
bash "$POLS" >/dev/null 2>&1;                  expect "policy.sh with no args exits 2 (usage)" "2" "$?"
bash "$POLS" bogus >/dev/null 2>&1;            expect "policy.sh bogus subcommand exits 2" "2" "$?"
bash "$POLS" show extra >/dev/null 2>&1;       expect "policy.sh show with extra args exits 2" "2" "$?"
bash "$POLS" explain >/dev/null 2>&1;          expect "policy.sh explain without a command exits 2" "2" "$?"
bash "$POLS" audit --since abc >/dev/null 2>&1; expect "policy.sh audit --since abc exits 2" "2" "$?"
bash "$POLS" audit --since >/dev/null 2>&1;    expect "policy.sh audit --since without a value exits 2" "2" "$?"

# --- policy.sh show --------------------------------------------------------------
seed_perms
out=$(bash "$POLS" show); rc=$?
expect "policy.sh show exits 0 on a valid policy" "0" "$rc"
echo "$out" | grep -qF "policy: loaded" && pass "show renders the loaded state" || fail "show does not render loaded"
echo "$out" | grep -qF "posture:         allow — unmatched calls pass" &&
  pass "show renders the posture with its plain-language meaning" || fail "posture line wrong"
echo "$out" | grep -qF 'repos:           ["self"]' && pass "show renders the repos knob" || fail "repos line wrong"
echo "$out" | grep -qF "token ttl:       10 minutes" && pass "show renders the token ttl" || fail "token ttl line wrong"
echo "$out" | grep -qF "additionalDirectories (computed from .devloop.json):" &&
  pass "show carries the additionalDirectories header" || fail "no additionalDirectories header"
for d in "$work/home/project/worktrees/project" "$work/home/project/notes" "$work/home/project/worktrees/project/gate"; do
  echo "$out" | grep -qF "$d" && pass "additionalDirectories carries $d" || fail "additionalDirectories missing $d"
done
for pair in "[deny]|Bash(sudo:*)" "[ask]|Bash(gh pr merge:*)" "[allow]|Bash(ls:*)"; do
  cls=${pair%%|*}; rul=${pair#*|}
  block=$(echo "$out" | grep -A1 -F "  $cls (")
  echo "$block" | grep -qF "$rul" && pass "show groups $rul under $cls" ||
    fail "show does not group $rul under $cls (rules section:) $(echo "$out" | sed -n '/^rules/,$p')"
done

# show on a BROKEN policy: renders the unusable state (this tool's job), exit 0.
printf 'not { json\n' >permissions.json
out=$(bash "$POLS" show); rc=$?
expect "policy.sh show exits 0 on a broken policy (rendering it is the job)" "0" "$rc"
echo "$out" | grep -qF "policy: UNUSABLE — permissions.json is not valid JSON" &&
  pass "show names the unusable policy with the loader's error" || fail "show hides the unusable state"
echo "$out" | grep -qF "FAILING CLOSED" &&
  pass "show says the hook is failing closed" || fail "show does not say fail-closed"
seed_perms # restore

# --- policy.sh explain: the tripwire made interactive -----------------------------
out=$(bash "$POLS" explain sudo reboot); rc=$?
expect "explain exits 0 on a denied command (it is a report, not an action)" "0" "$rc"
echo "$out" | grep -qF "explain: sudo reboot" && pass "explain echoes the command" || fail "no command echo"
echo "$out" | grep -qF "verdict: deny" && pass "explain renders the deny verdict" || fail "deny verdict wrong"
echo "$out" | grep -qF "rule:    Bash(sudo:*)" && pass "explain renders the deciding rule" || fail "deny rule id wrong"
echo "$out" | grep -qF "denied by rule: Bash(sudo:*)" && pass "explain renders the reason" || fail "deny reason wrong"

out=$(bash "$POLS" explain gh pr merge 12); rc=$?
expect "explain exits 0 on an ask command" "0" "$rc"
echo "$out" | grep -qF "verdict: ask" && pass "explain renders the ask verdict" || fail "ask verdict wrong"
echo "$out" | grep -qF "rule:    Bash(gh pr merge:*)" && pass "explain renders the ask rule" || fail "ask rule id wrong"

out=$(bash "$POLS" explain ls -la); rc=$?
expect "explain exits 0 on an allowed command" "0" "$rc"
echo "$out" | grep -qF "verdict: allow" && pass "explain renders the allow verdict" || fail "allow verdict wrong"
echo "$out" | grep -qF "rule:    Bash(ls:*)" && pass "explain renders the allow rule" || fail "allow rule id wrong"

out=$(bash "$POLS" explain make check); rc=$?
expect "explain exits 0 on a default-posture command" "0" "$rc"
echo "$out" | grep -qF "verdict: allow" && pass "unmatched falls to the posture" || fail "default verdict wrong"
echo "$out" | grep -qF "rule:    (none — posture default)" && pass "the default has no rule id" || fail "default rule line wrong"
echo "$out" | grep -qF "no rule matched — default posture allow" && pass "the default reason names the posture" || fail "default reason wrong"
echo "$out" | grep -qF "string layer only" &&
  pass "explain carries the honesty note" || fail "no honesty note on explain"

# explain on a BROKEN policy: the evaluator's fail-closed verdict, exit 0.
printf 'not { json\n' >permissions.json
out=$(bash "$POLS" explain ls); rc=$?
expect "explain exits 0 on a broken policy (the verdict is the report)" "0" "$rc"
echo "$out" | grep -qF "verdict: deny" && pass "broken policy explains as deny" || fail "broken policy did not explain as deny"
echo "$out" | grep -qF "rule:    policy:unusable" && pass "the unusable rule id is rendered" || fail "no unusable rule id"
seed_perms # restore

# --- policy.sh audit ---------------------------------------------------------------
out=$(bash "$POLS" audit); rc=$?
expect "audit exits 0 when the log is absent" "0" "$rc"
echo "$out" | grep -qF "audit: no events recorded yet ($audit_log absent)" &&
  pass "the absent log is named" || fail "absent log line wrong"

now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
old_iso=$(date -u -d '-600 seconds' +%Y-%m-%dT%H:%M:%SZ)
now_ms=$(($(date +%s) * 1000 + 500))
old_s=$(( $(date +%s) - 600 ))
mline() { # mline "TS" LAYER SUMMARY — one audit line (the P2 writer's field set)
  printf '{"ts":%s,"session":"sess-1","actor":"orchestrator","ruleId":"Bash(sudo:*)","verdict":"deny","actionSummary":"%s","layer":"%s"}\n' "$1" "$3" "$2"
}
mkdir -p "$(dirname "$audit_log")"
# Order: old first, recent after — the reader preserves file order.
mline "\"$old_iso\"" hook "sudo reboot (old)" >"$audit_log"
mline "\"$now_iso\"" hook "sudo reboot" >>"$audit_log"
out=$(bash "$POLS" audit); rc=$?
expect "audit exits 0 on a seeded log" "0" "$rc"
[ "$(echo "$out" | grep -c '"ts"')" = "2" ] &&
  pass "audit prints both seeded lines in file order" ||
  fail "audit line count wrong (want 2, got: $(echo "$out" | grep -c '"ts"'))"
echo "$out" | grep -qF '"actionSummary":"sudo reboot"' &&
  pass "audit lines are printed verbatim" || fail "audit line altered"

# --since 30 drops the 600-second-old line only.
out=$(bash "$POLS" audit --since 30); rc=$?
expect "audit --since exits 0" "0" "$rc"
[ "$(echo "$out" | grep -c '"ts"')" = "1" ] &&
  pass "--since 30 keeps only the recent line" ||
  fail "--since 30 wrong count (want 1, got: $(echo "$out" | grep -c '"ts"'))"
echo "$out" | grep -qF '"actionSummary":"sudo reboot"' &&
  pass "--since keeps the recent line" || fail "--since dropped the recent line"
# The trailing-s spelling is the same filter.
out=$(bash "$POLS" audit --since 30s); rc=$?
expect "audit --since 30s (trailing s) exits 0" "0" "$rc"
[ "$(echo "$out" | grep -c '"ts"')" = "1" ] &&
  pass "the trailing-s spelling filters identically" || fail "trailing-s spelling broken"

# Numeric ts: epoch milliseconds (recent) and epoch seconds (old) are both understood.
printf '{"ts":%s,"session":"s2","actor":"orchestrator","ruleId":"Bash(sudo:*)","verdict":"deny","actionSummary":"ms-recent","layer":"shim"}\n' "$now_ms" >"$audit_log"
printf '{"ts":%s,"session":"s2","actor":"orchestrator","ruleId":"Bash(sudo:*)","verdict":"deny","actionSummary":"s-old","layer":"shim"}\n' "$old_s" >>"$audit_log"
out=$(bash "$POLS" audit --since 30); rc=$?
[ "$(echo "$out" | grep -c '"ts"')" = "1" ] &&
  pass "numeric ts (ms and s) is understood by --since" ||
  fail "numeric ts wrong count (want 1, got: $(echo "$out" | grep -c '"ts"'))"
echo "$out" | grep -qF '"actionSummary":"ms-recent"' &&
  pass "the recent ms line survives --since" || fail "the recent ms line was dropped"

# An unparseable/missing ts is KEPT: the reader never drops evidence.
printf '{"ruleId":"Bash(sudo:*)","verdict":"deny","actionSummary":"no-ts","layer":"hook"}\n' >"$audit_log"
printf '{"ts":"garbage","session":"s3","actor":"orchestrator","ruleId":"Bash(sudo:*)","verdict":"deny","actionSummary":"bad-ts","layer":"hook"}\n' >>"$audit_log"
out=$(bash "$POLS" audit --since 1); rc=$?
[ "$(echo "$out" | grep -c '"actionSummary"')" = "2" ] &&
  pass "unparseable and missing ts are kept by --since" ||
  fail "unparseable ts lines were dropped"
echo "$out" | grep -qF '"actionSummary":"no-ts"' && pass "the no-ts line survives" || fail "no-ts line lost"
echo "$out" | grep -qF '"actionSummary":"bad-ts"' && pass "the bad-ts line survives" || fail "bad-ts line lost"

# Bounded output: only the newest AUDIT_TAIL (50) lines are ever printed.
: >"$audit_log"
i=1
while [ "$i" -le 52 ]; do
  printf '{"ts":"%s","session":"s4","actor":"orchestrator","ruleId":"Bash(sudo:*)","verdict":"deny","actionSummary":"line-%02d","layer":"hook"}\n' "$now_iso" "$i" >>"$audit_log"
  i=$((i + 1))
done
out=$(bash "$POLS" audit); rc=$?
expect "audit exits 0 on a long log" "0" "$rc"
[ "$(echo "$out" | grep -c '"actionSummary"')" = "50" ] &&
  pass "audit output is bounded to the newest 50 lines" ||
  fail "audit tail not bounded (want 50, got: $(echo "$out" | grep -c '"actionSummary"'))"
echo "$out" | grep -qF '"actionSummary":"line-01"' &&
  fail "the oldest line was kept (a head, not a tail?)" ||
  pass "the tail keeps the NEWEST lines"
echo "$out" | grep -qF '"actionSummary":"line-52"' &&
  pass "the last line survives the tail" || fail "the last line lost"

# Tidy the fixture: no policy files, no shims, no token dir, no audit log, base config.
rm -f permissions.json
rm -rf "$shim_dir" "$tok_dir" "$audit_log"
mkcfg ''

# --- install.sh: the extension package.json is installer-owned (#37) --------
# A stale npm-init'd type:commonjs manifest in the target's extension dir used
# to SURVIVE the sync (the best-effort copy pointed at a source file that does
# not exist), forcing CJS parsing of the ESM .ts sources and silently disabling
# the factory report. The installer now OWNS the manifest: it rewrites it on
# every sync, fresh install and upgrade alike.
INSTALL_PROJ="$work/installproj"
git init -q "$INSTALL_PROJ"
mkdir -p "$INSTALL_PROJ/.pi/extensions/multipi-devloop"
printf '{\n  "name": "multipi-devloop",\n  "version": "0.0.1",\n  "type": "commonjs"\n}\n' \
  >"$INSTALL_PROJ/.pi/extensions/multipi-devloop/package.json"
bash "$plugin/scripts/install.sh" "$INSTALL_PROJ" >/dev/null 2>&1 &&
  pass "install runs over a target with a pre-existing extension dir" ||
  fail "install failed over a pre-existing extension dir"
MANIFEST="$INSTALL_PROJ/.pi/extensions/multipi-devloop/package.json"
grep -q '"type": "module"' "$MANIFEST" &&
  pass "a stale type:commonjs manifest is rewritten to type:module" ||
  fail "the stale type:commonjs manifest survived the install"
grep -q '"type": "commonjs"' "$MANIFEST" &&
  fail "a commonjs declaration survived the install" || pass "no commonjs declaration remains"
grep -q 'typebox' "$MANIFEST" && grep -q '@earendil-works/pi-coding-agent' "$MANIFEST" &&
  pass "the owned manifest carries the two extension deps" ||
  fail "the owned manifest is missing an extension dep"
# Fresh install (no pre-existing manifest) writes the same owned ESM bytes.
rm -rf "$INSTALL_PROJ"
git init -q "$INSTALL_PROJ"
bash "$plugin/scripts/install.sh" "$INSTALL_PROJ" >/dev/null 2>&1
grep -q '"type": "module"' "$MANIFEST" &&
  pass "a fresh install writes the ESM manifest" ||
  fail "a fresh install wrote no ESM manifest"
# doctor IN THE INSTALLED TARGET computes the factory report from the installed
# copy (candidate 1), so the owned manifest is what keeps the factory line alive.
cat >"$INSTALL_PROJ/.devloop.json" <<'EOF'
{
  "base_branch": "main",
  "checks": [{"name": "unit", "command": "true"}]
}
EOF
git -C "$INSTALL_PROJ" remote add origin "$work/origin.git"
# A git WORKTREE (a .git file, not a directory) is a valid target: the dogfood
# checkouts themselves are worktrees, and an installer that refuses them cannot
# upgrade its own instance.
( cd "$INSTALL_PROJ" && git add -A >/dev/null && git commit -qm "chore: installed" )
git -C "$INSTALL_PROJ" worktree add -q "$work/installwt"
bash "$plugin/scripts/install.sh" "$work/installwt" >/dev/null 2>&1 &&
  pass "install runs over a worktree target (.git file)" ||
  fail "install refused a worktree target"
grep -q '"type": "module"' "$work/installwt/.pi/extensions/multipi-devloop/package.json" &&
  pass "the worktree target receives the owned ESM manifest" ||
  fail "no owned ESM manifest in the worktree target"
git -C "$INSTALL_PROJ" worktree remove --force "$work/installwt"
out=$(cd "$INSTALL_PROJ" && bash "$plugin/scripts/doctor.sh" 2>&1)
echo "$out" | grep -qF "factory collaborative, scenarios off (default)" &&
  pass "doctor prints the factory line in the installed target" ||
  fail "no factory line in the installed target (got: $(echo "$out" | grep -F 'factory' || echo '<no factory line at all>'))"
rm -rf "$INSTALL_PROJ"

# --- doctor.sh: extension runtime -------------------------------------------
# Stub the installed extension and a stub node_modules (offline stand-ins for the
# real packages; doctor must only see that they resolve).
EXT=.pi/extensions/multipi-devloop
mkdir -p "$EXT" node_modules
echo 'export default function () {}; ' >"$EXT/index.ts"
stub_pkg() { # stub_pkg DIR: a minimal importable package
  local dir="node_modules$1"
  mkdir -p "$dir"
  printf '{"name":"%s","version":"0.0.0","main":"index.js"}' "$1" >"$dir/package.json"
  echo 'module.exports = {}; ' >"$dir/index.js"
}

# All present: one ok line (with the node version) and the run stays healthy.
stub_pkg /typebox
stub_pkg /@earendil-works/pi-coding-agent
out=$(bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
expect "doctor stays ready when the extension runtime is complete" "0" "$rc"
echo "$out" | grep -q "doctor: ready" && pass "extension runtime adds no problems" ||
  fail "doctor not ready with the extension runtime complete"
echo "$out" | grep -Eq "ok      extension runtime \(node v[^,]+, typebox, pi-coding-agent\)" &&
  pass "doctor prints the extension runtime ok line" ||
  fail "no extension runtime ok line (want: ok  extension runtime (node v..., typebox, pi-coding-agent))"

# One package missing: exactly that one is named, with the npm remedy, exit non-zero.
rm -rf node_modules/@earendil-works
out=$(bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
[ "$rc" -ne 0 ] && pass "doctor fails with one extension package missing" ||
  fail "doctor passed with one extension package missing"
[ "$(echo "$out" | grep -c '^MISSING')" = 1 ] && pass "only the missing package is flagged" ||
  fail "expected exactly one MISSING line"
echo "$out" | grep -q "^MISSING @earendil-works/pi-coding-agent" &&
  pass "doctor names the one missing package" || fail "the missing package was not named"
echo "$out" | grep -q "cannot be loaded from .pi/extensions/multipi-devloop" &&
  pass "missing package line carries the load wording" ||
  fail "missing package line lacks the load wording (want: 'cannot be loaded')"
echo "$out" | grep -q "cannot be resolved" &&
  fail "stale resolution wording in the missing package line" ||
  pass "no stale resolution wording in the missing package line"
echo "$out" | grep -q "npm i -D typebox @earendil-works/pi-coding-agent" &&
  pass "doctor offers the npm remedy" || fail "no npm remedy"

# Both packages missing: each gets its own MISSING line.
rm -rf node_modules
out=$(bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
[ "$rc" -ne 0 ] && pass "doctor fails when both extension packages are missing" ||
  fail "doctor passed with both extension packages missing"
[ "$(echo "$out" | grep -c '^MISSING')" = 2 ] && pass "each missing package gets its own MISSING line" ||
  fail "expected two MISSING lines"
echo "$out" | grep -q "^MISSING typebox" && pass "doctor names typebox (both missing)" ||
  fail "typebox not named (both missing)"
echo "$out" | grep -q "^MISSING @earendil-works/pi-coding-agent" &&
  pass "doctor names pi-coding-agent (both missing)" ||
  fail "pi-coding-agent not named (both missing)"
echo "$out" | grep -q "doctor: 2 problem(s)" && pass "problem tally counts the missing packages" ||
  fail "problem tally does not count the missing packages"

# A dependency that crashes the probe must not yield a false ok line: nothing was verified.
mkdir -p node_modules/typebox
printf '{"name":"typebox","version":"0.0.0","main":"index.js"}' >node_modules/typebox/package.json
echo 'process.exit(1); ' >node_modules/typebox/index.js
out=$(bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
[ "$rc" -ne 0 ] && pass "doctor fails when a dependency crashes the runtime probe" ||
  fail "doctor passed although a dependency crashed the probe"
echo "$out" | grep -q '^ok      extension runtime' &&
  fail "false ok line from a crashed probe" ||
  pass "no false ok line when the probe crashes"
echo "$out" | grep -q '^MISSING extension runtime' &&
  pass "crashed probe is reported as a MISSING line" ||
  fail "crashed probe was not reported as MISSING"

# A package that RESOLVES but throws at evaluation: the probe's import rejects,
# so the package is named — with the LOAD wording (resolution was not what failed).
mkdir -p node_modules/typebox
printf '{"name":"typebox","version":"0.0.0","main":"index.js"}' >node_modules/typebox/package.json
echo 'throw new Error("evaluation failed"); ' >node_modules/typebox/index.js
stub_pkg /@earendil-works/pi-coding-agent
out=$(bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
[ "$rc" -ne 0 ] && pass "doctor fails when a package throws at evaluation" ||
  fail "doctor passed although a package threw at evaluation"
[ "$(echo "$out" | grep -c '^MISSING')" = 1 ] &&
  pass "eval-time throw flags exactly one problem" ||
  fail "expected exactly one MISSING line for the eval-time throw"
echo "$out" | grep -q "^MISSING typebox" &&
  pass "eval-time throw names the throwing package" ||
  fail "eval-time throw did not name the package"
echo "$out" | grep -q "cannot be loaded from .pi/extensions/multipi-devloop" &&
  pass "eval-time failure carries the load wording" ||
  fail "eval-time failure missing the load wording (want: 'cannot be loaded')"
echo "$out" | grep -q "cannot be resolved" &&
  fail "stale resolution wording remains beside the eval-time throw" ||
  pass "no stale resolution wording beside the eval-time throw"
echo "$out" | grep -q '^ok      extension runtime' &&
  fail "false ok line when a package throws at evaluation" ||
  pass "no false ok line for the eval-time throw"

# A dependency that prints noise but resolves must stay healthy: doctor reads only its own
# verdict lines, not the imported package's side effects.
mkdir -p node_modules/typebox
printf '{"name":"typebox","version":"0.0.0","main":"index.js"}' >node_modules/typebox/package.json
echo 'console.log("hello"); module.exports = {}; ' >node_modules/typebox/index.js
stub_pkg /@earendil-works/pi-coding-agent
out=$(bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
expect "doctor stays ready when a dependency prints during import" "0" "$rc"
echo "$out" | grep -q "doctor: ready" && pass "noisy-but-resolving import adds no problems" ||
  fail "noisy-but-resolving import broke the run"
echo "$out" | grep -Eq "ok      extension runtime \(node v[^,]+, typebox, pi-coding-agent\)" &&
  pass "noisy-but-resolving import still yields the ok line" ||
  fail "no ok line although the import succeeded"
echo "$out" | grep -q '^MISSING' &&
  fail "noise from a successful import was flagged as MISSING" ||
  pass "no MISSING line from a noisy import"
echo "$out" | grep -q 'hello' &&
  fail "dependency noise leaked into doctor output" ||
  pass "dependency noise does not leak into doctor output"

# A dependency that prints then hard-crashes (unreachable even by try/catch) plus a genuinely
# missing package: doctor must name the real miss AND flag the probe, and must not mistake
# the crashed dependency's output for a missing package name.
rm -rf node_modules
mkdir -p node_modules/@earendil-works/pi-coding-agent
printf '{"name":"@earendil-works/pi-coding-agent","version":"0.0.0","main":"index.js"}' \
  >node_modules/@earendil-works/pi-coding-agent/package.json
echo 'console.log("boom"); process.exit(1); ' >node_modules/@earendil-works/pi-coding-agent/index.js
out=$(bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
[ "$rc" -ne 0 ] && pass "doctor fails when a dependency prints then hard-crashes" ||
  fail "doctor passed although a dependency crashed the probe mid-run"
echo "$out" | grep -q '^MISSING typebox' &&
  pass "genuinely missing package is still named beside the crashed probe" ||
  fail "genuinely missing package was lost when the probe crashed"
echo "$out" | grep -q '^MISSING extension runtime' &&
  pass "mid-run crash is reported as a probe MISSING line" ||
  fail "mid-run crash was not reported as a probe MISSING line"
echo "$out" | grep -q '^MISSING boom' &&
  fail "dependency output was mistaken for a missing package" ||
  pass "dependency output is not mistaken for a missing package"
echo "$out" | grep -q '^ok      extension runtime' &&
  fail "false ok line from a mid-run crashed probe" ||
  pass "no false ok line when the probe crashes mid-run"
[ "$(echo "$out" | grep -c '^MISSING')" = 2 ] &&
  pass "exactly two problems: the real miss and the probe" ||
  fail "expected exactly two MISSING lines (package + probe)"

# node not on PATH: named, and the run fails even with the packages present.
stub_pkg /typebox
stub_pkg /@earendil-works/pi-coding-agent
# Split PATH into dirs (quoted); collect the ones that put node on PATH.
IFS=: read -ra path_dirs <<<"$PATH"
node_dirs=()
for d in "${path_dirs[@]}"; do [ -x "$d/node" ] && node_dirs+=("$d"); done
[ "${#node_dirs[@]}" -gt 0 ] || { echo "smoke: no node on PATH; cannot test the node-missing case"; exit 1; }
# path_nonode: the same dirs minus the node-bearing ones.
path_nonode=""
for d in "${path_dirs[@]}"; do
  skip=0
  for nd in "${node_dirs[@]}"; do [ "$d" = "$nd" ] && skip=1; done
  [ "$skip" -ne 1 ] && path_nonode+="${path_nonode:+:}$d"
done
mkdir -p "$work/bin-nonode"
# Re-provide what doctor.sh, common.sh and fake-gh need under the filtered PATH, deriving
# each location from `command -v` (no hardcoded bin dirs); node itself is left out:
for tool in env bash sh git jq python3 cut dirname basename realpath mkdir; do
  d=$(command -v "$tool" 2>/dev/null) || continue
  ln -sf "$d" "$work/bin-nonode/$tool"
done
ln -sf "$work/bin/gh" "$work/bin-nonode/gh"
out=$(PATH="$work/bin-nonode:$path_nonode" bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
[ "$rc" -ne 0 ] && pass "doctor fails when node is not on PATH" ||
  fail "doctor passed without node on PATH"
echo "$out" | grep -q "^MISSING node" && pass "doctor names the missing node" ||
  fail "node not named"
echo "$out" | grep -q "extension runtime" &&
  fail "doctor printed the runtime ok line without node" ||
  pass "no false ok line without node"

# A node on PATH that is itself broken (#!/bin/sh, exit 1): the probe cannot run,
# so no ok line, the probe problem line is present (reporting the node exit),
# and the run fails.
mkdir -p "$work/bin-badnode"
printf '#!/bin/sh\nexit 1\n' >"$work/bin-badnode/node"
chmod +x "$work/bin-badnode/node"
out=$(PATH="$work/bin-badnode:$PATH" bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
[ "$rc" -ne 0 ] && pass "doctor fails when node on PATH is broken" ||
  fail "doctor passed with a broken node on PATH"
echo "$out" | grep -q '^ok      extension runtime' &&
  fail "false ok line from a broken node" ||
  pass "no false ok line when node on PATH is broken"
echo "$out" | grep -q '^MISSING extension runtime probe (import check did not run cleanly; node exit 1)' &&
  pass "broken node yields the probe problem line" ||
  fail "broken node missing the probe problem line (want: MISSING extension runtime probe ... node exit 1)"

rm -rf "$EXT" node_modules "$work/bin-nonode" "$work/bin-badnode"

# --- scenario-stage.sh (dark-factory spec §5) ------------------------------------
# The stage is a script that decides green/red itself: run the system in its own process
# group (first line = target), judge every scenario with a CANNED bash judge (deterministic,
# no network), rejudge once (better run counts), seal, score. The leak sentinels in the
# scenario bodies and judge evidence must never reach the stage's stdout.
store_dir="$work/home/project/scenarios"
rm -rf "$store_dir" && mkdir -p "$store_dir" "$work/judge-rules"
ss_logs="$work/home/project/logs"

# write_ss FILE ID TITLE REQUIRED: a scenario file whose body carries the leak sentinel.
write_ss() {
  printf -- '---\nid: %s\ntitle: %s\nrequired: %s\n---\n## Steps\ndo the SENTINEL-SCENE-13 thing\n' "$2" "$3" "$4" >"$store_dir/$1"
}

# ss_cfg RUNCMD [JUDGECMD [JUDGE_SECS [RUN_SECS [SEALED]]]]: a project config whose scenarios
# block drives the stage. An empty JUDGECMD omits the judge key (default pi judge).
ss_cfg() {
  local js=${3:-5} rs=${4:-5} seal=${5:-0} judge_entry=""
  [ -n "${2:-}" ] && judge_entry=", \"judge\": \"$2\""
  cat >.devloop.json <<EOF
{
  "base_branch": "main",
  "fast_check": "test ! -e fast-fail",
  "checks": [{"name": "unit", "command": "./check.sh", "summary": "passed|failed"}],
  "heavy": {"slots": 2, "port_env": "SMOKE_PORT", "port_base": 9100, "port_step": 10, "poll_seconds": 1},
  "scenarios": {"run_seconds": $rs, "judge_seconds": $js, "pass": 0.8, "min_satisfaction": 0.9, "sealed": $seal, "run": "$1"$judge_entry}
}
EOF
}

# Canned judge: deterministic verdicts keyed by $work/judge-rules/<id>; counts its own
# invocations per id; records the env seams it received. Evidence carries the leak sentinel.
cat >"$work/judge.sh" <<EOF
#!/bin/sh
WORK=$work
id="\$MULTIPI_SCENARIO_ID"
cnt="\$WORK/judge-count-\$id"; n=\$(cat "\$cnt" 2>/dev/null || echo 0); n=\$((n + 1)); echo \$n >"\$cnt"
echo "\$id|\$MULTIPI_SCENARIO_TARGET|\$MULTIPI_SCENARIO_FILE" >"\$WORK/judge-seams-\$id"
rule=\$(cat "\$WORK/judge-rules/\$id" 2>/dev/null || echo pass)
case "\$rule" in
  rerun)   if [ "\$n" -ge 2 ]; then
             printf '{"id":"%s","satisfied":1.0,"required":true,"evidence":"second run ok SENTINEL-EVID-13","missing":""}\n' "\$id"
           else
             printf '{"id":"%s","satisfied":0.4,"required":true,"evidence":"SENTINEL-EVID-13","missing":"the alert stayed active"}\n' "\$id"
           fi ;;
  pass)    printf '{"id":"%s","satisfied":0.9,"required":true,"evidence":"SENTINEL-EVID-13 all fine","missing":""}\n' "\$id" ;;
  half)    printf '{"id":"%s","satisfied":0.8,"required":true,"evidence":"SENTINEL-EVID-13 marginal","missing":""}\n' "\$id" ;;
  full)    printf '{"id":"%s","satisfied":1.0,"required":true,"evidence":"SENTINEL-EVID-13 all fine","missing":""}\n' "\$id" ;;
  fail)    printf '{"id":"%s","satisfied":0.2,"required":true,"evidence":"SENTINEL-EVID-13","missing":"the alert stayed active"}\n' "\$id" ;;
  badjson) echo "the judge gave up, no verdict" ;;
  wrongid) printf '{"id":"some-other-scenario","satisfied":1.0,"required":true,"evidence":"e","missing":""}\n' ;;
  range)   printf '{"id":"%s","satisfied":1.5,"required":true,"evidence":"e","missing":""}\n' "\$id" ;;
  exit3)   echo "about to die" >&2; exit 3 ;;
esac
exit 0
EOF

# System-under-test stand-ins: cooperative and TERM-resistant sleepers, a silent and an
# immediate-exit run. The leader pid lands in a file so the "no sleeper survives" assertion
# can kill -0 the exact process.
cat >"$work/run-ok.sh" <<EOF
#!/bin/sh
echo "target-line-13"
echo \\$\$ >"$work/run-leader.pid"
exec sleep 30
EOF
cat >"$work/run-stubborn.sh" <<EOF
#!/bin/sh
echo "target-stubborn-13"
echo \\$\$ >"$work/run-leader.pid"
trap '' TERM
exec sleep 30
EOF
cat >"$work/run-silent.sh" <<EOF
#!/bin/sh
echo \\$\$ >"$work/run-leader.pid"
trap '' TERM
exec sleep 30
EOF
cat >"$work/run-exit.sh" <<EOF
#!/bin/sh
exit 9
EOF
# Contract-checking stand-in for the default judge's pi binary: verifies -p, the
# scenario-judge role flag and all three env seams, then emits one valid verdict.
cat >"$work/fakepi" <<'EOF'
#!/bin/sh
[ "$1" = "-p" ] || exit 7
prev=""; role=no
for a in "$@"; do
  [ "$prev" = "--append-system-prompt" ] && case "$a" in *scenario-judge.md) role=yes ;; esac
  prev="$a"
done
[ "$role" = "yes" ] || exit 8
[ -n "$MULTIPI_SCENARIO_ID" ] && [ -n "$MULTIPI_SCENARIO_FILE" ] && [ -n "$MULTIPI_SCENARIO_TARGET" ] || exit 9
printf '{"id":"%s","satisfied":0.95,"required":true,"evidence":"fake ok SENTINEL-EVID-13","missing":""}\n' "$MULTIPI_SCENARIO_ID"
exit 0
EOF
chmod +x "$work/fakepi" "$work/run-ok.sh" "$work/run-stubborn.sh" "$work/run-silent.sh" "$work/run-exit.sh"

stage() { bash "$plugin/scripts/scenario-stage.sh" 2>&1; }
reset_ss() { # fresh counters/seams/rules and store between cases
  rm -f "$work"/judge-count-* "$work"/judge-seams-* "$work"/judge-rules/* "$work/run-leader.pid" "$work/judge-cap.pid"
  rm -rf "$store_dir" && mkdir -p "$store_dir"
}

# Usage and config errors.
out=$(bash "$plugin/scripts/scenario-stage.sh" bogus 2>&1); rc=$?
expect "stage with an argument is a usage error" "2" "$rc"
echo "$out" | grep -q "usage: scenario-stage.sh" && pass "stage prints its usage" || fail "no stage usage message"
mv .devloop.json .devloop.json.ss-bak
out=$(stage); rc=$?
expect "stage without a config is a usage/config error" "2" "$rc"
mv .devloop.json.ss-bak .devloop.json

# Store off: skipped, exit 0, nothing started.
mkcfg ''
reset_ss
out=$(stage); rc=$?
expect "stage exits 0 when the store is off" "0" "$rc"
expect "store off prints the skipped line" "scenarios skipped" "$out"

# Store path exists as a REGULAR FILE: red at the named defect class (the symmetric stage
# pin for the doctor's file-store MISSING line) — exit 1, the exact red line, and the store
# path must not reach the stage's stdout (the no-leak rule).
reset_ss
ss_cfg "$work/run-ok.sh" "bash $work/judge.sh"
rm -rf "$store_dir" && printf 'not a dir\n' >"$store_dir"
out=$(stage); rc=$?
expect "a file store makes the stage red" "1" "$rc"
expect "the storeError red line is pinned" "scenarios red: cannot read the store (store path is not a directory (ENOTDIR))" "$out"
echo "$out" | grep -qF "$store_dir" &&
  fail "the store path leaked onto stage stdout for a file store" || pass "no store path on stage stdout for a file store"
rm -f "$store_dir"

# Green baseline: configured judge template (canned bash), TERM-resistant run proves the
# stage-end SIGKILL escalation, all seams and log files asserted, leak sentinels must not
# appear on the stage stdout.
reset_ss
ss_cfg "$work/run-stubborn.sh" "bash $work/judge.sh"
write_ss t1-a.md t1-a "Alpha works" true
write_ss t2-b.md t2-b "Beta works" false
echo pass >"$work/judge-rules/t1-a"; echo pass >"$work/judge-rules/t2-b"
out=$(stage); rc=$?
echo "$out"
expect "stage is green when all verdicts pass" "0" "$rc"
expect "green summary line is pinned" "scenarios green: mean 0.90 (2 judged, 0 unsatisfied)" "$out"
expect "the run's first line reaches the judges as MULTIPI_SCENARIO_TARGET" \
  "target-stubborn-13" "$(cut -d'|' -f2 "$work/judge-seams-t1-a")"
expect "the scenario file seam names the store file" \
  "$store_dir/t1-a.md" "$(cut -d'|' -f3 "$work/judge-seams-t1-a")"
grep -q "SENTINEL-EVID-13" "$ss_logs/train-scenario-judge/t1-a-1/transcript.log" &&
  pass "the configured judge template runs the canned script (transcript kept)" ||
  fail "no judge transcript from the canned judge"
expect "a passing scenario is judged exactly once" "1 1" \
  "$(cat "$work/judge-count-t1-a") $(cat "$work/judge-count-t2-b")"
[ -d "$ss_logs/train-scenario-judge/t1-a-1" ] && [ -f "$ss_logs/train-scenarios.log" ] &&
  [ -f "$ss_logs/train-scenario-results.jsonl" ] && [ -f "$ss_logs/train-scenarios-run.log" ] &&
  pass "all four stage logs exist in the logs dir" || fail "a stage log is missing"
grep -q "target-stubborn-13" "$ss_logs/train-scenarios-run.log" &&
  pass "the system output lands in train-scenarios-run.log" || fail "run log wrong"
grep -q '"scenario":"t1-a","run":1,"sealed":false' "$ss_logs/train-scenario-results.jsonl" &&
  grep '"scenario":"t1-a","run":1' "$ss_logs/train-scenario-results.jsonl" | grep -q '"valid":true' &&
  pass "results line carries scenario/run/sealed/valid/result" || fail "results line shape wrong"
leader=$(cat "$work/run-leader.pid" 2>/dev/null)
[ -n "$leader" ] && ! kill -0 "$leader" 2>/dev/null &&
  pass "no TERM-resistant sleeper survives stage end (kill -0 fails)" ||
  fail "the run's process group survived the stage"
printf '%s' "$out" | grep -q "SENTINEL-SCENE-13" &&
  fail "scenario text leaked onto stage stdout" || pass "no scenario text on stage stdout"
printf '%s' "$out" | grep -q "SENTINEL-EVID-13" &&
  fail "judge evidence leaked onto stage stdout" || pass "no judge evidence on stage stdout"
printf '%s' "$out" | grep -qF "$store_dir" &&
  fail "the store path leaked onto stage stdout" || pass "no store path on stage stdout"

# Rejudge-once: run 1 scores below pass, run 2 passes -> green, BETTER run counts, exactly
# two judge runs for that scenario, one for the already-passing one.
reset_ss
ss_cfg "$work/run-ok.sh" "bash $work/judge.sh"
write_ss t1-a.md t1-a "Alpha works" true
write_ss t2-b.md t2-b "Beta works" false
echo rerun >"$work/judge-rules/t1-a"; echo pass >"$work/judge-rules/t2-b"
out=$(stage); rc=$?
expect "rejudge once: better run counts -> green" "0" "$rc"
expect "the mean uses the better (second) run" "scenarios green: mean 0.95 (2 judged, 0 unsatisfied)" "$out"
expect "the below-pass scenario was judged exactly twice" "2" "$(cat "$work/judge-count-t1-a")"
expect "the passing scenario stayed at one judge run" "1" "$(cat "$work/judge-count-t2-b")"
[ "$(wc -l <"$ss_logs/train-scenario-results.jsonl" | tr -d ' ')" = 3 ] &&
  pass "results hold one line per judge run (2 + 1)" || fail "results line count wrong"
grep -q '"scenario":"t1-a","run":2' "$ss_logs/train-scenario-results.jsonl" &&
  pass "the second judge run is recorded" || fail "second run missing from results"

# The min_satisfaction floor as the DECIDING factor (not a co-factor of an unsatisfied
# scenario): every scenario at/above pass, mean below the floor -> red with ZERO
# per-scenario lines; the companion at mean exactly ON the floor -> green (inclusive),
# and its below-pass SCORED scenario is worded "below floor" so the green line cannot
# read contradictory.
reset_ss
ss_cfg "$work/run-ok.sh" "bash $work/judge.sh"
write_ss t1-a.md t1-a "Floor decider A" true
write_ss t2-b.md t2-b "Floor decider B" false
echo pass >"$work/judge-rules/t1-a"; echo half >"$work/judge-rules/t2-b"
out=$(stage); rc=$?
echo "$out"
expect "the min_satisfaction floor alone decides red (no scenario below pass)" "1" "$rc"
expect "the floor-red summary line is pinned" "scenarios red: mean 0.85 (2 judged, 0 unsatisfied)" \
  "$(printf '%s\n' "$out" | tail -1)"
[ "$(printf '%s\n' "$out" | grep -c '^scenario .* unsatisfied (')" = 0 ] &&
  pass "no per-scenario unsatisfied line (the floor, not a scenario, is red)" ||
  fail "an unsatisfied scenario line appeared although every scenario met pass"

reset_ss
ss_cfg "$work/run-ok.sh" "bash $work/judge.sh"
write_ss fl-00.md fl-00 "No verdict" false
echo badjson >"$work/judge-rules/fl-00"
for i in 01 02 03 04 05 06 07 08 09; do
  req=false; [ "$i" = 01 ] && req=true
  write_ss "fl-$i.md" "fl-$i" "Full $i" "$req"
  echo full >"$work/judge-rules/fl-$i"
done
out=$(stage); rc=$?
echo "$out"
expect "mean exactly on the floor is green (the comparison is inclusive)" "0" "$rc"
expect "the floor-green summary words a below-pass scored scenario 'below floor'" \
  "scenarios green: mean 0.90 (10 judged, 1 below floor)" "$(printf '%s\n' "$out" | tail -1)"

# Verdict failure handling: every bad shape scores 0 with its error in the results file,
# and each unsatisfied non-sealed scenario gets one red line.
reset_ss
ss_cfg "$work/run-ok.sh" "bash $work/judge.sh"
write_ss t1-a.md t1-a "Low score" true
write_ss t2-b.md t2-b "No JSON" false
write_ss t3-c.md t3-c "Wrong id" false
write_ss t4-d.md t4-d "Out of range" false
write_ss t5-e.md t5-e "Dies anyway" false
echo fail    >"$work/judge-rules/t1-a"
echo badjson >"$work/judge-rules/t2-b"
echo wrongid >"$work/judge-rules/t3-c"
echo range   >"$work/judge-rules/t4-d"
echo exit3   >"$work/judge-rules/t5-e"
out=$(stage); rc=$?
echo "$out"
expect "invalid and failing verdicts make the stage red" "1" "$rc"
expect "every unsatisfied scenario gets its own line" "5" \
  "$(printf '%s\n' "$out" | grep -c '^scenario .* unsatisfied (')"
printf '%s' "$out" | grep -qF "scenario t1-a unsatisfied (0.20, required): the alert stayed active" &&
  pass "low-score line carries score, tag and the missing text" || fail "low-score line wrong"
printf '%s' "$out" | grep -qF "scenario t2-b unsatisfied (0.00, scored): last line is not a JSON verdict" &&
  pass "non-JSON transcript is named with its parse error" || fail "non-JSON line wrong"
printf '%s' "$out" | grep -qF "scenario t4-d unsatisfied (0.00, scored): verdict satisfied out of range 0..1" &&
  pass "out-of-range score is rejected" || fail "range rejection missing"
grep '"scenario":"t3-c"' "$ss_logs/train-scenario-results.jsonl" | grep -q "id mismatch" &&
  pass "wrong-id verdict is rejected with its error" || fail "wrong-id not rejected"
grep '"scenario":"t5-e"' "$ss_logs/train-scenario-results.jsonl" | grep -q '"exitCode":3' &&
  pass "the non-zero judge exit is recorded" || fail "judge exit code not recorded"
grep '"scenario":"t5-e"' "$ss_logs/train-scenario-results.jsonl" | grep -q '"valid":false' &&
  pass "the dying judge's run is scored invalid" || fail "dying judge scored valid"
expect "red summary line is pinned" "scenarios red: mean 0.04 (5 judged, 5 unsatisfied)" \
  "$(printf '%s\n' "$out" | tail -1)"

# judge_seconds cap: a TERM-resistant judge is killed (kill -0 fails) and the run is red
# with the cap overrun recorded.
reset_ss
write_ss t1-a.md t1-a "Slow judge" true
echo pass >"$work/judge-rules/t1-a"
cat >"$work/judge-cap.sh" <<EOF
#!/bin/sh
echo \\$\$ >"$work/judge-cap.pid"
trap '' TERM
exec sleep 30
EOF
ss_cfg "$work/run-ok.sh" "bash $work/judge-cap.sh" 1
out=$(stage); rc=$?
expect "a judge cap overrun is red" "1" "$rc"
printf '%s' "$out" | grep -qF "scenario t1-a unsatisfied (0.00, required): judge_seconds cap (1s) exceeded" &&
  pass "the cap overrun is recorded as the scenario error" || fail "cap overrun not recorded"
cap_pid=$(cat "$work/judge-cap.pid" 2>/dev/null)
[ -n "$cap_pid" ] && ! kill -0 "$cap_pid" 2>/dev/null &&
  pass "no TERM-resistant judge survives the cap (kill -0 fails)" || fail "judge survived the cap"

# run failures: silence past run_seconds and exiting before printing are both red, and the
# run's group is stopped either way.
reset_ss
ss_cfg "$work/run-silent.sh" "bash $work/judge.sh" 5 1
write_ss t1-a.md t1-a "Never heard of it" true
out=$(stage); rc=$?
expect "a silent run is red" "1" "$rc"
expect "the silence reason is printed" \
  "scenarios red: system run failed (run silent for 1s past its first-line wait)" "$out"
sl_pid=$(cat "$work/run-leader.pid" 2>/dev/null)
[ -n "$sl_pid" ] && ! kill -0 "$sl_pid" 2>/dev/null &&
  pass "the silent run's sleeper was killed" || fail "silent run's group survived"

reset_ss
ss_cfg "$work/run-exit.sh" "bash $work/judge.sh"
write_ss t1-a.md t1-a "Dies on boot" true
out=$(stage); rc=$?
expect "a run that exits before printing is red" "1" "$rc"
expect "the early-exit reason is printed" \
  "scenarios red: system run failed (run exited before printing a target)" "$out"

# Invalid store files: red with the COUNT only — never a name, never the store path.
reset_ss
ss_cfg "$work/run-ok.sh" "bash $work/judge.sh"
write_ss t1-a.md t1-a "Valid one" true
printf -- '---\nid: t9-x\n' >"$store_dir/t9-x.md" # unclosed frontmatter
out=$(stage); rc=$?
expect "invalid store files are red" "1" "$rc"
expect "the invalid-file line carries the count, not names" \
  "scenarios red: 1 invalid scenario file(s)" "$out"
printf '%s' "$out" | grep -qF "t9-x" &&
  fail "an invalid file was named on stage stdout" || pass "invalid file not named"

# Sealed share 1.0: every scenario is sealed — judged and counted, never named.
reset_ss
ss_cfg "$work/run-ok.sh" "bash $work/judge.sh" 5 5 1.0
write_ss t1-a.md t1-a "Secret required" true
write_ss t2-b.md t2-b "Secret scored" false
echo fail >"$work/judge-rules/t1-a"; echo pass >"$work/judge-rules/t2-b"
out=$(stage); rc=$?
echo "$out"
expect "an unsatisfied sealed REQUIRED scenario is red" "1" "$rc"
printf '%s' "$out" | grep -qE 't1-a|t2-b' &&
  fail "a sealed scenario was named on stage stdout" || pass "sealed scenarios are never named"
expect "the sealed summary line is pinned" "scenarios sealed: 2 judged, 1 unsatisfied" \
  "$(printf '%s\n' "$out" | grep 'scenarios sealed')"
expect "the red summary counts sealed scenarios" "scenarios red: mean 0.55 (2 judged, 1 unsatisfied)" \
  "$(printf '%s\n' "$out" | tail -1)"

# Default judge: no judge key -> pi -p with the scenario-judge role, MULTIPI_PI_BIN honoured.
reset_ss
ss_cfg "$work/run-ok.sh" ""
write_ss t1-a.md t1-a "Fake-pi judged" true
echo pass >"$work/judge-rules/t1-a" # not read; fakepi ignores rules
out=$(MULTIPI_PI_BIN="$work/fakepi" bash "$plugin/scripts/scenario-stage.sh" 2>&1); rc=$?
expect "default judge runs pi -p (via MULTIPI_PI_BIN) with the scenario-judge role" "0" "$rc"
expect "the default judge's verdict scored green" "scenarios green: mean 0.95 (1 judged, 0 unsatisfied)" "$out"

# A store-on config without scenarios.run is a config error, not a red verdict.
mkcfg '"scenarios": {"judge": "bash '$work'/judge.sh"}'
reset_ss
out=$(stage); rc=$?
expect "a store without scenarios.run is a usage/config error" "2" "$rc"
echo "$out" | grep -q "scenarios.run is not configured" &&
  pass "the missing run command is named" || fail "missing-run message absent"
mkcfg '' # restore the base fixture config
rm -rf "$store_dir"

# --- cleanup-worktrees.sh (dark-factory spec §6/§7) --------------------------
# Consent semantics + fail-closed classification. WITHOUT --apply the script only
# lists removal candidates as DRYRUN and deletes nothing; WITH --apply it removes
# CLOSED worktrees (a PR is MERGED, or the branch's ticket is closed with no live
# PR) and STALE ones (no live PR, no open issue, last commit older than
# cleanup.stale_days). A branch NUMBER counts as a ticket only when that number
# is in the tracker's open+closed issue set — chore/2026-backup is a year, not
# ticket 2026, unless the tracker says otherwise, and is never ticket-protected.
# Every tracker query failure KEEPS the worktree ("cannot classify"); a failure
# is never read as "does not exist". Keep-invariants (gate/main kept, dirty kept,
# branch-still-on-remote kept, open issue kept) hold in both modes; the scenario
# store is owner data and survives.
mkcfg '"cleanup": {"stale_days": 2}'
cw() { bash "$plugin/scripts/cleanup-worktrees.sh" "$@" 2>&1; }
gt_dir="$work/home/project/worktrees/project/gate"
wt_base="$work/home/project/worktrees/project"

# Tracker fixtures: one closed ticket and three open ones. Deliberately NO issue
# 2026/2027/42 — those bare numbers must not count as tickets.
cl_n=$(gh issue create "closed ticket" "closed body" | sed -nE 's#.*/issues/([0-9]+)$#\1#p')
op_n=$(gh issue create "open ticket" "open body" | sed -nE 's#.*/issues/([0-9]+)$#\1#p')
op2_n=$(gh issue create "second open ticket" "open body 2" | sed -nE 's#.*/issues/([0-9]+)$#\1#p')
dt_n=$(gh issue create "dirty ticket" "dirty body" | sed -nE 's#.*/issues/([0-9]+)$#\1#p')
gh issue close "$cl_n" >/dev/null

# Candidates (all clean, branch off the remote): one CLOSED, three STALE (last
# commit years old via GIT_COMMITTER_DATE, far past the 2-day limit).
git worktree add -q "$wt_base/issue-$cl_n" -b "feat/$cl_n-closed" origin/main
git worktree add -q "$wt_base/issue-stale-old" -b feat/stale-old origin/main
GIT_COMMITTER_DATE="2020-01-05T00:00:00Z" \
  git -C "$wt_base/issue-stale-old" commit -q --allow-empty -m "chore: old commit"
# Numeric-looking branch whose number is ABSENT from the tracker: STALE.
git worktree add -q "$wt_base/issue-2026-backup" -b chore/2026-backup origin/main
GIT_COMMITTER_DATE="2020-01-05T00:00:00Z" \
  git -C "$wt_base/issue-2026-backup" commit -q --allow-empty -m "chore: old backup commit"
# Stale candidate whose WORKTREE PATH CONTAINS SPACES (porcelain parsing must be safe).
git worktree add -q "$wt_base/issue 42 spaced" -b feat/42-spaced-old origin/main
GIT_COMMITTER_DATE="2020-01-05T00:00:00Z" \
  git -C "$wt_base/issue 42 spaced" commit -q --allow-empty -m "chore: old spaced-path commit"
# Keep cases (all survive --apply):
git worktree add -q "$wt_base/issue-stale-young" -b feat/stale-young origin/main
GIT_COMMITTER_DATE="$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)" \
  git -C "$wt_base/issue-stale-young" commit -q --allow-empty -m "chore: young commit"
git worktree add -q "$wt_base/issue-2027-backup" -b chore/2027-backup origin/main
GIT_COMMITTER_DATE="$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)" \
  git -C "$wt_base/issue-2027-backup" commit -q --allow-empty -m "chore: young backup commit"
git worktree add -q "$wt_base/issue-$op_n" -b "feat/$op_n-open" origin/main
git worktree add -q "$wt_base/issue-$op2_n" -b "feat/$op2_n-open2" origin/main
git worktree add -q "$wt_base/issue-$dt_n" -b "feat/$dt_n-dirty" origin/main
echo scratch >"$wt_base/issue-$dt_n/scratch.txt"
git worktree add -q "$wt_base/issue-remote" -b feat/remote-kept origin/main
git push -q origin feat/remote-kept
# A merged PR whose issue is still OPEN (close lag): kept — "closed" means merged-and-CLOSED.
lag_n=$(gh issue create "merged but issue still open" "lag body" | sed -nE 's#.*/issues/([0-9]+)$#\1#p')
git worktree add -q "$wt_base/issue-$lag_n" -b "feat/$lag_n-merged" origin/main
gh pr create --head "feat/$lag_n-merged" --base main --title "feat: lag ($lag_n)" >/dev/null
echo MERGED >"$FAKE_GH_DIR/feat_${lag_n}-merged.state"
# A MERGED PR with no live issue is CLOSED immediately: FRESH last commit, which
# would keep the worktree "too young" if the merged arm were routed through the
# age gate (round-2 must-fix: gh pr list defaults to open without --state all).
git worktree add -q "$wt_base/issue-merged-now" -b feat/merged-now origin/main
gh pr create --head feat/merged-now --base main --title "feat: merged now" >/dev/null
echo MERGED >"$FAKE_GH_DIR/feat_merged-now.state"
# An OPEN PR keeps its worktree (the keep arm the reviewer found unpinned):
# branch numberless, so protection comes from the PR alone.
git worktree add -q "$wt_base/issue-pr-open" -b feat/pr-open-kept origin/main
gh pr create --head feat/pr-open-kept --base main --title "feat: open PR keeps its worktree" >/dev/null

# The tracker feed is ONE compact array line (real-CLI shape), and every open
# ticket in it protects its worktree. Four tickets are open right now.
raw_list=$(gh issue list --state open --json number)
expect "fake gh issue list is one compact line (real-CLI shape)" \
  "1" "$(printf '%s\n' "$raw_list" | wc -l | tr -d ' ')"
[ "${raw_list:0:1}" = "[" ] && [ "${raw_list: -1}" = "]" ] &&
  pass "the issue list is a single JSON array" || fail "the issue list is not one JSON array"
expect "the compact line carries all four open numbers" \
  "4" "$(printf '%s' "$raw_list" | grep -oE '"number"[[:space:]]*:[[:space:]]*[0-9]+' | wc -l | tr -d ' ')"

# DRYRUN mode: candidates listed, nothing deleted.
out=$(cw); rc=$?
echo "$out"
expect "cleanup without --apply exits 0" "0" "$rc"
printf '%s\n' "$out" | grep -q "^DRYRUN $wt_base/issue-$cl_n  (closed: no live PR" &&
  pass "the closed worktree is listed as DRYRUN with a closed reason" ||
  fail "no closed DRYRUN line (want: DRYRUN $wt_base/issue-$cl_n  (closed: no live PR))"
printf '%s\n' "$out" | grep -q "^DRYRUN $wt_base/issue-stale-old  (stale: " &&
  pass "the stale worktree is listed as DRYRUN with a stale reason" ||
  fail "no stale DRYRUN line"
printf '%s\n' "$out" | grep -q "^DRYRUN $wt_base/issue-2026-backup  (stale: " &&
  pass "chore/2026-backup with no tracker ticket 2026 is STALE, never ticket-protected" ||
  fail "the untracked number 2026 was treated as a ticket or dodged the age gate"
printf '%s\n' "$out" | grep -qF "DRYRUN $wt_base/issue 42 spaced  (stale:" &&
  pass "the spaced-path candidate is classified and listed" ||
  fail "the spaced-path worktree was not listed (porcelain parsing lost it)"
[ "$(printf '%s\n' "$out" | grep -c '^REMOVED')" = 0 ] &&
  pass "the dry run removes nothing" || fail "the dry run removed something"
[ "$(printf '%s\n' "$out" | grep -c '^DRYRUN')" = 5 ] &&
  pass "exactly the five candidates are listed" || fail "dry-run candidate count wrong"
printf '%s\n' "$out" | grep -qF "DRYRUN $wt_base/issue-merged-now  (closed: merged-and-closed)" &&
  pass "a merged-PR worktree with no live issue is a CLOSED candidate despite a fresh commit" ||
  fail "the merged-PR candidate was not closed immediately (routed through the age gate?)"
printf '%s\n' "$out" | grep -q "^KEPT  $gt_dir  (gate worktree)" &&
  pass "the gate worktree is kept" || fail "the gate worktree was not kept"
[ -n "$(printf '%s\n' "$out" | grep "^KEPT  $wt_base/issue-stale-young")" ] &&
  pass "a too-young worktree is kept (idle < stale_days)" || fail "the young worktree was not kept"
[ -n "$(printf '%s\n' "$out" | grep "^KEPT  $wt_base/issue-2027-backup")" ] &&
  pass "a too-young untracked-number worktree is kept (age-gated)" ||
  fail "the young untracked-number worktree was not kept"
printf '%s\n' "$out" | grep -q "^KEPT  $wt_base/issue-$op_n  (open issue #$op_n)" &&
  pass "a worktree whose branch has an open issue is kept" || fail "the open-issue worktree was not kept"
printf '%s\n' "$out" | grep -q "^KEPT  $wt_base/issue-$op2_n  (open issue #$op2_n)" &&
  pass "every open ticket in the compact list protects its worktree" ||
  fail "a second open ticket did not protect its worktree"
printf '%s\n' "$out" | grep -q "^KEPT  $wt_base/issue-$dt_n  (dirty" &&
  pass "a dirty worktree is kept" || fail "the dirty worktree was not kept"
printf '%s\n' "$out" | grep -q "^KEPT  $wt_base/issue-remote  (branch feat/remote-kept still on origin)" &&
  pass "a worktree whose branch is still on the remote is kept" || fail "the remote-branch worktree was not kept"
printf '%s\n' "$out" | grep -q "^KEPT  $wt_base/issue-$lag_n  (open issue #$lag_n)" &&
  pass "a merged-PR worktree with a still-open issue is kept (merged-and-closed only)" ||
  fail "the merged-but-open worktree was not kept"
printf '%s\n' "$out" | grep -q "^KEPT  $wt_base/issue-pr-open  (open PR for feat/pr-open-kept)" &&
  pass "a worktree with an open PR is kept" || fail "the open-PR worktree was not kept"
printf '%s' "$out" | grep -qF " $work/project" &&
  fail "the main worktree was listed" || pass "the main worktree is never listed"
[ -d "$wt_base/issue-$cl_n" ] && [ -d "$wt_base/issue-stale-old" ] &&
  [ -d "$wt_base/issue-2026-backup" ] && [ -d "$wt_base/issue 42 spaced" ] &&
  [ -d "$wt_base/issue-merged-now" ] && [ -d "$wt_base/issue-pr-open" ] &&
  pass "the dry run leaves the candidate worktrees in place" || fail "the dry run touched a candidate"
expect "the dry-run summary counts removed/dry-run/kept" \
  "cleanup: 0 removed, 5 dry-run, 9 kept" "$(printf '%s\n' "$out" | tail -1)"

# Fail-closed (review must-fix 1a): a FAILED issue-list fetch is read as
# "cannot classify", never as "the ticket does not exist" — no candidates arise.
export FAKE_GH_FAIL_ISSUE_LIST=1
out=$(cw)
echo "$out"
unset FAKE_GH_FAIL_ISSUE_LIST
[ "$(printf '%s\n' "$out" | grep -c '^DRYRUN')" = 0 ] &&
  [ "$(printf '%s\n' "$out" | grep -c '^REMOVED')" = 0 ] &&
  pass "an issue-list failure produces no removal candidates" ||
  fail "an issue-list failure produced candidates (fail-open!)"
printf '%s\n' "$out" | grep -qF "KEPT  $wt_base/issue-stale-old  (tracker unreachable — cannot classify)" &&
  pass "under an issue-list failure the stale candidate is KEPT (cannot classify)" ||
  fail "the stale candidate was not kept as unclassifiable"
printf '%s\n' "$out" | grep -qF "KEPT  $wt_base/issue-2026-backup  (tracker unreachable — cannot classify)" &&
  pass "under an issue-list failure the untracked-number candidate is KEPT" ||
  fail "the untracked-number candidate was not kept as unclassifiable"
printf '%s\n' "$out" | grep -qF "WARN  tracker fetch failed (issue list --state open): fake gh: simulated transient failure (issue list)" &&
  pass "a tracker fetch failure warns on one line carrying gh's stderr (diagnostics for the dark cycle)" ||
  fail "no one-line WARN carried gh's stderr on the tracker fetch failure"
expect "the issue-list-failure summary lists nothing for removal" \
  "cleanup: 0 removed, 0 dry-run, 14 kept" "$(printf '%s\n' "$out" | tail -1)"

# Fail-closed (review must-fix 1b): a FAILED pr query is not read as "no PR".
export FAKE_GH_FAIL_PR_LIST=1
out=$(cw)
unset FAKE_GH_FAIL_PR_LIST
[ "$(printf '%s\n' "$out" | grep -c '^DRYRUN')" = 0 ] &&
  [ "$(printf '%s\n' "$out" | grep -c '^REMOVED')" = 0 ] &&
  pass "a pr-query failure produces no removal candidates" ||
  fail "a pr-query failure produced candidates (fail-open!)"
printf '%s\n' "$out" | grep -qF "KEPT  $wt_base/issue-$cl_n  (pr query failed — cannot classify)" &&
  pass "under a pr-query failure the closed-ticket candidate is KEPT (cannot classify)" ||
  fail "the closed-ticket candidate was not kept as unclassifiable"
# Diagnostics (symmetric with the issue-list fetch WARN): every per-branch pr-query
# failure gets its own one-line WARN carrying gh's stderr — 8 worktrees reach the pr
# query in this fixture (open-issue/dirty/on-remote keeps all happen before it; the
# open-PR keep happens ON the pr query, so its worktree reaches it too).
[ "$(printf '%s\n' "$out" | grep -c '^WARN  pr query failed')" = 8 ] &&
  pass "every per-branch pr-query failure warns on its own line" ||
  fail "the pr-query failure WARN count is wrong (diagnostics lost?)"
printf '%s\n' "$out" | grep -qF "WARN  pr query failed (feat/stale-old): fake gh: simulated transient failure (pr list)" &&
  pass "the pr-query WARN carries gh's stderr" ||
  fail "the pr-query WARN is missing gh's stderr"
expect "the pr-query-failure summary lists nothing for removal" \
  "cleanup: 0 removed, 0 dry-run, 14 kept" "$(printf '%s\n' "$out" | tail -1)"

# Fail-closed (review round-3 must-fix): a FAILED local age probe is
# unclassifiable, NEVER "ancient" — a negative signal must not drive deletion,
# the same rule as the tracker. A git shim makes `log -1 --format=%ct` fail.
logshim_dir="$work/git-log-shim"
logshim_real=$(command -v git)
mkdir -p "$logshim_dir"
cat >"$logshim_dir/git" <<EOF
#!/usr/bin/env bash
# Fail ONLY the age probe (git [-C <wt>] log ...); every other invocation
# passes through to the real git with its arguments untouched.
args=("\$@")
subcmd="\${args[0]:-}"
[ "\$subcmd" = "-C" ] && subcmd="\${args[2]:-}"
if [ "\$subcmd" = "log" ]; then
  echo "fatal: simulated unreadable history (log)" >&2
  exit 1
fi
exec "$logshim_real" "\$@"
EOF
chmod +x "$logshim_dir/git"
out=$(PATH="$logshim_dir:$PATH" cw)
echo "$out"
[ "$(printf '%s\n' "$out" | grep -c '^REMOVED')" = 0 ] &&
  [ "$(printf '%s\n' "$out" | grep -c '^DRYRUN')" = 2 ] &&
  pass "a failing age probe demotes exactly the age-gated candidates (closed classifications stay positive)" ||
  fail "the failing age probe leaked beyond the candidates whose age it could not read"
printf '%s\n' "$out" | grep -qF "KEPT  $wt_base/issue-stale-old  (commit age unreadable — cannot classify)" &&
  pass "under a failing age probe the stale candidate is KEPT (cannot classify)" ||
  fail "the stale candidate was not kept as unclassifiable under a failing age probe"
printf '%s\n' "$out" | grep -qF "KEPT  $wt_base/issue-2026-backup  (commit age unreadable — cannot classify)" &&
  pass "under a failing age probe the untracked-number candidate is KEPT" ||
  fail "the untracked-number candidate was not kept as unclassifiable under a failing age probe"
printf '%s\n' "$out" | grep -qF "KEPT  $wt_base/issue 42 spaced  (commit age unreadable — cannot classify)" &&
  pass "under a failing age probe the spaced-path candidate is KEPT" ||
  fail "the spaced-path candidate was not kept as unclassifiable under a failing age probe"
[ -n "$(printf '%s\n' "$out" | grep "^KEPT  $wt_base/issue-stale-young")" ] &&
  printf '%s\n' "$out" | grep "^KEPT  $wt_base/issue-stale-young" | grep -qF "commit age unreadable — cannot classify" &&
  pass "even the too-young worktree cannot prove its age, so it is kept (a negative signal never deletes)" ||
  fail "the young worktree was not kept as unclassifiable under a failing age probe"
printf '%s\n' "$out" | grep -qF "DRYRUN $wt_base/issue-$cl_n  (closed: no live PR" &&
  pass "a failing age probe does not demote the closed-ticket classification (the failure stays local)" ||
  fail "the failing age probe demoted an unrelated positive classification"
expect "the failing-age-probe summary lists nothing for removal" \
  "cleanup: 0 removed, 2 dry-run, 12 kept" "$(printf '%s\n' "$out" | tail -1)"

# A FAILED `git status --porcelain` probe is unclassifiable, NEVER "clean" (reading
# empty-on-failure as clean would let a negative signal drive deletion). A git shim
# makes status fail.
statshim_dir="$work/git-status-shim"
statshim_real=$(command -v git)
mkdir -p "$statshim_dir"
cat >"$statshim_dir/git" <<EOF
#!/usr/bin/env bash
args=("\$@")
subcmd="\${args[0]:-}"
[ "\$subcmd" = "-C" ] && subcmd="\${args[2]:-}"
if [ "\$subcmd" = "status" ]; then
  echo "fatal: simulated status probe failure" >&2
  exit 1
fi
exec "$statshim_real" "\$@"
EOF
chmod +x "$statshim_dir/git"
out=$(PATH="$statshim_dir:$PATH" cw)
echo "$out"
[ "$(printf '%s\n' "$out" | grep -c '^DRYRUN')" = 0 ] &&
  [ "$(printf '%s\n' "$out" | grep -c '^REMOVED')" = 0 ] &&
  pass "a failing status probe produces no removal candidates" ||
  fail "a failing status probe produced candidates (fail-open!)"
printf '%s\n' "$out" | grep -qF "KEPT  $wt_base/issue-stale-old  (status probe failed — cannot classify)" &&
  pass "under a failing status probe the candidate is KEPT (cannot classify)" ||
  fail "the failing status probe was not read as unclassifiable"
printf '%s\n' "$out" | grep -qF "KEPT  $wt_base/issue-$dt_n  (status probe failed — cannot classify)" &&
  pass "even the dirty worktree reads unclassifiable when its status probe fails" ||
  fail "the dirty worktree was not kept as unclassifiable under a failing status probe"
printf '%s' "$out" | grep -q "dirty — uncommitted work" &&
  fail "a failing status probe was read as dirty (or clean)" ||
  pass "a failing status probe is neither clean nor dirty"
expect "the status-probe-failure summary lists nothing for removal" \
  "cleanup: 0 removed, 0 dry-run, 14 kept" "$(printf '%s\n' "$out" | tail -1)"

# The scenario store is owner data: populate it, then --apply must leave every file.
mkdir -p "$store_dir"
write_scen c1-delta.md c1-delta "Delta works" true
write_scen c2-omega.md c2-omega "Omega works" false
store_count_before=$(find "$store_dir" -mindepth 1 -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')

# --apply mode: removes exactly the five candidates, keeps everything else.
out=$(cw --apply); rc=$?
echo "$out"
expect "cleanup --apply exits 0" "0" "$rc"
[ "$(printf '%s\n' "$out" | grep -c '^REMOVED')" = 5 ] &&
  pass "exactly the five candidates are removed" || fail "--apply removed the wrong set"
ok=1
for cand in "issue-$cl_n" "issue-stale-old" "issue-2026-backup" "issue 42 spaced" "issue-merged-now"; do
  printf '%s\n' "$out" | grep -qF "REMOVED $wt_base/$cand" || ok=0
done
[ "$ok" = 1 ] && pass "each candidate worktree got a REMOVED line" || fail "a candidate worktree has no REMOVED line"
printf '%s\n' "$out" | grep -qF "REMOVED $wt_base/issue-merged-now  (closed: merged-and-closed; branch feat/merged-now)" &&
  pass "the merged-PR worktree is removed as closed, not as stale" ||
  fail "the merged-PR worktree was not removed with the closed reason"
printf '%s\n' "$out" | grep -qF "REMOVED $wt_base/issue-$cl_n  (closed: no live PR; branch feat/$cl_n-closed)" &&
  pass "the closed-ticket worktree's reason names the no-live-PR logic" ||
  fail "the closed-ticket REMOVED line does not say no live PR"
[ -z "$(git branch --list "feat/$cl_n-closed" feat/stale-old chore/2026-backup feat/42-spaced-old feat/merged-now)" ] &&
  pass "the removed branches are deleted locally" || fail "a removed branch remains"
[ ! -d "$wt_base/issue-$cl_n" ] && [ ! -d "$wt_base/issue-stale-old" ] &&
  [ ! -d "$wt_base/issue-2026-backup" ] && [ ! -d "$wt_base/issue 42 spaced" ] &&
  [ ! -d "$wt_base/issue-merged-now" ] &&
  pass "the removed worktrees are gone from disk" || fail "a removed worktree dir remains"
[ -d "$wt_base/issue-$op_n" ] && [ -d "$wt_base/issue-$op2_n" ] && [ -d "$wt_base/issue-$dt_n" ] &&
  [ -d "$wt_base/issue-stale-young" ] && [ -d "$wt_base/issue-2027-backup" ] &&
  [ -d "$wt_base/issue-remote" ] && [ -d "$wt_base/issue-$lag_n" ] && [ -d "$wt_base/issue-pr-open" ] && [ -d "$gt_dir" ] &&
  pass "the kept worktrees survive --apply" || fail "--apply removed a kept worktree"
store_count_after=$(find "$store_dir" -mindepth 1 -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
[ "$store_count_before" = "$store_count_after" ] && [ -f "$store_dir/c1-delta.md" ] &&
  [ -f "$store_dir/c2-omega.md" ] &&
  pass "every scenario store file survives --apply" || fail "the scenario store was damaged"
expect "the applied summary counts removed/dry-run/kept" \
  "cleanup: 5 removed, 0 dry-run, 9 kept" "$(printf '%s\n' "$out" | tail -1)"

# Idempotent: a second --apply finds nothing to do.
out=$(cw --apply)
expect "a second --apply changes nothing (idempotent)" "cleanup: 0 removed, 0 dry-run, 9 kept" \
  "$(printf '%s\n' "$out" | tail -1)"

# Failed local branch delete (review folded 4): the worktree goes, and the
# SURVIVING BRANCH is reported — never swallowed.
real_git=$(command -v git)
shim_dir="$work/git-shim"
mkdir -p "$shim_dir"
cat >"$shim_dir/git" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "branch" ] && [ "\${2:-}" = "-q" ] && [ "\${3:-}" = "-D" ]; then
  echo "fatal: simulated local branch delete failure" >&2
  exit 1
fi
exec "$real_git" "\$@"
EOF
chmod +x "$shim_dir/git"
git worktree add -q "$wt_base/issue-branchdel" -b feat/branchdel-old origin/main
GIT_COMMITTER_DATE="2020-01-05T00:00:00Z" \
  git -C "$wt_base/issue-branchdel" commit -q --allow-empty -m "chore: old commit"
out=$(PATH="$shim_dir:$PATH" cw --apply)
echo "$out"
printf '%s\n' "$out" | grep -qF "REMOVED $wt_base/issue-branchdel" &&
  pass "the stale worktree is still removed when the branch delete fails" ||
  fail "the worktree was not removed under the branch-delete failure"
printf '%s\n' "$out" | grep -qF "WARN  feat/branchdel-old: local branch delete FAILED" &&
  pass "the surviving branch is reported, not swallowed" ||
  fail "no WARN line for the surviving branch"
[ ! -d "$wt_base/issue-branchdel" ] &&
  pass "the worktree dir is gone despite the branch-delete failure" ||
  fail "the worktree dir remains"
[ -n "$(git branch --list feat/branchdel-old)" ] &&
  pass "the undeletable branch really survives" || fail "the branch vanished anyway"
expect "the branch-delete-failure summary" \
  "cleanup: 1 removed, 0 dry-run, 9 kept" "$(printf '%s\n' "$out" | tail -1)"
git branch -q -D feat/branchdel-old  # tidy the simulated survivor

# Abandoned-PR corner (review round-3 folded 3, pinned): a branch whose only PR
# is CLOSED (unmerged) has NO LIVE PR — it is not ticket-protected; after the
# idle window it is a plain STALE candidate (rationale: docs/DECISIONS.md).
git worktree add -q "$wt_base/issue-abandoned" -b feat/abandoned-old origin/main
GIT_COMMITTER_DATE="2020-01-05T00:00:00Z" \
  git -C "$wt_base/issue-abandoned" commit -q --allow-empty -m "chore: abandoned commit"
gh pr create --head feat/abandoned-old --base main --title "feat: abandoned" >/dev/null
echo CLOSED >"$FAKE_GH_DIR/feat_abandoned-old.state"
out=$(cw)
printf '%s\n' "$out" | grep -qE "DRYRUN $wt_base/issue-abandoned  \(stale: last commit [0-9]+d old \(> 2d limit\)\)" &&
  pass "a closed-unmerged PR does not protect: the branch falls into the STALE age gate" ||
  fail "the abandoned-PR branch was not classified as a stale candidate (protected by a dead PR?)"
expect "the abandoned-PR summary (only the new candidate)" \
  "cleanup: 0 removed, 1 dry-run, 9 kept" "$(printf '%s\n' "$out" | tail -1)"
out=$(cw --apply)
printf '%s\n' "$out" | grep -qF "REMOVED $wt_base/issue-abandoned  (stale:" &&
  pass "--apply removes the idle abandoned-PR branch as stale" ||
  fail "the idle abandoned-PR branch was not removed as stale"
[ ! -d "$wt_base/issue-abandoned" ] && [ -z "$(git branch --list feat/abandoned-old)" ] &&
  pass "the abandoned-PR worktree and its branch are gone" ||
  fail "the abandoned-PR worktree or branch remains"
expect "the abandoned-PR applied summary" "cleanup: 1 removed, 0 dry-run, 9 kept" \
  "$(printf '%s\n' "$out" | tail -1)"

# Default stale_days=14, config-FREE (review round-3 folded 2): with NO cleanup
# key at all the age gate must run at the 14-day default, not the 2-day override.
mkcfg ''
git worktree add -q "$wt_base/issue-default-3d" -b feat/default-3d origin/main
GIT_COMMITTER_DATE="$(date -u -d '3 days ago' +%Y-%m-%dT%H:%M:%SZ)" \
  git -C "$wt_base/issue-default-3d" commit -q --allow-empty -m "chore: three days old"
git worktree add -q "$wt_base/issue-default-30d" -b feat/default-30d origin/main
GIT_COMMITTER_DATE="2020-01-05T00:00:00Z" \
  git -C "$wt_base/issue-default-30d" commit -q --allow-empty -m "chore: thirty-plus days old"
out=$(cw)
printf '%s\n' "$out" | grep -qF "KEPT  $wt_base/issue-default-3d  (idle 3d within 14d — too young to be stale)" &&
  pass "without a config the age gate defaults to 14d: a 3-day-old branch is kept" ||
  fail "the age gate did not default to 14 days (a 3-day-old branch was stale-removable)"
printf '%s\n' "$out" | grep -qE "DRYRUN $wt_base/issue-default-30d  \(stale: last commit [0-9]+d old \(> 14d limit\)\)" &&
  pass "without a config the 14d default still bites: an ancient branch is a stale candidate" ||
  fail "an ancient branch was not stale-classified under the 14d default"
expect "the default-stale-days summary" "cleanup: 0 removed, 1 dry-run, 10 kept" \
  "$(printf '%s\n' "$out" | tail -1)"
git worktree remove -q "$wt_base/issue-default-3d"; git branch -q -D feat/default-3d
git worktree remove -q "$wt_base/issue-default-30d"; git branch -q -D feat/default-30d

# Operator errors: an unknown flag is a usage error.
cw --bogus >/dev/null 2>&1
expect "an unknown flag is a usage error" "2" "$?"

# Absorbed #32 should-fix: the tracker's gh-error temp file must not outlive the run.
# Scoping TMPDIR lands every mktemp of the script in an auditable dir (the normal
# path deletes it; an EXIT trap owns it against a mid-run death).
trap_line="trap 'rm -f \"\$gh_err_file\"' EXIT"
grep -qF "$trap_line" "$plugin/scripts/cleanup-worktrees.sh" &&
  pass "an EXIT trap owns the gh-error temp file (a mid-run death cannot leak it)" ||
  fail "no EXIT trap for the gh-error temp file in cleanup-worktrees.sh"
rm -rf "$work/ctmp" && mkdir -p "$work/ctmp"
out=$(TMPDIR="$work/ctmp" cw)
[ -z "$(ls -A "$work/ctmp" 2>/dev/null)" ] &&
  pass "the tracker temp file leaves no TMPDIR litter after a clean run" ||
  fail "the tracker temp file leaked into TMPDIR: $(ls -A "$work/ctmp" | tr '\n' ' ')"

# The per-cycle step is pinned in the devloop skill (both copies, in sync).
grep -q 'cleanup-worktrees.sh --apply' "$plugin/skills/devloop/SKILL.md" &&
  grep -qF '"dark"' "$plugin/skills/devloop/SKILL.md" &&
  pass "skills/devloop/SKILL.md pins the dark per-cycle cleanup step" ||
  fail "the source skill is missing the dark per-cycle cleanup step"
grep -q 'cleanup-worktrees.sh --apply' "$plugin/.pi/skills/devloop/SKILL.md" &&
  pass ".pi/skills/devloop/SKILL.md carries the dark per-cycle cleanup step" ||
  fail "the .pi skill copy is missing the dark per-cycle cleanup step"
diff -q "$plugin/skills/devloop/SKILL.md" "$plugin/.pi/skills/devloop/SKILL.md" >/dev/null &&
  pass "the skill copies stay in sync" || fail "the skill copies diverged"

# --- AGENTS.md + SKILL.md: the dark-factory documentation (ticket #16) ----------
# The documented seams, config keys, the guard's honest limits and the runbook are
# rg-asserted here: prose that decays silently is how loops lose their contracts.
agents_md="$plugin/AGENTS.md"
for seam in MULTIPI_CHILD_ROLE MULTIPI_SCENARIO_FILE MULTIPI_SCENARIO_ID MULTIPI_SCENARIO_TARGET MULTIPI_LIST_LAG_RETRY_MS; do
  grep -qF "$seam" "$agents_md" && pass "AGENTS.md names the $seam env seam" ||
    fail "AGENTS.md is missing the $seam env seam"
done
for key in '"factory"' '"scenarios"' 'cleanup.stale_days'; do
  grep -qF "$key" "$agents_md" && pass "AGENTS.md names the $key config key" ||
    fail "AGENTS.md is missing the $key config key"
done
grep -qEi "scripts? the agent writes" "$agents_md" &&
  pass "AGENTS.md names the agent-written-script guard limit" ||
  fail "AGENTS.md does not name the agent-written-script guard limit"
grep -qEi "assembled at run time" "$agents_md" &&
  pass "AGENTS.md names the runtime-assembled-path guard limit" ||
  fail "AGENTS.md does not name the runtime-assembled-path guard limit"
grep -qEi "recursive (search|walk) of an ancestor" "$agents_md" &&
  pass "AGENTS.md names the ancestor-recursion guard limit" ||
  fail "AGENTS.md does not name the ancestor-recursion guard limit"
grep -qF "OS user" "$agents_md" && grep -qF "not v1" "$agents_md" &&
  pass "AGENTS.md names the strong-isolation escalation (OS user, not v1)" ||
  fail "AGENTS.md does not document the strong-isolation escalation"
skill_md="$plugin/skills/devloop/SKILL.md"
grep -qi "going dark" "$skill_md" &&
  pass "the skill carries the going-dark runbook" || fail "the skill has no going-dark runbook"
grep -qiF "record the switch in docs/DECISIONS.md" "$skill_md" &&
  pass "the runbook records the switch in DECISIONS.md" ||
  fail "the runbook does not record the switch in DECISIONS.md"
grep -qiF "scenario-writer" "$skill_md" &&
  pass "the runbook dispatches the scenario-writer for the open tickets" ||
  fail "the runbook does not dispatch the scenario-writer"
grep -qiF "ordinary pipeline" "$skill_md" &&
  pass "the runbook merges through the ordinary pipeline" ||
  fail "the runbook does not say the switch merges through the ordinary pipeline"
grep -qiE "never ask[s]? the human to read a diff" "$skill_md" &&
  pass "the dark-mode rule: the orchestrator never asks the human to read a diff" ||
  fail "the dark-mode diff rule is missing"
for surface in "scenario title" "gate outcome" "verifier report" "dl/blocked"; do
  grep -qiF "$surface" "$skill_md" && pass "the dark review surface is named: $surface" ||
    fail "the dark review surface is missing: $surface"
done
for leak in train-scenario-results.jsonl train-scenario-judge train-scenarios-run.log; do
  grep -qF "$leak" "$skill_md" && pass "the log-hygiene rule names $leak" ||
    fail "the log-hygiene rule does not name $leak"
done
grep -qi "never forwarded to an implementer" "$skill_md" &&
  pass "the log-hygiene rule forbids forwarding stage logs to coding roles" ||
  fail "the log-hygiene never-forward rule is missing"
grep -qi "only the \`missing\`" "$skill_md" &&
  pass "the log-hygiene rule: only the missing text travels" ||
  fail "the log-hygiene rule does not say only the missing text travels"

mkcfg '' # restore the base fixture config
rm -rf "$store_dir"

# --- permission policy P2: the orchestrator's tool_call tripwire (node probes, offline) ----
# Seeded sibling policy in the operator's dialect: one deny, one ask, one allow, and the
# literal-`~` token-dir deny convention the hook layer must honour WITHOUT pre-expanding:
# the hook passes paths LITERALLY, so an expanded path skips the deny (ticket #40 addendum,
# spec §9 — the documented tripwire-only limit, pinned HERE in both directions).
cat >permissions.json <<'EOF'
{
  "permissions": {
    "deny": ["Bash(sudo:*)", "Read(~/.multipi/*/dev-loop-tokens/**)"],
    "ask":  ["Bash(gh pr merge:*)"],
    "allow": ["Bash(git status:*)"]
  }
}
EOF
export AUDIT_LOG="$work/home/project/logs/policy-audit.jsonl"
multipi_policy_probe() { # args: none; prints key=value lines (the asserts below pin them)
  MULTIPI_PLUGIN_DIR="$plugin" env -u MULTIPI_CHILD node --input-type=module -e '
const fs = await import("node:fs");
const pi = { tools: [], handlers: {}, commands: [], registerTool(t) { this.tools.push(t.name); }, registerCommand(n) { this.commands.push(n); }, on(ev, h) { (this.handlers[ev] ??= []).push(h); } };
const mod = await import(process.env.MULTIPI_PLUGIN_DIR + "/extension/index.ts");
mod.default(pi);
const ctx = { cwd: process.cwd(), hasUI: false, mode: "rpc", sessionManager: { getSessionId: () => "smoke-sess" } };
for (const h of pi.handlers.session_start ?? []) await h({}, ctx);
const call = async (toolName, input) => { const out = []; for (const h of pi.handlers.tool_call ?? []) out.push(await h({ toolName, input }, ctx)); return out; };
const denied = (await call("bash", { command: "sudo reboot" })).find((r) => r?.block);
console.log("deny=" + (denied?.block ? "yes" : "no"));
console.log("denyreason=" + (denied?.reason ?? ""));
const asked = (await call("bash", { command: "gh pr merge 12" })).find((r) => r?.block);
console.log("askreason=" + (asked?.reason ?? ""));
const tok = (await call("read", { path: "~/.multipi/project/dev-loop-tokens/a.tok" })).find((r) => r?.block);
console.log("tokdeny=" + (tok ? "yes" : "no"));
const tokexp = (await call("read", { path: process.env.TOK_EXP_PATH })).find((r) => r?.block);
console.log("tokexpanded=" + (tokexp ? "blocked" : "passed"));
const blockedAllow = (await call("bash", { command: "git status" })).some((r) => r?.block);
console.log("allowpass=" + (blockedAllow ? "no" : "yes"));
const lines = fs.existsSync(process.env.AUDIT_LOG) ? fs.readFileSync(process.env.AUDIT_LOG, "utf8").trim().split("\n").map(JSON.parse) : [];
console.log("auditlines=" + lines.length);
console.log("sessionhash=" + (lines[0]?.event === "policy_session_start" && typeof lines[0]?.policyHash === "string" ? "yes" : "no"));
console.log("fields=" + (lines.slice(1).every((l) => ["ts","session","actor","ruleId","verdict","actionSummary","layer"].every((k) => k in l) && l.layer === "hook") ? "yes" : "no"));
const hasTokenDir = lines.some((l) => String(l.actionSummary).includes("<token-dir>"));
const leaksTokenDir = lines.some((l) => String(l.actionSummary).includes("dev-loop-tokens/"));
console.log("redacted=" + (hasTokenDir && !leaksTokenDir ? "yes" : "no"));
console.log("tokrule=" + (lines.find((l) => l.ruleId === "Read(~/.multipi/*/dev-loop-tokens/**)")?.verdict === "deny" ? "yes" : "no"));
' 2>/dev/null
}
TOK_EXP_PATH="$HOME/.multipi/project/dev-loop-tokens/a.tok" multipi_policy_probe > "$work/.policy-probe" 2>/dev/null
gk() { sed -n "s/^$1=//p" "$work/.policy-probe" | head -1; } # gk KEY → the probe's value for KEY
expect "P2 smoke: a seeded deny rule blocks the orchestrator's bash call" "yes" "$(gk deny)"
expect "P2 smoke: exact 'DENIED <rule-id>: <reason>' tripwire text" \
  "DENIED Bash(sudo:*): denied by rule: Bash(sudo:*)" "$(gk denyreason)"
expect "P2 smoke: exact §6 ask escalation directive shape" \
  "ASK Bash(gh pr merge:*): bash: gh pr merge 12. Operator approval required: run 'multipi-approve Bash(gh pr merge:*)' in your own shell, then retry." "$(gk askreason)"
expect "P2 smoke: LITERAL-~ token-dir read is denied by the seeded rule (as the model wrote it)" "yes" "$(gk tokdeny)"
expect "P2 smoke: the token-dir deny lands in the audit under its seeded rule id" "yes" "$(gk tokrule)"
expect "P2 smoke: the audit actionSummary redacts the token-dir path (log hygiene)" "yes" "$(gk redacted)"
expect "P2 smoke: the EXPANDED token-dir path passes — the pinned tripwire-only limit (spec §9)" "passed" "$(gk tokexpanded)"
expect "P2 smoke: a curated allow passes" "yes" "$(gk allowpass)"
expect "P2 smoke: audit = session line + one per non-default verdict + the rule-backed allow (posture passes log nothing)" "5" "$(gk auditlines)"
expect "P2 smoke: the session-start line records the effective policy hash" "yes" "$(gk sessionhash)"
expect "P2 smoke: every verdict line carries the seven audit fields, layer=hook" "yes" "$(gk fields)"
# Drift: the on-disk policy is re-hashed at every non-default verdict — a mid-session edit is noise, not silence.
rm -f "$AUDIT_LOG"
TOK_EXP_PATH=x MULTIPI_PLUGIN_DIR="$plugin" env -u MULTIPI_CHILD node --input-type=module -e '
const fs = await import("node:fs");
const pi = { tools: [], handlers: {}, commands: [], registerTool() {}, registerCommand() {}, on(ev, h) { (this.handlers[ev] ??= []).push(h); } };
const mod = await import(process.env.MULTIPI_PLUGIN_DIR + "/extension/index.ts");
mod.default(pi);
const ctx = { cwd: process.cwd(), hasUI: false, mode: "rpc", sessionManager: { getSessionId: () => "smoke-drift" } };
const first = (await (pi.handlers.tool_call ?? [])[0]({ toolName: "bash", input: { command: "sudo a" } }, ctx))?.reason ?? "";
console.log("firstdrift=" + (first.startsWith("POLICY DRIFT") ? "unexpected" : "clean"));
fs.writeFileSync("permissions.json", "{\"permissions\":{\"deny\":[\"Bash(sudo:*)\",\"Bash(rm -rf /:*)\"],\"ask\":[],\"allow\":[]}}");
const second = (await (pi.handlers.tool_call ?? [])[0]({ toolName: "bash", input: { command: "sudo b" } }, ctx))?.reason ?? "";
console.log("drift=" + (second.startsWith("POLICY DRIFT:") && second.includes("enforcing the session-loaded policy") ? "yes" : "no"));
' 2>/dev/null > "$work/.drift-out"
grep -q '^firstdrift=clean$' "$work/.drift-out" && pass "P2 smoke: no drift warning before the on-disk policy changes" || fail "P2 smoke: first verdict unexpectedly drifts"
grep -q '^drift=yes$' "$work/.drift-out" && pass "P2 smoke: a mid-session permissions.json edit is announced as POLICY DRIFT on the next non-default verdict" || fail "P2 smoke: mid-session policy edit was silent (no POLICY DRIFT warning)"
rm -f permissions.json "$work/.policy-probe" "$work/.drift-out" "$AUDIT_LOG"
unset AUDIT_LOG
# --- ask machinery (permission-policy spec §6): operator mint + singleshot consume ----
# The fixture "operator" (this script's shell, with a fixture POLICY_SIGNING_SECRET) mints
# through the REAL scripts/multipi-approve CLI; consumption goes through the SAME module
# the P2 hook / P3 shims will call (attemptConsume). The clock is driven by
# MULTIPI_APPROVE_NOW_MS (mint) and the driver's `now` (consume) — TTL is tested without
# sleeping. Tokens land under MULTIPI_HOME (already $work/home), never in the repo.
APPR_CLI="$plugin/scripts/multipi-approve"
APPR_MOD="$plugin/extension/src/approvals.ts"
APPR_POLICY_MOD="$plugin/extension/src/policy.ts"
TOKDIR="$work/home/project/dev-loop-tokens"
AUDIT_LOG="$work/home/project/logs/policy-audit.jsonl"
ASK_SECRET="smoke-operator-secret-not-a-real-credential"
export POLICY_SIGNING_SECRET="$ASK_SECRET"
ask_now_ms() { date +%s%3N; }
ask_consume() { # ask_consume RULE [SCOPE] [NOW_MS] [SECRETFILE] -> "verdict" or "verdict:reason"
  APPR_MOD="$APPR_MOD" TOKENV="$TOKDIR" ASK_RULE="$1" ASK_SCOPE="${2:-}" ASK_NOW="${3:-}" \
    ASK_AUDIT="$AUDIT_LOG" POLICY_SIGNING_SECRET="$ASK_SECRET" ASK_SECRETFILE="${4:-}" \
    node --input-type=module -e '
import { readFileSync } from "node:fs";
const mod = await import(process.env.APPR_MOD);
const secret = process.env.ASK_SECRETFILE ? readFileSync(process.env.ASK_SECRETFILE, "utf8").trim() : process.env.POLICY_SIGNING_SECRET;
const o = { tokenDir: process.env.TOKENV, ruleId: process.env.ASK_RULE, secret, layer: "smoke" };
if (process.env.ASK_SCOPE) o.actionScope = process.env.ASK_SCOPE;
if (process.env.ASK_NOW) o.now = Number(process.env.ASK_NOW);
const out = mod.attemptConsume(o);
mod.appendAudit(process.env.ASK_AUDIT, out.audit);
console.log(out.verdict + (out.reason ? ":" + out.reason : ""));
'
}
# The fixture project's policy: the confirmed token protections (spec §6).
BASE_PORC=$(git status --porcelain) # the repo-clean pin's baseline, BEFORE this section touches the fixture
mkcfg '"policy": {"posture": "allow", "repos": ["self"], "token_ttl_minutes": 10}'
cat >permissions.json <<'EOF'
{ "permissions": { "deny": [ "Read(~/.multipi/*/dev-loop-tokens/**)", "Bash(*multipi-approve*)", "Read(~/.multipi/*/policy-secret)" ], "allow": [], "ask": [] } }
EOF

TOK_MERGE="$TOKDIR/Bash__gh_pr_merge__.tok"
TOK_TAG="$TOKDIR/Bash_git_tag___.tok"
out=$(bash "$APPR_CLI" 'Bash(*gh pr merge*)' 2>&1); rc=$?
expect "multipi-approve mints a token in the fixture operator's shell" "0" "$rc"
[ -f "$TOK_MERGE" ] && pass "the token file lands in <state>/dev-loop-tokens" || fail "no token file at $TOK_MERGE ($out)"
expect "the token dir is 0700" "700" "$(stat -c %a "$TOKDIR")"
expect "the token file is 0600" "600" "$(stat -c %a "$TOK_MERGE")"
grep -qF "$ASK_SECRET" "$TOK_MERGE" &&
  fail "the signing secret leaked into the token file" || pass "the token file carries no secret bytes"
READVERDICT=$(PROJDIR="$work/project" APPR_POLICY_MOD="$APPR_POLICY_MOD" READP="~/.multipi/project/dev-loop-tokens/Bash__gh_pr_merge__.tok" \
  node --input-type=module -e '
const mod = await import(process.env.APPR_POLICY_MOD);
const p = mod.loadPolicy(process.env.PROJDIR);
const d = mod.evaluate(p, { actor: "orchestrator", tool: "read", paths: [process.env.READP] });
console.log(d.verdict);
')
expect "the agent's Read of the token dir is denied by the seeded policy (pre-consumption)" "deny" "$READVERDICT"
expect "the live token passes consumption (mint -> consume happy path)" "pass" \
  "$(ask_consume 'Bash(*gh pr merge*)' "" "$(ask_now_ms)")"
[ -f "$TOK_MERGE" ] &&
  fail "consumption left the token file behind" || pass "consumption removed the token file (singleshot)"
expect "a second use of a consumed token denies no-token" "deny:no-token" \
  "$(ask_consume 'Bash(*gh pr merge*)' "" "$(ask_now_ms)")"
# TTL at the boundary, driven by the clock seam (no sleeps): ttl 1 minute.
N0=$(ask_now_ms)
MULTIPI_APPROVE_NOW_MS="$N0" bash "$APPR_CLI" 'Bash(git tag *)' --ttl 1 >/dev/null 2>&1
expect "the TTL is honoured: 59 s of a 1-minute token is still live (clock seam)" "pass" \
  "$(ask_consume 'Bash(git tag *)' "" $((N0 + 59 * 1000)))"
MULTIPI_APPROVE_NOW_MS="$N0" bash "$APPR_CLI" 'Bash(git tag *)' --ttl 1 >/dev/null 2>&1
expect "the TTL is enforced: 61 s of a 1-minute token is expired (clock seam, no sleep)" "deny:expired" \
  "$(ask_consume 'Bash(git tag *)' "" $((N0 + 61 * 1000)))"
[ -f "$TOK_TAG" ] &&
  pass "an expired token is left in place for the operator's inspection" || fail "an expired token was consumed/deleted"
NE=$(ask_now_ms)
MULTIPI_APPROVE_NOW_MS=$((NE - 11 * 60 * 1000)) bash "$APPR_CLI" 'Bash(git tag *)' >/dev/null 2>&1
expect "a token minted 11 minutes ago (default 10-minute TTL) is expired now" "deny:expired" \
  "$(ask_consume 'Bash(git tag *)' "" "$NE")"
# Forge: re-sign a LIVE token under a WRONG secret — verification must reject it.
N1=$(ask_now_ms)
MULTIPI_APPROVE_NOW_MS="$N1" bash "$APPR_CLI" 'Bash(git tag *)' --ttl 5 >/dev/null 2>&1
H_ORIG=$(grep -o '"hmac": "[0-9a-f]*"' "$TOK_TAG" | cut -d'"' -f4)
APPR_MOD="$APPR_MOD" FORGE_FILE="$TOK_TAG" node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const mod = await import(process.env.APPR_MOD);
const t = JSON.parse(readFileSync(process.env.FORGE_FILE, "utf8"));
t.hmac = mod.hmacOf(mod.canonicalPayload(t), "attacker-wrong-secret");
writeFileSync(process.env.FORGE_FILE, JSON.stringify(t));
'
expect "a forged token (wrong-secret HMAC) is still blocked" "deny:bad-hmac" \
  "$(ask_consume 'Bash(git tag *)' "" $((N1 + 60 * 1000)))"
[ -f "$TOK_TAG" ] &&
  pass "the forged token was denied, not consumed (audited event, evidence kept)" || fail "the forged token was consumed"
# Scope binding: a scoped token never covers a foreign scope; the matching scope passes.
bash "$APPR_CLI" 'Bash(*gh pr merge*)' --target main >/dev/null 2>&1
expect "a scoped token denies a foreign scope (scope-mismatch)" "deny:scope-mismatch" \
  "$(ask_consume 'Bash(*gh pr merge*)' staging "$(ask_now_ms)")"
[ -f "$TOK_MERGE" ] &&
  pass "a scope mismatch does not spend the token" || fail "a scope mismatch consumed the token"
expect "the matching scope passes" "pass" \
  "$(ask_consume 'Bash(*gh pr merge*)' main "$(ask_now_ms)")"
# Garbage in the token slot: denied malformed, left in place.
echo "not a token" >"$TOKDIR/Bash_git_tag_delete___.tok"
expect "a garbage token file is denied malformed" "deny:malformed" \
  "$(ask_consume 'Bash(git tag delete *)' "" "$(ask_now_ms)")"
# Keyring fallback: no env secret, a fresh state dir — the CLI creates a 0600 keyring and
# the SAME secret round-trips mint (bash) -> verify (TS).
KEYRING="$work/home3/project/policy-secret"
MULTIPI_HOME="$work/home3" env -u POLICY_SIGNING_SECRET bash "$APPR_CLI" 'Bash(git tag *)' >/dev/null 2>&1; rc=$?
expect "without POLICY_SIGNING_SECRET the CLI mints via the created keyring" "0" "$rc"
expect "the keyring is 0600 under the state dir" "600" "$(stat -c %a "$KEYRING" 2>/dev/null)"
KEYTOKDIR="$work/home3/project/dev-loop-tokens"
ASK_KEYCONSUME=$(APPR_MOD="$APPR_MOD" TOKENV="$KEYTOKDIR" ASK_RULE='Bash(git tag *)' ASK_NOW="$(ask_now_ms)" \
  ASK_SECRETFILE="$KEYRING" ASK_AUDIT="$AUDIT_LOG" \
  node --input-type=module -e '
import { readFileSync } from "node:fs";
const mod = await import(process.env.APPR_MOD);
const out = mod.attemptConsume({ tokenDir: process.env.TOKENV, ruleId: process.env.ASK_RULE, secret: readFileSync(process.env.ASK_SECRETFILE, "utf8").trim(), now: Number(process.env.ASK_NOW) });
mod.appendAudit(process.env.ASK_AUDIT, out.audit);
console.log(out.verdict + (out.reason ? ":" + out.reason : ""));
')
expect "the keyring secret verifies the minted token (bash mint -> TS consume)" "pass" "$ASK_KEYCONSUME"
# Hygiene: the token machinery never lands in the repo, and the audit log carries
# neither the secret nor any token hmac (log hygiene: forge attempts stay reviewable).
mkcfg '' # restore the base fixture config
rm -f permissions.json
expect "the token dir, keyring and tokens never land in the repo" "yes" \
  "$([ "$BASE_PORC" = "$(git status --porcelain)" ] && echo yes)"
find "$work/project" -name '*.tok' -print -quit | grep -q . &&
  fail "a .tok file exists inside the repo" || pass "no .tok files inside the repo"
n_audit=$(wc -l <"$AUDIT_LOG" 2>/dev/null || echo 0)
[ "$n_audit" -ge 10 ] &&
  pass "every consumption and denial was recorded (audit JSONL, $n_audit lines)" || fail "audit log has only $n_audit lines (want >= 10)"
grep -q '"kind":"consumed"' "$AUDIT_LOG" &&
  pass "the audit log carries consumed entries" || fail "no consumed audit entry"
grep -q 'bad-hmac' "$AUDIT_LOG" &&
  pass "the forge attempt is an AUDITED event (reason bad-hmac)" || fail "the forge attempt left no audit trail"
grep -qF "$ASK_SECRET" "$AUDIT_LOG" &&
  fail "the signing secret leaked into the audit log" || pass "the audit log carries no secret bytes"
grep -qF "$H_ORIG" "$AUDIT_LOG" &&
  fail "a token's hmac leaked into the audit log" || pass "the audit log carries no token hmac"
unset POLICY_SIGNING_SECRET
# --- permission policy P3: the git/gh shims — the full Layer-2 matrix (ticket #41) ----
# The loop is productized-installed into the fixture project, then the shim dir is prepended
# to PATH for each probed invocation. The real `git` is the system git; `gh` is tests/fake-gh
# (already first on PATH), so the shims' "first binary outside the shim dir" resolution lands
# on the fake gh — and its calls.log proves the real binary was never REACHED on a deny.
# (These comments are kept free of `$(…)`-shaped text purely so a naive grep for
#  command substitution does not flag this block; shell comments of course never execute.
#  They are single-quoted in the expect() lines below where they appear literally.)
cd "$work/project" || exit 1
git checkout -q main 2>/dev/null || true
mkcfg '"policy": {"repos": ["self"], "secondaries": ["'"$work"'/sec"]}'
cat >permissions.json <<'EOF'
{"permissions":{"deny":[],"ask":[],"allow":[]}}
EOF
bash "$plugin/scripts/install.sh" "$work/project" >/dev/null
PSH="$work/project/scripts/policy-shims"
[ -x "$PSH/git" ] && [ -x "$PSH/gh" ] && [ -f "$PSH/lib/policyshim.sh" ] &&
  pass "P3 smoke: the installer copies the shims + shared helper, executable" ||
  fail "P3 smoke: the installer did not lay down the shims"
P3_AUDIT="$work/home/project/logs/policy-audit.jsonl"
rm -f "$P3_AUDIT"
p3git() { PATH="$PSH:$PATH" git "$@"; }        # git THROUGH the shim
p3gh()  { PATH="$PSH:$PATH" gh "$@"; }         # gh THROUGH the shim
# grep -c exits non-zero on zero matches and prints nothing for a missing file: normalize to 0.
p3count() { local c; c=$(grep -c "$1" "$P3_AUDIT" 2>/dev/null); [ -n "$c" ] || c=0; printf '%s' "$c"; }
# Fresh actors: a foreign repo (same origin, different path — self is the TREE, not the URL)
# and a whitelisted secondary.
git clone -q "$work/origin.git" "$work/p3-foreign" 2>/dev/null
git clone -q "$work/origin.git" "$work/sec" 2>/dev/null
( cd "$work/p3-foreign" && echo foreign >f.txt && git add f.txt && git commit -q -m "chore: foreign file" )
git checkout -q -b feat/p3 && echo p3 >p3.txt && git add p3.txt && git commit -q -m "chore: p3 branch" && git checkout -q main

# 1. self commit passes clean (no audit line: posture allow, no rule)
echo self >self.txt && git add self.txt
p3git commit -q -m "chore: p3 self" && pass "P3 smoke: a self commit passes the shims" ||
  fail "P3 smoke: a self commit was blocked"
git cat-file -e HEAD && pass "P3 smoke: the self commit really landed" || fail "P3 smoke: the self commit did not land"
expect "P3 smoke: a clean self commit writes no audit line" "0" "$(p3count verdict)"

# 2. foreign-repo commit ⇒ deny 126 + audit; the commit must NOT land
cd "$work/p3-foreign"
echo more >>f.txt
out=$(PATH="$PSH:$PATH" git commit -q -m "chore: foreign mutation" 2>&1); rc=$?
cd "$work/project"
expect "P3 smoke: a foreign-repo commit is denied with exit 126" "126" "$rc"
echo "$out" | grep -qF "DENIED oneshot:foreign-repo:" && pass "P3 smoke: the foreign deny carries the rule id" ||
  fail "P3 smoke: the foreign deny line is wrong: $out"
git -C "$work/p3-foreign" status --porcelain | grep -q f.txt &&
  pass "P3 smoke: the foreign commit did NOT land" || fail "P3 smoke: the foreign mutation landed anyway"
expect "P3 smoke: the foreign deny is audited (rule id + verdict deny, layer shim)" "1" \
  "$(p3count '\"ruleId\":\"oneshot:foreign-repo\",\"verdict\":\"deny\"')"

# 2b. repo-REDIRECT specifiers cannot re-target away from classification (P3 review round 4):
#     the shim resolves what the command REDIRECTS at, not the cwd. All three spellings must
#     hit the SAME foreign deny; the control shows the unredirected self commit stays clean.
out=$(PATH="$PSH:$PATH" git --git-dir="$work/p3-foreign/.git" commit -q --allow-empty -m x 2>&1); rc=$?
expect "P3 smoke: --git-dir=<foreign> commit is denied (resolves the redirect target)" "126" "$rc"
echo "$out" | grep -qF "DENIED oneshot:foreign-repo:" && pass "P3 smoke: the --git-dir deny carries the foreign rule id" ||
  fail "P3 smoke: the --git-dir deny line is wrong: $out"
out=$(PATH="$PSH:$PATH" GIT_DIR="$work/p3-foreign/.git" git commit -q --allow-empty -m x 2>&1); rc=$?
expect "P3 smoke: a GIT_DIR env redirect to the foreign repo is denied too" "126" "$rc"
echo "$out" | grep -qF "DENIED oneshot:foreign-repo:" && pass "P3 smoke: the GIT_DIR deny carries the foreign rule id" ||
  fail "P3 smoke: the GIT_DIR deny line is wrong: $out"
out=$(PATH="$PSH:$PATH" git -C "$work/p3-foreign" commit -q --allow-empty -m x 2>&1); rc=$?
expect "P3 smoke: git -C <foreign> commit is denied (the -C redirect is honored)" "126" "$rc"
echo "$out" | grep -qF "DENIED oneshot:foreign-repo:" && pass "P3 smoke: the -C deny carries the foreign rule id" ||
  fail "P3 smoke: the -C deny line is wrong: $out"
p3git commit -q --allow-empty -m "chore: redirect control" && pass "P3 smoke: the UNredirected self commit still passes" ||
  fail "P3 smoke: the unredirected self commit was blocked"

# 3. unresolvable acting repo ⇒ deny (spec §7.2 fail direction)
mkdir -p "$work/p3-nr"
out=$(cd "$work/p3-nr" && PATH="$PSH:$PATH" git commit -q --allow-empty -m x 2>&1); rc=$?
expect "P3 smoke: a commit in a non-repo is denied (unresolvable) with 126" "126" "$rc"
echo "$out" | grep -qF "DENIED oneshot:unresolvable-target:" && pass "P3 smoke: the unresolvable deny carries the rule id" ||
  fail "P3 smoke: the unresolvable deny line is wrong: $out"

# 3b. gate-hang regression (post-approval review): the node-availability probe must never
#     READ STDIN. A bare `node` inherits the caller's stdin (REPL/script read); under the
#     gate that stdin is the open orchestrator execFile pipe, so the probe blocked forever
#     and devloop.gate never resolved. Pin offline: the SAME foreign deny must land, well
#     before the feeder closes, when the mutation runs against an OPEN stdin pipe.
t0=$(date +%s)
out=$( (cd "$work/p3-foreign" && PATH="$PSH:$PATH" git commit -q --allow-empty -m x) < <(sleep 15) 2>&1); rc=$?
t1=$(date +%s)
expect "P3 smoke: an open stdin pipe does not change the foreign deny (still 126)" "126" "$rc"
[ $((t1-t0)) -lt 5 ] && pass "P3 smoke: the shimmed deny completes with an open stdin pipe (well under 5s; the feeder holds 15s)" ||
  fail "P3 smoke: the shimmed commit BLOCKED on the open stdin pipe ($((t1-t0))s - the probe must be non-interactive)"

# 4. base-branch push ⇒ deny; 5. force push ⇒ deny (flag and +refspec forms)
out=$(p3git push origin main 2>&1); rc=$?
expect "P3 smoke: a base-branch push is denied with 126" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:base-branch:" && pass "P3 smoke: the base-branch deny carries the rule id" ||
  fail "P3 smoke: the base-branch deny line is wrong: $out"
out=$(p3git push --force origin feat/p3 2>&1); rc=$?
expect "P3 smoke: a force push is denied with 126" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:force-push:" && pass "P3 smoke: the force-push deny carries the rule id" ||
  fail "P3 smoke: the force-push deny line is wrong: $out"
out=$(p3git push origin +feat/p3:refs/heads/feat/p3 2>&1); rc=$?
expect "P3 smoke: a +refspec force push is denied too" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:force-push:" && pass "P3 smoke: the +refspec force push is caught as force" ||
  fail "P3 smoke: the +refspec force push was not caught: $out"
out=$(p3git push origin feat/p3:refs/heads/feat/p3 2>&1); rc=$?
expect "P3 smoke: a LITERAL feature refspec (no +) is not base and not force — allowed" "0" "$rc"
out=$(p3git push origin main: 2>&1); rc=$?
expect "P3 smoke: deleting the base ref (main:) is denied as a base write" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:base-branch:" || fail "P3 smoke: the base-ref delete was not caught: $out"

# 4f. --all / --branches (P3 review round 12): the implicit destination set is ALL local
#     heads — it includes the base ref from ANY checked-out branch, while the no-refspec
#     rule below the scan resolves only the CURRENT branch. Pinned FROM A TOPIC BRANCH,
#     where the current-branch rule alone sees only the topic. Over-deny to the base class
#     is the documented fail-safe direction (same as the wildcard-destination policy).
snap_before=$(git -C "$work/origin.git" for-each-ref --format='%(refname) %(objectname)')
git checkout -q feat/p3
n0_wild=$(p3count '"ruleId":"policy:base-branch","verdict":"deny"')
out=$(p3git push --all origin 2>&1); rc=$?
expect "P3 smoke: 'git push --all origin' from a topic branch is denied with 126 (its destination set includes base)" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:base-branch:" && pass "P3 smoke: the --all push carries the base rule id" ||
  fail "P3 smoke: the --all push was not caught by the base rule: $out"
out=$(p3git push --branches origin 2>&1); rc=$?
expect "P3 smoke: 'git push --branches origin' from a topic branch is denied with 126 too" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:base-branch:" && pass "P3 smoke: the --branches push carries the base rule id" ||
  fail "P3 smoke: the --branches push was not caught by the base rule: $out"
expect "P3 smoke: both wildcard-destination denies are audited" "$((n0_wild + 2))" \
  "$(p3count '"ruleId":"policy:base-branch","verdict":"deny"')"
snap_after=$(git -C "$work/origin.git" for-each-ref --format='%(refname) %(objectname)')
[ "$snap_before" = "$snap_after" ] && pass "P3 smoke: no ref (in particular the base) ever landed on the remote" ||
  fail "P3 smoke: a ref landed on the remote despite the denies: $(diff <(printf '%s\n' "$snap_before") <(printf '%s\n' "$snap_after") | head -5)"
git checkout -q main

# 4b. spelling-variant holes (P3 review round 2): attached/clustered short flags must
#     not bypass a rule class — `-fu` is the SAME call as `-f -u`, and `-Bname` is the
#     canonical attached spelling of the ref-writing `-B name`.
out=$(p3git push -fu origin feat/p3 2>&1); rc=$?
expect "P3 smoke: the -fu cluster force push is denied (same call as -f -u)" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:force-push:" && pass "P3 smoke: the -fu cluster carries the force rule id" ||
  fail "P3 smoke: the -fu cluster bypassed force detection: $out"
cd "$work/p3-foreign"
out=$(PATH="$PSH:$PATH" git checkout -Bp3hole 2>&1); rc=$?
cd "$work/project"
expect "P3 smoke: the attached-form checkout -Bname in a foreign repo is denied" "126" "$rc"
echo "$out" | grep -qF "DENIED oneshot:foreign-repo:" && pass "P3 smoke: -Bname is classified as a ref write" ||
  fail "P3 smoke: -Bname bypassed the ref-write class: $out"
# --force-create is the documented LONG form of `switch -C` (P3 review round 11): the
# same ref-write class as -B/-C — it must consult the evaluator, not ride the generic
# long-flag arm (reproduced: it fell through unconsulted and rewrote the foreign ref).
cd "$work/p3-foreign"
out=$(PATH="$PSH:$PATH" git switch --force-create victim 2>&1); rc=$?
cd "$work/project"
expect "P3 smoke: switch --force-create in a foreign repo is denied (the long -C form is a ref write)" "126" "$rc"
echo "$out" | grep -qF "DENIED oneshot:foreign-repo:" && pass "P3 smoke: --force-create is classified as a ref write" ||
  fail "P3 smoke: --force-create bypassed the ref-write class: $out"
git -C "$work/p3-foreign" show-ref --verify -q refs/heads/victim && \
  fail "P3 smoke: the --force-create victim ref LANDED" || \
  pass "P3 smoke: the --force-create victim ref did NOT land"
# Control: the new arm does not OVER-deny self — a self --force-create still passes.
p3git switch --force-create p3fc && pass "P3 smoke: a self switch --force-create passes" ||
  fail "P3 smoke: a self --force-create was over-denied"
git checkout -q main && git branch -q -D p3fc
out=$(p3git tag -n5 2>&1); rc=$?
expect "P3 smoke: the list spelling 'git tag -n5' is not classified as a tag mutation" "0" "$rc"

# 4c. leading GLOBAL options cannot mask a mutation (P3 review round 6): the scan peels
#     EVERY flag-shaped leading token (git's leading options are a closed, documented set;
#     a whitelist of them is unmaintainable), so unknown options still reach the subcommand.
cd "$work/p3-foreign"
out=$(PATH="$PSH:$PATH" git --exec-path=/usr/lib/git-core commit -q --allow-empty -m ep 2>&1); rc=$?
expect "P3 smoke: an unlisted leading option (--exec-path) cannot mask a foreign commit" "126" "$rc"
echo "$out" | grep -qF "DENIED oneshot:foreign-repo:" && pass "P3 smoke: the --exec-path-masked commit carries the foreign rule id" ||
  fail "P3 smoke: the --exec-path-masked deny line is wrong: $out"
out=$(PATH="$PSH:$PATH" git -P commit -q --allow-empty -m ep 2>&1); rc=$?
expect "P3 smoke: a short unlisted leading option (-P) cannot mask a foreign commit" "126" "$rc"
cd "$work/project"
git -C "$work/p3-foreign" log --oneline -1 | grep -qv '^ep$' && \
  pass "P3 smoke: neither masked foreign commit landed" || fail "P3 smoke: a masked foreign commit LANDED"
p3git --exec-path=/usr/lib/git-core commit -q --allow-empty -m oc && \
  pass "P3 smoke: the masked SELF commit still passes (control)" ||
  fail "P3 smoke: the masked self commit was blocked"

# 4d. value-carrying push flags (round 6): -o/--push-option eat their value; long flags are
#     never fed to the short-cluster f/t scanner.
out=$(p3git push -o ci=no origin 2>&1); rc=$?
expect "P3 smoke: 'git push -o ci=no origin' on base is denied (the value is not a positional)" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:base-branch:" && pass "P3 smoke: the -o-masked base push carries the base rule id" ||
  fail "P3 smoke: the -o-masked base push was not caught: $out"
out=$(p3git push --no-verify origin feat/p3 2>&1); rc=$?
expect "P3 smoke: --no-verify is NOT force (long flags never join the f/t cluster scan)" "0" "$rc"
# --follow-tags publishes all tags reachable from the pushed refs (P3 review round 11):
# tag-ref publication is the SAME class as --tags/-t — it joins the tag set, so the §6
# tag-push ASK must apply instead of being silently skipped (reproduced: it pushed clean).
n0_ft=$(p3count '"ruleId":"policy:tag-push","verdict":"ask"')
out=$(p3git push --follow-tags origin feat/p3 2>&1); rc=$?
expect "P3 smoke: 'git push --follow-tags origin feat/p3' is blocked with 126 (the tag ASK)" "126" "$rc"
echo "$out" | grep -qF "ASK policy:tag-push:" && pass "P3 smoke: --follow-tags carries the tag-push ask" ||
  fail "P3 smoke: --follow-tags skipped the tag-push ASK: $out"
expect "P3 smoke: the follow-tags ask is audited" "$((n0_ft + 1))" \
  "$(p3count '"ruleId":"policy:tag-push","verdict":"ask"')"

# 4e. review round 7: a help/version token CONSUMED as another flag's value must not
#     trigger the doc pass-through (only the token IMMEDIATELY after the subcommand
#     qualifies), and --force-if-includes joins the force set.
cd "$work/p3-foreign"
n0_fh=$(p3count '\"ruleId\":\"oneshot:foreign-repo\",\"verdict\":\"deny\"')
out=$(PATH="$PSH:$PATH" git commit -m '--help' -q --allow-empty 2>&1); rc=$?
cd "$work/project"
expect "P3 smoke: 'git commit -m --help' in a foreign repo is DENIED (the help token is -m's value)" "126" "$rc"
echo "$out" | grep -qF "DENIED oneshot:foreign-repo:" && pass "P3 smoke: the value-spelled commit carries the foreign rule id" ||
  fail "P3 smoke: a help-spelled commit slipped past the policy check: $out"
expect "P3 smoke: the value-spelled foreign deny is audited" "$((n0_fh + 1))" \
  "$(p3count '\"ruleId\":\"oneshot:foreign-repo\",\"verdict\":\"deny\"')"
[ "$(git -C "$work/p3-foreign" log --format=%s -1)" != "--help" ] && \
  pass "P3 smoke: the value-spelled foreign commit did NOT land" || fail "P3 smoke: the value-spelled foreign commit LANDED"
out=$(p3git push -o --help origin main 2>&1); rc=$?
expect "P3 smoke: 'git push -o --help origin main' is DENIED (the help token is -o's value)" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:base-branch:" && pass "P3 smoke: the -o-value-spelled base push carries the base rule id" ||
  fail "P3 smoke: a -o-value-spelled push slipped past the policy check: $out"
# Control: the token immediately after the subcommand IS still the doc form (zero policy cost).
out=$(p3git commit --help 2>&1); rc=$?
expect "P3 smoke: 'git commit --help' (immediate token) still passes through" "0" "$rc"
echo "$out" | grep -qi "usage" && pass "P3 smoke: the doc pass-through shows real git's help" ||
  fail "P3 smoke: the doc pass-through output is not git's help: $out"
# --force-if-includes: conditionally forcing — a TOPIC push is caught only by the force
# set, never by the base rule (space form and = form; the flag is present or not).
out=$(p3git push --force-if-includes origin feat/p3 2>&1); rc=$?
expect "P3 smoke: 'git push --force-if-includes origin feat/p3' is DENIED as force" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:force-push:" && pass "P3 smoke: --force-if-includes carries the force rule id" ||
  fail "P3 smoke: --force-if-includes was not classified as force: $out"
out=$(p3git push --force-if-includes=origin/feat/p3 origin feat/p3 2>&1); rc=$?
expect "P3 smoke: the --force-if-includes= form is DENIED as force too" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:force-push:" && pass "P3 smoke: the = form carries the force rule id" ||
  fail "P3 smoke: the = form was not classified as force: $out"

# 6. the §5 identity exemption: a loop script under the installed scripts/ pushing base
#    passes clean (this is merge-train's exact identity rule; the fixture script stands in
#    for merge-train.sh, which carries the same parent-chain shape in production).
cat >scripts/p3-push-main.sh <<'EOF'
#!/usr/bin/env bash
set -u
git push origin main
EOF
chmod +x scripts/p3-push-main.sh
out=$(PATH="$PSH:$PATH" bash scripts/p3-push-main.sh 2>&1); rc=$?
expect "P3 smoke: a trusted loop script pushing base is ALLOWED" "0" "$rc"
expect "P3 smoke: the trusted exemption is the audited baseline line" "1" \
  "$(p3count '\"ruleId\":\"trusted:exemption\",\"verdict\":\"allow\"')"
# Forgery must die: an env marker is not a mechanism, and MENTIONING a script is not ancestry.
out=$(PATH="$PSH:$PATH" env MULTIPI_TRUSTED=1 git push --force origin feat/p3 2>&1); rc=$?
expect "P3 smoke: an env-marker forgery attempt does not confer trust" "126" "$rc"
out=$(PATH="$PSH:$PATH" sh -c 'echo scripts/p3-push-main.sh; git push origin main' 2>&1); rc=$?
expect "P3 smoke: a shell that merely MENTIONS the script still dies on base" "126" "$rc"

# 7. Layer-1 honesty: a WRAPPED invocation passes any string pattern but hits Layer 2.
out=$(PATH="$PSH:$PATH" sh -c 'git push --force origin main' 2>&1); rc=$?
expect "P3 smoke: the wrapped force push dies at the shim (126)" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:force-push:" && pass "P3 smoke: the wrapped push is caught by the shim, not the tripwire" ||
  fail "P3 smoke: the wrapped push deny line is wrong: $out"

# 8. gh repo delete ⇒ deny; 9. gh pr merge ⇒ ask directive; the real gh is never reached.
GH_CALLS="$work/gh/calls.log"
n0_del=$(grep -c 'repo delete' "$GH_CALLS" 2>/dev/null); n0_del=${n0_del:-0}
out=$(p3gh repo delete o/r 2>&1); rc=$?
expect "P3 smoke: gh repo delete is denied with 126" "126" "$rc"
echo "$out" | grep -qF "DENIED gh:repo-delete:" && pass "P3 smoke: the repo-delete deny carries the rule id" ||
  fail "P3 smoke: the repo-delete deny line is wrong: $out"
n1_del=$(grep -c 'repo delete' "$GH_CALLS" 2>/dev/null); n1_del=${n1_del:-0}
expect "P3 smoke: the real gh never saw the repo delete" "$n0_del" "$n1_del"
out=$(p3gh pr merge 12 2>&1); rc=$?
expect "P3 smoke: a freeform gh pr merge is blocked with 126 (phase-1 ask)" "126" "$rc"
echo "$out" | grep -qF "ASK gh:pr-merge: pr merge 12. Operator approval required: run 'multipi-approve gh:pr-merge' in your own shell, then retry." &&
  pass "P3 smoke: the pr-merge ask carries the exact §6 directive" || fail "P3 smoke: the pr-merge ask line is wrong: $out"
expect "P3 smoke: the pr-merge ask is audited as verdict ask" "1" \
  "$(p3count '\"ruleId\":\"gh:pr-merge\",\"verdict\":\"ask\"')"
n0_il=$(grep -c 'merge 12$' "$GH_CALLS" 2>/dev/null); n0_il=${n0_il:-0}
out=$(p3gh pr -R o/r merge 12 2>&1); rc=$?
expect "P3 smoke: the INTERLEAVED spelling 'gh pr -R o/r merge 12' is blocked too" "126" "$rc"
echo "$out" | grep -qF "ASK gh:pr-merge:" && pass "P3 smoke: the interleaved spelling carries the same ask" ||
  fail "P3 smoke: the interleaved pr-merge bypassed the class: $out"
n1_il=$(grep -c 'merge 12$' "$GH_CALLS" 2>/dev/null); n1_il=${n1_il:-0}
expect "P3 smoke: the real gh never saw the interleaved merge" "$n0_il" "$n1_il"

# 8b. review round 7: the value-token rule applies to gh too, and the globals that CONSUME
#     a value on older gh releases (-c --color --api-version) must not leak their value
#     into the noun/verb slots.
n0_hv=$(grep -c 'merge 12' "$GH_CALLS" 2>/dev/null); n0_hv=${n0_hv:-0}
out=$(p3gh pr merge 12 -m --help 2>&1); rc=$?
expect "P3 smoke: 'gh pr merge 12 -m --help' is ASKED (the help token is -m's value)" "126" "$rc"
echo "$out" | grep -qF "ASK gh:pr-merge:" && pass "P3 smoke: the value-spelled merge carries the pr-merge ask" ||
  fail "P3 smoke: a help-spelled merge slipped past the class: $out"
n1_hv=$(grep -c 'merge 12' "$GH_CALLS" 2>/dev/null); n1_hv=${n1_hv:-0}
expect "P3 smoke: the real gh never saw the value-spelled merge" "$n0_hv" "$n1_hv"
# Control: the token immediately after the verb IS still the doc form — the shim is
# TRANSPARENT (fake-gh does not implement repo delete, so pin the FORWARDING, not its rc).
n0_hp=$(grep -c 'repo delete --help' "$GH_CALLS" 2>/dev/null); n0_hp=${n0_hp:-0}
out=$(p3gh repo delete --help 2>&1); rc=$?
[ "$rc" -ne 126 ] && pass "P3 smoke: 'gh repo delete --help' (immediate token) is not shim-blocked" ||
  fail "P3 smoke: the doc-form delete was blocked at the shim (rc $rc): $out"
n1_hp=$(grep -c 'repo delete --help' "$GH_CALLS" 2>/dev/null); n1_hp=${n1_hp:-0}
expect "P3 smoke: the doc-form delete was forwarded to the real gh" "$((n0_hp + 1))" "$n1_hp"
n0_av=$(grep -c 'repo delete' "$GH_CALLS" 2>/dev/null); n0_av=${n0_av:-0}
out=$(p3gh --api-version v4 repo delete o/r 2>&1); rc=$?
expect "P3 smoke: 'gh --api-version v4 repo delete o/r' is DENIED (the value does not become the noun)" "126" "$rc"
echo "$out" | grep -qF "DENIED gh:repo-delete:" && pass "P3 smoke: the api-version-spelled delete carries the rule id" ||
  fail "P3 smoke: the api-version-spelled delete slipped past the flat deny: $out"
n1_av=$(grep -c 'repo delete' "$GH_CALLS" 2>/dev/null); n1_av=${n1_av:-0}
expect "P3 smoke: the real gh never saw the api-version-spelled delete" "$n0_av" "$n1_av"
out=$(p3gh repo --api-version v4 delete o/r 2>&1); rc=$?
expect "P3 smoke: the mid-verb 'gh repo --api-version v4 delete o/r' is DENIED too" "126" "$rc"
echo "$out" | grep -qF "DENIED gh:repo-delete:" || fail "P3 smoke: the mid-verb api-version spelling was not caught: $out"

# 10. passthrough: the real git receives the argv UNTOUCHED (a logging stand-in for it,
#     first non-shim dir on PATH; it still execs the system git so the work happens).
mkdir -p "$work/p3-gitlog"
# Round-7 must-fix: the stand-in must exec the git captured on the PRISTINE PATH, as an
# ABSOLUTE path. Its own runtime PATH has the shim dir FIRST — a bare command lookup there
# re-resolves to the SHIM, and the shim resolves this stand-in again: an infinite
# shim→stand-in exec loop that grew argv.log without bound and hung the suite.
REALGIT=$(command -v git)
cat >"$work/p3-gitlog/git" <<EOF
#!/usr/bin/env bash
{ printf 'ARGV:'; printf ' [%s]' "\$@"; echo; } >>"$work/p3-gitlog/argv.log"
exec "$REALGIT" "\$@"
EOF
chmod +x "$work/p3-gitlog/git"
out=$(PATH="$PSH:$work/p3-gitlog:$PATH" git commit -m "two words" --allow-empty 2>&1)
grep -qxF "ARGV: [commit] [-m] [two words] [--allow-empty]" "$work/p3-gitlog/argv.log" &&
  pass "P3 smoke: the real git received the argv untouched (order, values, spelling)" ||
  fail "P3 smoke: the real git saw mangled argv: $(cat "$work/p3-gitlog/argv.log" | tail -1)"
PATH="$PSH:$work/p3-gitlog:$PATH" git status --porcelain >/dev/null
grep -qxF "ARGV: [status] [--porcelain]" "$work/p3-gitlog/argv.log" &&
  pass "P3 smoke: read-only git passes straight through (zero policy cost)" ||
  fail "P3 smoke: the read-only passthrough argv is wrong"

# 11. no recursion: the shim resolves the real binary OUTSIDE the shim dir (even doubly listed).
out=$(PATH="$PSH:$PSH:$PATH" git status --porcelain 2>&1); rc=$?
expect "P3 smoke: a doubled shim dir does not recurse" "0" "$rc"

# 11b. worktree common-dir spellings (P3 review round 10): the resolver must also accept the
#      version-dependent <main>/.git/worktrees/<name> spelling (strip the suffix, VERIFY the
#      survivor — unverified stays empty, the caller denies) besides the main .git spelling
#      (verified on git 2.53). A STUBBED real git pins every branch host-version-independently.
STUBBIN="$work/p3-stubbin"
mkdir -p "$STUBBIN"
p3_stubgit() { # p3_stubgit COMMON BARE — stand-in real git answering the resolver's two probes
  cat >"$STUBBIN/git" <<EOF
#!/usr/bin/env bash
case "\$*" in
  *is-bare-repository*) printf '%s\n' "$2" ;;
  *) printf '%s\n' "$1" ;;
esac
EOF
  chmod +x "$STUBBIN/git"
}
p3_resolved() { # the installed helper, sourced the way the shims source it
  ( shim_dir="$PSH"; . "$PSH/lib/policyshim.sh"; shim_resolve_repo "$STUBBIN/git" "$work/project" )
}
p3_stubgit "$work/project/.git" false
expect "P3 shim: the main .git spelling of --git-common-dir resolves to the main root" \
  "$work/project" "$(p3_resolved)"
p3_stubgit "$work/project/.git/worktrees/wt" false
expect "P3 shim: the worktrees spelling (<main>/.git/worktrees/<name>) resolves to the same main root" \
  "$work/project" "$(p3_resolved)"
p3_stubgit "$work/p3-nowhere/.git/worktrees/wt" false
expect "P3 shim: an UNVERIFIED worktrees survivor resolves to EMPTY (deny, never guess)" \
  "" "$(p3_resolved)"
p3_stubgit "$work/project/.git" true
expect "P3 shim: a bare repository still resolves to the .git dir itself" \
  "$work/project/.git" "$(p3_resolved)"

# 12. a whitelisted secondary ASKS (the consent path)
cd "$work/sec" && echo s >s.txt && git add s.txt
cd "$work/project"
out=$(cd "$work/sec" && PATH="$PSH:$PATH" git commit -q -m "chore: secondary" 2>&1); rc=$?
expect "P3 smoke: a secondary-repo commit is blocked with 126" "126" "$rc"
echo "$out" | grep -qF "ASK oneshot:secondary-repo:" && pass "P3 smoke: the secondary ask carries the rule id" ||
  fail "P3 smoke: the secondary ask line is wrong: $out"

# 13. load semantics: no permissions.json ⇒ the shims are INERT; broken ⇒ deny everything.
nav=$(p3count verdict)
mv permissions.json permissions.json.arm
echo inert >inert.txt && git add inert.txt
p3git commit -q -m "chore: inert" && pass "P3 smoke: without permissions.json the shims pass through" ||
  fail "P3 smoke: an unarmed shim blocked a commit"
expect "P3 smoke: the inert pass-through writes no audit line" "$nav" "$(p3count verdict)"
mv permissions.json.arm permissions.json
echo '{broken' >permissions.json
out=$(p3git commit -q --allow-empty -m x 2>&1); rc=$?
expect "P3 smoke: a broken permissions.json denies everything (fail closed)" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:unusable:" && pass "P3 smoke: the broken-policy deny names policy:unusable" ||
  fail "P3 smoke: the broken-policy deny line is wrong: $out"
cat >permissions.json <<'EOF'
{"permissions":{"deny":[],"ask":[],"allow":[]}}
EOF

# 13b. a PRESENT-BUT-CORRUPT .devloop.json must not self-disarm Layer-2 (loadConfig cannot
#      tell missing from unparseable; a corrupt config is agent-writable, so the shim
#      distinguishes with existsSync and falls to the unusable deny).
cp .devloop.json .devloop.json.arm
echo '{broken' >.devloop.json
out=$(p3git commit -q --allow-empty -m x 2>&1); rc=$?
expect "P3 smoke: a corrupt .devloop.json does not disarm the shims" "126" "$rc"
echo "$out" | grep -qF "DENIED policy:unusable:" && pass "P3 smoke: the corrupt-config deny names policy:unusable" ||
  fail "P3 smoke: the corrupt-config deny line is wrong: $out"
mv .devloop.json.arm .devloop.json

# 14. a broken install (no git anywhere outside the shim dir) refuses with 127, never runs.
mkdir -p "$work/p3-nogit"
for t in bash sh dirname tr sed awk readlink node; do
  ln -sf "$(command -v $t)" "$work/p3-nogit/$t" 2>/dev/null || true
done
out=$(PATH="$PSH:$work/p3-nogit" git status 2>&1); rc=$?
expect "P3 smoke: an unlocatable real git refuses with 127" "127" "$rc"
echo "$out" | grep -q "cannot locate the real git" && pass "P3 smoke: the 127 refusal is named" ||
  fail "P3 smoke: the 127 refusal line is wrong: $out"

# 15. audit hygiene: every shim verdict line carries the hook's seven fields.
if python3 - "$P3_AUDIT" <<'PYEOF'
import json, sys
bad = 0
for line in open(sys.argv[1]):
    l = json.loads(line)
    if not ({"ts","event","session","actor","ruleId","verdict","actionSummary","layer"} <= set(l)
            and l["layer"] == "shim" and l["actor"] == "shim" and l["session"] == "-" and l["event"] == "verdict"):
        bad += 1
sys.exit(1 if bad else 0)
PYEOF
then
  pass "P3 smoke: every shim audit line carries the hook's seven fields (layer=shim, session=-)"
else
  fail "P3 smoke: a shim audit line is malformed"
fi

# 15b. log hygiene (spec §8): the scenario-store path never reaches the shim's audit — the
#      driver computes the store dir from the loaded config and substitutes <store>, exactly
#      like the hook's redactSummary (P3 review round 10).
mkcfg '"policy": {"repos": ["self"], "secondaries": ["'"$work"'/sec"]}, "scenarios": {}'
P3_STORE="$work/home/project/scenarios"
rm -f "$P3_AUDIT"
out=$(cd "$work/p3-foreign" && PATH="$PSH:$PATH" git commit -q --allow-empty -m "steps in $P3_STORE/t1.md" 2>&1); rc=$?
cd "$work/project"
expect "P3 smoke: a foreign commit carrying the store path is denied" "126" "$rc"
expect "P3 smoke: the shim audit line carries <store>" "1" "$(p3count '<store>')"
! grep -qF "$P3_STORE" "$P3_AUDIT" && pass "P3 smoke: the raw store path never reached the shim audit log" ||
  fail "P3 smoke: the raw store path leaked into the shim audit log"

# 15c. the fallback audit honors the configured logs_dir (P3 review round 11): the ONE
#      path that bypasses the driver resolves the log dir the way dl_logs_dir does —
#      the configured logs_dir wins over the default state dir. The function is driven
#      DIRECTLY: it exists for the driver-broken case, so the smoke tests it as a
#      function, the way 11b drives the resolver.
P3_CUSTOMLOGS="$work/p3-customlogs"
cp .devloop.json .devloop.json.arm
python3 - "$P3_CUSTOMLOGS" <<'PYR11'
import json, sys
p = ".devloop.json"
v = json.load(open(p))
v["logs_dir"] = sys.argv[1]
json.dump(v, open(p, "w"))
PYR11
rm -f "$P3_AUDIT"
( shim_dir="$PSH"; . "$PSH/lib/policyshim.sh"; shim_init
  shim_audit_fallback "policy:shim-error" "deny" "commit -m x" )
[ -f "$P3_CUSTOMLOGS/policy-audit.jsonl" ] && grep -qF '"ruleId":"policy:shim-error"' "$P3_CUSTOMLOGS/policy-audit.jsonl" && \
  pass "P3 smoke: the fallback audit line honors the configured logs_dir" || \
  fail "P3 smoke: the fallback audit line missed the configured logs_dir"
expect "P3 smoke: the configured-dir fallback line did NOT land in the default state dir" "0" \
  "$(p3count 'policy:shim-error')"
mv .devloop.json.arm .devloop.json
( shim_dir="$PSH"; . "$PSH/lib/policyshim.sh"; shim_init
  shim_audit_fallback "policy:shim-error" "deny" "commit -m x" )
expect "P3 smoke: without a configured logs_dir the fallback line uses the default state dir" "1" \
  "$(p3count 'policy:shim-error')"

# 15d. fail-closed stderr carries EXACTLY ONE line even when coreutils is missing
#      (P3 review round 12): the fallback audit's $(basename …) / $(date -u …)
#      substitutions are guarded — with them absent from PATH the command-not-found
#      noise must not leak onto stderr and the fallback line must still land. Driven
#      directly, the way 15c drives the function; the block line is emitted by the
#      caller (shim_fail_closed), so the subshell plays out audit + block itself.
P3_NOCU="$work/p3-nocu-bin"
mkdir -p "$P3_NOCU"
for cu in bash pwd mkdir jq python3 sed tr grep cat awk dirname sh; do
  src=$(command -v "$cu") && ln -sf "$src" "$P3_NOCU/$cu"
done
p3no_out=$(P3_PSH="$PSH" P3_MH="$work/p3-nocu-home" PATH="$P3_NOCU" bash -c '
  shim_dir="$P3_PSH"; . "$shim_dir/lib/policyshim.sh"; shim_init
  MULTIPI_HOME="$P3_MH" shim_audit_fallback "policy:shim-error" "deny" "commit -m x"
  shim_block "DENIED policy:shim-error: the policy evaluator could not be consulted (missing node/driver?)"' 2>&1); p3no_rc=$?
expect "P3 smoke: the fail-closed path exits 126 with coreutils missing" "126" "$p3no_rc"
p3no_lines=$(printf '%s\n' "$p3no_out" | sed -n '/./p' | wc -l | tr -d '[:space:]')
expect "P3 smoke: fail-closed stderr carries exactly one line (no command-not-found noise)" "1" "$p3no_lines"
echo "$p3no_out" | grep -qF "DENIED policy:shim-error:" && pass "P3 smoke: the single line is the block line" ||
  fail "P3 smoke: the single fail-closed line is not the block line: $p3no_out"
[ -f "$work/p3-nocu-home/project/logs/policy-audit.jsonl" ] && grep -qF '"ruleId":"policy:shim-error"' "$work/p3-nocu-home/project/logs/policy-audit.jsonl" && \
  pass "P3 smoke: the fallback audit line still lands with coreutils missing (pure-shell basename)" || \
  fail "P3 smoke: the fallback audit line was lost: $(ls "$work/p3-nocu-home/project/logs" 2>&1)"
# Control: the guard does not degrade the happy path — present coreutils yield a real ts.
( shim_dir="$PSH"; . "$PSH/lib/policyshim.sh"; shim_init
  shim_audit_fallback "policy:shim-error" "deny" "commit -m ctrl" )
grep -o '"ts":"[^"]*"' "$P3_AUDIT" | tail -1 | grep -qE '"ts":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"' && \
  pass "P3 smoke: with coreutils present the fallback line still carries a real UTC ts" || \
  fail "P3 smoke: the guarded fallback degraded the timestamp"

# Teardown: leave the fixture the way the prior sections left it.
mkcfg ''
rm -f permissions.json scripts/p3-push-main.sh
rm -rf "$work/p3-foreign" "$work/p3-nr" "$work/p3-nogit" "$work/p3-gitlog" "$work/sec" "$work/p3-stubbin" "$work/p3-nocu-bin" "$work/p3-nocu-home"
git reset -q --hard HEAD 2>/dev/null || true
git checkout -q main 2>/dev/null || true
git branch -q -D feat/p3 2>/dev/null || true
rm -f self.txt inert.txt

# --- extension: registration + hook wiring (stub ExtensionAPI, offline) ------
MULTIPI_PLUGIN_DIR="$plugin" env -u MULTIPI_CHILD node --input-type=module -e '
const pi = { registered: [], handlers: {}, commands: [], registerTool(t) { this.registered.push(t.name); }, registerCommand(n) { this.commands.push(n); }, on(ev, h) { this.handlers[ev] = h; } };
const mod = await import(process.env.MULTIPI_PLUGIN_DIR + "/extension/index.ts");
if (typeof mod.default !== "function") { console.error("extension default export is not a factory"); process.exit(1); }
mod.default(pi);
const want = ["devloop.dispatch", "devloop.cancel", "devloop.pause", "devloop.gate", "devloop.merge", "devloop.status"].join(",");
if (pi.registered.join(",") !== want) { console.error("registered tools:", pi.registered.join(",")); process.exit(1); }
for (const ev of ["agent_before_settle", "tool_result", "session_start", "session_tree"]) {
  if (typeof pi.handlers[ev] !== "function") { console.error("missing hook:", ev); process.exit(1); }
}
if (pi.commands.join(",") !== "devloop-agents") { console.error("commands:", pi.commands.join(",")); process.exit(1); }
' >/dev/null 2>&1 && pass "extension registers the six devloop tools, hooks, and /devloop-agents" || fail "extension registration probe"

# --- extension: a child process (MULTIPI_CHILD) registers nothing -----------
MULTIPI_PLUGIN_DIR="$plugin" MULTIPI_CHILD=1 node --input-type=module -e '
const pi = { registered: [], handlers: {}, registerTool(t) { this.registered.push(t.name); }, on(ev, h) { this.handlers[ev] = h; } };
const mod = await import(process.env.MULTIPI_PLUGIN_DIR + "/extension/index.ts");
mod.default(pi);
if (pi.registered.length !== 0) { console.error("child registered tools:", pi.registered.join(",")); process.exit(1); }
if (Object.keys(pi.handlers).length !== 0) { console.error("child registered hooks:", Object.keys(pi.handlers).join(",")); process.exit(1); }
' >/dev/null 2>&1 && pass "a child process (MULTIPI_CHILD) registers no tools and no hooks" || fail "child extension guard"

echo "smoke: $passed passed, $failed failed (work dir $work)"
[ "$failed" -eq 0 ]
