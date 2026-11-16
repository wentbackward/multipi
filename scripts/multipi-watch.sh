#!/usr/bin/env bash
# multipi-watch.sh — the "every 10 minutes" net (spec 2026-11-15 §4): a watchdog that wakes
# a wedged orchestrator session before the 45-min tool bound becomes "hours of silence".
#
#   scripts/multipi-watch.sh [--daemon] [--interval SECS]
#
# ONE-SHOT CHECK (the testable core) reads the sidecar and, against the pinned thresholds:
#   • a tool in flight longer than MULTIPI_TOOL_MS (default 720000 = 12 min — BEFORE the
#     45-min bound) → wake:  WAKE (multipi-watch): <tool> has been in flight <N>min. …
#   • a heartbeat older than 5 × the stale bound (MULTIPI_STATUS_STALE_MS, default 120000,
#     so the default wedge threshold is 10 min) → the stronger wake:
#     WEDGE SUSPECTED (multipi-watch): no orchestrator heartbeat for <N>min. …
#   When BOTH fire, the WEDGE (the stronger wake) is chosen.
#   DEDUPE: at most one wake per tool.seq (sidecar's lastWakeSeq watermark — raised after a
#   WAKE) AND at most one wake per 3600 s of wall clock (timestamps in the watch log).
#   Every check appends one line to <state>/watch.log: "<now-ms> <HEALTHY|WAKE|WEDGE|
#   SUPPRESSED:<reason>|IDLE:<reason>|NOTTY>".
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
#
# Documented seams:
#   MULTIPI_WATCH_TOOL_MS     integer ms; the tool-in-flight wake threshold (default 720000)
#   MULTIPI_STATUS_STALE_MS   integer ms; the stale bound (default 120000; wedge = 5×)
#   MULTIPI_WATCH_NOW_MS      integer epoch-ms; the issuing clock (same pattern as
#                             MULTIPI_APPROVE_NOW_MS) — tests drive wake choice without sleeping
#   MULTIPI_INTERRUPT_TTY     the injection target override (shared with multipi-interrupt.sh)
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"
# shellcheck source=lib/liveness.sh
. "$scripts_dir/lib/liveness.sh"

WAKE_DEDUPE_WALL_MS=3600000

die_usage() {
  echo "usage: scripts/multipi-watch.sh [--daemon] [--interval SECS]" >&2
  exit 4
}
int_or() { # int_or VALUE DEFAULT NAME → prints a non-negative integer
  case "$1" in '' | *[!0-9]*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac
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
log="$DL_STATE/watch.log"
mkdir -p "$DL_STATE" 2>/dev/null || true
lv_now() {
  if [ -n "${MULTIPI_WATCH_NOW_MS:-}" ]; then
    case "${MULTIPI_WATCH_NOW_MS}" in '' | *[!0-9]*) echo "multipi-watch: MULTIPI_WATCH_NOW_MS must be an integer ms" >&2; exit 4 ;; esac
    printf '%s' "${MULTIPI_WATCH_NOW_MS}"
  else
    date +%s%3N
  fi
}
wlog() { printf '%s %s\n' "$now" "$*" >>"$log" 2>/dev/null || true; }

one_shot() {
  local sc state pid tick ev hb toolseq toolname toolstart lastwakeseq
  local wedge_age tool_age kind min_n msg lw
  now=$(lv_now)
  sc=$(lv_sidecar)
  if [ ! -f "$sc" ]; then
    wlog "IDLE:no-sidecar"
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
    *) wlog "IDLE:state-${state}"; echo "watch: state '${state}' — nothing to wake"; return 5 ;;
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
    wlog "HEALTHY"
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
    wlog "SUPPRESSED:seq"
    echo "watch: suppressed (already woken for seq ${toolseq})"
    return 0
  fi
  # Dedupe axis 2: at most one wake per 3600 s of wall clock (the watch log is the ledger).
  lw=$(lv_last_wake_ts "$log")
  if [ "$lw" -gt 0 ] && [ $((now - lw)) -lt "$WAKE_DEDUPE_WALL_MS" ]; then
    wlog "SUPPRESSED:recent"
    echo "watch: suppressed (last wake < 3600 s ago)"
    return 0
  fi

  lv_inject_target "$pid"
  if [ -z "$LV_TARGET" ]; then
    wlog "NOTTY"
    lv_no_tty_fallback "$pid" "$LV_TTY_RAW"
    return 6
  fi
  if ! printf '%s\n' "$msg" >"$LV_TARGET" 2>/dev/null; then
    wlog "NOTTY"
    lv_no_tty_fallback "$pid" "$LV_TTY_RAW"
    return 6
  fi
  if [ "$kind" = WAKE ]; then
    wlog "WAKE tool=${toolname}"
    lv_bump_wake_seq "$sc" "$toolseq"
  else
    wlog "WEDGE hb-age=${wedge_age}"
  fi
  echo "watch: injected ${kind} to ${LV_TARGET} (pid ${pid})"
  return 0
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
  trap 'rm -f "$pidfile"' EXIT INT TERM
  # The loop: check, sleep, repeat. A failed check is logged, never fatal — the net must
  # outlive the wedge it watches for.
  while :; do
    if ! one_shot >>"$log" 2>&1; then
      wlog "CHECK-FAILED"
    fi
    sleep "$interval"
  done
fi

rc=0
one_shot || rc=$?
exit "$rc"
