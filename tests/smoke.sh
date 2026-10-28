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
mv .devloop.json .devloop.json.bak
out=$(bash "$plugin/scripts/doctor.sh" 2>&1)
rc=$?
echo "$out"
[ "$rc" -ne 0 ] && pass "doctor fails without config" || fail "doctor passed without config"
echo "$out" | grep -q "MISSING .*\.devloop.json" && pass "doctor names the missing config" ||
  fail "doctor did not name the missing config"
mv .devloop.json.bak .devloop.json

echo "smoke: $passed passed, $failed failed (work dir $work)"
[ "$failed" -eq 0 ]
