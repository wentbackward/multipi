# multipi — learnings (institutional memory)

The operational lessons of the development rounds that are **not obvious from the code**,
distilled. Each entry: **symptom** (what was observed) → **root cause** (why it happened) →
**now prevents** (the mechanism that makes it impossible or visible) → **pinned at** (where
the prevention is asserted, so it cannot silently regress). Companion to `docs/SPEC.md`
(what the system IS) — this file is why the system is shaped that way. Newest lessons keep
land here; `docs/DECISIONS.md` carries the full decision record.

## 1. The wedge: an orchestrator silent for ~6 hours

- **Symptom:** the loop went silent mid-tool — no heartbeat, no report — for ~6 hours while a
  single `devloop_*` tool call sat in flight. To the operator the session looked dead but was
  not; nothing would say which. (Liveness spec trigger, reported verbatim there.)
- **Root cause:** a tool call with no timeout blocks the session's turn indefinitely (a stuck
  handshake or a child holding the stream), and no process monitored liveness. The event loop
  may never poll again — so an in-band fix (RPC/socket nudge) is exactly the wrong shape for
  the failure it must address.
- **Now prevents:** (1) every `devloop_*` call is bounded (`orchestrator.tool_timeout_minutes`,
  default 45) and on expiry RESOLVES with reconciliation text — it never hangs; (2) the
  liveness sidecar heartbeat; (3) `multipi-status.sh` (rc 2 = STALE/wedge); (4) the watchdog
  wakes a tool in flight > 12 min (WAKE) or a heartbeat silent > 10 min (WEDGE, outranks WAKE);
  (5) `multipi-interrupt.sh` force-sends a message by PASTING into the session TTY — a wedged
  event loop needs no cooperation to be reached (honest limit: a detached terminal is
  unreachable, rc 6 prints the kill-and-resume fallback).
- **Pinned at:** spec `2026-11-15-orchestrator-liveness.md`; `tests/smoke.sh` (watch/wake/wedge
  matrix, `wait_for`-bounded); `liveness.test.ts`; AGENTS.md "Operator console".

## 2. The OOM deaths: "No result provided"

- **Symptom:** sessions/children vanished mid-tool with "No result provided"; the loop logs
  were silent — the process was simply gone.
- **Root cause:** the OS OOM killer reaped the process (heavy jobs running concurrently
  against available RAM). Nothing in the loop knew to suspect the OS.
- **Now prevents:** (1) heavy work queues through `heavy.sh` — machine-wide slot locks
  (flock/mkdir) cap concurrent heavy jobs, with optional per-user memory caps
  (`heavy.memory_max`); (2) `multipi-status.sh` rc 3 says "very likely OOM-killed" and points
  at `journalctl --since <start> | grep oom-kill` — the diagnostic one-liner; (3) dead-pid
  reconciliation turns the vanished child into a `crashed` entry, freeing its slot for
  re-dispatch instead of a phantom "already running".
- **Pinned at:** `scripts/multipi-status.sh` (rc 3 line); `tests/smoke.sh` (heavy-slot matrix
  incl. the dead-holder lock sweep); AGENTS.md "Heavy-slot locks".

## 3. Shim mutual-exec: the dogfood-armed double-wrap

- **Symptom:** in a session armed with the policy shims (shims on PATH), a shim could
  "find the real `git`" and find the OTHER SHIM — shim→shim mutual exec under a
  double-wrapped test fixture.
- **Root cause:** `command -v git` inside the shim's own PATH resolves to the shim dir
  (PATH shadowing); "outside the shim dir" was not enough — a shim IS outside the dir that
  contains the other shim. An interpreted script as the "real" binary was accepted.
- **Now prevents:** `shim_find_real` requires a COMPILED artifact (2-byte magic, no `#!`) in
  addition to being outside the shim dir; every shim→binary exec goes through
  `_shim_exec_real`, which counts depth in the internal `_POLICYSHIM_DEPTH` and hard-refuses
  above 3 (exit 126). Test fixtures that plant fake binaries must resolve real binaries
  through the SAME helper, never bare `command -v` (smoke's `git-bdshim`).
- **Pinned at:** `tests/unit/policyshim.test.ts` (depth refusal, script refusal);
  `tests/smoke.sh` (the double-wrap fixture); AGENTS.md "Shim real-binary resolution (#68)".

## 4. Resume bias: the loop (and the child) trusting its own last word

- **Symptom:** after a lost report or crash, the loop believed the child was still running —
  a dead pid sat in the state file, the slot stayed occupied, and re-dispatch was refused with
  a stale "already running". The mirror image: a re-dispatched child resuming from its OWN
  earlier terminal report (its notes said `STATUS: DONE`) and treating the finished work as
  still-finished, or re-applying invalidated partial work. Observed live in several rounds
  (the #121 incident class).
- **Root cause:** state-file entries and report files are SNAPSHOTS; the process and the
  worktree's git state are the truth. Anyone who reads the snapshot as current — the loop,
  or a resuming child — acts on stale belief instead of evidence.
- **Now prevents:** (1) `reconcileState`/`pruneDead` reclassifies dead `running` entries to
  `crashed` (WITH `endedAt`) on EVERY read — dispatch, status, stop-gate — so a vanished
  child frees its ticket and slot; (2) the generation guard (`startedAt` equality in
  `finishEntry`) keeps a stale terminal write from stomping a newer re-dispatch's entry;
  (3) entries are replaced, not merged, on fresh dispatch (a previous generation's terminal
  fields never leak into the new one); (4) the implementer brief's resume section MANDATES
  inspecting the worktree (`git status`/`git log`) before acting — the git state outranks
  the old report; (5) reports are post-mortems (exactly-once late-report ledger), never
  instructions to a future child.
- **Pinned at:** `tests/unit/state.test.ts` (reap-then-redispatch race, generation guard);
  `tests/unit/brief.test.ts` (the resume directive); `tests/smoke.sh` (cancel/re-dispatch
  reuses the worktree, dead-pid pruning).

## 5. The should-fix cascade — and its terminus

- **Symptom:** CHANGES REQUIRED loops without a bottom: an APPROVE carrying should-fixes
  triggers a re-dispatch, whose review carries more should-fixes, … — polish rounds that
  re-open approval indefinitely (each round cheaper than the last, and the ticket never
  reaches the gate).
- **Root cause:** a must-fix loop has a natural terminus (APPROVE-clean), but should-fixes
  have no intrinsic bottom — every review finds something. Without a budget, "nice to have"
  becomes "never ships".
- **Now prevents:** the polish budget: should-fix re-dispatches are ONE ROUND each, marked
  (`should-fix follow-up` first line of the dispatch comment — the ticket's history IS the
  depth state, must-fix rounds carry no marker and never count); `scripts/polish-tail.sh`
  counts the marked rounds against `review.max_followup_depth` (default 2) and makes the
  deterministic call — below the cap (rc 10) re-dispatch; at/over the cap (rc 0) ACCEPT THE
  TAIL: findings park verbatim in the single per-area `Polish backlog — <area>` ticket and
  the ticket proceeds as `dl/approved`. Must-fix findings are never subject to the budget.
  The TERMINUS: the per-area backlog ticket, where polish converges instead of cascading.
- **Pinned at:** `tests/unit/polish.test.ts` (marker boundaries, counting);
  `tests/smoke.sh` (accept-tail flow); skill §4; `docs/DECISIONS.md` (ticket #105).

## 6. Tool-name portability: the Kimi 400

- **Symptom:** switching the session to Kimi (Moonshot) — an OpenAI-completions-shaped API —
  made the WHOLE request fail with a 400: the dotted control-plane tool names
  (`devloop.dispatch`, …) violate the OpenAI function-name grammar
  (`^[A-Za-z][A-Za-z0-9_-]*$`). One provider, one dot, the entire loop dead.
- **Root cause:** provider function-name grammars validate the ENTIRE tools array, not just
  the called tool; a name outside the grammar rejects the whole request. The original dotted
  names were tuned to one provider's lenience.
- **Now prevents:** the names are underscored and held in ONE place (`TOOL_NAMES` in
  `extension/src/toolnames.ts`, shared by registration, the bounded-run labels, the grammar
  probe and the pins); the unit pin asserts every registered name matches the strictest
  common grammar; doctor PROBEs the grammar offline for any provider (`MULTIPI_PROVIDER` /
  `MULTIPI_PROBE_TOOL_NAMES` what-if a rename without shipping it); the orchestrator's
  `session_start` warns (non-blocking) when the active provider is a known grammar-strict
  one (the openai-named family + pinned `kimi`/`moonshot`).
- **Pinned at:** `tests/unit/toolnames.test.ts`; `scripts/doctor.sh` (the grammar-probe line
  counts into the ready tally); AGENTS.md (doctor section).

## 7. The flake class: load-dependent sampling — and the `wait_for` idiom

- **Symptom:** smoke pins that passed 299/300 and failed 1/300 in isolation: fixed
  `sleep 2.5` then ASSERT AT ONE INSTANT; a slower spawn or first tick under load pushed the
  event past (or before) the sample instant and the pin flipped in both directions. Recurred
  across several daemons (watchdog tick, sweep grace, the slot-sweeper classifier's
  whole-second mtime truncation racing a mkdir across a second boundary).
- **Root cause:** sampling PRESENCE at a fixed instant is itself load-dependent. The test
  encoded timing assumptions the production code never made.
- **Now prevents:** the bounded-poll idiom in the smoke: `wait_for BOUND_MS CMD...` — check
  once, then re-check every 0.1 s until the bound; always tried at least once even for
  sub-100 ms bounds (a poll that never tries turns typos into phantom passes). Assert the
  LOAD-INVARIANT fact ("the condition holds within a finite bound") — e.g. an ABSENCE-poll
  ("the dir disappears within 5 s once the grace lapses") replaces one-instant presence
  sampling where the instant itself is the flake. Where the flake was in the classifier's
  contract reading (whole-second mtimes), the pin was phase-gated instead of the production
  mtime contract changed — the test artifact bends, not the classifier.
- **Pinned at:** `tests/smoke.sh` (`wait_for` in every tick/grace pin); `docs/DECISIONS.md`
  (2026-11-18 #82/#84, 2026-11-21 #133 phase-gated slot pin).

## 8. Delete-then-push: the PR closed without merging

- **Symptom:** observed on #55: a ticket's issue was closeable only after a REOPEN dance —
  the PR had been CLOSED while its branch was deleted in the delete-then-push rebase path,
  and the `Closes #n` body never fired because a close keyword only fires on MERGE.
- **Root cause:** deleting a branch closes the PR attached to it — but ONLY while the PR is
  still OPEN and UNMERGED (an already-merged PR is unaffected by branch deletion). The
  rebase path deletes and re-pushes the branch, which closed the open PR; the loop's docs
  originally implied post-merge deletion could close a merged PR (the over-broad wording,
  corrected with the #110 living-spec sweep). Closing via the PR body was an illusion:
  closing is MANUAL (`gh issue close` after the merge is confirmed).
- **Now prevents:** the loop's close mechanism is pinned in SPEC.md §5 / design spec §4 step 6
  with the NARROWED wording ("deleting a branch with an open, unmerged PR closes that PR");
  `merge.delete_branch` stays true (correct after a MERGED squash — the merged PR is
  unaffected), and the rebase path is documented as the trap.
- **Pinned at:** `tests/unit/design-spec-docs.test.ts` (item 5: the narrowed wording, the
  absence of the post-merge-deletion claim, the #55 attribution); `docs/SPEC.md` §5.

## 9. Isolation: the child that drove the loop (child-isolation seam)

- **Symptom:** an analyst child, delivered at minute 7, kept running 30+ minutes: it had
  loaded the project extension and sat in the stop-gate's "startable ticket + free slot"
  continue loop; and the same tools would have let ANY child dispatch grandchildren.
- **Root cause:** children inherit the project's `.pi/` tree; nothing told the extension
  "you are a child, not the orchestrator".
- **Now prevents:** `spawnPi` stamps `MULTIPI_CHILD=1`; the extension registers NOTHING (no
  tools, no hooks) for such a process. `MULTIPI_CHILD_ROLE` (guarded roles only, deleted
  before the stamp otherwise) selects the guard-ONLY mode. The guard itself fails CLOSED
  (missing/unparseable config → store access refused).
- **Pinned at:** `tests/unit/guard.test.ts`; `tests/smoke.sh` (a child loads no tools);
  AGENTS.md "Dark factory" and `docs/SPEC.md` §4.

## 10. State lies compound: classify on the role's contract, not on belief

- **Symptom:** three live instances of the same class: successful reviews recorded
  `crashed` (classified on the implementer's `STATUS` contract); a DONE analyst plan recorded
  `blocked` (WHOLE-TEXT scan caught the plan QUOTING `STATUS: BLOCKED` as documentation);
  and a marker-less "done" child that would have opened a PR (absence of BLOCKED defaulted to
  done).
- **Root cause:** classification rules were per-role ad hoc and text-position-agnostic; the
  state file — which every consumer trusts — was being lied to, and 70 entries needed
  reclassification once found.
- **Now prevents:** ONE uniform rule for every role: the report's LAST non-empty line,
  checked against THAT role's contract (implementer/scenario-writer/analyst/verifier:
  `STATUS: DONE|BLOCKED`; code-reviewer: `VERDICT: APPROVE|CHANGES [REQUIRED]`);
  `classifyReport` is the single choke point (finish, PR path, registry all route through
  it); a report with no terminal marker is `crashed`, and a crashed child opens no PR.
- **Pinned at:** `tests/unit/tools.test.ts` (mid-body quotes never decide; per-role
  contracts; marker-less ⇒ crashed ⇒ no PR); `docs/DECISIONS.md` (2026-11-01/2026-11-06).
