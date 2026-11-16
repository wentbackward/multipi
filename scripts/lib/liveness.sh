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
lv_interrupt_log() {
  mkdir -p "$DL_STATE" 2>/dev/null || return 0
  printf '%s pid=%s dry=%s msg=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "$1" "$3" >>"$DL_STATE/interrupts.log" 2>/dev/null || true
}

# lv_last_wake_ts LOG: the timestamp (ms) of the last WAKE/WEDGE entry (0 when none).
lv_last_wake_ts() {
  awk '$2 == "WAKE" || $2 == "WEDGE" {t = $1} END {print t + 0}' "$1" 2>/dev/null || echo 0
}

# lv_bump_wake_seq FILE SEQ: atomically raise the sidecar's lastWakeSeq watermark
# (read-modify-write through a tmp + rename, like the extension's own writer).
lv_bump_wake_seq() {
  python3 - "$1" "$2" <<'PY' 2>/dev/null || return 0
import json, os, sys, tempfile
p, seq = sys.argv[1], int(sys.argv[2])
with open(p) as f:
    d = json.load(f)
d["lastWakeSeq"] = seq
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p))
with os.fdopen(fd, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
os.rename(tmp, p)
PY
}
