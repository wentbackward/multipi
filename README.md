# multipi

The autonomous multi-agent development loop for the [pi](https://pi.dev) coding agent.
The main pi session orchestrates; one-shot role children (analyst, implementer, code-reviewer,
verifier) work in isolated git worktrees; a batch gate proves each train of approved
branches with one full check run; green trains are squash-merged in order.

GitHub issues are the tickets. Issue labels are the loop state. Deterministic scripts
plus a small pi extension are the hands; skills are the brain. The loop seeds itself:
with an empty board the analyst turns the spec into tickets, and the user's in-session
feedback becomes tickets the same turn it arrives.

Derived from [`wentbackward/claude-dev-loop`](https://github.com/wentbackward/claude-dev-loop)
(Claude Code). Design: `docs/superpowers/specs/2026-10-27-devloop-pi-design.md`.

## How it works

```
spec ──► devloop.dispatch analyst ──► ticket plan (ordered, falsifiable criteria)
           │                              │ orchestrator raises them
           ▼                              ▼
   GitHub issues (acceptance criteria, Depends on #n)
           │
           ▼
   devloop.dispatch ──► role child: pi -p --no-session --mode json
                        (own worktree, own ports, notes file, STATUS: report)
           │
           ▼
   devloop.dispatch code-reviewer ──► VERDICT: APPROVE / CHANGES REQUIRED
           │
           ▼
   devloop.gate [branches…]      one full check run per train (red ⇒ nothing merges)
           │
           ▼
   devloop.merge [branches…]     replay ⇒ tree==gated ⇒ ordered squash ⇒ close issues
           │
           ▼
   devloop.dispatch verifier     audit real outputs; anomalies become new tickets
           ▲
   user feedback in session ────┘ (steering: every request becomes a ticket, §skill 8)
```

The stop-gate hook (`agent_before_settle`) makes "keep going while work is startable" a
harness property, not a discipline: red fast check → continue (bounded), dirty tree →
continue (bounded), startable ticket + free slot → continue (unbounded).

## Tools (pi extension)

| Tool | What it does |
|---|---|
| `devloop.dispatch` | `{role, ticket}` (implementer) / `{role, ticket}` (reviewer) / `{role, task, worktree?}` (verifier) / `{role, spec}` or `{role, focus}` (analyst — spec decomposition or feedback-to-tickets; no ticket, no capacity slot, plan lands in the notes dir). Computes branch, worktree, ports, notes path and the full brief; enforces the concurrency cap; labels the ticket as it goes. |
| `devloop.cancel` | Kill one child by ticket. Worktree and branch are kept; re-dispatch resumes. |
| `devloop.gate` | `{branches}` — stack on latest base in the gate worktree, run every configured check once. green / red / conflict(branch) / error. |
| `devloop.merge` | `{branches}` — replay, verify tree == gated tree, squash each PR in order, delete branches. Refusals are informative, never silent. |
| `devloop.status` | In-flight children, open tickets with `dl/` labels, capacity, last green gate. |

## Hooks

- **Stop-gate** (`agent_before_settle`): the three-way "keep going" enforcement above.
- **Format-on-edit** (`tool_result`): after a successful write/edit, runs the configured
  formatter on that file (extension-filtered). Failures never block the agent.

## Layout

- `scripts/` — the deterministic core: `heavy.sh` (machine-wide slot queue with ports and
  a memory cap), `gate-train.sh`, `merge-train.sh`, `open-pr.sh`, `paths.sh`, `doctor.sh`,
  `install.sh`. Pinned exit-code contracts in each header and in the spec.
- `extension/` — the pi extension: pure-node domain modules (`config`, `state`, `brief`,
  `child`, `roles`, `stopgate`, `formatter`, `gate`, `merge`, `issues`) and a thin
  registration layer (`tools`, `index`). No build step (Node 24 type stripping).
- `agents/` — role prompts (analyst, implementer, code-reviewer, verifier).
- `skills/` — `devloop` (orchestrator workflow) and `devloop-setup` (project bootstrap).
- `templates/` — `.devloop.json`, AGENTS.md and DECISIONS.md skeletons.
- `tests/` — offline suites: `smoke.sh` (bash, local bare origin, `fake-gh`) and
  `tests/unit/*.test.ts` (node:test, `fake-pi`). No network, no real GitHub.

## Installing into a project

You manage multipi as a plain clone alongside your projects; it is **not** installed into pi
itself. Everything the loop needs is copied into the **target project**, where pi picks it up
automatically from the project layer:

```bash
git clone https://github.com/wentbackward/multipi ~/src/multipi
~/src/multipi/scripts/install.sh /path/to/target
```

What that does (idempotent — re-run after a `git pull` in multipi to update):

- `scripts/` → copied into the target and **versioned with the target** (the deterministic
  backbone: doctor, gate-train, merge-train, heavy queue).
- `extension/` → `.pi/extensions/multipi-devloop/` in the target — pi loads project extensions
  on session start, so the five `devloop.*` tools and both hooks are simply present.
- `agents/*.md` → `.pi/agents/` (role prompts, analyst/implementer/code-reviewer/verifier) **and** a copy
  bundled inside the extension (fallback when the project layer is absent).
- `skills/` → `.pi/skills/devloop` + `.pi/skills/devloop-setup` (visible via pi's skill picker).

So: yes — after running the script, open pi in the target folder and the extension, roles and
skills are already there (pi loads the project layer on session start; on first open it will ask
you to trust the project's extensions/skills — approve). Then, inside that pi session, run the **`devloop-setup`** skill (or do
it by hand): it writes the target's `.devloop.json` (start from `templates/devloop.json`) and
runs `scripts/doctor.sh` to verify the prerequisites.

Prerequisites on the target: git, node ≥ 24 (pi's native TS support), and — for non-multipi
targets — `typebox` and `@earendil-works/pi-coding-agent` resolvable from the repo root
(devDependencies; doctor checks this and prints the remedy).

This repo dogfoods itself: its committed `.pi/` directory **is** the result of
`scripts/install.sh .` — the loop that built this project ran from these exact files.

## Checks

```bash
make check    # tsc --noEmit + node unit tests + shellcheck (loud warning if absent) + smoke
```

Fully offline. A live end-to-end pass needs API access: open a pi session in a managed
repo and run `devloop.status`, then dispatch a trivial ticket.

## Field record (this repo runs its own loop)

- **#1** "doctor verifies the extension runtime" — dispatched implementer → independent reviewer
  found 2 real defects across 3 review rounds (each reproduced with fixtures) → implementer
  re-dispatched into the same worktree both times → batch gate → squash-merged (5b5aad8).
- **#3** "shellcheck 0.11.0 hygiene" — ran **in parallel** with #1 (slots=2, independent worktrees);
  root-caused a CWD-relative source-follow quirk of shellcheck 0.11.0 → reviewed → gated →
  squash-merged (ee09284).
- Defects the loop itself caught and fixed while running: gh output format drift, a state-file
  write race between concurrent dispatches, review findings never reaching the implementer
  (briefs now carry the latest ticket comment), gate worktree dependency staleness (`gate_setup`).
- Remaining: #5 (two parked doctor wording/test nit-picks).

## Project config (`.devloop.json`, committed)

`base_branch`, `remote`, `fast_check`, `format`/`format_extensions`, `checks[]`
(`{name, command, heavy, summary}` or plain command), `gate_worktree`,
`heavy.{slots, memory_max, port_env, port_base, port_step}`, `stop_gate.{require_clean_tree,
max_blocks}`, `merge.{method, delete_branch}`. Runtime state (notes, logs,
green-train record, dispatch state) lives under `~/.multipi/<repo>/` — derivable, never
authoritative over GitHub + git.

---

This project was built 100% autonomously by Qwen3.8-27B-FP8 and pi.
