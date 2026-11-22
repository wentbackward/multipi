#!/usr/bin/env bash
# multipi-watch.sh — the "every 10 minutes" net (spec 2026-11-15 §4): a watchdog that wakes
# a wedged orchestrator session before the 45-min tool bound becomes "hours of silence".
#
#   scripts/multipi-watch.sh [--daemon] [--interval SECS]
#
# ONE-SHOT CHECK (the testable core) reads the sidecar and, against the pinned thresholds:
#   • a tool in flight longer than MULTIPI_WATCH_TOOL_MS (default 720000 = 12 min — BEFORE the
#     45-min bound) → wake:  WAKE (multipi-watch): <tool> has been in flight <N>min. …
#   • a heartbeat older than 5 × the stale bound (MULTIPI_STATUS_STALE_MS, default 120000,
#     so the default wedge threshold is 10 min) → the stronger wake:
#     WEDGE SUSPECTED (multipi-watch): no orchestrator heartbeat for <N>min. …
#   When BOTH fire, the WEDGE (the stronger wake) is chosen.
#   DEDUPE: at most one wake per tool.seq (sidecar's lastWakeSeq watermark — raised after a
#   WAKE) AND at most one wake per 3600 s of wall clock (timestamps in the watch log).
#   • Blocked-ticket nudge (ticket #104): an open ticket labelled dl/blocked whose blocked
#     age is older than MULTIPI_WATCH_BLOCKED_MS (default 14400000 = 4h) → an informational
#     line in the watch log AND (where a usable TTY exists) a wake:
#     BLOCKED (multipi-watch): #<n> has awaited a human decision for <age> — "<question>".
#     Resume or drop it.   (When every "Depends on #k" on the ticket is verifiably CLOSED,
#     "Its dependencies are all closed — now resumable." is inserted before the last
#     sentence.) Blocked age = the created_at of the newest dl/blocked label event on the
#     issue's timeline (gh api --paginate --slurp — the newest event can sit past the
#     first page of a chatty ticket; slurped into one array, the max() survives);
#     the fallback is the issue-list row's updatedAt (the log
#     flags it approx=1 — the documented approximation, never a silent guess). The resumable
#     claim is refused when more than 10 distinct dependencies are referenced (an
#     unverifiable list must never earn the claim). This is a
#     SEPARATE dedupe axis: at most one nudge per ticket per 24h, ledgered in the watch log
#     (`BLOCKED n=<n>` lines — the same pattern as lastWakeSeq); it does not count as a
#     WAKE/WEDGE for the 3600 s wall axis. The TRACKER PROBE itself (gh auth + issue list
#     + the per-ticket calls) is throttled to at most one per 15 min, ledgered by
#     `BL-PROBE` stamps in the watch log — a 60 s daemon tick must not burn API calls every
#     tick; a due wake defers at most one 15-min period (far inside the 24h window — the
#     wake owns the cadence, the throttle only bounds probing). It runs only when the check
#     reached a valid
#     sidecar (rc 0/6), and skips silently when gh is unavailable or a tracker call fails —
#     it never fails the check and never changes the rc table. Log tokens: BLOCKED /
#     BLOCKED-SKIP / BLOCKED-NO-TTY / BLOCKED-NO-AGE / BL-PROBE / BL-THROTTLED.
#   • Report-landing wake (ticket #133, fire-and-poll dispatch): a child entry that turned
#     terminal (done/crashed/interrupted) in <state>/dispatch.json whose generation is NOT in
#     the ack ledger (<state>/reconcile-seen.json) → one wake line PER uncollected report,
#     appended to the TTY target:
#     REPORT LANDED (multipi-watch): #<key> <role> -> <status> — run devloop_status to collect it (act in this turn).
#     (non-numeric keys — review-/analyst-/verifier- — name plainly, the late-report surface's rule).
#     Priority: the WEDGE and the tool WAKE outrank it (a report stays due — unacked — until
#     collected, so losing the race only delays it a tick). Dedupe is a SEPARATE axis:
#     per report (per key+generation, ledgered by `REPORT n=<key> t=<t>` lines in the watch
#     log — the same pattern as BLOCKED n=), and it participates in the 3600 s WALL axis:
#     a WAKE/WEDGE inside the window suppresses it for the tick (`REPORT-SKIP n=<key>
#     recent`) — the report then surfaces at the next stop-gate turn. A report that could
#     not be delivered (`REPORT-NO-TTY`) starts no window (retried when a TTY returns) and
#     yields the same rc 6 + kill-and-resume fallback as the other wakes. Honest limit,
#     shared with multipi-interrupt: the wake is a TTY paste, not an RPC — a detached
#     terminal is unreachable; with the watchdog down, the report surfaces at the next
#     stop-gate turn. Missing or corrupt dispatch state reads as NO REPORTS (soft read,
#     the state surface's "history is lossy" stance — never a spurious wake). The one-shot
#     rc table is untouched (a due-but-undeliverable report is the existing rc 6 row).
#   Every check appends one line to <state>/watch.log: "<now-ms> <HEALTHY|WAKE|WEDGE|
#   SUPPRESSED:<reason>|IDLE:<reason>|NOTTY|BUMP-FAILED|BLOCKED…|BL-PROBE|BL-THROTTLED|
#   REPORT|REPORT-SKIP|REPORT-NO-TTY]. BUMP-FAILED: a WAKE was due and
#   injected but its lastWakeSeq bump failed (e.g. no python3) — the 3600 s wall axis caps
#   the damage, the log surfaces the lost seq axis.
#
# ONE-SHOT RC (pinned in this header and the smoke):
#   0  check completed (healthy no-op, dedupe-suppressed, or a wake was injected)
#   4  bad usage / the sidecar file exists but is unreadable
#   5  nothing to wake: no sidecar, unreadable-adjacent state, or state not active|idle
#   6  a wake was due but no usable TTY (the kill-and-resume fallback is printed)
#
# --daemon: single instance via <state>/watch.pid (a live pidfile wins: a second launch
# prints "already running" and exits 0 WITHOUT doubling). Loops: one-shot check, sleep
# --interval (default 60 s), repeat; its output goes to <state>/watch.log. Auto-started
# detached by the extension's session_start (TUI sessions only); it serves the NEXT session
# too and self-idles (IDLE:no-sidecar) when nothing is active.
# Manual --daemon launches need `setsid bash scripts/multipi-watch.sh --daemon &` (or
# nohup): the script does NOT self-daemonize (left optional on purpose) — the extension's
# detached spawn is the designed path, and a plain background job dies with its terminal.
#
# Documented seams:
#   MULTIPI_WATCH_TOOL_MS     integer ms; the tool-in-flight wake threshold (default 720000)
#   MULTIPI_WATCH_BLOCKED_MS  integer ms; the blocked-ticket nudge threshold (default
#                             14400000 = 4h; malformed ⇒ silent default, the same posture as
#                             the other runtime thresholds)
#   MULTIPI_STATUS_STALE_MS   integer ms; the stale bound (default 120000; wedge = 5×)
#   MULTIPI_WATCH_NOW_MS      integer epoch-ms (canonical decimal — a leading zero is
#                             refused, never read as octal); the issuing clock (same pattern as
#                             MULTIPI_APPROVE_NOW_MS) — tests drive wake choice without sleeping
#   MULTIPI_INTERRUPT_TTY     the injection target override (shared with multipi-interrupt.sh)
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"
# shellcheck source=lib/liveness.sh
. "$scripts_dir/lib/liveness.sh"

WAKE_DEDUPE_WALL_MS=3600000
BLOCKED_DEDUPE_WALL_MS=86400000   # one blocked-nudge per ticket per 24h (ledger: watch.log)
# Tracker-probe throttle (ticket #104 gate revision): internal cost constant, NOT an
# operator seam (like the two dedupe walls above) — the smoke's seam-hygiene pin keys off
# the documented MULTIPI_* set, and the cadence is a property of the probe, not of the
# operator. A due wake defers at most one period: 15 min is far inside the 24h window.
BLOCKED_PROBE_THROTTLE_MS=900000

die_usage() {
  echo "usage: scripts/multipi-watch.sh [--daemon] [--interval SECS]" >&2
  exit 4
}
int_or() { # int_or VALUE DEFAULT NAME → prints a non-negative integer
  # #76 (the #67 round-2 class, one consumer further in): a leading-zero value (08/09)
  # passes the all-digits gate, then bash arithmetic reads it as INVALID OCTAL and
  # aborts the check ($((09 * 5)): "value too great for base") — or the test builtin
  # silently mis-compares it as a tiny number (08 ≈ 8 ms: a healthy 1 min tool wakes).
  # Non-canonical decimal is GARBAGE → the documented default, never bash's coincidence.
  case "$1" in '' | *[!0-9]* | 0[0-9]*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac
}

daemon=0
interval=60
while [ $# -gt 0 ]; do
  case "$1" in
    --daemon) daemon=1 ;;
    --interval)
      [ $# -ge 2 ] || die_usage
      interval=$2
      case "$interval" in '' | *[!0-9]* | 0) die_usage ;; esac
      shift ;;
    *) die_usage ;;
  esac
  shift
done

dl_load_config
[ -n "${DL_ROOT:-}" ] || { echo "multipi-watch: not inside a git repository" >&2; exit 4; }
tool_bound=$(int_or "${MULTIPI_WATCH_TOOL_MS:-}" 720000)
stale=$(int_or "${MULTIPI_STATUS_STALE_MS:-}" 120000)
blocked_bound=$(int_or "${MULTIPI_WATCH_BLOCKED_MS:-}" 14400000)
log="$DL_STATE/watch.log"
mkdir -p "$DL_STATE" 2>/dev/null || true
lv_now() {
  # Returns 4 (NEVER exit) on a malformed seam: we run inside $(...) in every call site,
  # where an exit would not kill the check and the corrupt clock would keep feeding
  # silent comparisons (#78 found this latent hole on the NON-NUMERIC path too). A
  # leading zero is malformed here: $((now - hb)) would crash ("value too great for
  # base", 09) or read as epoch 8 ms (08 — every heartbeat looks fresh). The issuing
  # clock is the STRICT seam (spec §4: a wrong clock silently skews every comparison).
  if [ -n "${MULTIPI_WATCH_NOW_MS:-}" ]; then
    case "${MULTIPI_WATCH_NOW_MS}" in
      *[!0-9]* | 0[0-9]*) echo "multipi-watch: MULTIPI_WATCH_NOW_MS must be a canonical decimal integer ms" >&2; return 4 ;;
    esac
    printf '%s' "${MULTIPI_WATCH_NOW_MS}"
  else
    date +%s%3N
  fi
}
# wlog NOW MESSAGE — takes its timestamp EXPLICITLY (#65 round-4: the global `now`
# one_shot used to set leaked into the daemon loop's CHECK-FAILED line — the daemon
# scopes its own). The message is $2, never $*: $* would re-expand the timestamp too.
wlog() { printf '%s %s\n' "$1" "$2" >>"$log" 2>/dev/null || true; }

iso_to_ms() { # ISO8601 (UTC) -> epoch ms (prints nothing and returns 1 when unparseable)
  local ms
  ms=$(date -d "$1" +%s%3N 2>/dev/null) || return 1
  case "$ms" in '' | *[!0-9]*) return 1 ;; *) printf '%s' "$ms"; return 0 ;; esac
}

# tl_blocked_iso TIMELINE_JSON -> the created_at of the NEWEST dl/blocked label event
# ("" when none / unparseable). jq first, python3 second — the common.sh dependency rule.
tl_blocked_iso() {
  local js=$1
  if dl_have_jq; then
    jq -r '[ .[] | select(.event? == "labeled" and ((.label.name? // "") == "dl/blocked")) | .created_at ] | max // empty' <<<"$js" 2>/dev/null || true
  else
    python3 -I -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
xs = [e.get("created_at") for e in data
      if isinstance(e, dict) and e.get("event") == "labeled"
      and isinstance(e.get("label"), dict) and e["label"].get("name") == "dl/blocked"]
xs = [x for x in xs if isinstance(x, str)]
if xs:
    print(max(xs))
' <<<"$js" 2>/dev/null || true
  fi
}

# deps_from_text < TEXT -> the dependency numbers of the FIRST reference cluster after
# each "Depends on" marker (deduped, one per line, order preserved). The cluster is the
# run of "#<n>" refs immediately following the marker — separated by whitespace or
# commas only; the first non-ref token (a paren, prose, a sentence break) ends it, so
# "Depends on #2 (see #3 for the related note)" yields #2 ALONE: a parenthetical mention
# is context, not a dependency, and claiming it risks the false "now resumable". The
# consumer decides what the list earns: with MORE THAN 10 distinct dependencies the
# resumable claim must be refused (an unverifiable list — see bl_check).
deps_from_text() {
  awk '
    tolower($0) ~ /depends on/ {
      s = substr($0, index(tolower($0), "depends on") + 10)
      for (;;) {
        if (match(s, /^[[:space:],]+/)) { s = substr(s, RSTART + RLENGTH); continue }
        if (match(s, /^#[0-9]+/)) {
          print substr(s, 2, RLENGTH - 1)
          s = substr(s, RSTART + RLENGTH)
          continue
        }
        break
      }
    }' | awk '!seen[$0]++'
}

bl_check() {
  # The blocked-ticket nudge (ticket #104). Called by one_shot ONLY after the core check
  # reached a valid sidecar (rc 0 or 6): the nudge is delivered into the live session's
  # TTY, and there is no delivery target (nor a session to own the rc) otherwise. Every
  # failure mode — no gh, auth failure, list failure, unreadable timestamps — degrades to
  # a silent skip: the nudge must never fail the check, never change the one-shot rc,
  # and never kill the daemon. Its own dedupe (per ticket per 24h, ledger: watch.log)
  # is independent of the WAKE/WEDGE dedupe axes.
  local now sc pid lastprobe
  now=$(lv_now) || return 0
  sc=$(lv_sidecar)
  [ -f "$sc" ] && lv_valid "$sc" || return 0
  pid=$(lv_num "$sc" pid)
  # Probe throttle (ticket #104 gate revision): the tracker probe (gh auth + issue list
  # + the per-ticket calls) costs API calls, so it runs at most once per
  # BLOCKED_PROBE_THROTTLE_MS, ledgered by `BL-PROBE` stamps in the watch log —
  # independent of the 24h per-ticket wake dedupe, and it short-circuits BEFORE that
  # dedupe (a throttled tick makes ZERO tracker calls and logs nothing per-ticket). The
  # stamp lands BEFORE the gh calls: an outage burns at most one probe's cost per
  # period. A due wake defers at most one 15-min period — far inside the 24h window;
  # the wake owns the cadence, the throttle only bounds probing.
  lastprobe=$(lv_last_probe_ts "$log")
  if [ "$lastprobe" -gt 0 ] && [ $((now - lastprobe)) -lt "$BLOCKED_PROBE_THROTTLE_MS" ]; then
    wlog "$now" "BL-THROTTLED"
    return 0
  fi
  wlog "$now" "BL-PROBE"
  command -v gh >/dev/null 2>&1 || return 0
  gh auth status >/dev/null 2>&1 || return 0
  local rows
  rows=$(gh issue list --state open --label dl/blocked --json number,title,labels,body,updatedAt --limit 500 2>/dev/null) || return 0
  local ncount i num labs body upd tl iso approx t age last cview cc ctext q st deps ndeps d resumed=0 msg
  ncount=$(( $(printf '%s\n' "$rows" | grep -oE '"number"[[:space:]]*:' | wc -l) ))
  i=0
  while [ "$i" -lt "$ncount" ]; do
    num=$(json_get "$i.number" <<<"$rows")
    case "$num" in '' | *[!0-9]*) break ;; esac
    labs=$(json_get "$i.labels" <<<"$rows" \
      | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | sed -E 's/^"name"[[:space:]]*:[[:space:]]*"//; s/"$//' | tr '\n' ' ')
    # Client-side label re-check: the real gh honours --label, the stand-in does not.
    case " $labs " in
      *" dl/blocked "*) : ;;
      *) i=$((i + 1)); continue ;;
    esac
    body=$(json_get "$i.body" <<<"$rows")
    upd=$(json_get "$i.updatedAt" <<<"$rows")
    # The blocked start: the newest dl/blocked label event on the timeline (preferred);
    # the row's updatedAt is the DOCUMENTED approximation (approx=1 in the log line).
    # --paginate --slurp: on a chatty ticket the newest dl/blocked event can sit past
    # the first page; slurped, the concatenated pages are ONE JSON array, so
    # tl_blocked_iso's max() survives the page boundary.
    iso=""; approx=0
    if [ -n "${GH_REPO:-}" ]; then
      tl=$(gh api --paginate --slurp "repos/$GH_REPO/issues/$num/timeline" 2>/dev/null || true)
      iso=$(tl_blocked_iso "$tl")
    fi
    if [ -z "$iso" ]; then iso=$upd; approx=1; fi
    t=$(iso_to_ms "$iso") || { wlog "$now" "BLOCKED-NO-AGE n=$num"; i=$((i + 1)); continue; }
    age=$((now - t)); [ "$age" -lt 0 ] && age=0
    [ "$age" -gt "$blocked_bound" ] || { i=$((i + 1)); continue; }
    last=$(lv_last_blocked_ts "$log" "$num")
    if [ "$last" -gt 0 ] && [ $((now - last)) -lt "$BLOCKED_DEDUPE_WALL_MS" ]; then
      wlog "$now" "BLOCKED-SKIP n=$num"
      i=$((i + 1)); continue
    fi
    # The question (newest comment supersedes the body — the board's same rule) and the
    # resumable claim (every Depends-on verifiably CLOSED; unverifiable ⇒ never claimed).
    cview=$(gh issue view "$num" --json comments 2>/dev/null || true)
    cc=$(( $(printf '%s\n' "$cview" | grep -oE '"body"[[:space:]]*:' | wc -l) ))
    ctext=""
    [ "$cc" -gt 0 ] && ctext=$(json_get "comments.$((cc - 1)).body" <<<"$cview")
    q=$(dl_blocked_question "${ctext:-$body}")
    resumed=0
    deps=$({ printf '%s\n' "$ctext"; printf '%s\n' "$body"; } | deps_from_text)
    if [ -n "$deps" ]; then
      # Refuse-to-claim (ticket #104 gate revision): MORE THAN 10 distinct dependencies
      # cannot all be verified — claiming "now resumable" from a truncated list would be
      # the dangerous false claim, so the scan refuses (plain line, resumed=0). Exactly
      # 10 stays fully verifiable: the claim is allowed. Above the cap no per-dep state
      # call is spent (the claim is foregone; the calls would only burn quota).
      ndeps=$(printf '%s\n' "$deps" | wc -l)
      if [ "$ndeps" -le 10 ]; then
        resumed=1
        for d in $deps; do
          st=$(gh issue view "$d" --json state 2>/dev/null | json_get state)
          [ "$st" = CLOSED ] || { resumed=0; break; }
        done
      fi
    fi
    msg="BLOCKED (multipi-watch): #$num has awaited a human decision for $(lv_human_dur "$age") — \"$q\"."
    [ "$resumed" = 1 ] && msg="$msg Its dependencies are all closed — now resumable."
    msg="$msg Resume or drop it."
    lv_inject_target "$pid"
    # The nudge APPENDS to its target: byte-identical to a truncate-write on a real TTY,
    # and on a file sink (the tests' seam target) one line per nudge accumulates, so the
    # injection count is observable. A target path that does not exist is a NO-USABLE-TTY
    # condition (a detached terminal by another name): log-only, and the 24h window does
    # NOT start — the nudge is retried the next tick a target returns.
    if [ -n "$LV_TARGET" ] && [ -e "$LV_TARGET" ] && printf '%s\n' "$msg" >>"$LV_TARGET" 2>/dev/null; then
      wlog "$now" "BLOCKED n=$num age=$age resumed=$resumed approx=$approx"
      echo "watch: injected BLOCKED n=$num to ${LV_TARGET} (pid ${pid})"
    else
      # No usable TTY (a detached terminal): the informational log line still lands; the
      # dedupe window does NOT start — the nudge is retried the next tick a TTY returns.
      wlog "$now" "BLOCKED-NO-TTY n=$num"
      echo "watch: BLOCKED n=$num is due but no usable TTY (log only)"
    fi
    i=$((i + 1))
  done
  return 0
}

core_check() {
  local now sc state pid tick ev hb toolseq toolname toolstart lastwakeseq
  local wedge_age tool_age kind min_n msg lw reports
  now=$(lv_now) || return 4
  sc=$(lv_sidecar)
  if [ ! -f "$sc" ]; then
    wlog "$now" "IDLE:no-sidecar"
    echo "watch: no sidecar (nothing to wake)"
    return 5
  fi
  if ! lv_valid "$sc"; then
    echo "multipi-watch: sidecar unreadable at $sc" >&2
    return 4
  fi
  state=$(lv_field "$sc" state)
  case "$state" in
    active | idle) : ;;
    *) wlog "$now" "IDLE:state-${state}"; echo "watch: state '${state}' — nothing to wake"; return 5 ;;
  esac
  pid=$(lv_num "$sc" pid)
  tick=$(lv_num "$sc" lastTickAt)
  ev=$(lv_num "$sc" lastEventAt)
  hb=$tick; [ "$ev" -gt "$hb" ] && hb=$ev
  toolseq=$(lv_num "$sc" tool.seq)
  toolname=$(lv_field "$sc" tool.name)
  toolstart=$(lv_num "$sc" tool.startedAt)
  lastwakeseq=$(lv_num "$sc" lastWakeSeq -1)

  wedge_age=$((now - hb))
  [ "$wedge_age" -lt 0 ] && wedge_age=0
  tool_age=0
  [ "$toolseq" -gt 0 ] && tool_age=$((now - toolstart)) && [ "$tool_age" -lt 0 ] && tool_age=0
  reports=$(report_scan)
  local wedge_cond=0 tool_cond=0
  [ "$wedge_age" -gt $((stale * 5)) ] && wedge_cond=1
  [ "$toolseq" -gt 0 ] && [ "$tool_age" -gt "$tool_bound" ] && tool_cond=1
  if [ "$wedge_cond" = 0 ] && [ "$tool_cond" = 0 ] && [ -z "$reports" ]; then
    wlog "$now" "HEALTHY"
    echo "watch: healthy (pid ${pid})"
    return 0
  fi

  # The strongest wake wins: the wedge, then the long tool, then an uncollected report
  # (a report stays due — unacked — until collected, so losing the race only delays it a tick).
  kind=WAKE
  min_n=$((tool_age / 60000))
  msg="WAKE (multipi-watch): ${toolname} has been in flight ${min_n}min. If it is wedged, say so and abort/retry; otherwise continue."
  if [ "$wedge_cond" = 1 ]; then
    kind=WEDGE
    min_n=$((wedge_age / 60000))
    msg="WEDGE SUSPECTED (multipi-watch): no orchestrator heartbeat for ${min_n}min. Check scripts/multipi-status.sh; if dead, kill ${pid} and resume in a fresh session (step 0)."
  elif [ "$tool_cond" = 0 ]; then
    kind=REPORT
  fi
  if [ "$kind" = REPORT ]; then
    # One wake line per report, per-report ledger + the shared 3600 s wall axis (ticket #133).
    # Returns 0 (nothing injected, or all ledgred) or 6 (due but no usable TTY — the
    # one-shot rc table's existing no-TTY row, with the kill-and-resume fallback printed).
    local rc
    report_check "$now" "$pid" "$reports" || rc=$?
    return ${rc:-0}
  fi

  # Dedupe axis 1: per tool.seq (the sidecar's monotonic watermark).
  if [ "$kind" = WAKE ] && [ "$lastwakeseq" -eq "$toolseq" ]; then
    wlog "$now" "SUPPRESSED:seq"
    echo "watch: suppressed (already woken for seq ${toolseq})"
    return 0
  fi
  # Dedupe axis 2: at most one wake per 3600 s of wall clock (the watch log is the ledger).
  lw=$(lv_last_wake_ts "$log")
  if [ "$lw" -gt 0 ] && [ $((now - lw)) -lt "$WAKE_DEDUPE_WALL_MS" ]; then
    wlog "$now" "SUPPRESSED:recent"
    echo "watch: suppressed (last wake < 3600 s ago)"
    return 0
  fi

  lv_inject_target "$pid"
  if [ -z "$LV_TARGET" ]; then
    wlog "$now" "NOTTY"
    lv_no_tty_fallback "$pid" "$LV_TTY_RAW"
    return 6
  fi
  if ! printf '%s\n' "$msg" >"$LV_TARGET" 2>/dev/null; then
    wlog "$now" "NOTTY"
    lv_no_tty_fallback "$pid" "$LV_TTY_RAW"
    return 6
  fi
  if [ "$kind" = WAKE ]; then
    wlog "$now" "WAKE tool=${toolname}"
    # A failed bump (a python3-less box, CAS exhaustion) does NOT fail the wake: the wall
    # axis caps the damage at one duplicate wake. Log the degradation — the seq axis is
    # lost, so the operator must be able to see that it was lost.
    lv_bump_wake_seq "$sc" "$toolseq" || wlog "$now" "BUMP-FAILED tool=${toolname} seq=${toolseq}"
  else
    wlog "$now" "WEDGE hb-age=${wedge_age}"
  fi
  echo "watch: injected ${kind} to ${LV_TARGET} (pid ${pid})"
  return 0
}

# report_scan: the uncollected terminal entries of <state>/dispatch.json, one line per
# report: "key<TAB>role<TAB>status<TAB>t" — t = endedAt (or startedAt for legacy entries),
# the SAME generation identity as the extension's terminalTime (state.ts). An entry is
# UNCOLLECTED when its generation is absent from the ack ledger (reconcile-seen.json) —
# the same rule as the status surface's unseenTerminals. Missing or corrupt state reads
# as NO REPORTS (soft read, the state surface's "history is lossy" stance — never a
# spurious wake, never a crash). jq first, python3 second (the common.sh rule).
report_scan() {
  local st="$DL_STATE/dispatch.json" sn="$DL_STATE/reconcile-seen.json"
  [ -f "$st" ] || return 0
  if dl_have_jq; then
    { [ -f "$sn" ] && cat "$sn" 2>/dev/null || printf '{}'; } | jq -r --slurpfile st "$st" '
      ($st[0] | if type == "object" then . else {} end) as $st
      | (if type == "object" then . else {} end) as $sn
      | [ $st | to_entries[]
          | select((.value | type) == "object"
                   and ((.value.status? | type) == "string")
                   and .value.status != "running")
          | ((.value.endedAt? // .value.startedAt? // 0) | if type == "number" then . else 0 end) as $t
          | select((($sn[.key]) // -1) != $t)
          | [.key, (.value.role? // "?"), .value.status, ($t | tostring)] | @tsv
        ]
      | .[]' 2>/dev/null || true
  else
    python3 -I - "$st" "$sn" <<'PY' 2>/dev/null || true
import json, sys
def load(p):
    try:
        with open(p) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}
st, sn = load(sys.argv[1]), load(sys.argv[2])
for k, v in st.items():
    if not isinstance(v, dict):
        continue
    status = v.get("status")
    if not isinstance(status, str) or status == "running":
        continue
    t = v.get("endedAt", v.get("startedAt", 0))
    if isinstance(t, bool) or not isinstance(t, (int, float)):
        t = 0
    if sn.get(k, -1) == t:
        continue
    print("\t".join([str(k), str(v.get("role", "?")), status, str(int(t))]))
PY
  fi
  return 0
}

# report_check NOW PID REPORTS — the report-landing wake (ticket #133). One wake line
# per uncollected report, APPENDED to the TTY target (multiple reports accumulate, one
# line each). Dedupe: per report (per key+generation, the REPORT n= t= ledger in the
# watch log — an undelivered report retries, a delivered one never repeats) AND the
# shared 3600 s wall axis (a WAKE/WEDGE inside the window suppresses it for the tick).
# rc contribution: 0 (nothing due or all ledgred), 6 (due but no usable TTY — the
# existing no-TTY row, with the kill-and-resume fallback printed).
report_check() {
  local now=$1 pid=$2 reports=$3
  local rk rr rs rt rid last lw ok ntt msg newlines due_keys tab=$'\t'
  # Wall axis: a safety wake within the last 3600 s suppresses report wakes for the tick.
  lw=$(lv_last_wake_ts "$log")
  if [ "$lw" -gt 0 ] && [ $((now - lw)) -lt "$WAKE_DEDUPE_WALL_MS" ]; then
    while IFS=$'\t' read -r rk rr rs rt; do
      [ -n "$rk" ] && wlog "$now" "REPORT-SKIP n=$rk recent"
    done <<<"$reports"
    echo "watch: report(s) due but suppressed (last WAKE/WEDGE < 3600 s ago)"
    return 0
  fi
  # Split the due list: already-delivered (ledgred) vs new. All-delivered is a clean no-op.
  newlines=""
  while IFS=$'\t' read -r rk rr rs rt; do
    [ -n "$rk" ] || continue
    last=$(lv_last_report_ts "$log" "$rk" "$rt")
    if [ "$last" -gt 0 ]; then
      wlog "$now" "REPORT-SKIP n=$rk seen"
    else
      newlines="${newlines}${rk}${tab}${rr}${tab}${rs}${tab}${rt}"$'\n'
    fi
  done <<<"$reports"
  [ -n "$newlines" ] || return 0
  lv_inject_target "$pid"
  local due_keys=""
  while IFS=$'\t' read -r rk rr rs rt; do
    [ -n "$rk" ] && due_keys="$due_keys $rk"
  done <<<"${newlines%$'\n'}"
  # No usable TTY (the seam may point at a path that does not exist; a detached
  # terminal has no target at all): every due report stays due — the dedupe window does
  # NOT start, so it is retried the next tick a target returns. Same fallback + rc 6 the
  # other wakes use.
  if [ -z "$LV_TARGET" ] || [ ! -e "$LV_TARGET" ]; then
    for rk in $due_keys; do wlog "$now" "REPORT-NO-TTY n=$rk"; done
    lv_no_tty_fallback "$pid" "${LV_TTY_RAW:-}"
    return 6
  fi
  ok=0; ntt=0
  while IFS=$'\t' read -r rk rr rs rt; do
    [ -n "$rk" ] || continue
    case "$rk" in '' | *[!0-9]*) rid="$rk" ;; *) rid="#$rk" ;; esac
    msg="REPORT LANDED (multipi-watch): ${rid} ${rr} -> ${rs} — run devloop_status to collect it (act in this turn)."
    # APPEND (never `>`): the target may already hold a WAKE/WEDGE line — multiple wake
    # lines accumulate, one per report, one per tick.
    if printf '%s\n' "$msg" >>"$LV_TARGET" 2>/dev/null; then
      wlog "$now" "REPORT n=$rk t=$rt"
      ok=1
    else
      wlog "$now" "REPORT-NO-TTY n=$rk"
      ntt=1
    fi
  done <<<"${newlines%$'\n'}"
  if [ "$ntt" = 1 ]; then
    lv_no_tty_fallback "$pid" "${LV_TTY_RAW:-}"
    return 6
  fi
  [ "$ok" = 1 ] && echo "watch: injected REPORT wake(s) to ${LV_TARGET} (pid ${pid})"
  return 0
}

one_shot() {
  # The pinned one-shot contract (rc 0/4/5/6) is core_check's. When the check reached a
  # live sidecar (rc 0 or 6), the blocked-ticket nudge (ticket #104) then runs: an
  # independent, self-deduped informational check that never changes the returned rc.
  local rc=0
  core_check || rc=$?
  case "$rc" in
    0 | 6) bl_check ;;
  esac
  return "$rc"
}

if [ "$daemon" = 1 ]; then
  pidfile="$DL_STATE/watch.pid"
  if [ -f "$pidfile" ]; then
    old=$(cat "$pidfile" 2>/dev/null || true)
    case "$old" in
      '' | *[!0-9]*) rm -f "$pidfile" ;;
      *)
        if lv_pid_alive "$old"; then
          echo "multipi-watch: already running (pid ${old})"
          exit 0
        fi
        rm -f "$pidfile"   # stale
        ;;
    esac
  fi
  printf '%s\n' "$$" >"$pidfile"
  trap 'rm -f "$pidfile"' EXIT
  # A trapped TERM must EXIT: bash runs the handler and CONTINUES otherwise (verified),
  # which would turn every `kill` into a pidfile release with a still-running loop.
  trap 'rm -f "$pidfile"; exit 0' INT TERM
  # The loop: check, sleep, repeat. A failed check is logged, never fatal — the net must
  # outlive the wedge it watches for.
  while :; do
    if ! one_shot >>"$log" 2>&1; then
      # The daemon scopes ITS OWN timestamp: one_shot's `now` is local to the check.
      # #80: a malformed clock already parked its refusal in $log (one_shot's stderr
      # redirect); capturing it a SECOND time here re-emitted the same line onto the
      # daemon's dropped stderr. Drop that redundant emission; the wall-clock fallback
      # keeps the CHECK-FAILED line writing.
      wlog "$(lv_now 2>/dev/null || date +%s%3N)" "CHECK-FAILED"
    fi
    sleep "$interval"
  done
fi

rc=0
one_shot || rc=$?
exit "$rc"
