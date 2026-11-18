#!/usr/bin/env bash
# Run a heavy command (full test suite, e2e, big build) in one of N machine-wide slots, under a memory cap.
#
# Usage: heavy.sh <command> [args...]      (blocks until a slot is free, exits with the command's status)
#
# The slots are shared by every repository, worktree and session of this user on this machine: the lock
# directory lives under the user's runtime (or temp) directory, not in a repository. Each slot exports its
# own port (heavy.port_env = heavy.port_base + slot * heavy.port_step) so two e2e servers never collide.
#
# Config (.devloop.json, all optional): heavy.slots (2), heavy.memory_max ("" = no cap, e.g. "8G"),
# heavy.port_env, heavy.port_base (8600), heavy.port_step (10), heavy.clean_temp (globs of stale temp
# entries to delete), heavy.clean_temp_minutes (120), heavy.poll_seconds (10).
# Environment: MULTIPI_LOCK_DIR overrides the lock directory, MULTIPI_HEAVY_SLOTS the slot count.
set -u
# Pure-bash bootstrap (no dirname, no pwd(1)): a PATH that an upstream actor
# scrubbed or emptied entirely carries no coreutils, and the named dl_die must
# still be reachable (alignment with gate-train.sh, the ticket #67 form; #76
# item 2). The cd runs in a SUBSHELL — the script's cwd must stay where the
# operator called it.
case "${BASH_SOURCE[0]}" in
  */*) _sd=${BASH_SOURCE[0]%/*} ;;
  *) _sd=. ;;
esac
scripts_dir=$(cd -- "$_sd" && printf '%s' "$PWD")
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"

[ $# -gt 0 ] || dl_die "usage: heavy.sh <command> [args...]"
dl_load_config

slots=${MULTIPI_HEAVY_SLOTS:-$(cfg heavy.slots 2)}
memory_max=$(cfg heavy.memory_max "")
port_env=$(cfg heavy.port_env "")
port_base=$(cfg heavy.port_base 8600)
port_step=$(cfg heavy.port_step 10)
poll_seconds=$(cfg heavy.poll_seconds 10)
clean_minutes=$(cfg heavy.clean_temp_minutes 120)
lock_dir=${MULTIPI_LOCK_DIR:-${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/multipi-heavy-slots}
[[ "$slots" =~ ^[1-9][0-9]*$ ]] || dl_die "heavy.slots must be a positive integer (got '$slots')"
mkdir -p "$lock_dir" || dl_die "cannot create $lock_dir"

# clean_stale_temp: delete temp entries this tool knows about once they are older than clean_minutes:
# the project's heavy.clean_temp globs, old pytest base directories (the 5 newest are kept), dead locks.
clean_stale_temp() {
  local count i pattern entry
  count=$(cfg_len heavy.clean_temp)
  for ((i = 0; i < count; i++)); do
    pattern=$(cfg "heavy.clean_temp.$i" "")
    [ -n "$pattern" ] || continue
    pattern=${pattern//\$USER/${USER:-$(id -un)}}
    # shellcheck disable=SC2086  # intentional glob expansion of the configured pattern
    for entry in $pattern; do
      [ -e "$entry" ] || continue
      if [ -n "$(find "$entry" -maxdepth 0 -mmin +"$clean_minutes" 2>/dev/null)" ]; then
        chmod -R u+w "$entry" 2>/dev/null
        rm -rf -- "$entry"
      fi
    done
  done
  local pytest_root=${TMPDIR:-/tmp}/pytest-of-${USER:-$(id -un)}
  if [ -d "$pytest_root" ]; then
    # shellcheck disable=SC2012  # names are pytest-<n>, no spaces
    ls -dt "$pytest_root"/pytest-[0-9]* 2>/dev/null | tail -n +6 | while read -r entry; do
      chmod -R u+w "$entry" 2>/dev/null
      rm -rf -- "$entry"
    done
  fi
  for entry in "$lock_dir"/slot*.d; do
    [ -d "$entry" ] || continue
    slot_sweepable "$entry" && rm -rf -- "$entry"
  done
}

# slot_holder_dead LOCKDIR: true when a slot-lock directory holds NO live owner: no pid file
# at all, an unusable one (non-numeric, a leading zero, 0), or a pid that is not running.
# A SIGKILLed holder skips its EXIT trap, so its lock must ALWAYS read as FREE (ticket #68).
# `0` is rejected by the regex, not by `kill -0`: pid 0 targets the CALLER'S own process
# group and would answer "alive" for a ghost — the exact fallback the header forbids.
slot_holder_dead() { # slot_holder_dead LOCKDIR
  local pid=""
  [ -f "$1/pid" ] || return 0
  pid=$(tr -d '[:space:]' <"$1/pid" 2>/dev/null)
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  kill -0 "$pid" 2>/dev/null && return 1
  return 0
}

# slot_sweepable LOCKDIR: a slot-lock dir may be REMOVED only when its owner is dead AND
# the dir is at least one poll tick OLD. A holder between its `mkdir` and its
# `echo $$ > pid` looks ownerless for a few microseconds — the grace tick closes that
# window (ticket #67, review of #68 r3: the sweep racing a fresh dir would let two jobs
# into one slot). Unstat-able dirs read as UNSWEEPABLE: the fail-safe direction (a stalled
# queue is recoverable by deletion; a double-acquire is not). `stat -c %Y` (GNU) and
# `stat -f %m` (BSD) cover both platforms the mkdir path exists for.
slot_sweepable() { # slot_sweepable LOCKDIR
  local mt
  slot_holder_dead "$1" || return 1
  mt=$(stat -c %Y "$1" 2>/dev/null) || mt=$(stat -f %m "$1" 2>/dev/null) || return 1
  [ $(( $(date +%s) - mt )) -ge "$poll_seconds" ]
}

# have_flock: a flock that actually WORKS. The probe performs the SAME operation the slot
# locks perform — a non-blocking exclusive acquisition on a scratch file via an inherited
# fd — because a NAME check is not a capability check: `flock --version` is missing from a
# working busybox flock (the old probe silently downgraded it to the mkdir path, ticket
# #67) and a broken placeholder answers `command -v` but fails at use (ticket #68). The
# scratch file is per-pid and deleted afterwards; the lock is released with the subshell.
have_flock() {
  local f rc
  command -v flock >/dev/null 2>&1 || return 1
  f="${TMPDIR:-/tmp}/.multipi-have-flock.$$.tmp"
  ( flock -n 9 ) 9>>"$f"
  rc=$?
  rm -f "$f"
  return "$rc"
}

# have_memory_cap: true when systemd can run a transient user scope with a memory limit.
have_memory_cap() {
  command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

# run_in_slot SLOT: run the command with the slot's port, under the memory cap when one is configured.
run_in_slot() {
  local slot=$1
  shift
  export MULTIPI_SLOT=$slot
  if [ -n "$port_env" ]; then
    export "$port_env=$((port_base + slot * port_step))"
  fi
  echo "[heavy.sh] slot $slot/$slots acquired: $*" >&2
  if [ -z "$memory_max" ]; then
    "$@"
  elif have_memory_cap; then
    systemd-run --user --scope --quiet -p MemoryMax="$memory_max" -- "$@"
  else
    dl_warn "heavy.sh: no systemd user manager; running without the $memory_max memory cap"
    "$@"
  fi
}

# try_slot_flock SLOT COMMAND...: if the slot is free, take it, run the command and set ran=yes.
# The lock is held by an open file descriptor, so the kernel frees it even if this script is killed.
try_slot_flock() {
  local slot=$1 fd rc=0
  shift
  exec {fd}>"$lock_dir/slot$slot.lock"
  if flock -n "$fd"; then
    ran=yes
    run_in_slot "$slot" "$@"
    rc=$?
    flock -u "$fd"
  fi
  exec {fd}>&-
  return "$rc"
}

# try_slot_mkdir SLOT COMMAND...: the same with a lock directory, for systems without flock (macOS).
try_slot_mkdir() {
  local slot=$1 rc=0
  shift
  local d="$lock_dir/slot$slot.d"
  # A holder SIGKILLed mid-hold (EXIT trap skipped) leaves its dir with a dead pid — or no
  # pid file at all; either way the lock reads as FREE. The startup sweep (clean_stale_temp)
  # already ran BEFORE this slot was taken, so a WAITING instance must re-check at
  # acquisition, or it polls the ghost forever (ticket #68). The check is
  # slot_sweepable, not slot_holder_dead: a FRESH ownerless dir may belong to a holder
  # between its mkdir and its pid write, and sweeping it is the sub-ms double-acquire of
  # ticket #67 — the grace tick (>= poll_seconds old) closes the window.
  if [ -d "$d" ] && slot_sweepable "$d"; then
    rm -rf -- "$d"
  fi
  if mkdir "$d" 2>/dev/null; then
    ran=yes
    echo $$ >"$lock_dir/slot$slot.d/pid"
    trap 'rm -rf -- "$lock_dir/slot$slot.d"' EXIT INT TERM
    run_in_slot "$slot" "$@"
    rc=$?
    rm -rf -- "$lock_dir/slot$slot.d"
    trap - EXIT INT TERM
  fi
  return "$rc"
}

clean_stale_temp
# Whether flock WORKS is a property of the system, not of each poll: probe once, reuse
# the answer inside the loop (review round 2 — no repeated version probes per slot per tick).
use_flock=no
have_flock && use_flock=yes
waiting_said=""
while true; do
  for ((slot = 1; slot <= slots; slot++)); do
    ran=""
    if [ "$use_flock" = yes ]; then
      try_slot_flock "$slot" "$@"
    else
      try_slot_mkdir "$slot" "$@"
    fi
    rc=$?
    [ -z "$ran" ] || exit "$rc"
  done
  if [ -z "$waiting_said" ]; then
    echo "[heavy.sh] all $slots slots busy, waiting: $*" >&2
    waiting_said=yes
  fi
  sleep "$poll_seconds"
done
