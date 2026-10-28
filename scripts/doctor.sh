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
# Resolution is probed with Node's own resolver FROM THE EXTENSION DIRECTORY — the same lookup
# pi performs when it loads the extension. The probe silences stdout while a package is imported
# (so dependency side-effects cannot masquerade as verdicts) and prints exactly one verdict line
# per genuinely unresolvable known package.
if [ -n "$DL_ROOT" ] && [ -d "$DL_ROOT/.pi/extensions/multipi-devloop" ]; then
  if ! command -v node >/dev/null 2>&1; then
    missing "node (the devloop extension cannot run; install Node.js)"
  else
    probe_out=$(
      cd "$DL_ROOT/.pi/extensions/multipi-devloop" && node --input-type=module -e '
const say = process.stdout.write.bind(process.stdout);
for (const pkg of ["typebox", "@earendil-works/pi-coding-agent"]) {
  process.stdout.write = () => true; // swallow import-time side effects of a dependency
  let missed = false;
  try { await import(pkg); } catch { missed = true; } finally { process.stdout.write = say; }
  if (missed) say(pkg + "\n");
}
' 2>/dev/null
    )
    probe_rc=$?
    # Only verdict lines for the two known packages count as missing-package names; any other
    # line (or a non-zero probe exit) means the probe itself did not run cleanly — nothing
    # beyond the extracted names was verified, so it is reported as its own MISSING line.
    known_missing=''
    probe_bad=0
    while IFS= read -r line; do
      case "$line" in
        typebox | @earendil-works/pi-coding-agent) known_missing+="$line"$'\n' ;;
        '') ;;
        *) probe_bad=1 ;;
      esac
    done <<<"$probe_out"
    if [ -n "$known_missing" ]; then
      while IFS= read -r pkg; do
        [ -n "$pkg" ] || continue # herestring: skip the trailing empty line
        missing "$pkg (cannot be resolved from .pi/extensions/multipi-devloop; npm i -D typebox @earendil-works/pi-coding-agent)"
      done <<<"$known_missing"
    fi
    if [ "$probe_bad" -ne 0 ] || [ "$probe_rc" -ne 0 ]; then
      missing "extension runtime probe (import check did not run cleanly; node exit $probe_rc)"
    elif [ -z "$known_missing" ]; then
      ok "extension runtime (node $(node --version), typebox, pi-coding-agent)"
    fi
  fi
fi
[ "$problems" -eq 0 ] && echo "doctor: ready" || echo "doctor: $problems problem(s)"
[ "$problems" -eq 0 ]
