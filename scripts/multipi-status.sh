#!/usr/bin/env bash
# multipi-status.sh — the operator's one-liner (spec 2026-11-15 §1a): is the orchestrator
# session alive, wedged, or dead? Renders ONE line (state, in-flight tool + elapsed,
# heartbeat age, pid, tty, available RAM/swap-free) and exits per a PINNED CONTRACT
# (mirrored by renderStatus in extension/src/liveness.ts; both sides are test-pinned):
#
#   0  live: heartbeat ≤ the stale bound, a tool is in flight
#   1  alive but idle (no in-flight tool) — or no sidecar while a matching pi process runs
#   2  STALE / suspected WEDGE: heartbeat older than the bound, state not ended
#   3  dead: state ended, the sidecar's pid is gone, or no sidecar and no matching process
#   4  bad usage (any argument) / the sidecar file exists but is unreadable
#
# No arguments. No network: the script only reads the sidecar, /proc, /proc/meminfo and ps.
#
# Documented seams:
#   MULTIPI_STATUS_STALE_MS  integer ms (canonical decimal — a leading zero is refused,
#                            never read as octal); the stale bound (default 120000)
#   MULTIPI_STATUS_MEMINFO   /proc/meminfo path (default /proc/meminfo) — tests drive a
#                            fabricated file; the line degrades to no figures when unreadable
#   MULTIPI_STATUS_PI_PAT    ERE for the NO-SIDECAR process probe (default 'pi-coding-agent');
#                            the seam keeps the probe deterministic in tests and lets exotic
#                            pi installs be matched. With a sidecar, the probe is the pid itself.
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"
# shellcheck source=lib/liveness.sh
. "$scripts_dir/lib/liveness.sh"

[ $# -eq 0 ] || { echo "usage: scripts/multipi-status.sh (no arguments)" >&2; exit 4; }
dl_load_config
[ -n "${DL_ROOT:-}" ] || { echo "multipi-status: not inside a git repository" >&2; exit 4; }
# #78: a LEADING-ZERO bound (09) passes the all-digit gate, then bash honours it as 9 ms
# — a fresh sidecar flips to WEDGE and the typo never surfaces. Spec §1a pins the stance:
# malformed ⇒ rc 4. A non-canonical decimal is malformed: refuse it, never honour it.
stale=${MULTIPI_STATUS_STALE_MS:-120000}
case "$stale" in '' | *[!0-9]* | 0[0-9]*) echo "multipi-status: MULTIPI_STATUS_STALE_MS must be a canonical decimal integer ms (no leading zeros)" >&2; exit 4 ;; esac
now=$(date +%s%3N)
memsuffix=$(lv_mem_suffix "${MULTIPI_STATUS_MEMINFO:-/proc/meminfo}")

sc=$(lv_sidecar)
pid=""
if [ ! -f "$sc" ]; then
  pat=${MULTIPI_STATUS_PI_PAT:-pi-coding-agent}
  if pgrep -f "$pat" >/dev/null 2>&1; then
    echo "ALIVE (no liveness sidecar; a matching process is running)${memsuffix}"
    exit 1
  fi
  echo "DEAD (no sidecar, no matching process)${memsuffix}"
  exit 3
fi
lv_valid "$sc" || { echo "BAD: sidecar unreadable at $sc" >&2; exit 4; }

pid=$(lv_num "$sc" pid)
state=$(lv_field "$sc" state)
tick=$(lv_num "$sc" lastTickAt)
ev=$(lv_num "$sc" lastEventAt)
hb=$tick; [ "$ev" -gt "$hb" ] && hb=$ev
toolseq=$(lv_num "$sc" tool.seq)
toolname=$(lv_field "$sc" tool.name)
toolstart=$(lv_num "$sc" tool.startedAt)

# The tty is a kernel fact of a LIVE pid: it rides on the line wherever the pid is alive.
ttybit=""
if lv_pid_alive "$pid"; then
  lv_tty "$pid"
  ttybit=" tty=${LV_TTY:--}"
fi

if [ "$state" = ended ]; then
  echo "ENDED pid=${pid} (session ended)${ttybit}${memsuffix}"
  exit 3
fi
if ! lv_pid_alive "$pid"; then
  # The confirmed root cause of the vanished "No result provided" sessions is OOM-kill
  # (addendum 2026-11-15 21:20) — name the check on the line the operator reads.
  echo "DEAD pid=${pid} not running (state was ${state}) — likely OOM-killed; check: journalctl --since <start> | grep oom-kill${ttybit}${memsuffix}"
  exit 3
fi
if [ $((now - hb)) -gt "$stale" ]; then
  toolbit=""
  if [ "$toolseq" -gt 0 ]; then toolbit=" tool=${toolname} ($(lv_human_dur $((now - toolstart))))"; fi
  echo "STALE (suspected WEDGE) pid=${pid} heartbeat $(lv_human_dur $((now - hb))) ago${toolbit}${ttybit}${memsuffix}"
  exit 2
fi
if [ "$toolseq" -gt 0 ]; then
  echo "LIVE pid=${pid} tool=${toolname} ($(lv_human_dur $((now - toolstart)))) heartbeat $(lv_human_dur $((now - hb))) ago${ttybit}${memsuffix}"
  exit 0
fi
echo "IDLE pid=${pid} heartbeat $(lv_human_dur $((now - hb))) ago (no tool in flight)${ttybit}${memsuffix}"
exit 1
