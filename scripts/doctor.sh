#!/usr/bin/env bash
# Check that this machine and repository have what the dev loop needs, and print the resolved config.
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"

problems=0
ok() { echo "ok      $*"; }
missing() {
  echo "MISSING $*"
  problems=$((problems + 1))
}
optional() { echo "note    $*"; }

if command -v git >/dev/null 2>&1; then ok "git $(git --version | cut -d' ' -f3)"; else missing "git"; fi
if command -v jq >/dev/null 2>&1; then ok "jq"; elif command -v python3 >/dev/null 2>&1; then
  optional "jq not found: JSON is read with python3"
else missing "jq or python3 (to read .devloop.json)"; fi
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then ok "gh (authenticated)"; else missing "gh is not logged in (gh auth login)"; fi
else missing "gh (GitHub CLI) for issues and PRs"; fi
if command -v flock >/dev/null 2>&1; then ok "flock"; else optional "flock not found: heavy.sh uses lock directories"; fi
if command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  ok "systemd user scopes (heavy.memory_max is enforced)"
else optional "no systemd user manager: heavy.memory_max is not enforced"; fi

dl_load_config
if [ -z "$DL_ROOT" ]; then
  missing "a git repository (run inside the project)"
elif [ ! -f "$DL_CONFIG" ]; then
  missing "$DL_CONFIG (run the devloop setup skill)"
else
  ok "config $DL_CONFIG"
  if [ -n "$(json_get "" <"$DL_CONFIG")" ]; then ok "valid JSON"; else missing "valid JSON in $DL_CONFIG"; fi
  if [ "$(cfg_len checks)" -gt 0 ]; then ok "$(cfg_len checks) gate checks"; else missing "\"checks\" in $DL_CONFIG"; fi
  if git -C "$DL_ROOT" remote get-url "$DL_REMOTE" >/dev/null 2>&1; then ok "remote $DL_REMOTE"; else missing "git remote $DL_REMOTE"; fi
  echo "        base branch   $DL_BASE"
  echo "        gate worktree $(dl_gate_dir)"
  echo "        notes         $(dl_notes_dir)"
  echo "        logs          $(dl_logs_dir)"
  echo "        heavy slots   $(cfg heavy.slots 2), memory cap $(cfg heavy.memory_max none)"
  if [ -f "$DL_ROOT/AGENTS.md" ]; then ok "AGENTS.md"; else missing "AGENTS.md (run the devloop setup skill)"; fi
  if [ -f "$DL_ROOT/docs/DECISIONS.md" ]; then ok "docs/DECISIONS.md"; else optional "no docs/DECISIONS.md"; fi
fi

# Extension runtime: the installed extension imports typebox and the pi package at load time;
# a repo missing either dies inside pi with an inscrutable load error, so doctor catches it here.
# Resolution is probed with Node's own resolver from the repo root — the same lookup pi performs.
if [ -n "$DL_ROOT" ] && [ -d "$DL_ROOT/.pi/extensions/multipi-devloop" ]; then
  if ! command -v node >/dev/null 2>&1; then
    missing "node (the devloop extension cannot run; install Node.js)"
  else
    unresolved=$(cd "$DL_ROOT" && node --input-type=module -e '
for (const pkg of ["typebox", "@earendil-works/pi-coding-agent"]) {
  try { await import(pkg); } catch { console.log(pkg); }
}' 2>/dev/null)
    probe_rc=$?
    if [ -n "$unresolved" ]; then
      while IFS= read -r pkg; do
        missing "$pkg (not in $DL_ROOT/node_modules; npm i -D typebox @earendil-works/pi-coding-agent)"
      done <<<"$unresolved"
    elif [ "$probe_rc" -ne 0 ]; then
      # The probe itself died (a dependency crashed node at import): nothing was verified,
      # so never print an ok line for it.
      missing "extension runtime probe (node exited $probe_rc while importing the extension's dependencies)"
    else
      ok "extension runtime (node $(node --version), typebox, pi-coding-agent)"
    fi
  fi
fi
[ "$problems" -eq 0 ] && echo "doctor: ready" || echo "doctor: $problems problem(s)"
[ "$problems" -eq 0 ]
