# shellcheck shell=bash
# Shared half of the liveness surface (spec 2026-11-15): the sidecar the extension maintains
# at <state>/orchestrator-state.json, plus the TTY-paste injection shared by
# multipi-interrupt.sh and multipi-watch.sh. The TypeScript twin is extension/src/liveness.ts;
# both sides render the same line skeleton and the same rc table, and both are pinned by
# tests (unit for the TS, smoke for the bash) so neither can drift silently.
#
# Requires: common.sh sourced (DL_STATE set). Nothing here touches the network.
#
# The LV_* facts set below are read by the consuming scripts (the consumer crosses a
# file, so shellcheck cannot see the use — SC2034 is suppressed file-wide on purpose, the
# same pattern as the git shim).
# shellcheck disable=SC2034

# lv_sidecar: the sidecar path of this project's state dir.
lv_sidecar() {
  printf '%s/orchestrator-state.json\n' "$DL_STATE"
}

# lv_field FILE FIELD: one dotted field of the sidecar ("" when missing/null).
lv_field() {
  json_get "$2" <"$1" 2>/dev/null || true
}

# lv_num FILE FIELD [DEFAULT]: a non-negative integer field, or DEFAULT.
lv_num() {
  local v
  v=$(lv_field "$1" "$2")
  case "$v" in
    '' | *[!0-9]*) printf '%s\n' "${3:-0}" ;;
    *) printf '%s\n' "$v" ;;
  esac
}

# lv_valid FILE: the document parses and carries the fields a reader needs.
lv_valid() {
  local f=$1
  [ -f "$f" ] || return 1
  [ "$(lv_field "$f" schema)" = "1" ] || return 1
  case "$(lv_field "$f" state)" in active | idle | ended) : ;; *) return 1 ;; esac
  case "$(lv_field "$f" pid)" in '' | *[!0-9]*) return 1 ;; esac
  case "$(lv_field "$f" lastTickAt)" in '' | *[!0-9]*) return 1 ;; esac
  return 0
}

# lv_pid_alive PID: the process exists (a /proc check, with kill -0 as the portable fallback).
lv_pid_alive() {
  [ -d "/proc/$1" ] && return 0
  kill -0 "$1" 2>/dev/null
}

# lv_human_dur MS: s / m / h Xm / d scales — the same renderings as humanDur in liveness.ts.
lv_human_dur() {
  local ms=$1 s m h d
  s=$((ms / 1000)) m=$((s / 60)) h=$((m / 60)) d=$((h / 24))
  if [ "$s" -lt 60 ]; then printf '%ss' "$s"
  elif [ "$m" -lt 60 ]; then printf '%sm' "$m"
  elif [ "$h" -lt 48 ]; then printf '%sh%sm' "$h" "$((m % 60))"
  else printf '%sd' "$d"; fi
}

# lv_human_mem KIB: GiB with one decimal, else integral MiB (humanMem in liveness.ts).
lv_human_mem() {
  local kib=$1
  if [ "$kib" -ge 1048576 ]; then
    awk -v k="$kib" 'BEGIN{printf "%.1fG", k/1048576}'
  else
    awk -v k="$kib" 'BEGIN{printf "%dM", int(k/1024+0.5)}'
  fi
}

# lv_meminfo FILE: "RAM_KIB SWAPFREE_KIB" from a /proc/meminfo-shaped file ("" when unreadable).
lv_meminfo() {
  awk '/^MemAvailable:/{m=$2} /^SwapFree:/{s=$2} END{if(m!="" && s!="") print m+0, s+0}' "$1" 2>/dev/null
}

# lv_mem_suffix [MEMINFO_PATH]: " ram=<..> swapfree=<..>" or "" (an unreadable meminfo
# degrades to no figures — the line never fails because /proc was odd that day).
lv_mem_suffix() {
  local src=${1:-/proc/meminfo} kv ram swap
  [ -f "$src" ] || return 0
  kv=$(lv_meminfo "$src")
  [ -n "$kv" ] || return 0
  ram=${kv%% *}
  swap=${kv#* }
  printf ' ram=%s swapfree=%s' "$(lv_human_mem "$ram")" "$(lv_human_mem "$swap")"
}

# lv_tty PID: the process's controlling tty from fd 0. Sets LV_TTY ("" when fd 0 is not
# /dev/tty or /dev/pts/*) and LV_TTY_RAW (for diagnostics).
lv_tty() {
  local raw
  raw=$(readlink "/proc/$1/fd/0" 2>/dev/null || true)
  LV_TTY_RAW=${raw:-n/a}
  case "$raw" in
    /dev/tty | /dev/pts/*) LV_TTY=$raw ;;
    *) LV_TTY="" ;;
  esac
}

# lv_inject_target PID: resolve where a paste goes. The documented seam
# MULTIPI_INTERRUPT_TTY overrides the resolved path (smoke tests drive it; the seam is
# trusted — it bypasses the /dev/tty|pts check on purpose). Sets LV_TARGET ("" when unusable)
# and LV_TTY_SRC (a short origin label for logs/output).
lv_inject_target() {
  if [ -n "${MULTIPI_INTERRUPT_TTY:-}" ]; then
    LV_TARGET=$MULTIPI_INTERRUPT_TTY
    LV_TTY_SRC="seam"
    return 0
  fi
  lv_tty "$1"
  LV_TARGET=$LV_TTY
  LV_TTY_SRC="fd0"
}

# lv_no_tty_fallback PID RAW: the printed kill-and-resume instructions (the honest limit of
# a TTY paste: it cannot reach a detached or dead terminal).
lv_no_tty_fallback() {
  echo "multipi-interrupt: no usable TTY for pid $1 (fd 0 → $2)"
  echo "This is a TTY paste, not an RPC — the session's terminal is detached or dead."
  echo "Fallback (kill and resume):"
  echo "  kill $1"
  echo "  start a fresh pi session in ${DL_ROOT:-.} and say: keep going"
  echo "  (the devloop skill step 0 recovers state from git + the dl/ labels)"
}

# lv_interrupt_log DRY(0|1) PID MSG: one auditable line in <state>/interrupts.log.
# ONE LINE PER EVENT is this log's contract (operators and the loop grep it line-wise):
# the message is flattened to a single line (CR/LF/TAB -> space) and capped at 4096 chars.
lv_interrupt_log() {
  mkdir -p "$DL_STATE" 2>/dev/null || return 0
  local oneline
  oneline=$(printf '%s' "$3" | tr '\r\n\t' '   ' | cut -c1-4096)
  printf '%s pid=%s dry=%s msg=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "$1" "$oneline" >>"$DL_STATE/interrupts.log" 2>/dev/null || true
}

# lv_last_wake_ts LOG: the timestamp (ms) of the last WAKE/WEDGE entry (0 when none).
lv_last_wake_ts() {
  awk '$2 == "WAKE" || $2 == "WEDGE" {t = $1} END {print t + 0}' "$1" 2>/dev/null || echo 0
}

# lv_last_blocked_ts LOG N: the timestamp (ms) of the last `BLOCKED n=N` entry (0 when
# none) — the per-ticket 24h ledger of the blocked-nudge (ticket #104), the same watch-
# log-ledger pattern as lv_last_wake_ts. BLOCKED-SKIP/NO-TTY/NO-AGE entries do not count
# (only a DELIVERED wake starts the window).
lv_last_blocked_ts() {
  awk -v n="$2" '$2 == "BLOCKED" { split($3, kv, "="); if (kv[2] == n) t = $1 } END { print t + 0 }' "$1" 2>/dev/null || echo 0
}

# lv_last_probe_ts LOG: the timestamp (ms) of the last BL-PROBE stamp (0 when none) —
# the tracker-probe throttle ledger of the blocked-nudge (ticket #104 gate revision):
# the probe (gh auth + issue list + per-ticket calls) runs at most once per
# BLOCKED_PROBE_THROTTLE_MS. Same watch-log-ledger pattern as lv_last_wake_ts.
lv_last_probe_ts() {
  awk '$2 == "BL-PROBE" {t = $1} END {print t + 0}' "$1" 2>/dev/null || echo 0
}

# lv_bump_wake_seq FILE SEQ: atomically raise the sidecar's lastWakeSeq watermark
# (read-modify-write through a tmp + rename, like the extension's own writer). The two
# publishers race on the same file, so this closes the SAME lost-update window the
# extension side does (liveness.publishState): bounded CAS loop (≤ 3) — snapshot the
# file, merge (max — never a downgrade), re-read, rename ONLY if the file is unchanged.
# On exhaustion it logs to stderr and gives up WITHOUT writing — a lost bump costs at
# most one duplicate wake, and the watchdog's 3600 s wall axis caps the damage. The CALLER
# pins the contract: a non-zero return (including a missing python3, rc 127 → 1) is logged
# as a BUMP-FAILED line in watch.log by multipi-watch.sh — the degradation is visible, not
# silent (smoke-pinned).
lv_bump_wake_seq() {
  python3 - "$1" "$2" <<'PY' || return 1
import json, os, sys, tempfile
p, seq = sys.argv[1], int(sys.argv[2])
def snap():
    try:
        with open(p, "rb") as f:
            return f.read()
    except FileNotFoundError:
        return None
for _ in range(3):
    before = snap()
    try:
        d = json.loads(before)
        if not isinstance(d, dict):
            raise ValueError
    except Exception:
        sys.exit(0)  # missing/corrupt doc: the extension's writer owns its shape — leave it
    d["lastWakeSeq"] = max(d.get("lastWakeSeq", -1), seq)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p) or ".")
    with os.fdopen(fd, "w") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
    if snap() == before:
        os.rename(tmp, p)
        sys.exit(0)
    os.unlink(tmp)
sys.stderr.write("multipi-watch: lastWakeSeq bump abandoned after 3 stale reads (bounded; wall axis caps damage)\n")
sys.exit(1)
PY
}
