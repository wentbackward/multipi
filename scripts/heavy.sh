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
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
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
    if ! kill -0 "$(cat "$entry/pid" 2>/dev/null || echo 0)" 2>/dev/null; then rm -rf -- "$entry"; fi
  done
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
  if mkdir "$lock_dir/slot$slot.d" 2>/dev/null; then
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
waiting_said=""
while true; do
  for ((slot = 1; slot <= slots; slot++)); do
    ran=""
    if command -v flock >/dev/null 2>&1; then
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
