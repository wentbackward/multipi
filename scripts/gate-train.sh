#!/usr/bin/env bash
# Gate a batch of ready branches with ONE full run of the project's checks (a merge train).
#
# Usage: gate-train.sh <branch> [<branch> ...]          (branches in merge order)
#
# In the gate worktree, stacks each <remote>/<branch> on the latest <remote>/<base> in order, keeping each
# branch's rebased head as train-<branch>. A branch already stacked on the previous one in the train replays
# only its own commits (rebase --onto), so no branch ever carries foreign commits. Then it runs every check
# of .devloop.json "checks" once on the top of the stack; heavy checks run through heavy.sh, so the
# machine-wide slot limit and memory cap apply. The gate's own git work and every check run with
# the dogfood policy-shim dirs SCRUBBED from PATH (entries whose git or gh is an interpreted
# script, 2-byte `#!` magic — ticket #70, authority separation); the seam
# MULTIPI_GATE_SCRUB_POLICY_SHIMS controls it (default 1 = scrub; 0 restores the armed PATH).
# When the scenario store is on (dark-factory spec §5), the
# scenario stage (scenario-stage.sh) then runs on the train top: a red stage is TRAIN RED (no record), the
# stage's exit 2 propagates as the gate's exit 2, and a failed check prints `scenarios skipped` instead.
# Every terminal path also records the LAST-GATE ARTIFACT <state>/gate-last.txt (one line:
# `result=green|red ts=<ms> detail=<failing-checks|gate_setup|scenarios|-> logdir=<logs>`) — the
# board's "last gate" source (ticket #103); additive, it carries no new exit-code contract.
#
# Exit: 0 TRAIN GREEN (recorded for merge-train.sh), 1 TRAIN RED (includes gate_setup failure),
# 2 usage/config (includes a stage usage/config error), 3 rebase conflict (the output names the branch:
# drop it from the train, rebase it after the others merge).
set -u
# Pure-bash bootstrap (no dirname, no pwd(1)): a PATH the scrub below empties entirely
# carries no coreutils, and the named dl_die must still be reachable (ticket #67).
# The cd runs in a SUBSHELL — the script's cwd must stay where the operator called it.
case "${BASH_SOURCE[0]}" in
  */*) _sd=${BASH_SOURCE[0]%/*} ;;
  *) _sd=. ;;
esac
scripts_dir=$(cd -- "$_sd" && printf '%s' "$PWD")
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"

[ $# -gt 0 ] || dl_die "usage: gate-train.sh <branch> [<branch> ...]"

# --- policy-shim PATH scrub (ticket #70, authority separation) ----------------------
# The dogfood policy shims protect the loop's SESSIONS; they must never veto the loop's
# own verification. Rebuild PATH dropping every entry whose git or gh is an INTERPRETED
# script (2-byte `#!` magic — dl_scrub_policy_shims, lib/common.sh) BEFORE any git work
# of the gate (config load, worktree setup, stacking, checks, stage). Seam
# MULTIPI_GATE_SCRUB_POLICY_SHIMS: default 1 (scrub); 0 restores the armed PATH for
# tests that exercise the armed posture.
if [ "${MULTIPI_GATE_SCRUB_POLICY_SHIMS:-1}" != 0 ]; then
  PATH=$(dl_scrub_policy_shims "$PATH")
  # Named error, not a downstream command-not-found cascade (review of #70 r1): the
  # bootstrap and the scrub are pure shell, so this is reachable even with PATH gone.
  [ -n "$PATH" ] || dl_die "policy-shim scrub emptied PATH (every entry carried an interpreted git or gh — nothing left to run)"
  export PATH
fi

dl_load_config required
[ "$(cfg_len checks)" -gt 0 ] || dl_die "no \"checks\" in $DL_CONFIG"

gate=$(dl_ensure_gate_worktree) || exit 2
logs=$(dl_logs_dir)
mkdir -p "$logs" "$DL_STATE" || dl_die "cannot create $logs"
train_file=$(dl_train_file)
rm -f "$train_file"
last_file="$DL_STATE/gate-last.txt"
# gate_record RESULT DETAIL — write the last-gate artifact (ticket #103): the board reads it,
# nothing else consumes it. tmp+rename so a concurrent read never sees a torn line.
gate_record() {
  local ts
  ts=$(date +%s%3N)
  printf 'result=%s ts=%s detail=%s logdir=%s\n' "$1" "$ts" "$2" "$logs" >"$last_file.tmp.$$" && mv "$last_file.tmp.$$" "$last_file"
}
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

# --- codified conflict rules (ticket #134) -------------------------------------
# The rebase step auto-resolves a conflict only when EVERY unmerged file is covered by
# a deterministic rule; a single uncovered file refuses exactly as before (exit 3,
# branch named). The rules:
#   docs/DECISIONS.md — decisions-chronological-union: keep both additions, ordered by
#     the date line (`- YYYY-MM-DD …`), the lower train branch breaking ties; entries
#     already present in the shared context collapse (union, not concatenation) — and a
#     context entry that the upper side rewrote to a same-dated amendment is dropped
#     together with its stale twin (modify-vs-append, ticket #145 folded into #134):
#     the upper side's final line survives, a stale duplicate never does.
#   tests/smoke.sh — smoke-additive-both: an additive hunk on either side survives
#     (`git merge-file --union` keeps both, in file order, lower branch first).
# Each resolution is logged `auto-resolved: <rule> on <file>` (the gate output) and
# the resolved file is kept beside the gate logs. An uncovered file, or one with no
# stage blob at all, refuses exactly as before; a missing single stage (add/add: no
# base, delete/modify: no ours/theirs) resolves against an empty side.

RULE_DECISIONS="decisions-chronological-union"
RULE_SMOKE="smoke-additive-both"

# conflict_rule FILE — echo the rule covering FILE, or nothing.
conflict_rule() {
  case "$1" in
    docs/DECISIONS.md) printf '%s\n' "$RULE_DECISIONS" ;;
    tests/smoke.sh) printf '%s\n' "$RULE_SMOKE" ;;
  esac
}

# stage_blob FILE STAGE — the staged blob sha of an unmerged file (1 base, 2 ours, 3 theirs).
stage_blob() {
  git ls-files -u -- "$1" | awk -v s="$2" '$3 == s { print $2; exit }'
}

# resolve_decisions BASE-TMP OURS-TMP THEIRS-TMP — the chronological union described
# above, with the modify-vs-append extension (ticket #145 folded into #134). Shared
# head lines print verbatim; then every entry of either tail sorted by date, branch
# rank (ours first) and position, deduped against each other AND against the head
# (an entry the context already carries is not re-appended); any non-entry tail line
# (the file is one line per entry — prose is the exception) rides after the entries,
# ours first then theirs, never dropped.
# THE AMENDMENT EXTENSION: a stale line is a dated ours-tail entry that base carried
# past the shared prefix and theirs no longer carries (ours kept it, theirs rewrote
# or deleted it); a novel line is a dated theirs-tail entry base never carried (the
# rewrite). A stale line is dropped — its amendment kept, the duplicate gone — only
# when the counts of stale and novel entries on its date line agree exactly and are
# non-zero: the amend keeps the entry's date (it rewords the decision line, not the
# decision day), so a same-day rewrite yields exactly one new line per old line. Any
# disagreement keeps the plain union for that date — conservative: an amendment line
# is never lost, and an ambiguous shape at worst leaves the stale line beside it
# instead of inventing a drop. Detection is over the three stage blobs (content
# level); no git diff is consulted.
DECISIONS_ENTRY_RE='^- [0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]]'
resolve_decisions() {
  local -a a b c
  mapfile -t c <"$1"
  mapfile -t a <"$2"
  mapfile -t b <"$3"
  local n=${#a[@]} m=${#b[@]} clen=${#c[@]} p=0 i j
  while [ "$p" -lt "$n" ] && [ "$p" -lt "$m" ] && [ "${a[$p]}" = "${b[$p]}" ]; do
    p=$((p + 1))
  done
  for ((i = 0; i < p; i++)); do printf '%s\n' "${a[$i]}"; done
  local seen drop btmp ctmp d cs cn
  seen=$(mktemp); drop=$(mktemp); btmp=$(mktemp); ctmp=$(mktemp)
  { for ((i = 0; i < m; i++)); do printf '%s\n' "${b[i]}"; done } >"$btmp"
  { for ((i = p; i < clen; i++)); do printf '%s\n' "${c[i]}"; done } >"$ctmp"
  # stale/novel as the block above describes; dates parallel the line arrays.
  local -a stale=() novel=() stale_dates=() novel_dates=()
  for ((i = p; i < n; i++)); do
    [[ "${a[$i]}" =~ $DECISIONS_ENTRY_RE ]] || continue
    grep -Fxq -- "${a[$i]}" "$ctmp" || continue
    grep -Fxq -- "${a[$i]}" "$btmp" && continue
    stale+=("${a[$i]}")
  done
  for ((i = p; i < m; i++)); do
    [[ "${b[$i]}" =~ $DECISIONS_ENTRY_RE ]] || continue
    grep -Fxq -- "${b[$i]}" "$1" && continue
    novel+=("${b[$i]}")
  done
  for ((i = 0; i < ${#stale[@]}; i++)); do
    stale_dates[i]=$(printf '%s' "${stale[i]}" | cut -c3-12)
  done
  for ((i = 0; i < ${#novel[@]}; i++)); do
    novel_dates[i]=$(printf '%s' "${novel[i]}" | cut -c3-12)
  done
  for ((i = 0; i < ${#stale[@]}; i++)); do
    d=${stale_dates[i]} cs=0 cn=0
    for ((j = 0; j < ${#stale[@]}; j++)); do
      [ "${stale_dates[j]}" = "$d" ] && cs=$((cs + 1))
    done
    for ((j = 0; j < ${#novel[@]}; j++)); do
      [ "${novel_dates[j]}" = "$d" ] && cn=$((cn + 1))
    done
    if [ "$cs" = "$cn" ] && [ "$cs" -ge 1 ]; then
      printf '%s\n' "${stale[i]}" >>"$drop"
    fi
  done
  {
    for ((i = p; i < n; i++)); do
      if [[ "${a[$i]}" =~ $DECISIONS_ENTRY_RE ]]; then
        printf '%s\t0\t%s\t%s\n' "$(printf '%s' "${a[$i]}" | cut -c3-12)" "$i" "${a[$i]}"
      fi
    done
    for ((i = p; i < m; i++)); do
      if [[ "${b[$i]}" =~ $DECISIONS_ENTRY_RE ]]; then
        printf '%s\t1\t%s\t%s\n' "$(printf '%s' "${b[$i]}" | cut -c3-12)" "$i" "${b[$i]}"
      fi
    done
  } | LC_ALL=C sort -t "$(printf '\t')" -k1,1 -k2,2n -k3,3n | awk -F'\t' '
    FILENAME == ARGV[1] { seen[$0] = 1; next }
    FILENAME == ARGV[2] { drop[$0] = 1; next }
    { line = $4; for (i = 5; i <= NF; i++) line = line "\t" $i; if (!(line in seen) && !(line in drop)) { seen[line] = 1; print line } }
  ' "$seen" "$drop" -
  rm -f "$seen" "$drop" "$btmp" "$ctmp"
  for ((i = p; i < n; i++)); do
    [[ "${a[$i]}" =~ $DECISIONS_ENTRY_RE ]] || printf '%s\n' "${a[$i]}"
  done
  for ((i = p; i < m; i++)); do
    [[ "${b[$i]}" =~ $DECISIONS_ENTRY_RE ]] || printf '%s\n' "${b[$i]}"
  done
}

# stack_branch BRANCH — replay BRANCH onto $base_ref: rule-resolve fully covered
# conflicts (logging each), refuse everything else (exit 3, branch named — the
# original contract). $logs holds the resolved-file artifacts.
stack_branch() {
  local branch=$1 advance rule file entry sb so st d unmerged unresolved
  local -a covered=()
  advance=rebase
  while :; do
    if [ "$advance" = rebase ]; then
      git rebase -q --onto "$base_ref" "$(upstream_of "$branch")" >/dev/null 2>&1 && return 0
    else
      GIT_EDITOR=true git rebase --continue >/dev/null 2>&1 && return 0
    fi
    advance="continue"
    unmerged=$(git diff --name-only --diff-filter=U)
    [ -n "$unmerged" ] || break
    covered=()
    unresolved=""
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      rule=$(conflict_rule "$file")
      sb=$(stage_blob "$file" 1); so=$(stage_blob "$file" 2); st=$(stage_blob "$file" 3)
      if [ -z "$rule" ] || [ -z "$sb$so$st" ]; then
        unresolved=$file
        break
      fi
      covered+=("$file|$rule|$sb|$so|$st")
    done <<<"$unmerged"
    [ -z "$unresolved" ] || break
    d=$logs/rebase-auto-$(printf '%s' "$branch" | tr '/' '_').d
    mkdir -p "$d"
    for entry in "${covered[@]}"; do
      IFS='|' read -r file rule sb so st <<<"$entry"
      # A missing stage blob (add/add: no base; delete/modify: no ours/theirs) is an
      # EMPTY side — resolve against it; a bare cat-file would print a fatal into the
      # gate output.
      [ -n "$sb" ] && git cat-file blob "$sb" >"$d/base" || : >"$d/base"
      [ -n "$so" ] && git cat-file blob "$so" >"$d/ours" || : >"$d/ours"
      [ -n "$st" ] && git cat-file blob "$st" >"$d/theirs" || : >"$d/theirs"
      case "$rule" in
        "$RULE_DECISIONS") resolve_decisions "$d/base" "$d/ours" "$d/theirs" >"$d/resolved" ;;
        "$RULE_SMOKE") git merge-file -p --union "$d/ours" "$d/base" "$d/theirs" >"$d/resolved" ;;
      esac
      cp -f "$d/resolved" "$file"
      git add -- "$file"
      cp -f "$d/resolved" "$logs/rebase-auto-$(printf '%s' "$branch" | tr '/' '_')-$(printf '%s' "$file" | tr '/.' '__').txt"
      printf 'auto-resolved: %s on %s\n' "$rule" "$file"
    done
    rm -rf "$d"
    if git diff --cached --quiet; then
      # The resolution reproduces the current state: the commit is empty — skip it.
      GIT_EDITOR=true git rebase --skip >/dev/null 2>&1 && return 0
    else
      continue
    fi
  done
  git rebase --abort >/dev/null 2>&1
  git checkout -q --detach "$DL_REMOTE/$DL_BASE"
  gate_record red "rebase-conflict-at-$branch"
  echo "TRAIN rebase conflict at $branch"
  exit 3
}

for branch in "$@"; do
  git rev-parse -q --verify "$DL_REMOTE/$branch^{commit}" >/dev/null ||
    dl_die "$DL_REMOTE/$branch does not exist (push the branch first)"
  source_head=$(git rev-parse "$DL_REMOTE/$branch")
  git branch -q -f "train-$branch" "$source_head"
  git checkout -q "train-$branch"
  stack_branch "$branch"
  base_ref="train-$branch"
  previous=$branch
  records+="$branch $source_head $(git rev-parse HEAD) pending"$'\n'
  echo "stacked $branch -> $(git rev-parse --short HEAD)"
done

setup=$(cfg gate_setup "")
if [ -n "$setup" ]; then
  if ! bash -c "$setup" >"$logs/train-setup.log" 2>&1; then
    gate_record red gate_setup
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
failures=""
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
  [ "$rc" -eq 0 ] || { all_green=""; failures="${failures:+$failures,}$name"; }
  pattern=$(check_field "$i" summary "")
  if [ -n "$pattern" ]; then
    summary+="$(grep -E -- "$pattern" "$log" | tail -n 3)"$'\n'
  else
    summary+="$(tail -n 2 "$log")"$'\n'
  fi
done
printf '%s' "$summary" | sed '/^$/d'

# --- scenario stage (dark-factory spec §5) ---------------------------------------
# The on/off call uses the SAME pure module (config.ts: loadConfig + scenariosOn) the
# stage and the doctor use, so all three agree: loadConfig resolves the config from the
# MAIN worktree's .devloop.json, i.e. the same single main-root config the stage and the
# doctor read — NOT whatever is checked out at the train top here. When the call cannot
# be made (no node, no modules, an incomplete module candidate), the stage is skipped:
# the gate degrades to its pre-stage behaviour and the doctor reports the defect — an
# undeterminable store is not a green light for anything.
scen_src=""
for cand in "$DL_ROOT/.pi/extensions/multipi-devloop/src" "$scripts_dir/../extension/src"; do
  # The same three modules the stage itself requires: an incomplete candidate must read
  # as "the call cannot be made" (degrade), never as runnable.
  if [ -f "$cand/config.ts" ] && [ -f "$cand/scenarios.ts" ] && [ -f "$cand/scenario-run.ts" ]; then
    scen_src=$cand
    break
  fi
done
scen_on=off
if [ -n "$scen_src" ] && command -v node >/dev/null 2>&1; then
  detected=$(
    SCEN_SRC=$scen_src node --input-type=module -e '
const { loadConfig, scenariosOn } = await import(process.env.SCEN_SRC + "/config.ts");
const cfg = loadConfig(process.cwd());
process.stdout.write(cfg && scenariosOn(cfg) ? "on" : "off");
' 2>/dev/null
  )
  [ "$detected" = "on" ] && scen_on=on
fi
if [ "$scen_on" = on ] && [ -n "$all_green" ]; then
  # The stage runs on the train top and inherits the gate's stdout; its own lines land in
  # train-scenarios.log. The stage never prints the TRAIN word — this gate owns it. A red
  # stage is a red train WITHOUT the record; the stage's exit 2 (usage/config) propagates
  # as the gate's exit 2, like the gate's own config errors.
  "$scripts_dir/scenario-stage.sh"
  scen_rc=$?
  if [ "$scen_rc" -ne 0 ]; then
    git checkout -q --detach "$DL_REMOTE/$DL_BASE"
    [ "$scen_rc" -eq 2 ] && exit 2
    gate_record red scenarios
    echo "TRAIN RED"
    exit 1
  fi
elif [ "$scen_on" = on ]; then
  echo "scenarios skipped"
fi

git checkout -q --detach "$DL_REMOTE/$DL_BASE"
if [ -n "$all_green" ]; then
  printf '%s' "$records" >"$train_file"
  gate_record green -
  echo "TRAIN GREEN"
  exit 0
fi
gate_record red "$failures"
echo "TRAIN RED"
exit 1
