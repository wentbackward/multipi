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

# Worktrees: one consolidated dir per project (under state), gate inside it.
expect "worktree dir defaults under state, not beside the repo" \
  "$work/home/project/worktrees/project" "$(cfg_out 'dl_worktree_dir')"
expect "gate dir defaults inside the worktree dir" \
  "$work/home/project/worktrees/project/gate" "$(cfg_out 'dl_gate_dir')"
cp .devloop.json /tmp/.smoke-devloop-backup
printf '{"worktree_dir":"/tmp/elsewhere"}' > .devloop.json
expect "worktree dir honours an explicit worktree_dir" \
  "/tmp/elsewhere" "$(bash -c ". \"$plugin/scripts/lib/common.sh\" && dl_load_config required && dl_worktree_dir")"
printf '{"worktree_dir":"~/wt-home"}' > .devloop.json
expect "worktree dir ~/ expands against HOME" \
  "$work/home2/wt-home" "$(cd "$work/project" && HOME="$work/home2" bash -c ". \"$plugin/scripts/lib/common.sh\" && dl_load_config required && dl_worktree_dir")"
mv /tmp/.smoke-devloop-backup .devloop.json

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

# The stage config must be COMMITTED on the gated branch: the gate reads .devloop.json
# from what is checked out at the train top. The store (outside the repo) is seeded once;
# a canned bash judge decides, as in the stage section below.
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

# --- doctor.sh ----------------------------------------------------------------
out=$(bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
expect "doctor is ready in a healthy fixture" "0" "$rc"
echo "$out" | grep -q "doctor: ready" && pass "doctor prints ready" || fail "doctor did not print ready"
echo "$out" | grep -q "extension runtime" &&
  fail "doctor probed the extension runtime without an installed extension" ||
  pass "doctor silently skips the extension runtime check"
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

mkcfg '' # restore the base fixture config
rm -rf "$store_dir"

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
# Consent semantics: WITHOUT --apply the script only lists removal candidates as
# DRYRUN and deletes nothing; WITH --apply it removes CLOSED worktrees (ticket
# closed, branch gone from the remote) and STALE ones (no PR, no open issue,
# last commit older than cleanup.stale_days). Keep-invariants (gate/main kept,
# dirty kept, branch-still-on-remote kept, open issue kept) hold in both modes;
# the scenario store is owner data and survives.
mkcfg '"cleanup": {"stale_days": 2}'
cw() { bash "$plugin/scripts/cleanup-worktrees.sh" "$@" 2>&1; }
gt_dir="$work/home/project/worktrees/project/gate"
wt_base="$work/home/project/worktrees/project"

# Tracker fixtures: a closed, an open and a dirty ticket (number -> branch name).
cl_n=$(gh issue create "closed ticket" "closed body" | sed -nE 's#.*/issues/([0-9]+)$#\1#p')
op_n=$(gh issue create "open ticket" "open body" | sed -nE 's#.*/issues/([0-9]+)$#\1#p')
dt_n=$(gh issue create "dirty ticket" "dirty body" | sed -nE 's#.*/issues/([0-9]+)$#\1#p')
gh issue close "$cl_n" >/dev/null

# Candidates: CLOSED (clean, branch off the remote, ticket closed) and STALE (no PR,
# no open issue, last commit 3 days old > the 2-day limit — GIT_COMMITTER_DATE).
git worktree add -q "$wt_base/issue-$cl_n" -b "feat/$cl_n-closed" origin/main
git worktree add -q "$wt_base/issue-stale-old" -b feat/stale-old origin/main
GIT_COMMITTER_DATE="2020-01-05T00:00:00Z" \
  git -C "$wt_base/issue-stale-old" commit -q --allow-empty -m "chore: old commit"
# Keep cases (all survive --apply):
git worktree add -q "$wt_base/issue-stale-young" -b feat/stale-young origin/main
GIT_COMMITTER_DATE="$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)" \
  git -C "$wt_base/issue-stale-young" commit -q --allow-empty -m "chore: young commit"
git worktree add -q "$wt_base/issue-$op_n" -b "feat/$op_n-open" origin/main
git worktree add -q "$wt_base/issue-$dt_n" -b "feat/$dt_n-dirty" origin/main
echo scratch >"$wt_base/issue-$dt_n/scratch.txt"
git worktree add -q "$wt_base/issue-remote" -b feat/remote-kept origin/main
git push -q origin feat/remote-kept
# A merged PR whose issue is still OPEN (close lag): kept — "closed" means merged-and-CLOSED.
lag_n=$(gh issue create "merged but issue still open" "lag body" | sed -nE 's#.*/issues/([0-9]+)$#\1#p')
git worktree add -q "$wt_base/issue-$lag_n" -b "feat/$lag_n-merged" origin/main
gh pr create --head "feat/$lag_n-merged" --base main --title "feat: lag ($lag_n)" >/dev/null
echo MERGED >"$FAKE_GH_DIR/feat_${lag_n}-merged.state"

# DRYRUN mode: candidates listed, nothing deleted.
out=$(cw); rc=$?
echo "$out"
expect "cleanup without --apply exits 0" "0" "$rc"
printf '%s\n' "$out" | grep -q "^DRYRUN $wt_base/issue-$cl_n  (closed: ticket closed" &&
  pass "the closed worktree is listed as DRYRUN with a closed reason" ||
  fail "no closed DRYRUN line (want: DRYRUN $wt_base/issue-$cl_n  (closed: ...))"
printf '%s\n' "$out" | grep -q "^DRYRUN $wt_base/issue-stale-old  (stale: " &&
  pass "the stale worktree is listed as DRYRUN with a stale reason" ||
  fail "no stale DRYRUN line"
[ "$(printf '%s\n' "$out" | grep -c '^REMOVED')" = 0 ] &&
  pass "the dry run removes nothing" || fail "the dry run removed something"
[ "$(printf '%s\n' "$out" | grep -c '^DRYRUN')" = 2 ] &&
  pass "exactly the two candidates are listed" || fail "dry-run candidate count wrong"
printf '%s\n' "$out" | grep -q "^KEPT  $gt_dir  (gate worktree)" &&
  pass "the gate worktree is kept" || fail "the gate worktree was not kept"
[ -n "$(printf '%s\n' "$out" | grep "^KEPT  $wt_base/issue-stale-young")" ] &&
  pass "a too-young worktree is kept (idle < stale_days)" || fail "the young worktree was not kept"
printf '%s\n' "$out" | grep -q "^KEPT  $wt_base/issue-$op_n  (open issue #$op_n)" &&
  pass "a worktree whose branch has an open issue is kept" || fail "the open-issue worktree was not kept"
printf '%s\n' "$out" | grep -q "^KEPT  $wt_base/issue-$dt_n  (dirty" &&
  pass "a dirty worktree is kept" || fail "the dirty worktree was not kept"
printf '%s\n' "$out" | grep -q "^KEPT  $wt_base/issue-remote  (branch feat/remote-kept still on origin)" &&
  pass "a worktree whose branch is still on the remote is kept" || fail "the remote-branch worktree was not kept"
printf '%s\n' "$out" | grep -q "^KEPT  $wt_base/issue-$lag_n  (open issue #$lag_n)" &&
  pass "a merged-PR worktree with a still-open issue is kept (merged-and-closed only)" ||
  fail "the merged-but-open worktree was not kept"
printf '%s' "$out" | grep -qF " $work/project" &&
  fail "the main worktree was listed" || pass "the main worktree is never listed"
[ -d "$wt_base/issue-$cl_n" ] && [ -d "$wt_base/issue-stale-old" ] &&
  pass "the dry run leaves the candidate worktrees in place" || fail "the dry run touched a candidate"
expect "the dry-run summary counts removed/dry-run/kept" \
  "cleanup: 0 removed, 2 dry-run, 6 kept" "$(printf '%s\n' "$out" | tail -1)"

# The scenario store is owner data: populate it, then --apply must leave every file.
mkdir -p "$store_dir"
write_scen c1-delta.md c1-delta "Delta works" true
write_scen c2-omega.md c2-omega "Omega works" false
store_count_before=$(find "$store_dir" -mindepth 1 -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')

# --apply mode: removes exactly the closed and the stale worktree, keeps everything else.
out=$(cw --apply); rc=$?
echo "$out"
expect "cleanup --apply exits 0" "0" "$rc"
[ "$(printf '%s\n' "$out" | grep -c '^REMOVED')" = 2 ] &&
  pass "exactly the two candidates are removed" || fail "--apply removed the wrong set"
printf '%s\n' "$out" | grep -q "^REMOVED $wt_base/issue-$cl_n" &&
  pass "the closed worktree is removed" || fail "the closed worktree was not removed"
printf '%s\n' "$out" | grep -q "^REMOVED $wt_base/issue-stale-old" &&
  pass "the stale worktree is removed" || fail "the stale worktree was not removed"
[ ! -d "$wt_base/issue-$cl_n" ] && [ ! -d "$wt_base/issue-stale-old" ] &&
  pass "the removed worktrees are gone from disk" || fail "a removed worktree dir remains"
[ -z "$(git branch --list "feat/$cl_n-closed")" ] && [ -z "$(git branch --list feat/stale-old)" ] &&
  pass "the removed branches are deleted locally" || fail "a removed branch remains"
[ -d "$wt_base/issue-$op_n" ] && [ -d "$wt_base/issue-$dt_n" ] &&
  [ -d "$wt_base/issue-stale-young" ] && [ -d "$wt_base/issue-remote" ] && [ -d "$wt_base/issue-$lag_n" ] &&
  [ -d "$gt_dir" ] &&
  pass "the kept worktrees survive --apply" || fail "--apply removed a kept worktree"
store_count_after=$(find "$store_dir" -mindepth 1 -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
[ "$store_count_before" = "$store_count_after" ] && [ -f "$store_dir/c1-delta.md" ] &&
  [ -f "$store_dir/c2-omega.md" ] &&
  pass "every scenario store file survives --apply" || fail "the scenario store was damaged"
expect "the applied summary counts removed/dry-run/kept" \
  "cleanup: 2 removed, 0 dry-run, 6 kept" "$(printf '%s\n' "$out" | tail -1)"

# Idempotent: a second --apply finds nothing to do.
out=$(cw --apply)
expect "a second --apply changes nothing (idempotent)" "cleanup: 0 removed, 0 dry-run, 6 kept" \
  "$(printf '%s\n' "$out" | tail -1)"

# Operator errors: an unknown flag is a usage error.
cw --bogus >/dev/null 2>&1
expect "an unknown flag is a usage error" "2" "$?"

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

mkcfg '' # restore the base fixture config
rm -rf "$store_dir"

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
