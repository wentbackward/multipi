#!/usr/bin/env bash
# Scenario stage of the batch gate (dark-factory spec §5): start the system under test in its
# OWN process group (first printed line = target for the judges), judge every scenario in the
# store with one-shot headless judges (verdict JSON on the judge's last line, rejudge once —
# the better run counts), seal the deterministic share, and decide green/red IN THIS SCRIPT,
# like every other multipi gate contract. The gate relays the verdict; no new gate codes.
#
# Usage: scenario-stage.sh            (no arguments; run inside the project, e.g. by the gate)
#
# Exit: 0 GREEN (store off: prints "scenarios skipped", also 0)
#       1 RED — invalid store files (count only, never named), unstartable or failed run,
#         unseeded store, or a failing scenario. Printable lines carry ONLY scenario ids,
#         scores and the judges' "missing"/error text — never scenario text, the store path,
#         or judge evidence.
#       2 usage/config — bad invocation, missing node or modules, store on without scenarios.run.
#
# Green iff every REQUIRED scenario (sealed included) scores >= pass AND the mean over all
# judged scenarios >= min_satisfaction. Sealed scenarios (isSealed: pinned sha256 share of the
# id) are judged and counted but NEVER named.
#
# Documented env seams (spec §5.2): MULTIPI_SCENARIO_FILE / MULTIPI_SCENARIO_ID /
# MULTIPI_SCENARIO_TARGET are exported to every judge; MULTIPI_PI_BIN selects the pi binary of
# the default judge (else `pi` on PATH); MULTIPI_CONFIG / MULTIPI_HOME as in every loop script.
#
# Stage logs (logs dir; the last three hold judge evidence or sealed ids and must NEVER be
# shown to an implementer, reviewer or verifier — only the first is safe to forward):
#   train-scenarios.log               the stage's own lines (what it prints)
#   train-scenario-results.jsonl      one line per judge run: scenario, run, sealed, valid, result/error
#   train-scenario-judge/<id>-<run>/  each judge's raw transcript
#   train-scenarios-run.log           the system under test's full output
set -u
scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$scripts_dir/lib/common.sh"

[ "$#" -eq 0 ] || dl_die "usage: scenario-stage.sh (no arguments)"
dl_load_config required

# --- stage bookkeeping ----------------------------------------------------------
tmp=""
STAGE_LOG=""
RUN_PGID_FILE=""
MODULES_SRC=""
# Invoked only via the EXIT/INT/TERM traps below (shellcheck cannot trace trap-by-name).
# shellcheck disable=SC2329
cleanup() {
  # Every exit path stops the system-under-test group (SIGTERM, SIGKILL after 2 s) and drops
  # the stage's temp dir. The group id file is stage-owned state, not a log.
  if [ -n "$MODULES_SRC" ] && [ -n "$RUN_PGID_FILE" ] && [ -f "$RUN_PGID_FILE" ]; then
    SCEN_SRC="$MODULES_SRC" node --input-type=module -e '
const { stopGroup } = await import(process.env.SCEN_SRC + "/scenario-run.ts");
const fs = await import("node:fs");
const pgid = Number(fs.readFileSync(process.argv[1], "utf8").trim());
if (Number.isInteger(pgid) && pgid > 0) await stopGroup(pgid);
' "$RUN_PGID_FILE" >/dev/null 2>&1 || true
  fi
  [ -n "$tmp" ] && rm -rf -- "$tmp"
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# say LINE: the stage's one outward voice — stdout AND train-scenarios.log (kept in lockstep
# because the log is the "safe to forward" copy of exactly these lines).
say() {
  printf '%s\n' "$*"
  [ -n "$STAGE_LOG" ] && printf '%s\n' "$*" >>"$STAGE_LOG"
  return 0
}

# jesc VALUE: JSON-escape one string (quotes included), via the same node the stage needs anyway.
jesc() {
  node --input-type=module -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

# --- prerequisites ---------------------------------------------------------------
command -v node >/dev/null 2>&1 || dl_die "node is required to run the scenario stage"
for cand in "$DL_ROOT/.pi/extensions/multipi-devloop/src" "$scripts_dir/../extension/src"; do
  if [ -f "$cand/config.ts" ] && [ -f "$cand/scenarios.ts" ] && [ -f "$cand/scenario-run.ts" ]; then
    MODULES_SRC=$cand
    break
  fi
done
[ -n "$MODULES_SRC" ] || dl_die "scenario modules not found (extension/src incomplete: config.ts, scenarios.ts, scenario-run.ts)"
export SCEN_SRC=$MODULES_SRC

# One node one-shot computes the whole stage context from the PURE modules, so the stage and
# the doctor share one notion of on/off, path resolution, validity and seal (doctor's pattern).
meta_json=$(
  node --input-type=module -e '
const path = await import("node:path");
const { loadConfig, scenariosOn, resolvePaths } = await import(process.env.SCEN_SRC + "/config.ts");
const { scanStore, storeCounts, isSealed } = await import(process.env.SCEN_SRC + "/scenarios.ts");
const cfg = loadConfig(process.cwd());
if (!cfg) process.exit(0);
if (!scenariosOn(cfg)) { process.stdout.write(JSON.stringify({ on: false })); process.exit(0); }
const s = cfg.scenarios && typeof cfg.scenarios === "object" ? cfg.scenarios : {};
const p = resolvePaths(cfg);
const files = scanStore(p.scenariosDir);
const counts = storeCounts(files);
const scenarios = files.filter((f) => f.valid).map((f) => ({
  id: f.id,
  file: path.default.join(p.scenariosDir, f.file),
  required: f.required === true,
  sealed: isSealed(f.id, s.sealed ?? 0.2),
}));
process.stdout.write(JSON.stringify({
  on: true, mode: cfg.factory,
  run: s.run ?? null, runSeconds: s.runSeconds ?? 120,
  judge: s.judge ?? null, judgeSeconds: s.judgeSeconds ?? 600,
  pass: s.pass ?? 0.8, minSatisfaction: s.minSatisfaction ?? 0.9, sealed: s.sealed ?? 0.2,
  total: counts.total, required: counts.required, invalid: counts.invalid,
  scenarios,
}));
' 2>/dev/null
)
[ -n "$meta_json" ] || dl_die "scenario stage could not resolve its config (node module import failed)"

on=$(json_get on <<<"$meta_json")
[ "$on" = "true" ] || { say "scenarios skipped"; exit 0; }

# --- logs (stage-owned; recreated fresh each run) ---------------------------------
LOGS_DIR=$(dl_logs_dir)
mkdir -p "$LOGS_DIR" || dl_die "cannot create the logs dir"
STAGE_LOG="$LOGS_DIR/train-scenarios.log"
RESULTS_FILE="$LOGS_DIR/train-scenario-results.jsonl"
JUDGE_DIR="$LOGS_DIR/train-scenario-judge"
RUN_LOG="$LOGS_DIR/train-scenarios-run.log"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/multipi-scenario-stage.XXXXXX") || dl_die "cannot create a temp dir"
RUN_PGID_FILE="$tmp/run.pgid"
META_FILE="$tmp/meta.tsv"
: >"$RESULTS_FILE"
: >"$RUN_LOG"
rm -rf -- "$JUDGE_DIR" # stage-owned dir: it holds THIS run's transcripts and nothing else
mkdir -p "$JUDGE_DIR" || dl_die "cannot create the judge log dir"

run_cmd=$(json_get run <<<"$meta_json")
# A config defect (store on, no run command) outranks any store-state verdict: judges
# would have no target to work with, and the operator must fix the config, not the store.
[ -n "$run_cmd" ] || dl_die "scenarios.run is not configured; the stage cannot start the system under test"
run_seconds=$(json_get runSeconds <<<"$meta_json")
judge_template=$(json_get judge <<<"$meta_json")
judge_seconds=$(json_get judgeSeconds <<<"$meta_json")
pass_floor=$(json_get pass <<<"$meta_json")
min_sat=$(json_get minSatisfaction <<<"$meta_json")

# --- store gates (red before any process is started) ------------------------------
invalid=$(json_get invalid <<<"$meta_json")
total=$(json_get total <<<"$meta_json")
req_count=$(json_get required <<<"$meta_json")
mode=$(json_get mode <<<"$meta_json")
[ "$invalid" -gt 0 ] && { say "scenarios red: $invalid invalid scenario file(s)"; exit 1; }
[ "$total" -eq 0 ] && { say "scenarios red: no valid scenarios in the store"; exit 1; }
# A dark factory must hold at least one valid REQUIRED scenario or its gates stay red
# (the stage twin of doctor's "MISSING factory dark" — spec §2).
if [ "$mode" = "dark" ] && [ "$req_count" -eq 0 ]; then
  say "scenarios red: no valid required scenario in the store"
  exit 1
fi

# --- 1. run the system in its own process group -----------------------------------
run_result=$(
  node --input-type=module -e '
const { spawnSystemRun } = await import(process.env.SCEN_SRC + "/scenario-run.ts");
process.stdout.write(JSON.stringify(await spawnSystemRun(JSON.parse(process.argv[1]))));
' "$(printf '{"command":%s,"runSeconds":%s,"logFile":%s}' "$(jesc "$run_cmd")" "$run_seconds" "$(jesc "$RUN_LOG")")" 2>/dev/null
)
if [ -n "$run_result" ] && [ "$(json_get ok <<<"$run_result")" = "true" ]; then
  TARGET=$(json_get target <<<"$run_result")
  printf '%s\n' "$(json_get pgid <<<"$run_result")" >"$RUN_PGID_FILE"
else
  # A stage-internal spawn failure and a dead system are both RED: an unjudgable system
  # must never green-light a train. The reason is ours (never the system's own output).
  say "scenarios red: system run failed ($( [ -n "$run_result" ] && json_get reason <<<"$run_result" || echo 'stage could not spawn the run' ))"
  exit 1
fi

# --- judge resolution (default: pi -p with the scenario-judge role) ----------------
PI_BIN=${MULTIPI_PI_BIN:-pi}
ROLE_FILE=""
for cand in "$DL_ROOT/.pi/agents/scenario-judge.md" "$scripts_dir/../agents/scenario-judge.md"; do
  if [ -f "$cand" ]; then
    ROLE_FILE=$cand
    break
  fi
done
if [ -z "$judge_template" ]; then
  [ -n "$ROLE_FILE" ] || dl_die "scenario-judge role file not found (agents/ incomplete)"
  # $ROLE_FILE is quoted FOR THE INNER SHELL: JUDGE_CMD_DEFAULT is executed via `bash -c`
  # by the judge spawner, so spaces in the resolved path must not split the flag's argument.
  JUDGE_CMD_DEFAULT="$PI_BIN -p --no-session --append-system-prompt \"$ROLE_FILE\" Judge the scenario."
else
  JUDGE_CMD_DEFAULT=""
fi

# --- 2./3. judge every scenario once; a score below pass is rejudged (better counts) --
: >"$META_FILE"
n_scen=$(json_len scenarios <<<"$meta_json")
i=0
while [ "$i" -lt "$n_scen" ]; do
  sid=$(json_get "scenarios.$i.id" <<<"$meta_json")
  sfile=$(json_get "scenarios.$i.file" <<<"$meta_json")
  sreq=$(json_get "scenarios.$i.required" <<<"$meta_json")
  sseal=$(json_get "scenarios.$i.sealed" <<<"$meta_json")
  i=$((i + 1))
  [ -n "$sid" ] || continue
  printf '%s\t%s\t%s\n' "$sid" "$sreq" "$sseal" >>"$META_FILE"
  # The seams ride the judge env two ways: spawnJudge sets them explicitly, and these exports
  # cover a configured judge TEMPLATE that refers to $MULTIPI_SCENARIO_* inside its shell.
  export MULTIPI_SCENARIO_FILE="$sfile" MULTIPI_SCENARIO_ID="$sid" MULTIPI_SCENARIO_TARGET="$TARGET"

  best="" # empty = no valid verdict yet; a valid score is a decimal string
  run_no=1
  while [ "$run_no" -le 2 ]; do
    jdir="$JUDGE_DIR/$sid-$run_no"
    mkdir -p "$jdir"
    transcript="$jdir/transcript.log"
    : >"$transcript"
    if [ -n "$JUDGE_CMD_DEFAULT" ]; then
      judge_cmd=$JUDGE_CMD_DEFAULT
    else
      judge_cmd=$judge_template
    fi
    judge_params=$(
      printf '{"command":%s,"judgeSeconds":%s,"outFile":%s,"env":{"MULTIPI_SCENARIO_FILE":%s,"MULTIPI_SCENARIO_ID":%s,"MULTIPI_SCENARIO_TARGET":%s}}' \
        "$(jesc "$judge_cmd")" "$judge_seconds" "$(jesc "$transcript")" \
        "$(jesc "$sfile")" "$(jesc "$sid")" "$(jesc "$TARGET")"
    )
    judge_out=$(
      node --input-type=module -e '
const { spawnJudge } = await import(process.env.SCEN_SRC + "/scenario-run.ts");
process.stdout.write(JSON.stringify(await spawnJudge(JSON.parse(process.argv[1]))));
' "$judge_params" 2>/dev/null
    )
    spawn_error=""
    j_code=null
    if [ -z "$judge_out" ] || [ "$(json_get ok <<<"$judge_out")" != "true" ]; then
      spawn_error=$( [ -n "$judge_out" ] && json_get reason <<<"$judge_out" || echo "stage could not spawn the judge" )
    else
      j_code=$(json_get exitCode <<<"$judge_out")
    fi
    # One results line per judge run: scenario, run, sealed, valid, result/error. The node
    # one-shot also parses the transcript with the SHARED parseVerdict (scenarios.ts) and
    # prints the winning score ("" when the verdict is invalid) — no verdict logic in bash.
    sealed_bool=false
    [ "$sseal" = "true" ] && sealed_bool=true
    spawn_err_json=null
    [ -n "$spawn_error" ] && spawn_err_json=$(jesc "$spawn_error")
    record_params=$(
      printf '{"transcript":%s,"id":%s,"run":%s,"sealed":%s,"resultsFile":%s,"spawnError":%s,"exitCode":%s}' \
        "$(jesc "$transcript")" "$(jesc "$sid")" "$run_no" "$sealed_bool" "$(jesc "$RESULTS_FILE")" "$spawn_err_json" "$j_code"
    )
    score=$(
      node --input-type=module -e '
const fs = await import("node:fs");
const { parseVerdict } = await import(process.env.SCEN_SRC + "/scenarios.ts");
const p = JSON.parse(process.argv[1]);
const fold = (s) => String(s).replace(/\s+/g, " ").trim();
const rec = { scenario: p.id, run: p.run, sealed: p.sealed, exitCode: p.exitCode ?? null };
if (p.spawnError !== null) {
  rec.valid = false;
  rec.error = fold(p.spawnError);
} else {
  const v = parseVerdict(fs.readFileSync(p.transcript, "utf8"), p.id);
  // A non-zero judge exit scores 0 even when a well-formed verdict line exists:
  // an unhealthy judge never green-lights (spec §5.2).
  if (p.exitCode !== 0) {
    rec.valid = false;
    const ex = "judge exited " + p.exitCode + "; ";
    rec.error = v.ok ? ex + "verdict discarded (non-zero exit)" : ex + fold(v.reason);
  } else if (v.ok) {
    rec.valid = true;
    rec.result = {
      id: v.verdict.id, satisfied: v.verdict.satisfied, required: v.verdict.required,
      evidence: fold(v.verdict.evidence), missing: fold(v.verdict.missing),
    };
    process.stdout.write(String(v.verdict.satisfied));
  } else {
    rec.valid = false;
    rec.error = fold(v.reason);
  }
}
fs.appendFileSync(p.resultsFile, JSON.stringify(rec) + "\n");
' "$record_params" 2>/dev/null
    )
    [ -n "$score" ] && best=$score
    # Rejudge once when the best so far sits below the floor (invalid verdicts score 0).
    if [ "$run_no" -eq 1 ] && awk -v b="${best:-0}" -v p="$pass_floor" 'BEGIN { exit !(b < p) }'; then
      run_no=2
    else
      run_no=3
    fi
  done
done
unset MULTIPI_SCENARIO_FILE MULTIPI_SCENARIO_ID MULTIPI_SCENARIO_TARGET

# --- stage end: stop the system group (SIGTERM, SIGKILL after 2 s) ------------------
if [ -f "$RUN_PGID_FILE" ]; then
  SCEN_SRC=$MODULES_SRC node --input-type=module -e '
const { stopGroup } = await import(process.env.SCEN_SRC + "/scenario-run.ts");
const fs = await import("node:fs");
const pgid = Number(fs.readFileSync(process.argv[1], "utf8").trim());
if (Number.isInteger(pgid) && pgid > 0) await stopGroup(pgid);
' "$RUN_PGID_FILE" >/dev/null 2>&1 || true
fi

# --- 4./5./6. score, seal, decide (math in node, the verdict lines in THIS script) ---
agg_params=$(
  printf '{"metaFile":%s,"resultsFile":%s,"pass":%s,"minSat":%s}' \
    "$(jesc "$META_FILE")" "$(jesc "$RESULTS_FILE")" "$pass_floor" "$min_sat"
)
agg_json=$(
  node --input-type=module -e '
const fs = await import("node:fs");
const p = JSON.parse(process.argv[1]);
const meta = fs.readFileSync(p.metaFile, "utf8").trim().split("\n").filter((l) => l !== "")
  .map((l) => { const [id, required, sealed] = l.split("\t"); return { id, required: required === "true", sealed: sealed === "true" }; });
const runs = fs.readFileSync(p.resultsFile, "utf8").trim().split("\n").filter((l) => l !== "")
  .map((l) => JSON.parse(l));
const best = new Map();
for (const r of runs) {
  const score = r.valid ? r.result.satisfied : 0; // an invalid verdict counts 0
  const note = r.valid ? r.result.missing : r.error;
  const prev = best.get(r.scenario);
  if (!prev || score > prev.score) best.set(r.scenario, { score, note });
}
const rows = meta.map((m) => {
  const b = best.get(m.id) ?? { score: 0, note: "no judge run recorded" };
  return { ...m, score: b.score, note: b.note, unsat: b.score < p.pass };
});
const unsat = rows.filter((r) => r.unsat);
const sealedRows = rows.filter((r) => r.sealed);
const mean = rows.length > 0 ? rows.reduce((a, r) => a + r.score, 0) / rows.length : 0;
// Green: every REQUIRED scenario (sealed included) >= pass AND mean over ALL judged >= minSat.
const green = rows.every((r) => !r.required || !r.unsat) && mean >= p.minSat;
process.stdout.write(JSON.stringify({
  green, mean, judged: rows.length, unsat,
  sealedJudged: sealedRows.length,
  sealedUnsat: sealedRows.filter((r) => r.unsat).length,
}));
' "$agg_params" 2>/dev/null
)
[ -n "$agg_json" ] || { say "scenarios red: stage could not aggregate the judge results"; exit 1; }

green=$(json_get green <<<"$agg_json")
mean_raw=$(json_get mean <<<"$agg_json")
judged=$(json_get judged <<<"$agg_json")
u_count=$(json_len unsat <<<"$agg_json")
s_judged=$(json_get sealedJudged <<<"$agg_json")
s_unsat=$(json_get sealedUnsat <<<"$agg_json")
mean_fmt=$(awk -v m="$mean_raw" 'BEGIN { printf "%.2f", m }')

u=0
while [ "$u" -lt "$u_count" ]; do
  # Sealed scenarios are counted only: never named, never described (overfitting check).
  if [ "$(json_get "unsat.$u.sealed" <<<"$agg_json")" = "false" ]; then
    u_id=$(json_get "unsat.$u.id" <<<"$agg_json")
    u_score=$(awk -v s="$(json_get "unsat.$u.score" <<<"$agg_json")" 'BEGIN { printf "%.2f", s }')
    u_tag=scored
    [ "$(json_get "unsat.$u.required" <<<"$agg_json")" = "true" ] && u_tag=required
    # The note is the sanctioned feedback: the judge's missing text, or — when both runs
    # yielded no valid verdict — the verdict error (structurally id-only; no evidence leaks).
    u_note=$(json_get "unsat.$u.note" <<<"$agg_json")
    say "scenario $u_id unsatisfied ($u_score, $u_tag): $u_note"
  fi
  u=$((u + 1))
done
[ "$s_judged" -gt 0 ] && say "scenarios sealed: $s_judged judged, $s_unsat unsatisfied"
if [ "$green" = "true" ]; then
  say "scenarios green: mean $mean_fmt ($judged judged, $u_count unsatisfied)"
  exit 0
fi
say "scenarios red: mean $mean_fmt ($judged judged, $u_count unsatisfied)"
exit 1
