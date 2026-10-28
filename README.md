# multipi

The autonomous multi-agent development loop for the [pi](https://pi.dev) coding agent.
The main pi session orchestrates; one-shot role children (implementer, code-reviewer,
verifier) work in isolated git worktrees; a batch gate proves each train of approved
branches with one full check run; green trains are squash-merged in order.

GitHub issues are the tickets. Issue labels are the loop state. Deterministic scripts
plus a small pi extension are the hands; skills are the brain.

Derived from [`wentbackward/claude-dev-loop`](https://github.com/wentbackward/claude-dev-loop)
(Claude Code). Design: `docs/superpowers/specs/2026-10-27-devloop-pi-design.md`.

## How it works

```
spec ──► GitHub issues (acceptance criteria, Depends on #n)
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
```

The stop-gate hook (`agent_before_settle`) makes "keep going while work is startable" a
harness property, not a discipline: red fast check → continue (bounded), dirty tree →
continue (bounded), startable ticket + free slot → continue (unbounded).

## Tools (pi extension)

| Tool | What it does |
|---|---|
| `devloop.dispatch` | `{role, ticket}` (implementer) / `{role, ticket}` (reviewer) / `{role, task, worktree?}` (verifier). Computes branch, worktree, ports, notes path and the full brief; enforces the concurrency cap; labels the ticket as it goes. |
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
- `agents/` — role prompts (implementer, code-reviewer, verifier).
- `skills/` — `devloop` (orchestrator workflow) and `devloop-setup` (project bootstrap).
- `templates/` — `.devloop.json`, AGENTS.md and DECISIONS.md skeletons.
- `tests/` — offline suites: `smoke.sh` (bash, local bare origin, `fake-gh`) and
  `tests/unit/*.test.ts` (node:test, `fake-pi`). No network, no real GitHub.

## Installing into a project

```bash
/path/to/multipi/scripts/install.sh /path/to/target
```

Copies `scripts/` (versioned in the target), the extension to
`.pi/extensions/multipi-devloop/`, roles to `.pi/agents/`, skills to `.pi/skills/`.
Then the target writes its `.devloop.json` (start from `templates/devloop.json`) and runs
`scripts/doctor.sh`. Non-multipi targets additionally need `typebox` and
`@earendil-works/pi-coding-agent` resolvable (devDependencies). In a pi session, the
`devloop-setup` skill does all of this.

## Checks

```bash
make check    # tsc --noEmit + node unit tests + shellcheck (loud warning if absent) + smoke
```

Fully offline. A live end-to-end pass needs API access: open a pi session in a managed
repo and run `devloop.status`, then dispatch a trivial ticket.

## Project config (`.devloop.json`, committed)

`base_branch`, `remote`, `fast_check`, `format`/`format_extensions`, `checks[]`
(`{name, command, heavy, summary}` or plain command), `gate_worktree`,
`heavy.{slots, memory_max, port_env, port_base, port_step}`, `stop_gate.{require_clean_tree,
max_blocks}`, `merge.{method, delete_branch}`. Runtime state (notes, logs,
green-train record, dispatch state) lives under `~/.multipi/<repo>/` — derivable, never
authoritative over GitHub + git.
