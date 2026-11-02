# shellcheck shell=bash
# Shared helpers for the multipi (dev-loop) scripts: repository paths and the project config
# (.devloop.json). JSON is read with jq when it is installed, else with python3
# (MULTIPI_NO_JQ=1 forces python3).

dl_die() {
  echo "multipi: $*" >&2
  exit 2
}

dl_have_jq() {
  [ -z "${MULTIPI_NO_JQ:-}" ] && command -v jq >/dev/null 2>&1
}

dl_warn() {
  echo "multipi: $*" >&2
}

# json_get PATH < json  -> the value at a dotted path ("heavy.slots", "checks.0.name").
# Strings print raw, other values as JSON, missing or null values print nothing.
json_get() {
  local path=$1
  if dl_have_jq; then
    jq -r --arg p "$path" '
      ($p | if . == "" then [] else split(".") | map(tonumber? // .) end) as $k
      | (try getpath($k) catch null)
      | if . == null then empty elif type == "string" then . else tojson end' 2>/dev/null
  else
    python3 -I -c '
import json, sys
path = [p for p in sys.argv[1].split(".") if p]
try:
    value = json.load(sys.stdin)
    for key in path:
        if isinstance(value, list):
            value = value[int(key)]
        elif isinstance(value, dict):
            value = value[key]
        else:
            raise KeyError(key)
except (KeyError, IndexError, ValueError, TypeError):
    sys.exit(0)
if value is None:
    sys.exit(0)
print(value if isinstance(value, str) else json.dumps(value))
' "$path" 2>/dev/null
  fi
}

# json_len PATH < json  -> the length of the array at PATH (0 when missing or not an array).
json_len() {
  local value
  value=$(json_get "$1")
  if [ -z "$value" ]; then
    echo 0
  elif dl_have_jq; then
    printf '%s' "$value" | jq -r 'if type == "array" then length else 0 end' 2>/dev/null || echo 0
  else
    printf '%s' "$value" | python3 -I -c '
import json, sys
value = json.load(sys.stdin)
print(len(value) if isinstance(value, list) else 0)' 2>/dev/null || echo 0
  fi
}

# dl_main_root: the root of the main worktree (where .devloop.json lives), from any worktree.
dl_main_root() {
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  if [ "$(basename "$common")" = ".git" ]; then
    dirname "$common"
  else
    git rev-parse --show-toplevel 2>/dev/null
  fi
}

# dl_load_config [required]: sets DL_ROOT, DL_CONFIG, DL_REPO, DL_STATE and the common settings.
# With "required", a missing repository or config file is an error; otherwise defaults apply.
dl_load_config() {
  local required=${1:-}
  DL_ROOT=$(dl_main_root) || DL_ROOT=""
  if [ -z "$DL_ROOT" ] && [ "$required" = required ]; then
    dl_die "not inside a git repository"
  fi
  DL_CONFIG=${MULTIPI_CONFIG:-${DL_ROOT:+$DL_ROOT/.devloop.json}}
  if [ "$required" = required ] && [ ! -f "$DL_CONFIG" ]; then
    dl_die "no config at ${DL_CONFIG:-.devloop.json}; run the devloop setup skill or copy templates/devloop.json"
  fi
  DL_REPO=$(basename "${DL_ROOT:-$PWD}")
  DL_STATE=${MULTIPI_HOME:-$HOME/.multipi}/$DL_REPO
  DL_REMOTE=$(cfg remote origin)
  DL_BASE=$(cfg base_branch main)
  # Fork-trap protection: bare `gh` calls in a fork can resolve to the UPSTREAM tracker
  # by default (see AGENTS.md). Pin GH_REPO to the configured origin unless the caller
  # already exported one. Applies to every loop script (gate/merge/open-pr/doctor/heavy).
  # NOTE: this block is local patch — keep it in sync with the per-repo copies (crisis_monitor
  # main @ 4a60747). An upgrade reinstall overwrites per-repo scripts from this plugin source;
  # without the pin here, upgrades silently drop the pin and merges hit the parent tracker.
  if [ -z "${GH_REPO:-}" ]; then
    local origin_url
    origin_url=$(git -C "${DL_ROOT:-.}" remote get-url "$DL_REMOTE" 2>/dev/null || true)
    case $origin_url in
      *github.com*)
        GH_REPO=$(printf '%s\n' "$origin_url" | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')
        ;;
    esac
  fi
  [ -n "${GH_REPO:-}" ] && export GH_REPO
  # Return 0 unconditionally: as the function's last command, the conditional above
  # would make dl_load_config fail whenever GH_REPO is empty, breaking every "&&" caller.
  return 0
}

# cfg PATH [DEFAULT]: a value from the project config, or DEFAULT.
cfg() {
  local value=""
  if [ -n "${DL_CONFIG:-}" ] && [ -f "$DL_CONFIG" ]; then
    value=$(json_get "$1" <"$DL_CONFIG")
  fi
  if [ -n "$value" ]; then printf '%s\n' "$value"; else printf '%s\n' "${2:-}"; fi
}

# cfg_len PATH: the length of an array in the project config.
cfg_len() {
  if [ -n "${DL_CONFIG:-}" ] && [ -f "$DL_CONFIG" ]; then json_len "$1" <"$DL_CONFIG"; else echo 0; fi
}

# dl_resolve PATH: an absolute path; relative paths resolve against the main worktree root.
dl_resolve() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    "~"/*) printf '%s\n' "$HOME/${1#"~/"}" ;;
    *) printf '%s\n' "${DL_ROOT:-$PWD}/$1" ;;
  esac
}

# dl_canonical PATH: an absolute path without . or .. components (unchanged if realpath is missing).
dl_canonical() {
  realpath -m -q -- "$1" 2>/dev/null || printf '%s\n' "$1"
}

dl_notes_dir() {
  local configured
  configured=$(cfg notes_dir "")
  if [ -n "$configured" ]; then dl_canonical "$(dl_resolve "$configured")"; else dl_canonical "$DL_STATE/notes"; fi
}

dl_logs_dir() {
  local configured
  configured=$(cfg logs_dir "")
  if [ -n "$configured" ]; then dl_canonical "$(dl_resolve "$configured")"; else dl_canonical "$DL_STATE/logs"; fi
}

dl_worktree_dir() {
  # Single directory holding ALL issue worktrees of this project (plus the gate worktree).
  # worktree_dir: absolute, ~/, or relative to the repo's PARENT dir (never the repo itself —
  # a worktree cannot live inside the repository it belongs to). Mirrors worktreeDir in config.ts.
  local wd
  wd=$(cfg worktree_dir "")
  if [ -z "$wd" ]; then
    dl_canonical "$DL_STATE/worktrees/$DL_REPO"
  elif [ "${wd#/}" != "$wd" ] || [ "${wd#~/}" != "$wd" ]; then
    dl_canonical "$(dl_resolve "$wd")"
  else
    dl_canonical "$(dl_resolve "../$wd")"
  fi
}

dl_gate_dir() {
  local configured
  configured=$(cfg gate_worktree "")
  if [ -n "$configured" ]; then
    dl_canonical "$(dl_resolve "$configured")"
  else
    # Default: <worktree dir>/gate — the same default config.ts computes, so scripts and
    # extension agree on one location.
    dl_canonical "$(dl_worktree_dir)/gate"
  fi
}

# dl_note_file BRANCH: the PR notes file of a branch (slashes become underscores).
dl_note_file() {
  printf '%s/pr-%s.md\n' "$(dl_notes_dir)" "${1//\//_}"
}

# dl_train_file: where gate-train.sh records the last green train (branch, source head, gated head).
dl_train_file() {
  printf '%s/train-green.txt\n' "$DL_STATE"
}

# dl_ensure_gate_worktree: create the gate worktree (detached at the base) if it does not exist yet.
dl_ensure_gate_worktree() {
  local gate
  gate=$(dl_gate_dir)
  if [ -d "$gate" ]; then
    git -C "$gate" rev-parse --git-dir >/dev/null 2>&1 || dl_die "$gate exists but is not a git worktree"
    [ "$(cd "$gate" && dl_main_root)" = "$DL_ROOT" ] || dl_die "$gate is a worktree of another repository"
  else
    git -C "$DL_ROOT" fetch -q "$DL_REMOTE" || dl_die "git fetch $DL_REMOTE failed"
    git -C "$DL_ROOT" worktree add -q --detach "$gate" "$DL_REMOTE/$DL_BASE" >/dev/null ||
      dl_die "could not create the gate worktree at $gate"
  fi
  printf '%s\n' "$gate"
}
