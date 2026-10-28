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
