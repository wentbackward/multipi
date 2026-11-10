# shellcheck shell=bash
# Shared machinery of the policy shims (scripts/policy-shims/git|gh) — ticket #41,
# permission-policy spec 2026-11-09-multipi-permission-policy.md §4-L2, §5, §8.
#
# The shim is a WRAPPER, not a reimplementation: it resolves the real binary OUTSIDE the
# shim dir (no recursion), collects ground truth (acting repo from rev-parse, refspec
# facts from the real argv, ancestor scripts from /proc), consults the shared evaluator
# through extension/src/policydriver.ts, and execs the real binary with argv untouched.
#
# Exit codes (pinned; DECISIONS 2026-11-10): 126 = policy deny or ask (nothing executed —
# phase-1 ask is a block; token consumption arrives with P6); 127 = the real binary cannot
# be located outside the shim dir (broken install). Any other exit is the real binary's own.

# Set by the caller before sourcing completes: shim_dir (the policy-shims dir, -P resolved).
# shim_dir is the CALLER's variable (dot-sourced context): SC2154 is suppressed file-wide.
# shellcheck disable=SC2154
shim_init() {
  SIM_SHIM_DIR=${shim_dir}
  _SIM_DECIDE_EXTRA=()                       # further driver flags (shim_decide)
  SIM_INSTALL_ROOT=$(cd "$SIM_SHIM_DIR/../.." && pwd -P)
  SIM_DRIVER="$SIM_INSTALL_ROOT/.pi/extensions/multipi-devloop/src/policydriver.ts"
  # The loop's base branch is the protected ref: read it from the INSTALLED checkout's
  # config (the acting repo's own config, if it has one, is a different loop — its base is
  # not ours to protect here; DECISIONS 2026-11-10).
  SIM_BASE_BRANCH=main
  SIM_SCRIPTS_DIR=$(cd "$SIM_SHIM_DIR/.." 2>/dev/null && pwd)
  if [ -n "$SIM_SCRIPTS_DIR" ] && [ -f "$SIM_SCRIPTS_DIR/lib/common.sh" ]; then
    # shellcheck source=lib/common.sh
    . "$SIM_SCRIPTS_DIR/lib/common.sh"
    SIM_HAVE_COMMON=1
    if [ -f "$SIM_INSTALL_ROOT/.devloop.json" ]; then
      SIM_BASE_BRANCH=$(json_get base_branch <"$SIM_INSTALL_ROOT/.devloop.json")
      [ -n "$SIM_BASE_BRANCH" ] || SIM_BASE_BRANCH=main
    fi
  else
    SIM_HAVE_COMMON=0
  fi
}

# Print the real binary's path: the FIRST executable on PATH that is NOT inside the shim
# dir (resolving outside the shim dir is what makes recursion impossible). rc 1 when no
# such binary exists (the caller exits 127).
shim_find_real() {
  local want=$1 entry real
  local -a parts
  local IFS=':'
  read -r -a parts <<<"${PATH:-}"
  for entry in "${parts[@]}"; do
    [ -n "$entry" ] || continue
    real=$(cd "$entry" 2>/dev/null && pwd -P) || continue
    [ "$real" = "$SIM_SHIM_DIR" ] && continue
    if [ -f "$real/$want" ] && [ -x "$real/$want" ]; then
      printf '%s\n' "$real/$want"
      return 0
    fi
  done
  return 1
}

_shim_add_candidate() { # _shim_add_candidate PATH  — dedupe-append into _SIM_CANDS
  local c=$1 x
  for x in "${_SIM_CANDS[@]}"; do
    [ "$x" = "$c" ] && return 0
  done
  _SIM_CANDS+=("$c")
}

# The §5 identity PROOF: walk the parent chain via /proc (PPID ancestry — an env marker is
# forgeable by a plain shell invocation, so it is deliberately NOT a mechanism; DECISIONS
# 2026-11-10) and print one candidate script path per line: each ancestor's script argument
# (an interpreter's .sh argument, or a shebang-executed .sh program), resolved to an ABSOLUTE
# path via the ancestor's own /proc cwd when spelled relatively. The DRIVER decides identity
# (realpath under THIS repo's checkout scripts/). No /proc ⇒ no candidates ⇒ untrusted
# (fail closed). Depth is capped: a sane loop nests far shallower.
shim_trusted_candidates() {
  [ -d /proc ] || return 0
  local -a _SIM_CANDS=()
  local pid=$PPID ppid a0 a1 base cwd n=0
  while [ "$pid" -gt 1 ] && [ "$n" -lt 32 ]; do
    n=$((n + 1))
    a0=$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | sed -n '1p') || a0=""
    [ -n "$a0" ] || break                       # the ancestor already reaped
    a1=$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | sed -n '2p')
    base=${a0##*/}
    case "$base" in
      bash | sh | dash | zsh | ksh)
        # The interpreter's SCRIPT argument: absolute, or relative to the ancestor's cwd.
        if [ -n "${a1:-}" ] && [ "${a1#-}" = "$a1" ]; then
          case "$a1" in
            /*.sh) _shim_add_candidate "$a1" ;;
            *.sh)
              cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || cwd=""
              [ -n "$cwd" ] && _shim_add_candidate "$cwd/$a1"
              ;;
          esac
        fi
        ;;
      *)
        # A shebang-executed script: argv[0] IS the script (absolute, or relative to its cwd).
        case "$a0" in
          /*.sh) _shim_add_candidate "$a0" ;;
          *.sh)
            cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || cwd=""
            [ -n "$cwd" ] && _shim_add_candidate "$cwd/$a0"
            ;;
        esac
        ;;
    esac
    ppid=$(awk '/^PPid:/{print $2; exit}' "/proc/$pid/status" 2>/dev/null)
    [ -n "$ppid" ] || break
    [ "$ppid" -le 1 ] && break
    pid=$ppid
  done
  if [ "${#_SIM_CANDS[@]}" -gt 0 ]; then
    printf '%s\n' "${_SIM_CANDS[@]}"
  fi
  return 0
}

# Resolve the acting repository's MAIN root from ground truth (spec §7.2: unresolvable
# stays EMPTY — the caller denies). Prints nothing when it cannot be resolved with certainty.
shim_resolve_repo() { # shim_resolve_repo REALGIT DIR
  local real=$1 dir=$2 common
  [ -d "$dir" ] || return 0
  common=$("$real" -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 0
  [ -n "$common" ] || return 0
  if "$real" -C "$dir" rev-parse --is-bare-repository 2>/dev/null | grep -q '^true$'; then
    [ -d "$common" ] && { printf '%s\n' "$common"; return 0; }
    return 0
  fi
  if [ "$(basename "$common")" = ".git" ] && [ -d "$common" ]; then
    printf '%s\n' "$(dirname "$common")"
  fi
  return 0
}

# Consult the evaluator. Caller sets: SIM_CMD (the command line), SIM_TARGET (resolved
# repo root, "" = unresolvable), the fact flags SIM_PUSH_FORCE / SIM_PUSH_BASE /
# SIM_PUSH_TAGS / SIM_TAG_MUTATION / SIM_GH_ACTION, and _SIM_DECIDE_EXTRA (further driver
# flags — the git shim passes `--unresolvable-target` per unknown target). Result on
# stdout: the driver's verdict line (ALLOW | BLOCK<TAB>LINE | INACTIVE…). rc 1 when it failed.
shim_decide() {
  local -a drv=(node "$SIM_DRIVER" --root "$SIM_INSTALL_ROOT" --command "$SIM_CMD")
  if [ -n "${SIM_TARGET:-}" ]; then
    drv+=(--target "$SIM_TARGET")
  fi
  local x
  for x in "${_SIM_DECIDE_EXTRA[@]}"; do
    drv+=("$x")
  done
  [ "$SIM_PUSH_FORCE" = 1 ] && drv+=(--push-force)
  [ "$SIM_PUSH_BASE" = 1 ] && drv+=(--push-base)
  [ "$SIM_PUSH_TAGS" = 1 ] && drv+=(--push-tags)
  [ "$SIM_TAG_MUTATION" = 1 ] && drv+=(--tag-mutation)
  [ -n "$SIM_GH_ACTION" ] && drv+=(--gh-action "$SIM_GH_ACTION")
  local c
  while IFS= read -r c; do
    [ -n "$c" ] && drv+=(--candidate "$c")
  done < <(shim_trusted_candidates)
  node >/dev/null 2>&1 || return 1
  [ -f "$SIM_DRIVER" ] || return 1   # evaluator missing ⇒ the verdict is unknown ⇒ fail closed
  [ "$SIM_HAVE_COMMON" = 1 ] || return 1   # config reader missing ⇒ facts incomplete ⇒ fail closed
  "${drv[@]}" 2>/dev/null
}

_shim_json_escape() { # minimal JSON string escaper for the fallback audit line
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

# Best-effort audit append for the ONE case the driver cannot serve (itself broken): the
# deny still lands in the log, shaped like every other line (layer=shim, seven fields).
# A failing append never breaks the verdict.
shim_audit_fallback() { # shim_audit_fallback RULEID VERDICT SUMMARY
  local rule=$1 verdict=$2 summary=$3
  local main=$SIM_INSTALL_ROOT logs
  if [ -f "$main/.git" ]; then
    local gd
    gd=$(sed -n 's/^gitdir://p' "$main/.git" | tr -d '[:space:]')
    if [ -n "$gd" ]; then main=$(dirname "$(dirname "$(dirname "$gd")")"); fi
  fi
  logs="${MULTIPI_HOME:-$HOME/.multipi}/$(basename "$main")/logs"
  {
    mkdir -p "$logs" 2>/dev/null || return 0
    printf '{"ts":"%s","event":"verdict","session":"-","actor":"shim","ruleId":"%s","verdict":"%s","actionSummary":"%s","layer":"shim"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(_shim_json_escape "$rule")" "$verdict" "$(_shim_json_escape "$summary")" \
      >>"$logs/policy-audit.jsonl" 2>/dev/null
  } || true
  return 0
}

# Print the block line verbatim and refuse: exit 126 (denies and asks both — pinned).
shim_block() {
  echo "$1" >&2
  exit 126
}

# The driver failed (missing node/driver, non-zero exit, broken config reader): the verdict
# is UNKNOWN, and the only honest unknown for a mutation is deny (spec §7.2, fail closed).
shim_fail_closed() { # shim_fail_closed REASON
  local reason=$1
  shim_audit_fallback "policy:shim-error" "deny" "$SIM_CMD"
  shim_block "DENIED policy:shim-error: $reason — failing closed"
}
