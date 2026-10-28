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
