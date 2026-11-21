#!/usr/bin/env bash
# Standard post-merge independent verification for contract-touching trains (ticket #108).
#
# The gate already proved the train in the loop's own worktree; this is the independent
# confirmation on a clean environment. The classify mode classifies a MERGED train's diff
# against the shared contracts and renders the standard fresh-clone verifier brief
# (single-sourced in templates/verify-brief.md — shipped into installed targets beside the
# scripts as scripts/verify-brief.template.md); the report mode attaches the verifier's
# report to the train's tickets as the single verification comment, so the human finds
# the proof on the issue, not in a session log.
#
# Usage:
#   verify-brief.sh <pre>..<post> [exercise]
#       Classify the train's diff <pre>..<post> in the current repository and print the
#       standard verifier brief (dispatch it as the verifier child's task, skill §7).
#       [exercise] (optional, one line) is the train-specific contract exercise the
#       verifier runs on top of the standard steps.
#   verify-brief.sh report <ticket> [<ticket> ...] < report.md
#       Attach the verifier's report (on stdin) to every train ticket as one
#       "Post-merge verification" comment; the header verdict rides the report's own
#       `VERIFICATION: PASS` / `VERIFICATION: FAIL` line (absent = plain header).
#
# The dispatch threshold (DECISIONS.md 2026-11-21, #108 — default-ON for anything
# contract-touching): the train touches a shared contract iff its diff carries any of
#   extension/   (incl. the installed .pi/extensions/ mirror)
#   scripts/
#   agents/      (incl. the installed .pi/agents/ mirror)
#   skills/      (incl. the installed .pi/skills/ mirror)
#   the .devloop.json schema (root .devloop.json, templates/devloop.json,
#   .pi/templates/devloop.json)
#   spec docs under docs/superpowers/specs/ (spec-pinned contracts)
# A diff without any of these (docs, tests, README, …) is docs/test-only.
#
# Exit: 0 contract touched — the brief is rendered on stdout (dispatch the verifier),
# 2 usage/config error, 3 internal error (template missing, tracker failure),
# 10 docs/test-only train — no verifier, no verification comment.
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"

# The standard brief, single-sourced: this repo's template, else the installed twin.
verify_template() {
	local cand
	for cand in "$scripts_dir/../templates/verify-brief.md" "$scripts_dir/verify-brief.template.md"; do
		if [ -f "$cand" ]; then
			cat "$cand"
			return 0
		fi
	done
	echo "multipi: verify-brief template not found (templates/verify-brief.md or scripts/verify-brief.template.md — rerun scripts/install.sh)" >&2
	return 3
}

# Literal placeholder render: {{NAME}} -> value (no regex, no escaping surprises).
vb_sub() {
	local s=$1 name=$2 val=$3 pat
	pat="{{${name}}}"
	printf '%s' "${s//"$pat"/$val}"
}

# Classify the range: sets VB_FILES/VB_COUNT/VB_TOUCHED; rc 2 = not a valid range here.
classify_range() {
	local range=$1 f cat NL=$'\n'
	VB_FILES=$(git diff --name-only "$range" 2>/dev/null) || {
		echo "multipi: cannot classify '$range' (not a valid revision range in the current repository)" >&2
		return 2
	}
	VB_COUNT=0
	VB_TOUCHED=""
	while IFS= read -r f; do
		[ -n "$f" ] || continue
		VB_COUNT=$((VB_COUNT + 1))
		case "$f" in
		".devloop.json" | "templates/devloop.json" | ".pi/templates/devloop.json") cat=".devloop.json schema" ;;
		extension/* | .pi/extensions/*) cat="extension/" ;;
		scripts/*) cat="scripts/" ;;
		agents/* | .pi/agents/*) cat="agents/" ;;
		skills/* | .pi/skills/*) cat="skills/" ;;
		docs/superpowers/specs/*) cat="specs" ;;
		*) continue ;;
		esac
		case "$VB_TOUCHED" in
		*"$NL$cat$NL"*) ;; # already counted (newline-delimited list)
		*) VB_TOUCHED="${VB_TOUCHED}${cat}${NL}" ;;
		esac
	done <<<"$VB_FILES"
}

# report mode: attach the single verification comment to every train ticket.
attach_report() {
	local body verdict header text t out bad=0
	[ $# -ge 1 ] || dl_die "usage: verify-brief.sh report <ticket> [<ticket> ...] < report.md"
	dl_load_config required
	command -v gh >/dev/null 2>&1 || {
		echo "multipi: gh (GitHub CLI) is not installed" >&2
		exit 3
	}
	body=$(cat)
	[ -n "$body" ] || dl_die "the report body (stdin) is empty"
	verdict=""
	if printf '%s\n' "$body" | grep -q "VERIFICATION: PASS"; then
		verdict=" — PASS"
	elif printf '%s\n' "$body" | grep -q "VERIFICATION: FAIL"; then
		verdict=" — FAIL"
	fi
	header="## Post-merge verification${verdict}"
	text="$(printf '%s\n\n%s' "$header" "$body")"
	for t in "$@"; do
		if ! out=$(gh issue comment "$t" --body "$text" 2>&1); then
			echo "multipi: could not attach the verification report to ticket $t: $out" >&2
			bad=1
		fi
	done
	[ "$bad" -eq 0 ] || exit 3
	echo "verification report attached to: $*"
}

[ $# -ge 1 ] || dl_die "usage: verify-brief.sh <pre>..<post> [exercise] | report <ticket> [<ticket> ...] < report.md"
if [ "$1" = "report" ]; then
	shift
	attach_report "$@"
	exit 0
fi
[ $# -le 2 ] || dl_die "usage: verify-brief.sh <pre>..<post> [exercise]"
range=$1
exercise=${2:-"none declared for this train — the standard steps 1-5 are the whole proof"}
classify_range "$range" || exit 2
template=$(verify_template) || exit 3
url=$(git remote get-url origin 2>/dev/null) || url=""
[ -n "$url" ] || url=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
touched=${VB_TOUCHED%$'\n'}
touched=${touched//$'\n'/, }
if [ -z "$touched" ]; then
	echo "VERIFY SKIP: no contract paths in $range ($VB_COUNT files changed) — docs/test-only train, no verifier (threshold: skill §7, DECISIONS.md #108)."
	exit 10
fi
brief=$(vb_sub "$template" RANGE "$range")
brief=$(vb_sub "$brief" REPO_URL "$url")
brief=$(vb_sub "$brief" TOUCHED "$touched")
brief=$(vb_sub "$brief" EXERCISE "$exercise")
echo "VERIFY DISPATCH: the train touches shared contracts — dispatch the verifier (skill §7)."
echo "range: $range"
echo "touched: $touched"
echo "files: $VB_COUNT changed"
echo "--- verifier brief (dispatch: role=verifier, worktree=<repo root>, task=<brief>) ---"
printf '%s\n' "$brief"
