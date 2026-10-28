#!/usr/bin/env bash
# Print the multipi (dev-loop) paths of the current repository, so prompts and notes use
# absolute paths.
#
# Usage: paths.sh notes <branch> | notes-dir | logs | gate | state | config | root
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"

dl_load_config
[ -n "$DL_ROOT" ] || dl_die "not inside a git repository"
case "${1:-}" in
  notes)
    [ -n "${2:-}" ] || dl_die "usage: paths.sh notes <branch>"
    mkdir -p "$(dl_notes_dir)"
    dl_note_file "$2"
    ;;
  notes-dir) dl_notes_dir ;;
  logs) dl_logs_dir ;;
  gate) dl_gate_dir ;;
  state) printf '%s\n' "$DL_STATE" ;;
  config) printf '%s\n' "$DL_CONFIG" ;;
  root) printf '%s\n' "$DL_ROOT" ;;
  *) dl_die "usage: paths.sh notes <branch> | notes-dir | logs | gate | state | config | root" ;;
esac
