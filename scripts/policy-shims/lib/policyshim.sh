# shellcheck shell=bash
# Shared machinery of the policy shims (scripts/policy-shims/git|gh) — ticket #41,
# permission-policy spec 2026-11-09-multipi-permission-policy.md §4-L2, §5, §8.
#
# The shim is a WRAPPER, not a reimplementation: it resolves the real binary OUTSIDE the
# shim dir AND as a COMPILED ARTIFACT — no interpreted script ever passes, whatever its
# dir or name (ticket #68: under a wrapped PATH the "first other executable" WAS another
# wrapper, and the mutual exec spun one PID forever while holding a heavy slot). It
# collects ground truth (acting repo from rev-parse, refspec facts from the real argv,
# ancestor scripts from /proc), consults the shared evaluator through
# extension/src/policydriver.ts, and execs the real binary with argv untouched.
#
# Every shim→binary exec goes through `_shim_exec_real`, which bumps an env depth counter
# (`_POLICYSHIM_DEPTH`) and refuses (exit 126) when the next hop would land above 3 —
# the mutual-exec guard of record.
#
# Exit codes (pinned; DECISIONS 2026-11-10): 126 = policy deny or ask, or the
# recursion-depth guard (nothing executed — phase-1 ask is a block; token consumption
# arrives with P6); 127 = the real binary cannot be located outside the shim dir (broken
# install) OR a configured MULTIPI_SHIM_REAL_GH / MULTIPI_SHIM_REAL_GIT seam target is
# unusable — the seam is the FIRST authority and a broken one NEVER falls back to the
# PATH scan (the fallback would leak onto a real compiled binary — exactly what the seam
# exists to prevent; ticket #72). Any other exit is the real binary's own.
#
# Requires git >= 2.36 (rev-parse --path-format=absolute). On older git the probe errors,
# resolution stays EMPTY and the shim denies the mutation (fail closed, never misresolves).

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
  SIM_SCRIPTS_DIR=$(cd "$SIM_SHIM_DIR/.." 2>/dev/null && pwd -P)
  if [ -n "$SIM_SCRIPTS_DIR" ] && [ -f "$SIM_SCRIPTS_DIR/lib/common.sh" ]; then
    # shellcheck source=lib/common.sh
    # The path is built from the -P-resolved scripts dir (presence checked above); the hint
    # cannot be followed CWD-relative in the gate's input set, so the info is disabled:
    # shellcheck disable=SC1091
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

# True when FILE (symlinks followed by the open itself) is a COMPILED ARTIFACT: its first
# two bytes are not the `#!` script magic. A wrapper that is a symlink TO a script fails
# too. FAIL-CLOSED: an empty or unreadable candidate is NOT a compiled artifact (a failed
# read must reject — accepting on unreadable would admit exactly the wrappers we hunt).
# Pure shell, wrapper-agnostic, no path-name knowledge (ticket #68 — the
# path-whitelist alternative is rejected in DECISIONS 2026-11-17).
shim_is_compiled() { # shim_is_compiled FILE
  local f=$1 magic=''
  [ -f "$f" ] || return 1
  IFS= read -r -n 2 magic <"$f" 2>/dev/null || return 1
  [ "$magic" != '#!' ]
}

# Print the real binary's path. Authority order (ticket #72):
#
#   1. THE SEAM — the per-binary env var MULTIPI_SHIM_REAL_GH / MULTIPI_SHIM_REAL_GIT.
#      A process that sets it owns the resolution for its own tree: the target is used
#      as-is and is NOT required to be a compiled artifact (that is precisely how an
#      offline script stand-in serves a test environment — its calls.log then proves the
#      real binary was never reached). Only processes the loop spawns should carry it.
#      A seam target that is missing, unreadable or not executable FAILS CLOSED (rc 1)
#      and never falls back to the PATH scan: a typo'd seam leaking onto the first
#      compiled binary is the exact leak the seam exists to prevent. An EMPTY value is
#      unset (the scan applies).
#   2. THE SCAN — the FIRST executable on PATH that is (a) NOT inside the shim dir and
#      (b) a COMPILED ARTIFACT (shim_is_compiled). Both conditions are belt and braces
#      against the same accident — a wrapper anywhere on PATH must never be handed back
#      as "the real binary" (ticket #68).
#
# rc 1 when nothing resolves (the caller exits 127).
shim_find_real() {
  local want=$1 seam_var="" seam="" entry real
  local -a parts
  local IFS=':'
  # Bash-native uppercase (bash 4+ project floor): no external `tr` on the resolution
  # path — a scrubbed test PATH carries no coreutils, and a silent failure here would
  # degrade the seam to "unset" (the scan would win over the operator's authority).
  seam_var="MULTIPI_SHIM_REAL_${want^^}"
  seam=${!seam_var:-}
  if [ -n "$seam" ]; then
    if [ -f "$seam" ] && [ -r "$seam" ] && [ -x "$seam" ]; then
      printf '%s\n' "$seam"
      return 0
    fi
    echo "multipi policy: $seam_var=$seam is missing, unreadable or not executable — refusing (no PATH fallback)" >&2
    return 1
  fi
  read -r -a parts <<<"${PATH:-}"
  for entry in "${parts[@]}"; do
    [ -n "$entry" ] || continue
    real=$(cd "$entry" 2>/dev/null && pwd -P) || continue
    [ "$real" = "$SIM_SHIM_DIR" ] && continue
    if [ -f "$real/$want" ] && [ -x "$real/$want" ] && shim_is_compiled "$real/$want"; then
      printf '%s\n' "$real/$want"
      return 0
    fi
  done
  return 1
}

# The mutual-exec recursion guard (ticket #68): every shim→binary exec bumps an ENV depth
# counter and refuses when the next hop would land ABOVE 3 (exit 126, one stderr line,
# nothing executed). A sound chain is short — session → wrapper → shim → real binary lands
# at 1–2; only wrapper-vs-wrapper mutual exec climbs (the 12-h spin, where every "real"
# resolution was another wrapper). The counter is INTERNAL plumbing, deliberately not a
# MULTIPI_* operator seam (DECISIONS 2026-11-17).
_shim_exec_real() { # _shim_exec_real REALBIN ARGV...
  local depth=${_POLICYSHIM_DEPTH:-0}
  # #67 round-4: bash arithmetic parses its strings as EXPRESSIONS — a garbage inherited
  # counter is not a silent no-op: "0x1" reads as HEX 1 (one less than it was), a 25-digit
  # value wraps 64 bits back UNDER the bound, and a plain word crashes under set -u. Any
  # of them voids the hard-refuse invariant. Coerce: ≤ 9 digits is the real counter (the
  # loop itself never passes 3 — values beyond that only reach the guard via this check),
  # > 9 digits is beyond the bound by construction (clamp, so wraparound is impossible),
  # anything else is garbage → 0 (the guard stays armed for the hops that follow).
  case "$depth" in
    *[!0-9]*) depth=0 ;;
  esac
  # Leading zero = non-canonical decimal: bash arithmetic reads `08`/`09` as invalid
  # OCTAL and hard-crashes the shim (rc 1, parse error, no guard line) — the same
  # expression-semantics class this coercion exists to close, one spelling further.
  # Garbage: read as no-counter-yet (0). A bare `0` stays canonical (the arm requires
  # a digit after the zero).
  case "$depth" in
    0[0-9]*) depth=0 ;;
  esac
  [ ${#depth} -le 9 ] || depth=999
  if [ $((depth + 1)) -gt 3 ]; then
    echo "multipi policy: DENIED shim:recursion-depth: depth $((depth + 1)) would exceed 3 — refusing (mutual-exec loop guard)" >&2
    exit 126
  fi
  _POLICYSHIM_DEPTH=$((depth + 1))
  export _POLICYSHIM_DEPTH
  exec "$@"
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
  # ${arr[@]+"${arr[@]}"}: expands to NOTHING when _SIM_REDIR is unset/empty — an
  # unquoted empty string would inject a spurious empty argument into the git call.
  [ -d "$dir" ] || return 0
  common=$("$real" -C "$dir" ${_SIM_REDIR[@]+"${_SIM_REDIR[@]}"} rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 0
  [ -n "$common" ] || return 0
  if "$real" -C "$dir" ${_SIM_REDIR[@]+"${_SIM_REDIR[@]}"} rev-parse --is-bare-repository 2>/dev/null | grep -q '^true$'; then
    [ -d "$common" ] && { printf '%s\n' "$common"; return 0; }
    return 0
  fi
  case "$common" in
    */.git/worktrees/*)
      # Version-dependent git spells the linked-worktree common dir as
      # <main>/.git/worktrees/<name>: strip the suffix and VERIFY the survivor —
      # resolution stays empty (the caller denies) when it does not check out.
      main_git="${common%/.git/worktrees/*}/.git"
      if [ "$(basename "$main_git")" = ".git" ] && [ -d "$main_git" ]; then
        printf '%s\n' "$(dirname "$main_git")"
      fi
      return 0
      ;;
  esac
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
  # Guarded expansion: the array is legitimately empty on most calls, and the project floor
  # is bash 4+ (unguarded "${arr[@]}" on an empty array dies under set -u before 4.4).
  for x in ${_SIM_DECIDE_EXTRA[@]+"${_SIM_DECIDE_EXTRA[@]}"}; do
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
  node --version >/dev/null 2>&1 || return 1   # NON-INTERACTIVE probe: a bare `node` reads stdin (gate-hang, post-approval review)
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

# Find a locale in which bash counts CHARACTERS: é must measure as 1. Called LAZILY by
# `_shim_redact_summary` — at most once per process, and only when the truncation branch
# first needs it: every git/gh shim invocation sources this lib, so a source-time probe
# paid 1-2 child-bash forks on the hot path for a feature the happy path never reaches
# (#55 review round-2 SF1). Result is cached in SHIM_UTF8_LOCALE (flag SHIM_UTF8_PROBED);
# empty = none found (the documented byte-based fallback in _shim_redact_summary).
_shim_pick_utf8_locale() {
  local probe=$'\xc3\xa9' cand
  for cand in C.UTF-8 C.utf8; do
    if LC_ALL="$cand" bash -c '[ "${#1}" -eq 1 ]' _ "$probe" 2>/dev/null; then
      printf '%s' "$cand"
      return
    fi
  done
  printf ''
}

# Minimal mirror of the driver's redactActionSummary for the ONE path that bypasses it:
# scrub the token-dir shape and bound the length (a commit message may carry a token path
# and the fallback line must not print it raw — P3 review round-6 should-fix).
# LOCKED to extension/src/policy.ts by the equivalence pin (tests/unit/shim-redact-equiv.
# test.ts, #55): identical adversarial input must yield byte-identical output.
#
# The bound counts CHARACTERS, decided under a PINNED UTF-8 locale — never the caller's:
# under a C locale ${#s}/${s:0:160} count BYTES and cut mid-UTF-8-sequence (a lone 0xB6
# tail — an undecodable audit line; #55 review SF1, reproduced). The probe picks a locale
# in which bash counts characters (C.UTF-8 / C.utf8). The probe is evaluated LAZILY —
# on the first call that actually needs it, cached per process — never at source time
# (#55 review round-2 SF1: every shim invocation sources this lib, and only the
# driver-broken fallback path ever truncates). If NO candidate is found it degrades to
# the historical byte-based bound — documented fallback, only on systems without any
# UTF-8 locale (the output can then split a sequence, as before).
_shim_redact_summary() {
  local s=$1
  # ERE mirrors the TS TOKEN_DIR_RE: (~ | literal $HOME | literal ${HOME} | /), a span
  # excluding whitespace, both quotes, backtick and the shell meta set, over the
  # token-dir name. The program is built with $'...' so the backslashes reach sed
  # VERBATIM: in the old double-quoted string `\$` collapsed to a bare $, which mid-ERE
  # is the END-OF-LINE anchor — the $HOME/${HOME} alternatives silently never matched
  # (the latent desync the equivalence pin exists to catch). Bound = 160 chars cut with
  # the ellipsis mark, the TS truncation shape.
  local re
  re=$'(~|\\$HOME|\\$\\{HOME\\}|/)[^[:space:]"\'`|;&<>]*dev-loop-tokens[^[:space:]"\'`|;&<>]*'
  s=$(printf '%s' "$s" | sed -E "s#${re}#<token-dir>#g")
  # The gate under the caller's locale never MISSES a needed cut: a byte-counting (C)
  # locale over-counts (superset trigger), a char-counting locale counts the same
  # characters the pinned locale does. The DECISION itself happens in a child bash
  # under the pinned UTF-8 locale, where ${#s}/${s:0:160} count characters and a
  # sequence can never be split. A C-locale caller therefore sees the same answer the
  # TS engine makes (the pin drives LC_ALL=C over the whole corpus). Astral-plane
  # strings (emoji & co.) count 1 here but 2 UTF-16 units in TS, so for those the two
  # engines may differ by a few chars — both outputs stay valid, bounded UTF-8.
  if [ "${#s}" -gt 160 ]; then
    # Lazy init: probe the UTF-8 locale on first NEED, cache per process. The flag is
    # separate from SHIM_UTF8_LOCALE because an EMPTY locale (no candidate) is a valid,
    # already-probed answer and must not re-trigger the probe.
    if [ -z "${SHIM_UTF8_PROBED:-}" ]; then
      SHIM_UTF8_PROBED=1
      SHIM_UTF8_LOCALE=$(_shim_pick_utf8_locale)
    fi
    if [ -n "$SHIM_UTF8_LOCALE" ]; then
      s=$(LC_ALL="$SHIM_UTF8_LOCALE" bash -c 'if [ "${#1}" -gt 160 ]; then printf "%s…" "${1:0:160}"; else printf "%s" "$1"; fi' _ "$s")
    else
      s="${s:0:160}…"
    fi
  fi
  printf '%s' "$s"
}

# Best-effort audit append for the ONE case the driver cannot serve (itself broken): the
# deny still lands in the log, shaped like every other line (layer=shim, seven fields).
# The log dir resolves the way dl_logs_dir (lib/common.sh) does: the configured
# logs_dir wins over the default state dir (P3 review round 11). The basename/date
# substitutions are GUARDED (P3 review round 12): with coreutils missing from PATH the
# command-not-found noise must not reach fail-closed stderr (exactly one line: the
# block) and the fallback line still lands (pure-shell basename; ts=unknown). A failing
# append never breaks the verdict.
shim_audit_fallback() { # shim_audit_fallback RULEID VERDICT SUMMARY
  local rule=$1 verdict=$2 summary=$3
  local main=$SIM_INSTALL_ROOT logs="" configured="" base ts
  if [ -f "$main/.git" ]; then
    local gd
    gd=$(sed -n 's/^gitdir://p' "$main/.git" | tr -d '[:space:]')
    if [ -n "$gd" ]; then main=$(dirname "$(dirname "$(dirname "$gd")")"); fi
  fi
  if [ "$SIM_HAVE_COMMON" = 1 ] && [ -f "$SIM_INSTALL_ROOT/.devloop.json" ]; then
    configured=$(json_get logs_dir <"$SIM_INSTALL_ROOT/.devloop.json")
    if [ -n "$configured" ]; then
      # dl_resolve/dl_canonical need DL_ROOT set (relative logs_dir resolves against the
      # MAIN root). The shim deliberately does not dl_load_config — its helpers call bare
      # `git`, which would re-enter the shimmed binary — so set the resolver context
      # locally for this call only.
      # dl_resolve/dl_canonical read DL_ROOT from the CALLER's scope (dynamic scope, no
      # subshell) — this local assignment IS the mechanism, hence the suppression.
      # shellcheck disable=SC2034
      local DL_ROOT=$main
      logs=$(dl_canonical "$(dl_resolve "$configured")")
    fi
  fi
  if [ -z "$logs" ]; then
    base=$(basename "$main" 2>/dev/null) || base=${main##*/}
    logs="${MULTIPI_HOME:-$HOME/.multipi}/$base/logs"
  fi
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || ts=unknown
  {
    mkdir -p "$logs" 2>/dev/null || return 0
    printf '{"ts":"%s","event":"verdict","session":"-","actor":"shim","ruleId":"%s","verdict":"%s","actionSummary":"%s","layer":"shim"}\n' \
      "$ts" "$(_shim_json_escape "$rule")" "$verdict" "$(_shim_json_escape "$(_shim_redact_summary "$summary")")" \
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
