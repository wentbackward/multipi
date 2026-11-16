#!/usr/bin/env bash
# multipi-interrupt.sh — the operator's force-send (spec 2026-11-15 §3): inject a plain
# message into a wedged orchestrator session. Usage:
#
#   scripts/multipi-interrupt.sh [--dry-run] "message"
#
# PINNED CONTRACT (test-pinned by the smoke):
#   0  message injected — or a --dry-run verified it would be
#   4  bad usage (no/empty message, extra arguments, unknown flag)
#   5  no sidecar (or an unreadable one) / state not active|idle (nothing to inject into)
#   6  no usable TTY — prints the exact kill-and-resume fallback commands
#
# Mechanism: sidecar → pid → readlink /proc/<pid>/fd/0 → must resolve to /dev/tty or
# /dev/pts/* → write "<message>\n" to it. pi's TUI queues in-terminal input; the appended
# newline submits. Every injection AND dry-run is appended to <state>/interrupts.log
# (timestamp, pid, message, dry-run flag).
#
# Honest limit (documented in the spec): this is a TTY PASTE, not an RPC — if the session's
# terminal is detached or dead there is no path in, hence rc 6 and the printed fallback.
#
# Documented seam:
#   MULTIPI_INTERRUPT_TTY=/dev/pts/X  overrides the resolved path (smoke tests capture a
#   real pty with script -qec; the seam is trusted and bypasses the /dev/tty|pts check).
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"
# shellcheck source=lib/liveness.sh
. "$scripts_dir/lib/liveness.sh"

die_usage() {
  echo "usage: scripts/multipi-interrupt.sh [--dry-run] \"message\"" >&2
  exit 4
}

dry=0
[ $# -gt 0 ] || die_usage
if [ "$1" = "--dry-run" ]; then
  dry=1
  shift
fi
[ $# -eq 1 ] || die_usage
msg=$1
[ -n "$msg" ] || die_usage

dl_load_config
[ -n "${DL_ROOT:-}" ] || { echo "multipi-interrupt: not inside a git repository" >&2; exit 4; }
sc=$(lv_sidecar)
lv_valid "$sc" || { echo "multipi-interrupt: no usable sidecar at ${sc} (the session may never have started liveness)" >&2; exit 5; }

state=$(lv_field "$sc" state)
case "$state" in active | idle) : ;; *)
  echo "multipi-interrupt: state is '${state}' — nothing to inject into (only active|idle)" >&2
  exit 5 ;;
esac
pid=$(lv_num "$sc" pid)
lv_inject_target "$pid"
if [ -z "$LV_TARGET" ]; then
  lv_no_tty_fallback "$pid" "$LV_TTY_RAW"
  exit 6
fi

if [ "$dry" = 1 ]; then
  lv_interrupt_log 1 "$pid" "$msg"
  echo "dry-run: would inject to ${LV_TARGET} (pid ${pid}, source: ${LV_TTY_SRC})"
  exit 0
fi

printf '%s\n' "$msg" >"$LV_TARGET" 2>/dev/null || {
  lv_no_tty_fallback "$pid" "$LV_TTY_RAW"
  exit 6
}
lv_interrupt_log 0 "$pid" "$msg"
echo "injected to ${LV_TARGET} (pid ${pid}, source: ${LV_TTY_SRC})"
exit 0
