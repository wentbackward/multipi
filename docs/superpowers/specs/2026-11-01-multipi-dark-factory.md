# multipi Dark Factory — spec (2026-11-01)

One installation, two operating modes: **dev-loop** (the human steers; the loop proposes) and
**dark factory** (the loop runs unattended for long stretches; the human supervises outcomes).
The core loop — tickets, worktree implementers, independent review, the batch gate, ordered
merges, worktree lifecycle, watchdog, pause — is **the same in both modes**. Dark mode adds one
gate stage and moves where the human looks. It does not fork the loop.

Reference: `wentbackward/claude-dev-loop` 0.7 (epic #2, parts a–e), adapted to multipi's
architecture (pi extensions, `spawnPi` children, `gate-train.sh` scripts, `~/.multipi` state).

---

## 0. Problem

The gate proves the **tests pass**, not that the **software does what users need**:

- The implementer works in the same worktree it is judged by: it sees every test it must
  satisfy. Code can satisfy the tests without satisfying the spec (*teaching to the test*),
  and nothing would notice.
- The code-reviewer judges the diff, not the behaviour of the running system.
- The verifier checks real outputs, but only after merged work.

An unattended factory multiplies exactly this failure: nobody is reading diffs. The fix is the
standard lights-out one — **holdout scenarios**: end-to-end user scenarios, kept **outside the
codebase**, **never shown to the coding agents**, judged against the **running system** at the
gate. Reviewing intent (scenarios) replaces reviewing diffs; that is what "dark" means here,
and nothing more.

## 1. Operating mode: the `factory` toggle

New config key in `.devloop.json` (committed):

```json
"factory": "collaborative" | "dark"        // default: collaborative (= dev-loop, unchanged)
```

| | `collaborative` (default) | `dark` |
|---|---|---|
| Core loop | identical | identical |
| `scenarios` | off unless configured | **on by default** (explicit `false` wins — see §9) |
| Where the human looks | PRs, spec wording, decisions | **scenarios** (new/changed, titles in the issue), gate outcomes, verifier reports, parked `dl/blocked` list |
| PR review | `code-reviewer` child; human may read any PR | `code-reviewer` child only; the orchestrator **does not ask the human about diffs** |
| Scenario writing | optional | `scenario-writer` child at ticket creation; a ticket is startable only when its scenarios exist (§4) |
| Cleanup | `cleanup-worktrees.sh` / branch cleanup needs operator consent (`--apply`) | runs automatically each loop cycle (closed + stale branches, clean worktrees only) |

**The preset only sets defaults; an explicit option always wins.** `"scenarios": false` keeps
the store off in a dark factory; a `scenarios` block turns the store on in a collaborative
loop. `factory` itself changes nothing directly — it is a readability device plus the three
defaults above.

**Identical in every mode (the fences):** the stop conditions (missing/rejected credentials,
spec contradictions that change stored data or behaviour users rely on, real money or orders,
production data, deleting git history, security settings), deploy timing and safety rules in
`AGENTS.md`, and the batch-gate contract (a red gate is never merged). *Dark means nobody
reviews the code, not that nobody is responsible.*

**Going dark** is a normal config change on a branch: flip the key, run the `scenario-writer`
for the open tickets (so the board becomes startable), and record the switch in `docs/DECISIONS.md`.
It merges through the ordinary pipeline; the first dark gate is the moment the scenario stage
activates.

## 2. Scenario store

### Config (new `scenarios` block; its mere presence turns the store ON)

```json
"scenarios": {
  "dir":  "~/.multipi/<repo>/scenarios",   // default; must lie outside every worktree and the repo
  "run":  "<command>",                     // starts the system against fakes (optional key)
  "run_seconds": 120,                      // wait for run's first line
  "judge": "<command template>",           // one judge run per scenario (default: headless pi, §5)
  "judge_seconds": 600,                    // per-judge cap
  "pass": 0.8,                             // floor per required scenario
  "min_satisfaction": 0.9,                 // floor of the mean over all judged scenarios
  "sealed": 0.2                            // share of scenarios only counted, never named
}
```

- **Location** resolves like every multipi path (`~`-expand; relative resolves against the
  repo's PARENT — a worktree can never live inside the store, and vice versa). Default
  `~/.multipi/<repo>/scenarios` is a sibling of the (new, consolidated) `worktrees/` dir, so
  ordinary worktree searches never reach it.
- **Doctor** prints `factory <mode>, scenarios on|off (preset|explicit|default)`, the store
  path, the scenario count and required count, and each invalid file as
  `MISSING scenario <file>: <reason>`. A dark factory whose store holds **no valid required
  scenario** is `MISSING factory dark: ...` — and its gates are red until the store is seeded.
  A missing store (key just turned on) is a note, not MISSING.

### File format — one Markdown file per scenario (`*.md`, any depth, nothing under `.git`)

```markdown
---
id: t12-close-position-clears-alert      # required; unique in the store; convention t<ticket>-<slug>
title: Closing a position clears its price alert
spec: [positions, alerts]                # the spec sections this scenario covers
tags: [smoke, alerts]
required: true                           # true: must pass; false: scored
---
## User and goal
## Preconditions and fixtures
## Steps
## Satisfied when                        # in the USER's terms, observable behaviour
```

Validation (pure, unit-tested): `id` + `title` present, `id` unique, `required` is
`true|false` (missing → **invalid**, not default-false: a forgotten line must not silently
demote a scenario), lists as `[a, b]`, non-empty body. Invalid files make the stage red
(`scenarios red: <n> invalid scenario file(s)` — without naming them; doctor names them).

**Scenarios are written from the spec, never from the code** — that rule is in the writer's
brief and the format comment.

## 3. Isolation: the role guard

The store must stay invisible to the agents whose work is judged by it.

- **Mechanism (pi-native):** multipi children currently load *no* extension
  (`MULTIPI_CHILD=1` → register nothing — tools and hooks are orchestrator-only, that
  isolation stays). Refinement: a child of a **guarded role** loads a **guard-only** mode —
  it registers exactly one `tool_call` hook (pi's block-capable pre-tool event) and nothing
  else. No tools, no stop-gate, no UI: a guarded child still cannot drive the loop.
- **New documented env seam** `MULTIPI_CHILD_ROLE=<role>` (set by `spawnPi` next to
  `MULTIPI_CHILD=1`). Guarded roles: `implementer`, `code-reviewer`, `verifier`. **Not**
  guarded: `analyst`, `scenario-writer`, `scenario-judge` (writer and judge must reach the
  store; analyst reads spec only but touches no store paths — left unguarded, simplest and it
  can never be judged by the store). The verifier IS guarded: it runs at the repo root
  post-merge and its reports reach the implementer, so an unguarded verifier could read the
  store and launder it through its report.
- **How the guard learns the store path:** the guard-only extension reads `.devloop.json`
  from the child's working directory (the committed repo config) at extension load; **no env
  seam carries the path** — env is child-readable, and the path was never secret (it sits in
  the committed config): what the hook denies is *access*, not *knowledge*. If the config
  cannot be parsed or the store path cannot be resolved, the guard fails closed — every
  guarded call gets the generic refusal — so a broken config bricks the loop loudly rather
  than running a guarded child loose.
- **Active when** the store is on (`scenarios` block, or `factory: dark` without
  `"scenarios": false`). With the store off the guard registers nothing, ever.
- **Matching (best effort, like the reference — it reads the command line, not what runs):**
  refuse any `read`/`grep`/`find`/`ls`/`edit`/`write`/`bash` call by a guarded role whose
  arguments name a path **inside the store**: absolute, `~/`- or `$HOME`-prefixed, relative
  to the working directory (including after a `cd` in the same command), a symlink into the
  store, or a shell glob whose expansion intersects it. Blocked calls return a short refusal
  naming the guard (the child sees *that* it is blocked, never *why* in detail).
- **Layered with the rest:** the orchestrator never puts the store path or scenario text in
  a guarded role's prompt, and the briefs never name the store (smoke-asserted) — the hook is
  the backstop, the brief is the first wall.
- **Honest limits** (documented, matching the reference): a script the agent writes that
  opens the store, a path assembled at run time, or a recursive search of an ancestor
  directory is not caught. The default location (outside every worktree and the repo) is the
  cheap first defence; **strong isolation** = run coding children as an OS user that cannot
  read the store (documented escalation, not v1).

## 4. Scenario writer (new role)

`agents/scenario-writer.md`, dispatched by the orchestrator **at ticket creation, before
implementation can start**:

- **Input:** the ticket (title + acceptance criteria) and the spec sections it cites. It
  reads **never the code** (no worktree; runs at repo root with the store + spec readable).
- **Output:** scenario files in the store (writes *only* inside the store; it stops if the
  store lies inside the repository). Convention `id: t<ticket>-<slug>`; one scenario per
  falsifiable behaviour the ticket promises; `required: true` for the ticket's core behaviour.
- **The issue** gets the new/changed scenarios **as titles only** (`id`, title, `required`,
  *new*/*changed*) — never their text. *This list is what the human reviews in dark mode.*
- **Report contract:** `STATUS: DONE` + the scenario list (as the dispatch tool already
  handles reports). A store-inside-repo condition is `STATUS: BLOCKED`.

**Startability rule (new, gate-enforced):** with the store on, a ticket is *startable* only
if the store holds at least one valid scenario whose id starts with `t<ticket>-`. The
stop-gate's "startable + free slot → continue" clause reads this; the dispatch tool refuses
with the reason. In a dark factory this is what makes the self-seed → write scenarios →
implement pipeline safe to leave alone.

## 5. Scenario judge + the gate stage

The stage is a **script** (`scripts/scenario-stage.sh`), run by `gate-train.sh` after the
checks pass on the train's top (multipi gates sequentially; a failed check prints
`scenarios skipped`). **The script decides green/red, not any agent** — pinned, like every
other multipi gate contract.

1. **Run the system.** `scenarios.run` (if set) starts in its **own process group** (the
   watchdog's `detached`+group machinery, reused). Its **first printed line** is how to reach
   the system (URL/command) → passed to judges as `MULTIPI_SCENARIO_TARGET`. It may keep
   running (foreground server) or exit; the stage stops the group at the end (SIGTERM →
   SIGKILL after 2 s). Exiting before printing, or silence past `run_seconds`, is red.
2. **Judge each scenario**, once per scenario, as a one-shot headless child (default
   `judge` = `pi -p` with the `scenario-judge` role — the stage script itself execs the `pi`
   binary in a detached process group, mirroring the spawnPi/watchdog spawn contract: own
   group, bounded wait, TERM→KILL; a bash script cannot import the TS `spawnPi`. The judge is
   NOT a guarded role, so it may read its own scenario file). Env contract (documented
   seams): `MULTIPI_SCENARIO_FILE`, `MULTIPI_SCENARIO_ID`, `MULTIPI_SCENARIO_TARGET`. The
   judge drives the system (HTTP/CLI/browser) and ends with a **verdict** — its last line
   starting with `{`: `{"id", "satisfied": 0..1, "required", "evidence", "missing"}`.
   Anything else (no valid JSON, wrong id, out-of-range score, non-zero exit, cap overrun)
   **counts as 0** with `error` recorded — an unreliable judge never green-lights.
3. **Rejudge once:** a scenario below `pass` is judged again; the **better run counts**, so
   LLM-judge flakiness fails only when both runs fail.
4. **Green:** every non-sealed-required and sealed-required scenario `>= pass` AND the mean
   of all judged scenarios `>= min_satisfaction`. **Red** prints one line per unsatisfied
   NON-sealed scenario — `scenario <id> unsatisfied (<score>, required|scored): <missing>`
   — then `scenarios red: mean <m> (<n> judged, <k> unsatisfied)` and `TRAIN RED`.
5. **Sealed:** a scenario is sealed when `int(first 10 hex chars of sha256(id), 16) mod 1000
   < sealed * 1000` — the digest is pinned so the seal cannot drift across platforms or
   versions; the choice depends only on the id (stable, no state, no agent discretion). Sealed scenarios are
   judged and **counted only**: never named, never described, `scenarios sealed: <n> judged,
   <k> unsatisfied`. This is the overfitting check on the feedback loop itself.
6. **Feedback without leakage:** what travels back to the implementer is the `missing` text
   — the behaviour that was absent, in user terms ("closing a position leaves its alert
   active") — **never the scenario text, never the store path, never the judge's evidence**.
   The stage prints no scenario text at all.

### Log hygiene (pinned)

Stage logs in the logs dir: `train-scenarios.log` (the stage's own lines — safe to forward),
`train-scenario-results.jsonl` (one line per judge run: scenario, run, sealed, valid,
result/error), `train-scenario-judge/<id>-<run>/` (each judge's raw output),
`train-scenarios-run.log` (the system's output). The latter three hold judge evidence and
sealed ids/results: **never shown to an implementer, reviewer or verifier** — the skill
forbids it and the gate's red output contains only `missing` lines.

## 6. What dark automates (and deliberately does not)

**Automated in dark:** scenario writing at ticket creation (with the issue title-list for the
human), the scenario gate stage, worktree/branch cleanup each cycle (closed = merged-and-closed
or not-planned, closed-with-`--include` equivalent; stale = no live PR, no open issue, idle
`cleanup.stale_days`, default 14; clean worktrees only — the dirty-keep rule is unchanged),
re-dispatch of crashed/watched children (already loop behaviour), and re-gating after fixes
(already loop behaviour).

**Never automated (both modes):** the stop conditions, deploy timing, `dl/blocked` scope
decisions (they park; the human looks at the parked list — in a well-seeded dark factory this
list stays short because ambiguity is resolved at creation time by analyst + scenarios),
anything in `AGENTS.md` safety rules, and spending beyond what the checks spend.

## 7. Config, seams and contracts

New `.devloop.json` keys: `factory` (§1), `scenarios` block (§2), `cleanup.stale_days`
(default 14). New documented env seams: `MULTIPI_CHILD_ROLE` (§3),
`MULTIPI_SCENARIO_FILE|ID|TARGET` (§5). Gate exit codes: the scenario stage participates in
the existing gate verdict — `scenarios red`/`scenarios skipped` are TRAIN-RED/skipped lines
within the current contract (no new exit codes). Role files: `agents/scenario-writer.md`,
`agents/scenario-judge.md`. New script: `scripts/scenario-stage.sh`. New state: the store dir
(it is data the human owns — excluded from `clean_temp`).

`doctor.sh`: the lines of §2. `templates/devloop.json`: **no** `scenarios` key and **no**
`factory` key (presence/absence semantics; a fresh setup is collaborative, scenarios off).

## 8. Out of scope for v1 (follow-ups)

- `affected`-based scenario filtering (run only scenarios whose `spec`/`tags` intersect the
  train's changed paths + all required) — cost lever for large stores; multipi has no
  changed-files listing yet.
- Per-session budget/cost caps as a stop condition (childreg already measures cost; the cap
  is a few lines once wanted).
- Identity-mode equivalent (per-role GitHub identities; the store in its own private repo).
- Parallel gate stages and `fail_fast` (claude-dev-loop 0.6 features).
- Sealed-share tuning and scenario promotion (scored → required) tooling.

## 9. Semantics summary (the one-paragraph contract)

`"factory"` is a preset: dark ⇒ scenarios on unless explicitly off, scenario-writing at
ticket creation with startability conditioned on it, and automatic cleanup. `"scenarios"`
alone ⇒ the store and the gate stage in ANY mode, guard included. The guard is a block-capable
`tool_call` hook loaded ONLY by implementer, code-reviewer, and verifier children, ONLY when
the store is on, refusing anything that names a path inside the store. The gate's scenario stage runs
the system (`run`, first line = target, own process group), judges every scenario with a
one-shot headless judge (verdict JSON, rejudge once, better run counts, invalid ⇒ 0), decides
in the script (all required ≥ `pass`, mean ≥ `min_satisfaction`), seals a deterministic share
(counted, never named), and feeds the implementer only `missing` text. The human in a dark
factory reads the scenario title lists in issues, gate outcomes, verifier reports, and the
parked list — and nothing else is expected of them between visits. The stop conditions, the
safety rules, and "a red gate is never merged" are identical in both modes.
