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
