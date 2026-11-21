#!/usr/bin/env bash
# multipi-watch.sh — the "every 10 minutes" net (spec 2026-11-15 §4): a watchdog that wakes
# a wedged orchestrator session before the 45-min tool bound becomes "hours of silence".
#
#   scripts/multipi-watch.sh [--daemon] [--interval SECS]
#
# ONE-SHOT CHECK (the testable core) reads the sidecar and, against the pinned thresholds:
#   • a tool in flight longer than MULTIPI_WATCH_TOOL_MS (default 720000 = 12 min — BEFORE the
#     45-min bound) → wake:  WAKE (multipi-watch): <tool> has been in flight <N>min. …
#   • a heartbeat older than 5 × the stale bound (MULTIPI_STATUS_STALE_MS, default 120000,
#     so the default wedge threshold is 10 min) → the stronger wake:
#     WEDGE SUSPECTED (multipi-watch): no orchestrator heartbeat for <N>min. …
#   When BOTH fire, the WEDGE (the stronger wake) is chosen.
#   DEDUPE: at most one wake per tool.seq (sidecar's lastWakeSeq watermark — raised after a
#   WAKE) AND at most one wake per 3600 s of wall clock (timestamps in the watch log).
#   • Blocked-ticket nudge (ticket #104): an open ticket labelled dl/blocked whose blocked
#     age is older than MULTIPI_WATCH_BLOCKED_MS (default 14400000 = 4h) → an informational
#     line in the watch log AND (where a usable TTY exists) a wake:
#     BLOCKED (multipi-watch): #<n> has awaited a human decision for <age> — "<question>".
#     Resume or drop it.   (When every "Depends on #k" on the ticket is verifiably CLOSED,
#     "Its dependencies are all closed — now resumable." is inserted before the last
#     sentence.) Blocked age = the created_at of the newest dl/blocked label event on the
#     issue's timeline (gh api); the fallback is the issue-list row's updatedAt (the log
#     flags it approx=1 — the documented approximation, never a silent guess). This is a
#     SEPARATE dedupe axis: at most one nudge per ticket per 24h, ledgered in the watch log
#     (`BLOCKED n=<n>` lines — the same pattern as lastWakeSeq); it does not count as a
#     WAKE/WEDGE for the 3600 s wall axis. It runs only when the check reached a valid
#     sidecar (rc 0/6), and skips silently when gh is unavailable or a tracker call fails —
#     it never fails the check and never changes the rc table. Log tokens: BLOCKED /
#     BLOCKED-SKIP / BLOCKED-NO-TTY / BLOCKED-NO-AGE.
#   Every check appends one line to <state>/watch.log: "<now-ms> <HEALTHY|WAKE|WEDGE|
#   SUPPRESSED:<reason>|IDLE:<reason>|NOTTY|BUMP-FAILED|BLOCKED…"]. BUMP-FAILED: a WAKE was due and
#   injected but its lastWakeSeq bump failed (e.g. no python3) — the 3600 s wall axis caps
#   the damage, the log surfaces the lost seq axis.
#
# ONE-SHOT RC (pinned in this header and the smoke):
#   0  check completed (healthy no-op, dedupe-suppressed, or a wake was injected)
#   4  bad usage / the sidecar file exists but is unreadable
#   5  nothing to wake: no sidecar, unreadable-adjacent state, or state not active|idle
#   6  a wake was due but no usable TTY (the kill-and-resume fallback is printed)
#
# --daemon: single instance via <state>/watch.pid (a live pidfile wins: a second launch
# prints "already running" and exits 0 WITHOUT doubling). Loops: one-shot check, sleep
# --interval (default 60 s), repeat; its output goes to <state>/watch.log. Auto-started
# detached by the extension's session_start (TUI sessions only); it serves the NEXT session
# too and self-idles (IDLE:no-sidecar) when nothing is active.
# Manual --daemon launches need `setsid bash scripts/multipi-watch.sh --daemon &` (or
# nohup): the script does NOT self-daemonize (left optional on purpose) — the extension's
# detached spawn is the designed path, and a plain background job dies with its terminal.
#
# Documented seams:
#   MULTIPI_WATCH_TOOL_MS     integer ms; the tool-in-flight wake threshold (default 720000)
#   MULTIPI_WATCH_BLOCKED_MS  integer ms; the blocked-ticket nudge threshold (default
#                             14400000 = 4h; malformed ⇒ silent default, the same posture as
#                             the other runtime thresholds)
#   MULTIPI_STATUS_STALE_MS   integer ms; the stale bound (default 120000; wedge = 5×)
#   MULTIPI_WATCH_NOW_MS      integer epoch-ms (canonical decimal — a leading zero is
#                             refused, never read as octal); the issuing clock (same pattern as
#                             MULTIPI_APPROVE_NOW_MS) — tests drive wake choice without sleeping
#   MULTIPI_INTERRUPT_TTY     the injection target override (shared with multipi-interrupt.sh)
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"
# shellcheck source=lib/liveness.sh
. "$scripts_dir/lib/liveness.sh"

WAKE_DEDUPE_WALL_MS=3600000
BLOCKED_DEDUPE_WALL_MS=86400000   # one blocked-nudge per ticket per 24h (ledger: watch.log)

die_usage() {
  echo "usage: scripts/multipi-watch.sh [--daemon] [--interval SECS]" >&2
  exit 4
}
int_or() { # int_or VALUE DEFAULT NAME → prints a non-negative integer
  # #76 (the #67 round-2 class, one consumer further in): a leading-zero value (08/09)
  # passes the all-digits gate, then bash arithmetic reads it as INVALID OCTAL and
  # aborts the check ($((09 * 5)): "value too great for base") — or the test builtin
  # silently mis-compares it as a tiny number (08 ≈ 8 ms: a healthy 1 min tool wakes).
  # Non-canonical decimal is GARBAGE → the documented default, never bash's coincidence.
  case "$1" in '' | *[!0-9]* | 0[0-9]*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac
}

daemon=0
interval=60
while [ $# -gt 0 ]; do
  case "$1" in
    --daemon) daemon=1 ;;
    --interval)
      [ $# -ge 2 ] || die_usage
      interval=$2
      case "$interval" in '' | *[!0-9]* | 0) die_usage ;; esac
      shift ;;
    *) die_usage ;;
  esac
  shift
done

dl_load_config
[ -n "${DL_ROOT:-}" ] || { echo "multipi-watch: not inside a git repository" >&2; exit 4; }
tool_bound=$(int_or "${MULTIPI_WATCH_TOOL_MS:-}" 720000)
stale=$(int_or "${MULTIPI_STATUS_STALE_MS:-}" 120000)
blocked_bound=$(int_or "${MULTIPI_WATCH_BLOCKED_MS:-}" 14400000)
log="$DL_STATE/watch.log"
mkdir -p "$DL_STATE" 2>/dev/null || true
lv_now() {
  # Returns 4 (NEVER exit) on a malformed seam: we run inside $(...) in every call site,
  # where an exit would not kill the check and the corrupt clock would keep feeding
  # silent comparisons (#78 found this latent hole on the NON-NUMERIC path too). A
  # leading zero is malformed here: $((now - hb)) would crash ("value too great for
  # base", 09) or read as epoch 8 ms (08 — every heartbeat looks fresh). The issuing
  # clock is the STRICT seam (spec §4: a wrong clock silently skews every comparison).
  if [ -n "${MULTIPI_WATCH_NOW_MS:-}" ]; then
    case "${MULTIPI_WATCH_NOW_MS}" in
      *[!0-9]* | 0[0-9]*) echo "multipi-watch: MULTIPI_WATCH_NOW_MS must be a canonical decimal integer ms" >&2; return 4 ;;
    esac
    printf '%s' "${MULTIPI_WATCH_NOW_MS}"
  else
    date +%s%3N
  fi
}
# wlog NOW MESSAGE — takes its timestamp EXPLICITLY (#65 round-4: the global `now`
# one_shot used to set leaked into the daemon loop's CHECK-FAILED line — the daemon
# scopes its own). The message is $2, never $*: $* would re-expand the timestamp too.
wlog() { printf '%s %s\n' "$1" "$2" >>"$log" 2>/dev/null || true; }

iso_to_ms() { # ISO8601 (UTC) -> epoch ms (prints nothing and returns 1 when unparseable)
  local ms
  ms=$(date -d "$1" +%s%3N 2>/dev/null) || return 1
  case "$ms" in '' | *[!0-9]*) return 1 ;; *) printf '%s' "$ms"; return 0 ;; esac
}

# tl_blocked_iso TIMELINE_JSON -> the created_at of the NEWEST dl/blocked label event
# ("" when none / unparseable). jq first, python3 second — the common.sh dependency rule.
tl_blocked_iso() {
  local js=$1
  if dl_have_jq; then
    jq -r '[ .[] | select(.event? == "labeled" and ((.label.name? // "") == "dl/blocked")) | .created_at ] | max // empty' <<<"$js" 2>/dev/null || true
  else
    python3 -I -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
xs = [e.get("created_at") for e in data
      if isinstance(e, dict) and e.get("event") == "labeled"
      and isinstance(e.get("label"), dict) and e["label"].get("name") == "dl/blocked"]
xs = [x for x in xs if isinstance(x, str)]
if xs:
    print(max(xs))
' <<<"$js" 2>/dev/null || true
  fi
}

# deps_from_text < TEXT -> the ticket numbers after each "Depends on" marker (deduped,
# capped at 10), one per line — the resumable-detection scan of ticket #104.
deps_from_text() {
  awk '
    tolower($0) ~ /depends on/ {
      s = $0
      while (match(s, /#[0-9]+/)) {
        print substr(s, RSTART + 1, RLENGTH - 1)
        s = substr(s, RSTART + RLENGTH)
      }
    }' | awk '!seen[$0]++' | sed -n '1,10p'
}

bl_check() {
  # The blocked-ticket nudge (ticket #104). Called by one_shot ONLY after the core check
  # reached a valid sidecar (rc 0 or 6): the nudge is delivered into the live session's
  # TTY, and there is no delivery target (nor a session to own the rc) otherwise. Every
  # failure mode — no gh, auth failure, list failure, unreadable timestamps — degrades to
  # a silent skip: the nudge must never fail the check, never change the one-shot rc,
  # and never kill the daemon. Its own dedupe (per ticket per 24h, ledger: watch.log)
  # is independent of the WAKE/WEDGE dedupe axes.
  local now sc pid
  now=$(lv_now) || return 0
  sc=$(lv_sidecar)
  [ -f "$sc" ] && lv_valid "$sc" || return 0
  pid=$(lv_num "$sc" pid)
  command -v gh >/dev/null 2>&1 || return 0
  gh auth status >/dev/null 2>&1 || return 0
  local rows
  rows=$(gh issue list --state open --label dl/blocked --json number,title,labels,body,updatedAt --limit 500 2>/dev/null) || return 0
  local ncount i num labs body upd tl iso approx t age last cview cc ctext q st deps d resumed=0 msg
  ncount=$(( $(printf '%s\n' "$rows" | grep -oE '"number"[[:space:]]*:' | wc -l) ))
  i=0
  while [ "$i" -lt "$ncount" ]; do
    num=$(json_get "$i.number" <<<"$rows")
    case "$num" in '' | *[!0-9]*) break ;; esac
    labs=$(json_get "$i.labels" <<<"$rows" \
      | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | sed -E 's/^"name"[[:space:]]*:[[:space:]]*"//; s/"$//' | tr '\n' ' ')
    # Client-side label re-check: the real gh honours --label, the stand-in does not.
    case " $labs " in
      *" dl/blocked "*) : ;;
      *) i=$((i + 1)); continue ;;
    esac
    body=$(json_get "$i.body" <<<"$rows")
    upd=$(json_get "$i.updatedAt" <<<"$rows")
    # The blocked start: the newest dl/blocked label event on the timeline (preferred);
    # the row's updatedAt is the DOCUMENTED approximation (approx=1 in the log line).
    iso=""; approx=0
    if [ -n "${GH_REPO:-}" ]; then
      tl=$(gh api "repos/$GH_REPO/issues/$num/timeline" 2>/dev/null || true)
      iso=$(tl_blocked_iso "$tl")
    fi
    if [ -z "$iso" ]; then iso=$upd; approx=1; fi
    t=$(iso_to_ms "$iso") || { wlog "$now" "BLOCKED-NO-AGE n=$num"; i=$((i + 1)); continue; }
    age=$((now - t)); [ "$age" -lt 0 ] && age=0
    [ "$age" -gt "$blocked_bound" ] || { i=$((i + 1)); continue; }
    last=$(lv_last_blocked_ts "$log" "$num")
    if [ "$last" -gt 0 ] && [ $((now - last)) -lt "$BLOCKED_DEDUPE_WALL_MS" ]; then
      wlog "$now" "BLOCKED-SKIP n=$num"
      i=$((i + 1)); continue
    fi
    # The question (newest comment supersedes the body — the board's same rule) and the
    # resumable claim (every Depends-on verifiably CLOSED; unverifiable ⇒ never claimed).
    cview=$(gh issue view "$num" --json comments 2>/dev/null || true)
    cc=$(( $(printf '%s\n' "$cview" | grep -oE '"body"[[:space:]]*:' | wc -l) ))
    ctext=""
    [ "$cc" -gt 0 ] && ctext=$(json_get "comments.$((cc - 1)).body" <<<"$cview")
    q=$(dl_blocked_question "${ctext:-$body}")
    resumed=0
    deps=$({ printf '%s\n' "$ctext"; printf '%s\n' "$body"; } | deps_from_text)
    if [ -n "$deps" ]; then
      resumed=1
      for d in $deps; do
        st=$(gh issue view "$d" --json state 2>/dev/null | json_get state)
        [ "$st" = CLOSED ] || { resumed=0; break; }
      done
    fi
    msg="BLOCKED (multipi-watch): #$num has awaited a human decision for $(lv_human_dur "$age") — \"$q\"."
    [ "$resumed" = 1 ] && msg="$msg Its dependencies are all closed — now resumable."
    msg="$msg Resume or drop it."
    lv_inject_target "$pid"
    if [ -n "$LV_TARGET" ] && printf '%s\n' "$msg" >"$LV_TARGET" 2>/dev/null; then
      wlog "$now" "BLOCKED n=$num age=$age resumed=$resumed approx=$approx"
      echo "watch: injected BLOCKED n=$num to ${LV_TARGET} (pid ${pid})"
    else
      # No usable TTY (a detached terminal): the informational log line still lands; the
      # dedupe window does NOT start — the nudge is retried the next tick a TTY returns.
      wlog "$now" "BLOCKED-NO-TTY n=$num"
      echo "watch: BLOCKED n=$num is due but no usable TTY (log only)"
    fi
    i=$((i + 1))
  done
  return 0
}

core_check() {
  local now sc state pid tick ev hb toolseq toolname toolstart lastwakeseq
  local wedge_age tool_age kind min_n msg lw
  now=$(lv_now) || return 4
  sc=$(lv_sidecar)
  if [ ! -f "$sc" ]; then
    wlog "$now" "IDLE:no-sidecar"
    echo "watch: no sidecar (nothing to wake)"
    return 5
  fi
  if ! lv_valid "$sc"; then
    echo "multipi-watch: sidecar unreadable at $sc" >&2
    return 4
  fi
  state=$(lv_field "$sc" state)
  case "$state" in
    active | idle) : ;;
    *) wlog "$now" "IDLE:state-${state}"; echo "watch: state '${state}' — nothing to wake"; return 5 ;;
  esac
  pid=$(lv_num "$sc" pid)
  tick=$(lv_num "$sc" lastTickAt)
  ev=$(lv_num "$sc" lastEventAt)
  hb=$tick; [ "$ev" -gt "$hb" ] && hb=$ev
  toolseq=$(lv_num "$sc" tool.seq)
  toolname=$(lv_field "$sc" tool.name)
  toolstart=$(lv_num "$sc" tool.startedAt)
  lastwakeseq=$(lv_num "$sc" lastWakeSeq -1)

  wedge_age=$((now - hb))
  [ "$wedge_age" -lt 0 ] && wedge_age=0
  tool_age=0
  [ "$toolseq" -gt 0 ] && tool_age=$((now - toolstart)) && [ "$tool_age" -lt 0 ] && tool_age=0
  local wedge_cond=0 tool_cond=0
  [ "$wedge_age" -gt $((stale * 5)) ] && wedge_cond=1
  [ "$toolseq" -gt 0 ] && [ "$tool_age" -gt "$tool_bound" ] && tool_cond=1
  if [ "$wedge_cond" = 0 ] && [ "$tool_cond" = 0 ]; then
    wlog "$now" "HEALTHY"
    echo "watch: healthy (pid ${pid})"
    return 0
  fi

  # The stronger wake wins: the wedge.
  kind=WAKE
  min_n=$((tool_age / 60000))
  msg="WAKE (multipi-watch): ${toolname} has been in flight ${min_n}min. If it is wedged, say so and abort/retry; otherwise continue."
  if [ "$wedge_cond" = 1 ]; then
    kind=WEDGE
    min_n=$((wedge_age / 60000))
    msg="WEDGE SUSPECTED (multipi-watch): no orchestrator heartbeat for ${min_n}min. Check scripts/multipi-status.sh; if dead, kill ${pid} and resume in a fresh session (step 0)."
  fi

  # Dedupe axis 1: per tool.seq (the sidecar's monotonic watermark).
  if [ "$kind" = WAKE ] && [ "$lastwakeseq" -eq "$toolseq" ]; then
    wlog "$now" "SUPPRESSED:seq"
    echo "watch: suppressed (already woken for seq ${toolseq})"
    return 0
  fi
  # Dedupe axis 2: at most one wake per 3600 s of wall clock (the watch log is the ledger).
  lw=$(lv_last_wake_ts "$log")
  if [ "$lw" -gt 0 ] && [ $((now - lw)) -lt "$WAKE_DEDUPE_WALL_MS" ]; then
    wlog "$now" "SUPPRESSED:recent"
    echo "watch: suppressed (last wake < 3600 s ago)"
    return 0
  fi

  lv_inject_target "$pid"
  if [ -z "$LV_TARGET" ]; then
    wlog "$now" "NOTTY"
    lv_no_tty_fallback "$pid" "$LV_TTY_RAW"
    return 6
  fi
  if ! printf '%s\n' "$msg" >"$LV_TARGET" 2>/dev/null; then
    wlog "$now" "NOTTY"
    lv_no_tty_fallback "$pid" "$LV_TTY_RAW"
    return 6
  fi
  if [ "$kind" = WAKE ]; then
    wlog "$now" "WAKE tool=${toolname}"
    # A failed bump (a python3-less box, CAS exhaustion) does NOT fail the wake: the wall
    # axis caps the damage at one duplicate wake. Log the degradation — the seq axis is
    # lost, so the operator must be able to see that it was lost.
    lv_bump_wake_seq "$sc" "$toolseq" || wlog "$now" "BUMP-FAILED tool=${toolname} seq=${toolseq}"
  else
    wlog "$now" "WEDGE hb-age=${wedge_age}"
  fi
  echo "watch: injected ${kind} to ${LV_TARGET} (pid ${pid})"
  return 0
}

one_shot() {
  # The pinned one-shot contract (rc 0/4/5/6) is core_check's. When the check reached a
  # live sidecar (rc 0 or 6), the blocked-ticket nudge (ticket #104) then runs: an
  # independent, self-deduped informational check that never changes the returned rc.
  local rc=0
  core_check || rc=$?
  case "$rc" in
    0 | 6) bl_check ;;
  esac
  return "$rc"
}

if [ "$daemon" = 1 ]; then
  pidfile="$DL_STATE/watch.pid"
  if [ -f "$pidfile" ]; then
    old=$(cat "$pidfile" 2>/dev/null || true)
    case "$old" in
      '' | *[!0-9]*) rm -f "$pidfile" ;;
      *)
        if lv_pid_alive "$old"; then
          echo "multipi-watch: already running (pid ${old})"
          exit 0
        fi
        rm -f "$pidfile"   # stale
        ;;
    esac
  fi
  printf '%s\n' "$$" >"$pidfile"
  trap 'rm -f "$pidfile"' EXIT
  # A trapped TERM must EXIT: bash runs the handler and CONTINUES otherwise (verified),
  # which would turn every `kill` into a pidfile release with a still-running loop.
  trap 'rm -f "$pidfile"; exit 0' INT TERM
  # The loop: check, sleep, repeat. A failed check is logged, never fatal — the net must
  # outlive the wedge it watches for.
  while :; do
    if ! one_shot >>"$log" 2>&1; then
      # The daemon scopes ITS OWN timestamp: one_shot's `now` is local to the check.
      # #80: a malformed clock already parked its refusal in $log (one_shot's stderr
      # redirect); capturing it a SECOND time here re-emitted the same line onto the
      # daemon's dropped stderr. Drop that redundant emission; the wall-clock fallback
      # keeps the CHECK-FAILED line writing.
      wlog "$(lv_now 2>/dev/null || date +%s%3N)" "CHECK-FAILED"
    fi
    sleep "$interval"
  done
fi

rc=0
one_shot || rc=$?
exit "$rc"
