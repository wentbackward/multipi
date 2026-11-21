#!/usr/bin/env bash
# multipi-board.sh — the one-glance operator dashboard (ticket #103): the whole loop on
# ONE screen — header (tracker @ base head, main sync), the last gate result, the
# in-flight children, the open tickets (dl/blocked FIRST, with the blocking question),
# and the blocked ages. A human runs it to decide; it never decides.
#
# Read-only. Sources: `gh issue list` / `gh issue view` / `gh pr list` (labels, titles,
# bodies, comments, PR numbers — the ONLY network this script does), the dispatch state
# file, the last-gate record (<state>/gate-last.txt, written by gate-train.sh; the
# train-green record is the legacy fallback), and `git rev-parse` on LOCAL refs only —
# it never fetches. It writes nothing.
#
# rc contract (PINNED — mirrored by the smoke matrix, the same posture as
# multipi-status.sh):
#   0  board rendered; nothing needs the human
#   1  board rendered; ≥1 ticket dl/blocked (the human's decision is the bottleneck)
#   2  board rendered; ≥1 in-flight child past its expected bound OR last gate RED
#      (precedence: 2 wins when both hold — a red pipeline shadows the waiting, the
#       same severity order status gives WEDGE over IDLE; the blocked ticket still renders)
#   4  bad usage (any argument) / unreadable state (no git repository) / malformed seam
#
# Graceful degradation: when `gh` is unavailable or unauthenticated, the board renders
# LOCAL-ONLY (state file, gate record, worktrees) and says so — it never hard-fails.
#
# Documented seams:
#   MULTIPI_BOARD_REPO             the tracker slug owner/name (default: the GH_REPO the
#                                  configured origin derives — github.com only — else the
#                                  repository's basename). The seam also pins --repo for
#                                  the gh calls (the fork-trap rule).
#   MULTIPI_BOARD_CHILD_BOUND_MIN  canonical decimal integer MINUTES (a leading zero is
#                                  refused, never read as octal — the #78/#80 rule); the
#                                  expected bound of an in-flight one-shot child (default
#                                  480; 0 = disabled). Past-bound children tag OVER BOUND
#                                  and drive rc 2. (Docs: DECISIONS.md 2026-11-20.)
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"
# shellcheck source=lib/liveness.sh
. "$scripts_dir/lib/liveness.sh"

[ $# -eq 0 ] || { echo "usage: scripts/multipi-board.sh (no arguments)" >&2; exit 4; }
dl_load_config
[ -n "${DL_ROOT:-}" ] || { echo "multipi-board: not inside a git repository" >&2; exit 4; }
# #78/#80 discipline: a leading-zero bound passes the digit gate, then bash honours it as
# octal — refuse non-canonical decimals instead of honouring a typo.
bound=${MULTIPI_BOARD_CHILD_BOUND_MIN:-480}
case "$bound" in '' | *[!0-9]* | 0[0-9]*) echo "multipi-board: MULTIPI_BOARD_CHILD_BOUND_MIN must be a canonical decimal integer minutes" >&2; exit 4 ;; esac
bound_ms=$((bound * 60 * 1000))
now=$(date +%s%3N)

# --- tracker slug: the seam wins, the origin-derived pin next, the basename last ---
repo=${MULTIPI_BOARD_REPO:-${GH_REPO:-$DL_REPO}}
[ -n "${MULTIPI_BOARD_REPO:-}" ] && export GH_REPO="$MULTIPI_BOARD_REPO"

# --- header: repo @ local base head (main synced | behind N | ahead) ---------------
local_head=$(git -C "$DL_ROOT" rev-parse -q --verify "refs/heads/$DL_BASE" 2>/dev/null || true)
remote_head=$(git -C "$DL_ROOT" rev-parse -q --verify "refs/remotes/$DL_REMOTE/$DL_BASE" 2>/dev/null || true)
sha=$(git -C "$DL_ROOT" rev-parse --short "${local_head:-HEAD}" 2>/dev/null || printf '?')
if [ -n "$local_head" ] && [ -n "$remote_head" ]; then
  behind=$(git -C "$DL_ROOT" rev-list --count "${local_head}..${remote_head}" 2>/dev/null || printf '0')
  ahead=$(git -C "$DL_ROOT" rev-list --count "${remote_head}..${local_head}" 2>/dev/null || printf '0')
  if [ "$behind" -eq 0 ] && [ "$ahead" -eq 0 ]; then mainbit="(main synced)"
  elif [ "$behind" -eq 0 ]; then mainbit="(main ahead $ahead)"
  elif [ "$ahead" -eq 0 ]; then mainbit="(main behind $behind)"
  else mainbit="(main behind $behind, $ahead ahead)"; fi
else
  mainbit="(remote ref not fetched)"
fi
echo "multipi board — $repo @ $sha $mainbit"

# --- gh availability: unavailable OR unauthenticated ⇒ local-only, never hard-fail --
have_gh=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then have_gh=1; fi
if [ "$have_gh" -ne 1 ]; then
  echo "⚠ gh unavailable — local only (state file, gate record, worktrees); the tracker view is skipped"
fi

# --- last gate: gate-last.txt (ticket #103) with the train-green record as fallback -
gate_red=0
gate_line="gate: never run"
gl="$DL_STATE/gate-last.txt"
gres=""; gts=""; gdet=""; gdir=""
if [ -f "$gl" ]; then
  read -r f_res f_ts f_det f_dir _ <"$gl" || true
  gres=${f_res#result=}
  gts=${f_ts#ts=}
  gdet=${f_det#detail=}
  gdir=${f_dir#logdir=}
fi
case "$gts" in '' | *[!0-9]*) gts="" ;; esac
case "$gres" in green | red) : ;; *) gres="" ;; esac
if [ "$gres" = green ] && [ -n "$gts" ]; then
  gage=$((now - gts)); [ "$gage" -lt 0 ] && gage=0
  latest=$(find "$gdir" -maxdepth 1 -name 'train-*.log' -printf '%T@ %p\n' 2>/dev/null | sort -rn | sed -n 1p | cut -d' ' -f2-)
  gate_line="gate: GREEN $(lv_human_dur "$gage") (${latest:-${gdir:-logs}})"
elif [ "$gres" = red ] && [ -n "$gts" ]; then
  gage=$((now - gts)); [ "$gage" -lt 0 ] && gage=0
  gate_red=1
  gate_line="gate: RED $(lv_human_dur "$gage") — ${gdet:--}"
elif [ ! -f "$gl" ] && [ -f "$(dl_train_file)" ]; then
  # A train that predates the last-gate artifact: its GREEN record stands in.
  tm=$(stat -c %Y "$(dl_train_file)" 2>/dev/null || printf '0')
  tg=$((now - tm * 1000)); [ "$tg" -lt 0 ] && tg=0
  gate_line="gate: GREEN $(lv_human_dur "$tg") ($(dl_train_file))"
fi
echo "$gate_line"

# --- dispatch-state readers (fail-soft: a corrupt file reads as EMPTY, not error) ---
# dkeys FILE: the entry keys, one per line.  djf FILE KEY FIELD: one field of an entry
# ("" when absent). jq first, python3 second — the common.sh dependency rule.
dkeys() {
  local f=$1
  if [ -z "${MULTIPI_NO_JQ:-}" ] && command -v jq >/dev/null 2>&1; then
    jq -r 'keys_unsorted[]' "$f" 2>/dev/null
  else
    python3 -I -c 'import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
if isinstance(d, dict):
    for k in d:
        print(k)' "$f" 2>/dev/null
  fi
}
djf() {
  local f=$1 k=$2 fld=$3
  if [ -z "${MULTIPI_NO_JQ:-}" ] && command -v jq >/dev/null 2>&1; then
    jq -r --arg k "$k" --arg f "$fld" \
      '.[$k] as $e | select(type == "object") | ($e[$f] // empty) | if type == "string" then . else tojson end' "$f" 2>/dev/null
  else
    python3 -I -c 'import json, sys
try:
    v = json.load(open(sys.argv[1])).get(sys.argv[2])
except Exception:
    sys.exit(0)
if not isinstance(v, dict):
    sys.exit(0)
x = v.get(sys.argv[3])
if x is None:
    sys.exit(0)
print(x if isinstance(x, str) else json.dumps(x))' "$f" "$k" "$fld" 2>/dev/null
  fi
}

# --- in-flight children: running entries whose pid is alive -------------------------
df="$DL_STATE/dispatch.json"
slots=$(cfg heavy.slots 2)
over_any=0
inflight_n=0
ifl_num=""; ifl_dur=""; ifl_role=""; ifl_over=""; ifl_kv=""
dkeys_list=""
[ -f "$df" ] && dkeys_list=$(dkeys "$df" || true)
for k in $dkeys_list; do
  status=$(djf "$df" "$k" status)
  [ "$status" = running ] || continue
  pid=$(djf "$df" "$k" pid)
  case "$pid" in '' | *[!0-9]*) continue ;; esac
  lv_pid_alive "$pid" || continue
  st0=$(djf "$df" "$k" startedAt)
  role=$(djf "$df" "$k" role); [ -n "$role" ] || role="?"
  dur="?"; over=0
  case "$st0" in
    '' | *[!0-9]*) : ;;
    *)
      age=$((now - st0)); [ "$age" -lt 0 ] && age=0
      dur=$(lv_human_dur "$age")
      if [ "$bound_ms" -gt 0 ] && [ "$age" -gt "$bound_ms" ]; then over=1; over_any=1; fi
      ;;
  esac
  inflight_n=$((inflight_n + 1))
  ifl_num="$ifl_num $k"
  ifl_dur="$ifl_dur $dur"
  ifl_role="$ifl_role $role"
  ifl_over="$ifl_over $over"
  ifl_kv="$ifl_kv $k:$dur"
done
if [ "$inflight_n" -eq 0 ]; then
  echo "in-flight: none"
else
  # Role census in first-seen order: "2/2 implementers" (implementers carry the capacity
  # from heavy.slots, like dispatch) or "2 children (1 implementer, 1 analyst)" mixed.
  role_names=""
  for r in $ifl_role; do
    case " $role_names " in *" $r "*) : ;; *) role_names="$role_names $r" ;; esac
  done
  single=${role_names# }
  case "$single" in
    *" "*)
      bits=""
      for r in $single; do
        c=0
        for rr in $ifl_role; do [ "$rr" = "$r" ] && c=$((c + 1)); done
        [ "$c" -eq 1 ] && bit="$c $r" || bit="$c ${r}s"
        bits="${bits:+$bits, }$bit"
      done
      prefix="$inflight_n children ($bits)"
      per_role=1
      ;;
    implementer) prefix="$inflight_n/$slots implementers"; per_role=0 ;;
    *)
      if [ "$inflight_n" -eq 1 ]; then prefix="$inflight_n $single"
      else prefix="$inflight_n ${single}s"; fi
      per_role=0
      ;;
  esac
  items=""
  xd="$ifl_dur"; xo="$ifl_over"; xr="$ifl_role"
  for k in $ifl_num; do
    xd=${xd# }; d=${xd%% *}; xd=${xd#* }
    xo=${xo# }; o=${xo%% *}; xo=${xo#* }
    xr=${xr# }; r=${xr%% *}; xr=${xr#* }
    bit="$d"
    [ "$o" = 1 ] && bit="$d, OVER BOUND"
    [ "$per_role" = 1 ] && bit="$r $bit"
    items="${items:+$items, }#$k ($bit)"
  done
  echo "in-flight: $prefix — $items"
fi

# --- open tickets: one issue-list query, parsed with the common json helpers --------
open_raw=""
have_issues=0
if [ "$have_gh" -eq 1 ]; then
  if open_raw=$(gh issue list --state open --json number,title,labels,body --limit 500 2>/dev/null); then
    have_issues=1
  fi
fi
T_NUM=(); T_TITLE=(); T_LBL=(); T_BODY=()
if [ "$have_issues" -eq 1 ]; then
  ncount=$(( $(printf '%s\n' "$open_raw" | grep -oE '"number"[[:space:]]*:' | wc -l) ))
  i=0
  while [ "$i" -lt "$ncount" ]; do
    num=$(json_get "$i.number" <<<"$open_raw")
    case "$num" in '' | *[!0-9]*) break ;; esac   # structural mismatch: stop, render what parsed
    T_NUM+=("$num")
    T_TITLE+=("$(json_get "$i.title" <<<"$open_raw")")
    labs=$(json_get "$i.labels" <<<"$open_raw" \
      | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | sed -E 's/^"name"[[:space:]]*:[[:space:]]*"//; s/"$//' | tr '\n' ' ')
    T_LBL+=("${labs% }")
    T_BODY+=("$(json_get "$i.body" <<<"$open_raw")")
    i=$((i + 1))
  done
fi
has_lbl() { # has_lbl LABEL LABELS
  case " $2 " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}
idx_blocked=""; idx_other=""
cnt_blocked=0
i=0
for n in ${T_NUM[@]+"${T_NUM[@]}"}; do
  if has_lbl dl/blocked "${T_LBL[i]}"; then
    idx_blocked="$idx_blocked $i"
    cnt_blocked=$((cnt_blocked + 1))
  else
    idx_other="$idx_other $i"
  fi
  i=$((i + 1))
done
sortidx() { # sortidx "i j k" — the indices ordered by ticket number
  local out
  out=$(for i in $1; do printf '%s %s\n' "${T_NUM[$i]}" "$i"; done | sort -n | awk '{print $2}')
  printf '%s' "$out"
}
idx_blocked=$(sortidx "$idx_blocked")
idx_other=$(sortidx "$idx_other")

cnt_review=0; cnt_gated=0; cnt_prog=0
for i in $idx_other; do
  lbls=${T_LBL[i]}
  has_lbl dl/in-review "$lbls" && cnt_review=$((cnt_review + 1))
  has_lbl dl/gated "$lbls" && cnt_gated=$((cnt_gated + 1))
  has_lbl dl/in-progress "$lbls" && cnt_prog=$((cnt_prog + 1))
done

# bd_question I: the first line of the blocking question of ticket index I. The report
# lands as the NEWEST comment (it supersedes the body); the question is the first line
# of the "## Questions" section, else the "STATUS: BLOCKED — reason" line, else the
# first line ending in "?".
bd_extract_q() {
  local t=$1 q
  q=$(printf '%s\n' "$t" | awk '
    /^## Questions[[:space:]]*$/ {f = 1; next}
    f {sub(/^[[:space:]]+/, ""); if (length($0) > 0) {print; exit}}')
  [ -n "$q" ] && { printf '%s' "$q"; return 0; }
  q=$(printf '%s\n' "$t" | grep -m1 -E '^STATUS:[[:space:]]*BLOCKED' || true)
  if [ -n "$q" ]; then
    printf '%s\n' "$q" \
      | sed -E 's/^STATUS:[[:space:]]*BLOCKED[[:space:]]*[-—–][[:space:]]*//' \
      | sed -E 's/^STATUS:[[:space:]]*BLOCKED[[:space:]]*//'
    return 0
  fi
  q=$(printf '%s\n' "$t" | grep -m1 -E '\?[[:space:]]*$' || true)
  [ -n "$q" ] && { printf '%s' "$q"; return 0; }
  printf '(no question found in issue)'
}
bd_question() {
  local i=$1 n ctext="" cview cc
  n=${T_NUM[i]}
  if [ "$have_gh" -eq 1 ]; then
    if cview=$(gh issue view "$n" --json comments 2>/dev/null); then
      cc=$(( $(printf '%s\n' "$cview" | grep -oE '"body"[[:space:]]*:' | wc -l) ))
      # issue view's top level is an OBJECT (unlike the issue-list array): comments.N.body
      [ "$cc" -gt 0 ] && ctext=$(json_get "comments.$((cc - 1)).body" <<<"$cview")
    fi
  fi
  bd_extract_q "${ctext:-${T_BODY[i]}}"
}
# bd_branch_for N: the branch of ticket N, from the LOCAL remote refs (no fetch). A
# candidate is a branch whose slug starts with "<N>[-_.]"; the candidate carrying an
# OPEN PR wins (the PR, not the alphabet, identifies the branch), else the first.
bd_branch_for() {
  local n=$1 b base fallback="" cands=0
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    b=${b#"$DL_REMOTE/"}
    case "$b" in "$DL_BASE" | train-*) continue ;; esac
    base=${b#*/}
    if [ "$base" = "$n" ] || printf '%s\n' "$base" | grep -qE "^${n}([-_.])"; then
      if [ -z "$fallback" ]; then fallback=$b; fi
      if [ "$have_gh" -eq 1 ] && [ -n "$(gh pr list --head "$b" --json number 2>/dev/null | json_get '0.number')" ]; then
        printf '%s\n' "$b"
        return 0
      fi
      cands=$((cands + 1))
      [ "$cands" -ge 4 ] && break
    fi
  done < <(git -C "$DL_ROOT" for-each-ref "refs/remotes/$DL_REMOTE" --format='%(refname:short)' 2>/dev/null | sort)
  printf '%s\n' "$fallback"
}
# render_ticket I: one line per ticket (blocked carries its question line).
render_ticket() {
  local i=$1 n title bit lab prn sha br d
  n=${T_NUM[i]}
  title=${T_TITLE[i]}
  if has_lbl dl/blocked "${T_LBL[i]}"; then
    printf '  #%s  [dl/blocked]  %s\n' "$n" "$title"
    printf '       └─ Q: %s\n' "$(bd_question "$i")"
  elif has_lbl dl/in-review "${T_LBL[i]}"; then
    bit=""
    br=$(bd_branch_for "$n")
    if [ -n "$br" ]; then
      sha=$(git -C "$DL_ROOT" rev-parse --short "refs/remotes/$DL_REMOTE/$br" 2>/dev/null || printf '?')
      prn=""
      [ "$have_gh" -eq 1 ] && prn=$(gh pr list --head "$br" --json number 2>/dev/null | json_get '0.number')
      if [ -n "$prn" ]; then bit="PR #$prn, head $sha"; else bit="head $sha (no open PR)"; fi
    fi
    printf '  #%s  [dl/in-review] %s%s\n' "$n" "$title" "${bit:+  ($bit)}"
  elif has_lbl dl/gated "${T_LBL[i]}"; then
    printf '  #%s  [dl/gated] %s  (gate green — mergeable)\n' "$n" "$title"
  elif has_lbl dl/in-progress "${T_LBL[i]}"; then
    # mid-line safe: a second child sits AFTER a space, not at the line start
    d=$(printf '%s\n' "${ifl_kv# }" | grep -oE "(^| )${n}:[^ ]+" | sed -n 1p | sed -E "s/^[[:space:]]*${n}://")
    if [ -n "$d" ]; then bit="running $d"; else bit="no child in flight"; fi
    printf '  #%s  [dl/in-progress] %s  (%s)\n' "$n" "$title" "$bit"
  else
    lab="no label"
    [ -n "${T_LBL[i]}" ] && lab=${T_LBL[i]%% *}
    printf '  #%s  [%s] %s\n' "$n" "$lab" "$title"
  fi
}

n_open=${#T_NUM[@]}
if [ "$have_gh" -ne 1 ]; then
  echo "tickets: n/a (tracker unreachable)"
elif [ "$have_issues" -ne 1 ]; then
  echo "tickets: n/a (issue list failed)"
elif [ "$n_open" -eq 0 ]; then
  echo "tickets: 0 open — nothing needs you"
else
  bits=""
  [ "$cnt_blocked" -gt 0 ] && bits="$bits${bits:+, }$cnt_blocked awaiting YOUR decision"
  [ "$cnt_review" -gt 0 ] && bits="$bits${bits:+, }$cnt_review in review"
  [ "$cnt_gated" -gt 0 ] && bits="$bits${bits:+, }$cnt_gated gated"
  [ "$cnt_prog" -gt 0 ] && bits="$bits${bits:+, }$cnt_prog in flight"
  echo "tickets: $n_open open — $bits"
  for i in $idx_blocked $idx_other; do render_ticket "$i"; done
fi

# --- blocked ages: worktree mtime of the ticket's dispatch entry (last activity),
#     falling back to the dispatch file's own mtime; omitted when neither is readable -
blocked_bits=""
for i in $idx_blocked; do
  n=${T_NUM[i]}
  m=""
  wt=""
  [ -f "$df" ] && wt=$(djf "$df" "$n" worktree)
  if [ -n "$wt" ] && [ -d "$wt" ]; then
    m=$(stat -c %Y "$wt" 2>/dev/null || true)
  fi
  if [ -z "$m" ] && [ -f "$df" ]; then
    m=$(stat -c %Y "$df" 2>/dev/null || true)
  fi
  if [ -n "$m" ]; then
    bag=$((now - m * 1000)); [ "$bag" -lt 0 ] && bag=0
    blocked_bits="${blocked_bits:+$blocked_bits; }#$n blocked $(lv_human_dur "$bag")"
  fi
done
[ -n "$blocked_bits" ] && echo "blocked age: $blocked_bits"

# --- the pinned rc: 2 (pipeline trouble) shadows 1 (the waiting), 0 needs nothing ----
rc=0
[ "$over_any" -eq 1 ] && rc=2
[ "$gate_red" -eq 1 ] && rc=2
[ "$cnt_blocked" -gt 0 ] && [ "$rc" -eq 0 ] && rc=1
exit $rc
