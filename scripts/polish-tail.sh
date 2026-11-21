#!/usr/bin/env bash
# accept-tail (ticket #105): the deterministic half of the review-loop brake.
#
# The review came back APPROVE with should-fixes only. This script counts the
# ticket's "should-fix follow-up" comments against review.max_followup_depth
# (default 2) and decides:
#   BELOW CAP (rc 10) — re-dispatch the implementer for the should-fixes; its
#     re-dispatch comment must BEGIN WITH "should-fix follow-up" (that comment
#     IS the round the next call counts).
#   AT/OVER CAP (rc 0) — the tail is ACCEPTED: the findings are parked verbatim
#     in the single "Polish backlog — <area>" ticket (created on first use,
#     appended thereafter), the verdict is commented on the ticket, the ticket
#     is labelled dl/approved, and it proceeds to the gate with no further
#     should-fix implementer round.
# Must-fix findings never reach this script: they re-dispatch until
# APPROVE-clean regardless of depth — correctness is not budgeted.
#
# Usage: polish-tail.sh <ticket> <area> <findings-file>
#   <ticket>         issue number of the ticket under review
#   <area>           non-empty kebab-case area word (one backlog ticket per area)
#   <findings-file>  file holding the should-fix findings verbatim ('-' = stdin)
#
# The decision runs the pure extension modules (extension/src/polish.ts via
# node, doctor's one-shot pattern) so the count, the config validation and the
# backlog bookkeeping share ONE implementation with the unit tests.
#
# Exit codes: 0 accepted (parked + dl/approved) · 10 below cap (re-dispatch)
#             2 bad usage / no config / no node · 3 tracker or import error
set -u
die() { echo "polish-tail: $1" >&2; exit "${2:-2}"; }

[ $# -eq 3 ] || die "usage: polish-tail.sh <ticket> <area> <findings-file>"
ticket=$1
area=$2
findings_file=$3
[[ "$ticket" =~ ^[1-9][0-9]*$ ]] || die "ticket must be a positive integer (got '$ticket')"
[ -n "$area" ] || die "area must be a non-empty kebab-case word"

if [ "$findings_file" = "-" ]; then
  findings=$(cat)
else
  [ -r "$findings_file" ] || die "findings file not readable: $findings_file"
  findings=$(<"$findings_file")
fi
[ -n "$findings" ] || die "findings are empty"

scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"
dl_load_config required

# The decision modules: prefer the installed copy over the plugin source (doctor's rule),
# so an installed project and this repo both resolve the SAME implementation.
polish_src=""
for cand in "$DL_ROOT/.pi/extensions/multipi-devloop/src" "$scripts_dir/../extension/src"; do
  if [ -f "$cand/polish.ts" ]; then polish_src=$cand; break; fi
done
[ -n "$polish_src" ] || die "the polish module is missing (extension not installed?)"
command -v node >/dev/null 2>&1 || die "node not found (the accept-tail decision runs the pure extension modules)"

# Env, not string interpolation: paths and the findings never enter the JS source, so a
# payload containing a quote cannot break (or alter) the one-shot — doctor's pattern.
pt_err=$(mktemp)
trap 'rm -f "$pt_err"' EXIT
pt_json=$(
  PT_SRC=$polish_src PT_ROOT="$DL_ROOT" PT_REPO="${GH_REPO:-}" PT_TICKET=$ticket PT_AREA=$area PT_FINDINGS="$findings" \
  node --input-type=module -e '
const { acceptTail } = await import(process.env.PT_SRC + "/polish.ts");
process.stdout.write(JSON.stringify(acceptTail({
  root: process.env.PT_ROOT,
  repo: process.env.PT_REPO,
  ticket: Number(process.env.PT_TICKET),
  area: process.env.PT_AREA,
  findings: process.env.PT_FINDINGS,
})));
' 2>"$pt_err"
) || {
  echo "polish-tail: tracker or import error: $(head -n 1 "$pt_err")" >&2
  exit 3
}
[ -n "$pt_json" ] || { echo "polish-tail: empty decision (node import failed: $(head -n 1 "$pt_err"))" >&2; exit 3; }

action=$(json_get action <<<"$pt_json")
rounds=$(json_get rounds <<<"$pt_json")
cap=$(json_get cap <<<"$pt_json")
title=$(json_get backlogTitle <<<"$pt_json")
bn=$(json_get backlogNumber <<<"$pt_json")
ba=$(json_get backlogAction <<<"$pt_json")
case "$action" in
  accepted)
    echo "ACCEPT-TAIL: #${ticket} at the cap (${rounds} round(s) >= ${cap}) — findings parked in \"${title}\" (#${bn}, ${ba}); the ticket is dl/approved. Proceed to the gate."
    exit 0
    ;;
  below-cap)
    echo "BELOW-CAP: #${ticket} has ${rounds} should-fix round(s) < cap ${cap} — re-dispatch the implementer; its re-dispatch comment must begin with \"should-fix follow-up\"."
    exit 10
    ;;
  *)
    echo "polish-tail: unexpected decision: $pt_json" >&2
    exit 3
    ;;
esac
