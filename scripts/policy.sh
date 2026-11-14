#!/usr/bin/env bash
# policy.sh — the operator-facing surface of the permission policy (spec
# 2026-11-09-multipi-permission-policy.md §8). ONE EVALUATOR: every subcommand
# imports loadPolicy/evaluate from the extension's policy.ts (the doctor's
# same candidates), so what you see here is what the hook decides. The policy
# is read from the MAIN worktree root — a checkout may be a linked worktree,
# and the config plus permissions.json live in the main tree.
#
#   policy.sh show             render the EFFECTIVE policy: load state, knobs,
#                              the computed additionalDirectories, rules grouped
#                              by verdict. A BROKEN (UNUSABLE) policy renders
#                              the error and its fail-closed state — exit 0,
#                              because reporting a broken policy is the job.
#   policy.sh explain CMD...   dry-run a command through the evaluator (the
#                              tripwire made interactive): verdict + rule id +
#                              reason, exit 0 for ANY verdict (a report, not an
#                              action). Honest limit: the string layer only —
#                              no trusted-program ancestry, no resolved git
#                              targets (say so in the render; a real call also
#                              reaches the Layer-2 shims).
#   policy.sh audit [--since S]  tail the audit log (<state>/logs/policy-audit.jsonl):
#                              the LAST $AUDIT_TAIL lines, in file order, printed
#                              verbatim (the writer bounds and sanitizes each line,
#                              the reader never alters it). --since S keeps only
#                              lines whose ts is within S seconds of now (S is a
#                              positive integer, a trailing "s" is accepted:
#                              --since 60 and --since 60s). ts may be ISO-8601 or
#                              epoch (seconds or milliseconds); an UNPARSEABLE or
#                              MISSING ts is KEPT — the reader never drops evidence.
#                              Absent log: a named note, exit 0.
#
# Exit codes (PINNED — parsers key off these):
#   0  the command ran and rendered (any verdict, any policy state)
#   1  the evaluator is unreachable (no node, no evaluator source, node crashed)
#   2  usage
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"

# Bounded output: no more than the newest N lines are ever printed.
AUDIT_TAIL=50

usage() {
  echo "usage: policy.sh show | explain <command...> | audit [--since <seconds>]" >&2
  exit 2
}

dl_load_config required

# Evaluator source — the same candidates as doctor's reports (installed extension
# first, then the plugin tree for a source checkout).
policy_src=""
for cand in "$DL_ROOT/.pi/extensions/multipi-devloop/src" "$scripts_dir/../extension/src"; do
  if [ -f "$cand/policy.ts" ] && [ -f "$cand/config.ts" ]; then policy_src=$cand; break; fi
done
command -v node >/dev/null 2>&1 || { echo "policy.sh: node not found (the evaluator needs Node.js; install it)" >&2; exit 1; }
[ -n "$policy_src" ] || { echo "policy.sh: evaluator source not found (expected $DL_ROOT/.pi/extensions/multipi-devloop/src/policy.ts — run scripts/install.sh)" >&2; exit 1; }

# run_eval MODE [COMMAND] → sets EVAL_JSON, returns 1 with a named reason on failure.
# The command travels via env (POLICY_CMD), never string-interpolated into the JS
# source — the same discipline as the doctor's SCEN_SRC pattern.
run_eval() {
  local mode=$1 err rc first
  err=$(mktemp)
  EVAL_JSON=$(
    POLICY_SRC=$policy_src POLICY_ROOT=$DL_ROOT POLICY_MODE=$mode POLICY_CMD=${2-} node --input-type=module -e '
const { loadPolicy, evaluate } = await import(process.env.POLICY_SRC + "/policy.ts");
const policy = loadPolicy(process.env.POLICY_ROOT);
const out = { ok: policy.ok, error: policy.error ?? null, config: policy.config, hasPermissionsFile: policy.hasPermissionsFile };
if (process.env.POLICY_MODE === "explain") {
  out.decision = evaluate(policy, { actor: "policy.sh", tool: "bash", command: process.env.POLICY_CMD });
} else {
  out.counts = { deny: 0, ask: 0, allow: 0 };
  out.rulesByClass = { deny: [], ask: [], allow: [] };
  for (const r of policy.rules) { out.counts[r.cls]++; out.rulesByClass[r.cls].push(r.id); }
}
process.stdout.write(JSON.stringify(out));
' 2>"$err"
  )
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$EVAL_JSON" ]; then
    first=$(head -n 1 "$err")
    echo "policy.sh: evaluator failed${first:+: $first}" >&2
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  return 0
}

# audit_ts_epoch LINE → epoch seconds on stdout, EMPTY when unparseable (the caller
# treats empty as "keep the line" — evidence is never dropped by the reader).
audit_ts_epoch() {
  local ts
  ts=$(json_get ts <<<"$1")
  [ -n "$ts" ] || return 0
  case $ts in
    ''|*[!0-9]*) ;; # not all digits: try ISO below
    *)
      # 13+ digits = epoch milliseconds, fewer = epoch seconds.
      if [ "${#ts}" -ge 13 ]; then echo $(( 10#${ts:0:13} / 1000 )); else echo $(( 10#$ts )); fi
      return 0
      ;;
  esac
  # ISO-8601: only ISO-shaped values reach date (a free-form date -d would happily
  # parse relative phrases like "30 seconds" as a timestamp). The trailing - is a
  # literal in the class (a mid-class - would form a range).
  case $ts in
    *[!0-9T:.Z-]*) return 0 ;;
  esac
  # GNU date first, then the BSD/macOS spelling.
  date -u -d "$ts" +%s 2>/dev/null && return 0
  date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$ts" +%s 2>/dev/null && return 0
  return 0
}

cmd_show() {
  [ $# -eq 0 ] || usage
  run_eval show || exit 1
  if [ "$(json_get ok <<<"$EVAL_JSON")" != "true" ]; then
    echo "policy: UNUSABLE — $(json_get error <<<"$EVAL_JSON")"
    echo "the hook is FAILING CLOSED: every non-trusted call is denied until the policy files are repaired"
    return 0
  fi
  local posture
  posture=$(json_get config.posture <<<"$EVAL_JSON")
  echo "policy: loaded (root $DL_ROOT)"
  if [ "$posture" = "allow" ]; then
    echo "posture:         allow — unmatched calls pass"
  else
    echo "posture:         ask — unmatched calls escalate"
  fi
  echo "repos:           $(json_get config.repos <<<"$EVAL_JSON")"
  echo "secondaries:     $(json_get config.secondaries <<<"$EVAL_JSON")"
  echo "token ttl:       $(json_get config.tokenTtlMinutes <<<"$EVAL_JSON") minutes"
  # Computed, not hand-maintained (spec §2): the SAME dl_* helpers the loop itself
  # uses resolve these, so the render cannot drift from reality.
  echo "additionalDirectories (computed from .devloop.json):"
  echo "    $DL_ROOT                  self: the repo tree"
  echo "    $(dl_worktree_dir)         worktrees"
  echo "    $(dl_notes_dir)            notes"
  echo "    $(dl_gate_dir)             gate worktree"
  local total cls n i
  total=$(( $(json_len rulesByClass.deny <<<"$EVAL_JSON") + $(json_len rulesByClass.ask <<<"$EVAL_JSON") + $(json_len rulesByClass.allow <<<"$EVAL_JSON") ))
  echo "rules ($total total; $(json_len rulesByClass.deny <<<"$EVAL_JSON") deny, $(json_len rulesByClass.ask <<<"$EVAL_JSON") ask, $(json_len rulesByClass.allow <<<"$EVAL_JSON") allow):"
  for cls in deny ask allow; do
    n=$(json_len "rulesByClass.$cls" <<<"$EVAL_JSON")
    echo "  [$cls] ($n)"
    i=0
    while [ "$i" -lt "$n" ]; do
      echo "        - $(json_get "rulesByClass.$cls.$i" <<<"$EVAL_JSON")"
      i=$((i + 1))
    done
  done
}

cmd_explain() {
  [ $# -ge 1 ] || usage
  local command=$*
  run_eval explain "$command" || exit 1
  local verdict rid reason
  verdict=$(json_get decision.verdict <<<"$EVAL_JSON")
  rid=$(json_get decision.ruleId <<<"$EVAL_JSON")
  reason=$(json_get decision.reason <<<"$EVAL_JSON")
  echo "explain: $command"
  echo "verdict: $verdict"
  if [ -n "$rid" ]; then echo "rule:    $rid"; else echo "rule:    (none — posture default)"; fi
  echo "reason:  $reason"
  echo "(string layer only — no trusted-program ancestry or resolved git targets; a real call also reaches the shims)"
}

cmd_audit() {
  local since="" log cutoff="" line ts_epoch
  while [ $# -gt 0 ]; do
    case $1 in
      --since)
        [ $# -ge 2 ] || usage
        since=$2
        shift 2
        ;;
      *) usage ;;
    esac
  done
  if [ -n "$since" ]; then
    # Positive integer seconds; a trailing s/S is accepted (the "60s" spelling).
    case $since in
      '' | *[!0-9sS]*) usage ;;
    esac
    since=${since//[Ss]/s} # lowercase any stray capital, then strip one trailing s
    since=${since%s}
    case $since in
      '' | *[!0-9]*) usage ;;
    esac
  fi
  log="$(dl_logs_dir)/policy-audit.jsonl"
  if [ ! -f "$log" ]; then
    echo "audit: no events recorded yet ($log absent)"
    return 0
  fi
  # No --since ⇒ no time filter at all (cutoff stays empty, every parseable ts passes).
  if [ -n "$since" ]; then
    cutoff=$(( $(date +%s) - since ))
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    ts_epoch=$(audit_ts_epoch "$line")
    if [ -z "$ts_epoch" ]; then
      printf '%s\n' "$line" # unparseable/missing ts: KEPT (the reader never drops evidence)
    elif [ -n "$cutoff" ] && [ "$ts_epoch" -lt "$cutoff" ]; then
      : # older than --since: dropped
    else
      printf '%s\n' "$line"
    fi
  done <"$log" | tail -n "$AUDIT_TAIL"
}

sub=${1-}
[ $# -ge 1 ] || usage
shift
case $sub in
  show) cmd_show "$@" ;;
  explain) cmd_explain "$@" ;;
  audit) cmd_audit "$@" ;;
  *) usage ;;
esac
