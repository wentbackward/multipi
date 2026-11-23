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
3. Test first: failing tests from the behavioural acceptance criteria, then the code.
4. Targeted tests + fast check (`fast_check` in `.devloop.json`) only while implementing.
   The full checks run once per batch in the gate.
5. Small Conventional Commits, each referencing the ticket (`Refs #12`).
6. The independent code-reviewer on every branch; fix every must-fix; re-review until APPROVE.
7. Approved branches are gated as one train (`gate-train.sh` via `devloop_gate`); a green
   train merges in order (`merge-train.sh` via `devloop_merge`), one squash per ticket.
   A red train is never merged.
8. After a job ticket merges, run the job for real and verify its outputs.

### Parallel work

- At most 3 implementer agents, one ticket each, each in its own worktree.
- Heavy commands (full suite, e2e, long builds) only through `scripts/heavy.sh`.

## Secrets and safety

- Never read `.env` or credential files. Never write secrets or personal identifiers into
  code, tests, docs, commits, issues or PRs. Use role words and placeholders.
- Merges only through the merge train after a green gate.

## Engineering standard
I am a pedantic engineer about *correctness and evidence*: exact behaviour,
edge cases, contracts, and proof that a change works. I am not pedantic about
form. Good engineering, not over-engineering: every test, finding and line of
code must earn its cost.

- Tests verify behaviour through public interfaces. Never write tests that
  read source files, comments, file layout, or other tests. To verify config
  (CI, YAML), parse or execute it rather than grep it.
- Acceptance criteria phrased as greps or file checks are verified once, at
  review, and quoted in the report. They do not become permanent tests.
- Every review finding states a concrete failure scenario
  (input/state -> wrong outcome).
- Severity = likelihood x impact. MUST-FIX: a plausible failure with real
  impact (wrong behaviour, security, data loss, broken contract).
  SHOULD-FIX: unlikely or low-impact failures. NIT: no failure scenario;
  batch nits, never block on them.
- Test economy: the minimum set of tests that guards the most likely real
  regressions. Each test names the regression it prevents. Prefer one
  behaviour test over several narrow ones. A test that cannot fail for a
  real bug is a cost, not a benefit.
- Findings about tests, comments or docs alone go to the polish backlog once.
  A review of a polish-backlog ticket never creates another backlog ticket.
- Deleting code or tests that add no protection is a valid improvement.
