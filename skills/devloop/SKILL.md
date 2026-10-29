---
name: devloop
description: Run the autonomous dev loop as the orchestrator — tickets from the spec, up to N implementer children in their own worktrees, independent review until approval, one batched gate per train, ordered squash merges, then verify and close. Use when asked to work through the spec or the open tickets autonomously, to "keep going", or to start the dev loop.
---

# The dev loop (orchestrator)

You are the main session: the orchestrator. You own the tickets, the merges and the verdicts on
progress. Children write code, the reviewer judges it, the batch gate proves it, and you merge it.
Keep the queue full. The stop-gate hook enforces "no idle while work is startable" for you — it will
send you back with a reason if you try to settle while tickets remain startable. Read those messages
and act on them.

## 0. Start of a session (always, first)

1. Read `AGENTS.md`, the spec it names, `.devloop.json`, `docs/DECISIONS.md` and the repo's spec docs.
2. `devloop.status` — in-flight children, open tickets with their `dl/` labels, capacity, last green
   gate. Then `git worktree list` and `git fetch` for anything the state file misses.
3. Recover: a child marked `crashed`/`interrupted` with a live worktree is a RE-DISPATCH (it resumes
   from git state). A ticket labelled `dl/in-review` with a green branch is ready for the reviewer.
   A gated-but-unmerged train may be mergeable now.
4. If `.devloop.json` is missing or `scripts/doctor.sh` reports MISSING items, run the `devloop-setup`
   skill before anything else.
5. **Self-seeding (Phase 0):** if there are NO open tickets and the spec named by `AGENTS.md`
   exists, the loop seeds itself: dispatch the analyst on the spec (§1.1), raise the tickets it
   plans, and continue. The user never has to pre-populate the board.

## 1. Tickets

- One GitHub issue per work item: acceptance criteria as a checklist, `Depends on #n` lines in the
  body for dependencies, sensible labels. You create issues mechanically (`gh issue create`); the
  CONTENT comes from the analyst (§1.1) or from the user's steer (§8). You do not invent scope
  yourself.

### 1.1 Self-seeding: spec → analyst → tickets

`devloop.dispatch {role: "analyst", spec: <spec path>}` — the analyst reads the spec and the
existing code, and returns an ordered ticket plan (also written to the plan file named in its
report). Then, for each planned ticket IN PLAN ORDER:

1. `gh issue create` with the planned title and a body carrying the plan's `Why`, the acceptance
   criteria as `- [ ]` checkboxes, `Depends on #<numbers>` (resolve titles to the numbers as you
   create, in order) and a `Size: S|M` line. Keep the body verbatim from the plan — no rewriting.
2. Collect the new numbers; `gh issue list` to confirm the board matches the plan.
3. Comment the plan's **Out of scope** list on the FIRST ticket (scope transparency for humans).

Then dispatch implementers per the normal rules. If the analyst came back `STATUS: BLOCKED`
(spec unreadable/contradictory), label the situation, tell the user, and stop for a decision.

### 1.2 Ticket lifecycle
- The label line IS the loop state — keep it truthful:
  - `dl/in-progress` — a child is working (set automatically on dispatch)
  - `dl/in-review` — branch pushed, PR open, reviewer may run (set automatically on green report)
  - `dl/approved` — `VERDICT: APPROVE` received
  - `dl/gated` — included in a green gate
  - `dl/merged` — squash-merged; then close the issue (`gh issue close <n> --comment ...`)
  - `dl/blocked` — needs a human decision; the ticket body says what
- Comment each transition on the issue (one line: what, which branch, evidence). Issues are the audit
  trail; future sessions and humans read them cold.

## 2. Scheduling

- Up to `heavy.slots` implementers at once (check `devloop.status`); a fourth concurrent dispatch is
  refused by the tool with the in-flight list — wait for a report, do not retry in a tight loop.
- A ticket is STARTABLE when unblocked and every dependency is merged or in-flight (stacking).
- Never run two tickets that edit the same hot files at once — conflicts cost more than waiting. Pair
  tickets from different areas.
- After every report, gate or merge, dispatch the next startable ticket in the SAME turn. Continuous
  work is the norm; stopping to narrate is not.

## 3. Dispatch

`devloop.dispatch {role: "implementer", ticket: <n>}` — everything else (branch, worktree, ports,
notes, brief) is computed for you. When a dependency's branch is pushed but unmerged and the ticket
stacks on it, tell the child in a follow-up comment on the ticket before dispatching; the re-dispatch
brief carries the stack-on context through the branch base.

On the child's report:
- `STATUS: DONE` + label `dl/in-review`: dispatch the reviewer.
- `STATUS: BLOCKED`: read the reason. Human-decision items: label `dl/blocked`, comment the question
  on the issue, and move to other startable work. Technical blockers the child misdiagnosed: reply
  with what you know and re-dispatch.

## 4. Review loop (every branch, before the gate)

`devloop.dispatch {role: "code-reviewer", ticket: <n>}` reviews the ticket's branch independently of
the implementer. Never skip it; never merge on the implementer's self-review.

- `VERDICT: CHANGES REQUIRED`: comment the must-fix list verbatim on the issue, re-dispatch the
  implementer for the same ticket (it resumes in the same worktree), then review again. Repeat until
  APPROVE. Cheap should-fix items: fold them into the same round. Expensive ones: follow-up issue.
- `VERDICT: APPROVE`: label `dl/approved`.

## 5. Gate the train (batch, never per-branch)

When the set of `dl/approved` branches stabilises (nothing new expected this pass):
1. Choose the merge order: foundations first, dependents later; pairs from different areas adjacent.
2. `devloop.gate {branches: [...]}` in that order. Green: label every covered ticket `dl/gated` and
   comment the gate log path.
3. Red: nothing merges. Read the tail, identify the owning ticket(s), dispatch the implementer(s) to
   fix, and re-gate the whole train when they are back.
4. Conflict at branch X: gate the rest without X; send X's implementer to rebase on the lower
   branches; re-gate.

## 6. Merge

`devloop.merge {branches: [...]}` — the SAME list and order as the gate. Outcomes:
- `merged`: label `dl/merged`, close the issues, comment the squash commits. Stacked branches that
  sat on a now-merged lower branch rebase `--onto` the base; re-gate if they carry foreign commits.
- `tree-differs` / `branch-changed` / `replay-conflict`: someone moved the ground — re-gate, then
  merge. Never force a merge past a refusal; the refusals exist because a silent merge would corrupt
  the invariant (merged tree == gated tree).
- `notes-missing` / `pr-not-merged`: fix the concrete defect (write the notes file per its format;
  push the branch) and retry.

## 7. Verify and close

After a meaningful train lands, `devloop.dispatch {role: "verifier", worktree: <where the real output
lives>, task: <precise, checkable expectations with the commands to run>}`. The verifier's anomalies
become new tickets (broken expectation = P1 ticket before the loop continues). When the spec section
is done: mark its issues closed, summarise what shipped and where, and stop ONLY then.

## 8. Interruptions, steering and the user

- `devloop.cancel {ticket}` kills one child (its worktree and branch are kept; a re-dispatch resumes).
  Ctrl+C kills everything — after it, recover via step 0.
- A requirement changes while a child runs: edit the ISSUE first (the child re-reads it on resume),
  then cancel, then re-dispatch. There is no live messaging into a running child.
- **Steering = tickets.** Whenever the user reports something in chat — a bug they hit while
  testing, a test result, a "I wish it would…" — turn it into a ticket the same turn:
  - Single obvious item: create the issue directly, with a `## Reported` section quoting the user's
    words verbatim plus your context (what they were testing, what they saw).
  - Multi-item or ambiguous: `devloop.dispatch {role: "analyst", focus: <user's words + context>}`
    and raise the tickets from the plan (§1.1 mechanics).
  - Triage on creation: reproducible defect → dispatch an implementer immediately (or queue it per
    §2); preference/enhancement → queue it; anything needing the user's judgement →
    `dl/blocked` with the question in the body.
  - Acknowledge the user in ONE line (ticket number + what happens next) and keep working — the
    ticket, not the chat, is the record.
- The user's direct instructions always outrank this skill. When the user asks for a report, give it
  and CONTINUE afterwards unless told to stop.

## 9. What you never do

- Never dispatch two children for one ticket; never dispatch a ticket that is `dl/in-progress`.
- Never raise a ticket whose acceptance criteria you cannot falsify; if a request is too vague to
  falsify, ask ONE question before creating it (or send it to the analyst with the vagueness noted).
- Never merge a branch that was not in a green gate; never gate a branch that has no APPROVE.
- Never weaken a check, a test or a gate to make the loop "go green". A red gate is a finding, not an
  inconvenience.
- Never push to the base branch from the main worktree for a ticket; ticket work travels branches only
  (docs/config commits to the base are fine and get merged immediately).
- Never let a `dl/blocked` ticket silently age: every session start revisits them.
