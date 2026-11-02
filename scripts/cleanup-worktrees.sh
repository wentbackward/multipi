#!/usr/bin/env bash
# cleanup-worktrees.sh — collect the worktree litter left by earlier loop versions.
#
# Removes ISSUE worktrees of THIS repository when:
#   - the worktree is CLEAN (uncommitted work is never destroyed), and
#   - its branch is gone from the remote (i.e. the ticket merged and its branch deleted),
#   - it is not the gate worktree and not the main worktree.
# Everything else is listed as KEPT with the reason — a collector, not a bulldozer.
#
# Usage: scripts/cleanup-worktrees.sh [repo-root]     (default: $PWD)
set -u
if [ -n "${1:-}" ]; then
  git -C "$1" rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repo: $1" >&2; exit 2; }
  cd "$1" || exit 2
fi
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"
dl_load_config required

removed=0
kept=0
while read -r wt _h branch; do
  [ -n "$wt" ] || continue
  [ "$wt" = "$DL_ROOT" ] && continue
  case "${branch#refs/heads/}" in gate*) echo "KEPT  $wt  (gate worktree)"; kept=$((kept+1)); continue;; esac
  if [ -z "$branch" ]; then
    echo "KEPT  $wt  (detached HEAD — not a ticket worktree)"; kept=$((kept+1)); continue
  fi
  br=${branch#refs/heads/}
  if git rev-parse --verify -q "$DL_REMOTE/$br" >/dev/null 2>&1; then
    echo "KEPT  $wt  (branch $br still on $DL_REMOTE)"; kept=$((kept+1)); continue
  fi
  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    echo "KEPT  $wt  (dirty — uncommitted work)"; kept=$((kept+1)); continue
  fi
  if git worktree remove "$wt" >/dev/null 2>&1; then
    git branch -q -D "$br" >/dev/null 2>&1 || true
    echo "REMOVED $wt  (branch $br)"
    removed=$((removed+1))
  else
    echo "KEPT  $wt  (worktree remove failed)"; kept=$((kept+1))
  fi
done < <(git worktree list --porcelain | awk '$1 == "worktree" { wt = $2 } $1 == "HEAD" { h = $2 } $1 == "branch" { print wt, h, $2 } $1 == "detached" { print wt, h, "" }')
git worktree prune >/dev/null 2>&1 || true
echo "cleanup: $removed removed, $kept kept"
exit 0
