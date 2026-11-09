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
  cfg_valid=0
  if [ -n "$(json_get "" <"$DL_CONFIG")" ]; then ok "valid JSON"; cfg_valid=1; else missing "valid JSON in $DL_CONFIG"; fi
  if [ "$(cfg_len checks)" -gt 0 ]; then ok "$(cfg_len checks) gate checks"; else missing "\"checks\" in $DL_CONFIG"; fi
  if git -C "$DL_ROOT" remote get-url "$DL_REMOTE" >/dev/null 2>&1; then ok "remote $DL_REMOTE"; else missing "git remote $DL_REMOTE"; fi
  echo "        base branch   $DL_BASE"
  echo "        gate worktree $(dl_gate_dir)"
  echo "        notes         $(dl_notes_dir)"
  echo "        logs          $(dl_logs_dir)"
  echo "        heavy slots   $(cfg heavy.slots 2), memory cap $(cfg heavy.memory_max none)"
  # Factory mode and store health (dark-factory spec §2): the report is computed by
  # importing the pure modules (loadConfig/scenariosOn/resolvePaths from config.ts,
  # scanStore/storeCounts from scenarios.ts) so doctor shares exactly one notion of
  # on/off, path resolution, and scenario validity with the gate. Node prints one JSON
  # object; doctor applies the spec's note-vs-MISSING rules and does the tallying.
  if [ "$cfg_valid" -eq 1 ]; then
    factory_src=""
    for cand in "$DL_ROOT/.pi/extensions/multipi-devloop/src" "$scripts_dir/../extension/src"; do
      if [ -f "$cand/config.ts" ] && [ -f "$cand/scenarios.ts" ]; then factory_src=$cand; break; fi
    done
    factory_json=""
    if [ -z "$factory_src" ]; then
      optional "factory report unavailable (scenario modules not found)"
    elif ! command -v node >/dev/null 2>&1; then
      optional "factory report skipped (node not found)"
    else
      # SCEN_SRC env, not string interpolation: the path never enters the JS source, so a
      # path containing a quote can't break (or alter) the one-shot — the stage's pattern.
      # stderr goes to a temp file, not /dev/null (ticket #37): when the import fails the
      # note must carry the first line of the error — a stale type:commonjs manifest, a
      # missing module — not just "import failed" (the #15 WARN pattern: diagnose, don't
      # hide). Only the extension's own source paths can appear in that line; the store
      # path is computed after a successful import, so the store-path rule holds.
      factory_err=$(mktemp)
      # EXIT trap owns the temp file until the normal path resets it (same discipline as
      # cleanup-worktrees.sh's tracker temp): a mid-run death cannot leak it.
      trap 'rm -f "$factory_err"' EXIT
      factory_json=$(
        SCEN_SRC=$factory_src node --input-type=module -e '
const { loadConfig, scenariosOn, resolvePaths } = await import(process.env.SCEN_SRC + "/config.ts");
const { scanStore, storeCounts } = await import(process.env.SCEN_SRC + "/scenarios.ts");
const cfg = loadConfig(process.cwd());
if (cfg) {
  const on = scenariosOn(cfg);
  const source = cfg.scenarios === undefined ? (on ? "preset" : "default") : "explicit";
  const report = { mode: cfg.factory, on, source };
  if (on) {
    const store = resolvePaths(cfg).scenariosDir;
    const scanned = scanStore(store);
    report.store = store;
    if (scanned.ok) {
      const counts = storeCounts(scanned.files);
      report.total = counts.total;
      report.required = counts.required;
      report.invalid = scanned.files.filter((f) => !f.valid).map((f) => ({ file: f.file, reason: f.reason || "unknown" }));
    } else {
      // Named reason only (never the store path — the reason text carries the defect class).
      report.scanError = scanned.reason;
    }
  }
  process.stdout.write(JSON.stringify(report));
}
' 2>"$factory_err"
      )
      if [ -z "$factory_json" ]; then
        err_first=$(head -n 1 "$factory_err")
        optional "factory report unavailable (node import failed${err_first:+: $err_first})"
      fi
      rm -f "$factory_err"
      trap - EXIT
    fi
    if [ -n "$factory_json" ]; then
      f_mode=$(json_get mode <<<"$factory_json")
      f_on=$(json_get on <<<"$factory_json")
      f_source=$(json_get source <<<"$factory_json")
      echo "        factory $f_mode, scenarios $([ "$f_on" = "true" ] && echo on || echo off) ($f_source)"
      if [ "$f_on" = "true" ]; then
        f_store=$(json_get store <<<"$factory_json")
        f_scanerr=$(json_get scanError <<<"$factory_json")
        if [ -n "$f_scanerr" ]; then
          # The store path exists but cannot be read (regular file, permissions): a config
          # defect the operator fixes, never a crash of the scan — the doctor names it.
          missing "scenario store: $f_scanerr ($f_store)"
        else
          f_total=$(json_get total <<<"$factory_json")
          f_required=$(json_get required <<<"$factory_json")
          echo "        store         $f_store ($f_total scenarios, $f_required required)"
          inv_count=$(json_len invalid <<<"$factory_json")
          inv_i=0
          while [ "$inv_i" -lt "$inv_count" ]; do
            missing "scenario $(json_get "invalid.$inv_i.file" <<<"$factory_json"): $(json_get "invalid.$inv_i.reason" <<<"$factory_json")"
            inv_i=$((inv_i + 1))
          done
          if [ ! -d "$f_store" ]; then
            optional "scenario store not created yet: $f_store"
          elif [ "$f_mode" = "dark" ] && [ "$f_required" -eq 0 ]; then
            missing "factory dark: no valid required scenario in $f_store (seed the store)"
          fi
        fi
      fi
    fi
  fi
  if [ -f "$DL_ROOT/AGENTS.md" ]; then ok "AGENTS.md"; else missing "AGENTS.md (run the devloop setup skill)"; fi
  if [ -f "$DL_ROOT/docs/DECISIONS.md" ]; then ok "docs/DECISIONS.md"; else optional "no docs/DECISIONS.md"; fi
fi

# Orphaned local branches (review of #15): a local branch with no worktree and no remote
# counterpart is the residue of a failed `git branch -D` after a worktree removal. It is
# NOTED, never counted — notes are advisory, and deleting a branch is the operator's consent
# (the same collector-not-bulldozer stance as cleanup-worktrees.sh). The remote probe is
# SKIPPED when the remote itself is absent: `git remote get-url` failing must not read as
# "every branch not on origin" — with no remote the scan cannot classify anything.
if [ -n "$DL_ROOT" ] && git -C "$DL_ROOT" remote get-url "$DL_REMOTE" >/dev/null 2>&1; then
  checked=""
  while IFS= read -r line; do
    case $line in branch*) checked+="${line#branch }"$'\n' ;; esac
  done < <(git -C "$DL_ROOT" worktree list --porcelain 2>/dev/null)
  while IFS= read -r br; do
    [ -n "$br" ] || continue
    [ "$br" = "$DL_BASE" ] && continue
    git -C "$DL_ROOT" rev-parse -q --verify "$DL_REMOTE/$br" >/dev/null 2>&1 && continue
    case "$checked" in *"refs/heads/$br"$'\n'*) continue ;; esac
    optional "orphaned local branch $br (no worktree, not on $DL_REMOTE — a failed branch -D?)"
  done < <(git -C "$DL_ROOT" for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null)
fi

# Extension runtime: the installed extension imports typebox and the pi package at load time;
# a repo missing either dies inside pi with an inscrutable load error, so doctor catches it here.
# Resolution is probed with Node's own resolver FROM THE EXTENSION DIRECTORY — the same lookup
# pi performs when it loads the extension. The probe silences stdout while a package is imported
# (so dependency side-effects cannot masquerade as verdicts) and prints exactly one verdict line
# per known package that fails to load (does not resolve, or throws at evaluation).
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
        missing "$pkg (cannot be loaded from .pi/extensions/multipi-devloop; npm i -D typebox @earendil-works/pi-coding-agent)"
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
