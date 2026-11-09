#!/usr/bin/env bash
# cleanup-worktrees.sh — collect the ticket worktrees the loop has outgrown.
#
# Consent semantics (dark-factory spec §1/§6): WITHOUT --apply nothing is deleted —
# every removal candidate is printed as DRYRUN. WITH --apply the candidates are
# removed (worktree + local branch). A dark factory orchestrator runs --apply each
# loop cycle; in collaborative mode --apply is the operator's consent.
#
# Removal candidates — CLEAN ticket worktrees whose branch is GONE FROM THE REMOTE
# and whose tracked work is done or abandoned. An OPEN ISSUE for the branch always
# wins over every removal reason (a merged-but-not-yet-closed ticket keeps its
# worktree — "closed" means merged-and-CLOSED):
#   CLOSED : a PR is MERGED (merged-and-closed), or the ticket exists but is not
#            open (not planned) —
#   STALE  : no PR and no open issue for the branch, and the last commit is older
#            than cleanup.stale_days (default 14, read via `cfg cleanup.stale_days 14`).
# Always KEPT (printed with the reason, in both modes):
#   - the main worktree (never listed) and the gate worktree, plus detached heads
#     (not ticket worktrees),
#   - DIRTY worktrees (uncommitted work is never destroyed — the rule is unchanged),
#   - branches that are still on the remote,
#   - branches with an open PR or an open issue,
#   - anything unclassifiable when the tracker is unreachable (gh missing or
#     unauthenticated): removal demands a POSITIVE classification.
# The scenario store is owner data: it lives outside every worktree and is never touched.
#
# Usage: scripts/cleanup-worktrees.sh [--apply] [repo-root]   (default: $PWD)
# Exit: 0 done (dry-run or applied; idempotent); 2 usage or config error.
set -u

usage() {
  echo "usage: cleanup-worktrees.sh [--apply] [repo-root]" >&2
}

apply=0
repo=""
for a in "$@"; do
  case $a in
    --apply) apply=1 ;;
    -*) usage; exit 2 ;;
    *)
      [ -z "$repo" ] || { usage; exit 2; }
      repo=$a
      ;;
  esac
done
if [ -n "$repo" ]; then
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repo: $repo" >&2; exit 2; }
  cd "$repo" || exit 2
fi
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"
dl_load_config required

stale_days=$(cfg cleanup.stale_days 14)
case $stale_days in
  *[!0-9]* | '') dl_die "cleanup.stale_days must be a non-negative integer (got: $stale_days)" ;;
esac

gate_dir=$(dl_gate_dir)

# Tracker state, read once (offline-safe: fake-gh serves the same surface).
have_gh=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then have_gh=1; fi
open_issues=""
if [ "$have_gh" -eq 1 ]; then
  open_issues=$(gh issue list --state open --json number 2>/dev/null |
    sed -n 's/.*"number"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*$/\1/p') || open_issues=""
fi
issue_is_open() { # issue_is_open N
  [ -n "$1" ] && printf '%s\n' "$open_issues" | grep -qx -- "$1"
}
issue_exists() { # issue_exists N  (open OR closed)
  [ -n "$1" ] && gh issue view "$1" --json title >/dev/null 2>&1
}
pr_state_of() { # pr_state_of BRANCH -> OPEN|MERGED|...|"" (no PR)
  gh pr view "$1" --json state --jq .state 2>/dev/null || true
}

removed=0
dryrun=0
kept=0
keep() { # keep WT REASON
  echo "KEPT  $1  ($2)"
  kept=$((kept + 1))
}
take() { # take WT BR REASON — DRYRUN without --apply, removal with
  if [ "$apply" -eq 1 ]; then
    if git worktree remove "$1" >/dev/null 2>&1; then
      git branch -q -D "$2" >/dev/null 2>&1 || true
      echo "REMOVED $1  ($3; branch $2)"
      removed=$((removed + 1))
    else
      keep "$1" "worktree remove failed"
    fi
  else
    echo "DRYRUN $1  ($3)"
    dryrun=$((dryrun + 1))
  fi
}

now=$(date +%s)
while read -r wt _h branch; do
  [ -n "$wt" ] || continue
  [ "$wt" = "$DL_ROOT" ] && continue
  [ "$wt" = "$gate_dir" ] && { keep "$wt" "gate worktree"; continue; }
  case "${branch#refs/heads/}" in gate*) keep "$wt" "gate worktree"; continue ;; esac
  if [ -z "$branch" ]; then
    keep "$wt" "detached HEAD — not a ticket worktree"; continue
  fi
  br=${branch#refs/heads/}
  if git rev-parse --verify -q "$DL_REMOTE/$br" >/dev/null 2>&1; then
    keep "$wt" "branch $br still on $DL_REMOTE"; continue
  fi
  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    keep "$wt" "dirty — uncommitted work"; continue
  fi
  # Clean, branch gone from the remote: classify the tracked work via the tracker.
  num=$(printf '%s\n' "${br##*/}" | sed -nE 's/^([0-9]+).*/\1/p')
  if [ "$have_gh" -ne 1 ]; then
    keep "$wt" "tracker unreachable (gh missing or unauthenticated) — cannot classify"; continue
  fi
  if [ -n "$num" ] && issue_is_open "$num"; then
    keep "$wt" "open issue #$num"; continue
  fi
  pr=$(pr_state_of "$br")
  case $pr in
    MERGED) take "$wt" "$br" "closed: merged-and-closed" ;;
    OPEN) keep "$wt" "open PR for $br" ;;
    *)
      if [ -n "$num" ] && issue_exists "$num"; then
        take "$wt" "$br" "closed: ticket closed without a PR"
      else
        # No PR, no open issue: the STALE bucket, age-gated by cleanup.stale_days.
        last=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0)
        idle_days=$(( (now - last) / 86400 ))
        if [ $((now - last)) -gt $((stale_days * 86400)) ]; then
          take "$wt" "$br" "stale: last commit ${idle_days}d old (> ${stale_days}d limit)"
        else
          keep "$wt" "idle ${idle_days}d within ${stale_days}d — too young to be stale"
        fi
      fi
      ;;
  esac
done < <(git worktree list --porcelain | awk '$1 == "worktree" { wt = $2 } $1 == "HEAD" { h = $2 } $1 == "branch" { print wt, h, $2 } $1 == "detached" { print wt, h, "" }')
git worktree prune >/dev/null 2>&1 || true
echo "cleanup: $removed removed, $dryrun dry-run, $kept kept"
exit 0
