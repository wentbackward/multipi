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
#       Attach the verifier's report (on stdin) to every train ticket that does not
#       already carry one, as one "Post-merge verification" comment (one per ticket —
#       a ticket already carrying the header is skipped, so a retry after a partial
#       attach appends nothing); the header verdict rides the report's own
#       `VERIFICATION: PASS` / `VERIFICATION: FAIL` line (line-anchored, PASS a whole
#       word — prose mentions do not count; absent = plain header). A tracker failure
#       on the check or the attach of any ticket exits 3 (nothing half-attached
#       passes silently).
#
# The dispatch threshold (DECISIONS.md 2026-11-21, #108 — default-ON for anything
# contract-touching): the train touches a shared contract iff its diff carries any of
#   extension/   (incl. the installed .pi/extensions/ mirror)
#   scripts/
#   agents/      (incl. the installed .pi/agents/ mirror)
#   skills/      (incl. the installed .pi/skills/ mirror)
#   the .devloop.json schema (root .devloop.json, templates/devloop.json,
#   .pi/templates/devloop.json)
#   the verifier brief template (templates/verify-brief.md — it prescribes every
#   future verifier's behaviour and is mirrored byte-for-byte into every install;
#   its own change is contract-touching, never docs/test-only — review #126)
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
	# Seeded with a leading newline sentinel so the *"$NL$cat$NL"* containment test
	# below rejects a repeat of the FIRST entry too (an unseeded accumulator has no
	# newline before its first category — the #129 double-render); both ends are
	# trimmed before joining.
	VB_TOUCHED="$NL"
	while IFS= read -r f; do
		[ -n "$f" ] || continue
		VB_COUNT=$((VB_COUNT + 1))
		case "$f" in
		".devloop.json" | "templates/devloop.json" | ".pi/templates/devloop.json") cat=".devloop.json schema" ;;
		"templates/verify-brief.md") cat="verify-brief template" ;;
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

# report mode: attach the single verification comment to every train ticket that
# does not already carry one (one 'Post-merge verification' comment per ticket —
# the skill's contract; a retry after a partial attach must append nothing).
attach_report() {
	local body verdict header text t out bad=0 attached=""
	[ $# -ge 1 ] || dl_die "usage: verify-brief.sh report <ticket> [<ticket> ...] < report.md"
	dl_load_config required
	command -v gh >/dev/null 2>&1 || {
		echo "multipi: gh (GitHub CLI) is not installed" >&2
		exit 3
	}
	body=$(cat)
	[ -n "$body" ] || dl_die "the report body (stdin) is empty"
	# Line-ANCHORED verdict (review #126): the markers count only when they open a
	# line and PASS is a whole word (a space or line end follows) — a quoted
	# 'VERIFICATION: PASSING — …', a mid-line mention, or prose quoting the markers
	# must not set the header verdict.
	verdict=""
	if printf '%s\n' "$body" | grep -qE '^VERIFICATION: PASS([[:space:]]|$)'; then
		verdict=" — PASS"
	elif printf '%s\n' "$body" | grep -qE '^VERIFICATION: FAIL([[:space:]]|$)'; then
		verdict=" — FAIL"
	fi
	header="## Post-merge verification${verdict}"
	text="$(printf '%s\n\n%s' "$header" "$body")"
	for t in "$@"; do
		# De-dupe (review #126): a ticket that ALREADY carries the header (a prior
		# attach, an rc 3 partial retry, a manual re-run) is skipped, never doubled.
		# A check that fails is a tracker failure: fail closed (rc 3) — never attach
		# against an unknown state and risk a second comment.
		if ! out=$(gh issue view "$t" --json comments 2>&1); then
			echo "multipi: could not check ticket $t for an existing verification comment: $out" >&2
			bad=1
			continue
		fi
		if printf '%s\n' "$out" | grep -qF "## Post-merge verification"; then
			echo "skip: ticket $t already carries a 'Post-merge verification' comment — nothing attached"
			continue
		fi
		if ! out=$(gh issue comment "$t" --body "$text" 2>&1); then
			echo "multipi: could not attach the verification report to ticket $t: $out" >&2
			bad=1
			continue
		fi
		attached="${attached:+$attached }$t"
	done
	[ "$bad" -eq 0 ] || exit 3
	echo "verification report attached to: ${attached:- (none new — every ticket already verified)}"
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
# Credential hygiene (review #126, the sharpest finding): an origin carrying
# embedded userinfo (https://user:token@…) must not leak the token into the
# brief → the verifier's session log → the issue comment. Strip the userinfo@
# component of a scheme:// URL (userinfo never contains '/' or '@'); scp-style
# user@host:path has no credential and passes through untouched.
url=$(printf '%s\n' "$url" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]+@#\1#')
[ -n "$url" ] || url=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
touched=${VB_TOUCHED#$'\n'}
touched=${touched%$'\n'}
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
