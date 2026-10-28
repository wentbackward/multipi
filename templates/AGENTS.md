# AGENTS.md — {{PROJECT_NAME}}

{{ONE_PARAGRAPH_WHAT_THIS_PROJECT_IS}} The spec is `{{SPEC_PATH}}` and is the source of truth.

## Operating mode: autonomous (dev loop)

- Work end to end without asking for approval: plan, ticket, build, test, commit, review,
  gate, merge, run, verify. The workflow is the `devloop` skill of the multipi extension.
- Stop and ask only for the stop conditions below.
- When the spec is silent, choose the simplest option that fits it, record it in
  `docs/DECISIONS.md` (date, decision, reason, alternatives), and continue.
- Never wait idle on a long job: run it in the background, verify the first output, continue.

### Stop conditions (the only reasons to stop and ask)

1. A required credential or key is missing or rejected ({{CREDENTIALS_EXAMPLE}}).
2. A paid action would exceed the cost cap: {{COST_CAP_OR_NONE}}.
3. The spec contradicts itself and both readings change stored data or relied-upon behaviour.
4. Anything unsafe or irreversible: production data, real money or orders, deleting history,
   security settings, {{PROJECT_SPECIFIC_DANGERS}}.

## Workflow loop (repeat until the spec's Definition of Done is met)

1. One GitHub issue per work item: acceptance criteria, `Depends on #n`, labels.
2. One branch per ticket (`feat/<n>-<slug>` etc.), each in its own worktree.
3. Test first: failing tests from the acceptance criteria, then the code.
4. Targeted tests + fast check (`fast_check` in `.devloop.json`) only while implementing.
   The full checks run once per batch in the gate.
5. Small Conventional Commits, each referencing the ticket (`Refs #12`).
6. The independent code-reviewer on every branch; fix every must-fix; re-review until APPROVE.
7. Approved branches are gated as one train (`gate-train.sh` via `devloop.gate`); a green
   train merges in order (`merge-train.sh` via `devloop.merge`), one squash per ticket.
   A red train is never merged.
8. After a job ticket merges, run the job for real and verify its outputs.

### Parallel work

- At most 3 implementer agents, one ticket each, each in its own worktree.
- Heavy commands (full suite, e2e, long builds) only through `scripts/heavy.sh`.

## Secrets and safety

- Never read `.env` or credential files. Never write secrets or personal identifiers into
  code, tests, docs, commits, issues or PRs. Use role words and placeholders.
- Merges only through the merge train after a green gate.
