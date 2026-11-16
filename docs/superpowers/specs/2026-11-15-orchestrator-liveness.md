# Spec — Orchestrator liveness, interrupt, and bounded tool calls (2026-11-15)

**Trigger (reported, verbatim):** *"Clearly there's an issue with the devloop.gate. … 1. I
need some way to see if anything is running or if you're just wedged and 2. some way to
interrupt you with a message to unwedge the process. On top of that, would some kind of wake
up interrupt help even if it's every 10 minutes or so — at least you won't be forever
wedged."*

Observed incident (evidence in the #55 gate logs): a `devloop.gate` tool call spawned its
child (train logs written 18:46), then the tool promise never resolved in the orchestrator
("No result provided"); the session sat silent for ~6h with no observable liveness state and
no operator path in. A wedged tool call must be (a) visible, (b) interruptible by the
operator with a plain message, and (c) unable to exceed a bound.

## Non-goals

- Nothing about child-process liveness (children are already tracked; `devloop.status` shows
  in-flight; `devloop.cancel` kills one). This spec covers the **orchestrator session** only.
- No daemons outside the loop's own one-shot scripts (below).
- No changes to the label pipeline, gate/merge semantics, or the guard.

## 1. Liveness sidecar (part A)

Pure-node module `extension/src/liveness.ts` (dependency rule: **no pi imports**) exporting
`loadState/writeState/renderStatus` against a JSON sidecar at
`~/.multipi/<repo>/orchestrator-state.json` (path = loop notes dir, per `config.ts`
convention). Shape:

```json
{ "schema": 1, "sessionId": "...", "pid": 123, "state": "active|idle|ended",
  "tool": { "name": "devloop.gate", "startedAt": 176..., "seq": 7 } | null,
  "lastEventAt": 176..., "lastTickAt": 176..., "lastWakeSeq": 0 }
```

`index.ts` (the only place with pi types) maintains it from extension events:

- `tool_execution_start` → set `tool {name, startedAt, ++seq}`; `tool_execution_end` →
  clear `tool`. (Events carry `toolCallId/toolName/args`; see pi extensions docs §tool
  lifecycle.)
- High-frequency events (`message_update` et al.) tick `lastEventAt`, **throttled to ≤1
  write/s**; every write is atomic (tmp + rename).
- A `setInterval` (15 s) started in `session_start` ticks `lastTickAt` — proof the event
  loop itself is alive even with zero LLM traffic; cleared in `session_shutdown` (which
  also writes `state:"ended"`).
- pid is `process.pid` (the extension runs in-process with pi) — this is what lets the
  interrupt path find the TTY.

### 1a. `scripts/multipi-status.sh` — the operator's one-liner

Renders one line (state, in-flight tool + elapsed, heartbeat age, pid, tty) and exits per a
**pinned contract**:

| rc | meaning |
|----|---------|
| 0 | live: heartbeat ≤ `MULTIPI_STATUS_STALE_MS` (default 120000) |
| 1 | alive but idle (no in-flight tool) |
| 2 | **STALE / suspected WEDGE** (heartbeat older, state not `ended`) |
| 3 | dead (`state=ended` or no sidecar and no matching pi process) |
| 4 | bad usage / unreadable sidecar |

`MULTIPI_STATUS_STALE_MS` is a documented test seam (integer ms). Offline: the script only
reads the sidecar (and `ps` for the pid).

**Addendum (2026-11-15 21:20) — OOM root cause surfaced on the line:** the repeated
"No result provided" deaths are confirmed OOM-kills (three `tmux-spawn-*.scope … result
'oom-kill'` journal events matching every transport death; the box's swapfile sits ~100 %
full permanently). Accordingly:

- The rendered line ALSO shows **available RAM and swap-free**, read from `/proc/meminfo`
  (`MemAvailable`, `SwapFree`, human-readable) via the documented seam
  `MULTIPI_STATUS_MEMINFO=/path` (default `/proc/meminfo`) — a wedged or dying session is
  usually a memory story, and the operator must see the headroom without a second tool.
- rc 3's dead text (a session whose pid is gone) mentions checking
  `journalctl --since <start> | grep oom-kill` as the likely cause of a vanished session.
- One extra smoke assertion: the line contains the meminfo figures read from a FABRICATED
  `/proc/meminfo` driven through `MULTIPI_STATUS_MEMINFO`.

## 2. Bounded tool calls — the unwedge (part B)

`tools.ts` wraps **every** `devloop.*` implementation in `withTimeout(name, impl, ms)`
(extracted as a pure helper in `liveness.ts` so it is unit-testable without pi):

- `ms` from new `.devloop.json` key `"orchestrator": { "tool_timeout_minutes": 45 }`
  (absent ⇒ 45; gate trains run 5–15 min, implementers can run long). `MULTIPI_TOOL_TIMEOUT_MS`
  env seam overrides (integer ms; `0` = disabled) — documented, tests use it.
- On expiry the tool **resolves with an error result** (never rejects, never hangs):
  `devloop.<tool> timed out after <N>m — external state (branch, worktree, child) is
  UNTOUCHED; check scripts/multipi-status.sh and devloop.status, then retry or
  devloop.cancel <ticket>.` The underlying promise is abandoned (its child, if any,
  continues — exactly what the timeout text tells the operator to reconcile).
- The sidecar's `tool` field plus this bound means a wedged tool call can at worst be
  invisible for `tool_timeout_minutes` — never hours.

## 3. Operator interrupt — force-send a message (part C)

`scripts/multipi-interrupt.sh [--dry-run] "message"` — pinned contract:

| rc | meaning |
|----|---------|
| 0 | message injected (or dry-run verified it would be) |
| 5 | no sidecar / state not `active` or `idle` |
| 6 | no usable TTY (prints the exact kill-and-resume fallback commands) |
| 4 | bad usage |

Mechanism: sidecar → `pid` → `readlink /proc/<pid>/fd/0` → must resolve to `/dev/tty` or
`/dev/pts/*` → write `<message>\n` to it (pi's TUI queues in-terminal input; an appended
newline submits). Appends every injection to `~/.multipi/<repo>/interrupts.log` (timestamp,
pid, message, dry-run flag). `MULTIPI_INTERRUPT_TTY=/dev/pts/X` seam overrides the resolved
path (smoke tests capture it with `script -qec`). Honest limit, documented: this is a TTY
paste, not an RPC — if the session's terminal is detached/dead, rc 6 + printed fallback
(kill pid, fresh session, devloop skill step 0 recovers from git + labels).

## 4. Watchdog wake (part D — the "every 10 minutes" net)

`scripts/multipi-watch.sh [--daemon] [--interval SECS]`:

- **One-shot check** (the testable core, pure function of inputs): read sidecar;
  - tool in flight longer than `MULTIPI_WATCH_TOOL_MS` (default 720000 = 12 min, i.e.
    BEFORE the 45-min tool timeout) → inject wake: `WAKE (multipi-watch): <tool> has been
    in flight <N>min. If it is wedged, say so and abort/retry; otherwise continue.`
  - heartbeat older than `MULTIPI_STATUS_STALE_MS` × 5 (10 min) → inject stronger:
    `WEDGE SUSPECTED (multipi-watch): no orchestrator heartbeat for <N>min. Check
    scripts/multipi-status.sh; if dead, kill <pid> and resume in a fresh session (step 0).`
  - **dedupe:** at most one wake per `tool.seq` and per 3600 s wall (state in
    `lastWakeSeq` + watch log).
- Clocks/thresholds overridable: `MULTIPI_WATCH_NOW_MS` (integer epoch-ms, same pattern as
  `MULTIPI_APPROVE_NOW_MS`), `MULTIPI_WATCH_TOOL_MS`, `MULTIPI_STATUS_STALE_MS`,
  `MULTIPI_INTERRUPT_TTY` — all documented seams.
- **`--daemon`**: `setsid nohup` self-loop (sleep `--interval`, default 60 s), pidfile +
  pid-liveness lockfile (single instance), log to `~/.multipi/<repo>/watch.log`.
- **Auto-start:** the `session_start` hook spawns
  `bash scripts/multipi-watch.sh --daemon` detached (stdio ignored) — **TUI sessions only**:
  the watchdog's wake path is a write to the session's TTY (`/dev/tty`), and a headless
  session has no TTY to wake into (part B's 45-min tool bound still covers it, and
  `--daemon` can be started by hand where needed); the lockfile makes the spawn idempotent
  across sessions/restarts. `session_shutdown` leaves it running (it serves the *next*
  session too and self-idles when no sidecar is active).

## 5. Docs and tests

- DECISIONS.md: the TTY-paste interrupt choice (vs RPC — impossible for an in-flight TUI
  session; pi's RPC mode cannot attach to a running TUI session), the sidecar-as-state
  choice, the 45-min default.
- AGENTS.md: short "Operator console" paragraph — `multipi-status.sh` (and its rc table),
  `multipi-interrupt.sh`, watchdog auto-start, the honest limits.
- devloop skill §8: one line naming the two operator scripts.
- **Unit (offline, fake-gh/fake-pi world):** `liveness.ts` (write/read atomicity, render
  decisions, `withTimeout` resolves-with-error on a 5 ms drive via the seam); status rc
  matrix via smoke against fabricated sidecars.
- **Smoke:** (a) status rc 0/1/2/3/4 matrix (including the fabricated-`/proc/meminfo`
  figures on the line and the oom-kill hint on rc 3's dead text); (b) interrupt dry-run + real injection into a
  `script -qec`-captured pty asserting the exact line landed; (c) watch one-shot: fabricated
  sidecars + `MULTIPI_WATCH_NOW_MS` → correct wake chosen / dedupe honoured / rc 0 no-op
  when healthy; (d) `--daemon` single-instance (second launch exits 0 without doubling).
- `make check` green offline; shellcheck-clean; `tsc --noEmit` clean.

## 6. Rollout

Implemented on one branch, one ticket (cohesive scope, shared hot files). After it lands,
the parked **#55** resumes: solo gate → merge.
