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
#   CLOSED : a PR is MERGED (work has landed), or the branch's ticket exists but
#            is not open (not planned) and no PR is live —
#   STALE  : no live PR, no open issue, and the last commit is older than
#            cleanup.stale_days (default 14, read via `cfg cleanup.stale_days 14`).
#            A branch NUMBER counts as a ticket only when that number is in the
#            tracker's open+closed issue set — a bare number that matches no
#            ticket (chore/2026-backup) is not one and falls into STALE.
# Classification is FAIL-CLOSED: a tracker query may fail without saying "does
# not exist". If gh is missing or unauthenticated, or EITHER issue-list fetch or
# a per-branch pr query fails mid-run, the worktree is KEPT ("cannot classify") —
# removal always demands a POSITIVE classification.
# Always KEPT (printed with the reason, in both modes):
#   - the main worktree (never listed) and the gate worktree, plus detached heads
#     (not ticket worktrees),
#   - DIRTY worktrees (uncommitted work is never destroyed — the rule is unchanged),
#   - branches that are still on the remote,
#   - branches with an open PR or an open issue,
#   - anything unclassifiable (tracker unreachable or a failed query).
# A FAILED `git branch -D` after the worktree removal is reported as WARN (the
# deletion log must not lie); the exit code stays 0 (reruns are idempotent).
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

# Tracker snapshot, read ONCE up front (offline-safe: fake-gh serves the same
# surface). Both fetches must succeed or nothing below is classifiable — a failed
# fetch is a negative signal, never "the ticket does not exist".
have_gh=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then have_gh=1; fi
open_raw=""
closed_raw=""
tracker_ok=0
if [ "$have_gh" -eq 1 ]; then
  open_raw=$(gh issue list --state open --json number --limit 500 2>/dev/null) &&
    closed_raw=$(gh issue list --state closed --json number --limit 500 2>/dev/null) &&
    tracker_ok=1
fi
# nums_of: layout-agnostic — real gh emits ONE compact array line, and future
# clients may pretty-print; every "number" field yields one line.
nums_of() { grep -oE '"number"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$'; }
open_set=$(printf '%s\n' "$open_raw" | nums_of | tr '\n' ' ')
closed_set=$(printf '%s\n' "$closed_raw" | nums_of | tr '\n' ' ')
num_in_set() { # num_in_set SET NUM
  case " $1 " in
    *" $2 "*) return 0 ;;
  esac
  return 1
}
pr_states_of() { # pr_states_of BRANCH -> raw PR state list; rc != 0 on query failure
  # A LIST (not pr view) is the query: exit 0 with [] is "no PR", non-zero is a
  # failure — pr view reports both with the same rc and would blur them.
  gh pr list --head "$1" --json state 2>/dev/null
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
      echo "REMOVED $1  ($3; branch $2)"
      git branch -q -D "$2" >/dev/null 2>&1 ||
        echo "WARN  $2: local branch delete FAILED after worktree removal (branch survives)"
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
# worktree paths may contain spaces: capture the REST OF THE LINE and carry the
# PATH first — with a whitespace IFS char a LEADING empty field would be stripped
# away, but a trailing one (detached => no branch) is not, so read path, branch.
while IFS=$'\t' read -r wt br; do
  [ -n "$wt" ] || continue
  [ "$wt" = "$DL_ROOT" ] && continue
  [ "$wt" = "$gate_dir" ] && { keep "$wt" "gate worktree"; continue; }
  case ${br#refs/heads/} in gate*) keep "$wt" "gate worktree"; continue ;; esac
  if [ -z "$br" ]; then
    keep "$wt" "detached HEAD — not a ticket worktree"; continue
  fi
  br=${br#refs/heads/}
  if git rev-parse --verify -q "$DL_REMOTE/$br" >/dev/null 2>&1; then
    keep "$wt" "branch $br still on $DL_REMOTE"; continue
  fi
  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    keep "$wt" "dirty — uncommitted work"; continue
  fi
  # Clean, branch gone from the remote: classify the tracked work via the tracker.
  if [ "$tracker_ok" -ne 1 ]; then
    keep "$wt" "tracker unreachable — cannot classify"; continue
  fi
  num=$(printf '%s\n' "${br##*/}" | sed -nE 's/^([0-9]+).*/\1/p')
  if [ -n "$num" ] && num_in_set "$open_set" "$num"; then
    keep "$wt" "open issue #$num"; continue
  fi
  states=$(pr_states_of "$br") || { keep "$wt" "pr query failed — cannot classify"; continue; }
  case $states in
    *OPEN*) keep "$wt" "open PR for $br"; continue ;;
    *MERGED*) take "$wt" "$br" "closed: merged-and-closed"; continue ;;
  esac
  if [ -n "$num" ] && num_in_set "$closed_set" "$num"; then
    take "$wt" "$br" "closed: ticket closed without a PR"; continue
  fi
  # No live PR, and the branch number is no ticket on the tracker (or there is
  # none at all): the STALE bucket, age-gated by cleanup.stale_days.
  last=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0)
  idle_days=$(( (now - last) / 86400 ))
  if [ $((now - last)) -gt $((stale_days * 86400)) ]; then
    take "$wt" "$br" "stale: last commit ${idle_days}d old (> ${stale_days}d limit)"
  else
    keep "$wt" "idle ${idle_days}d within ${stale_days}d — too young to be stale"
  fi
done < <(git worktree list --porcelain | awk '
  $1 == "worktree" { wt = substr($0, 10) }
  $1 == "branch"   { print wt "\t" substr($0, 8) }
  $1 == "detached" { print wt "\t" }')
git worktree prune >/dev/null 2>&1 || true
echo "cleanup: $removed removed, $dryrun dry-run, $kept kept"
exit 0
