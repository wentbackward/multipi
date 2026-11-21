# Post-merge verification — train {{RANGE}}

Independent confirmation that the merged train holds on a CLEAN environment (shared
contracts touched: {{TOUCHED}}). The gate already proved it in the loop's own worktree; this proof comes from a fresh clone, unjudged by the loop's policy shims. You
audit — you do not fix: every write lives in a throwaway dir under your temp space, and
the session repo, the gate worktree and the loop's state are read-only for you.

## Steps — record EVERY command and its rc, one line each, grouped by step

1. **Fresh clone.** `tmp=$(mktemp -d)`; clone `{{REPO_URL}}` at the base branch into
   `$tmp/clone`. NEVER clone into, or reuse, the session repo or the gate worktree.
2. **Scrub PATH** before any git/gh work: drop every PATH entry whose `git` or `gh`
   resolves to an interpreted script (first two bytes `#!`) — the policy-shim detection
   the gate uses (ticket #70). The verification must run on real binaries, not the
   dogfood shims; record the resulting PATH entry count.
3. **Full `make check`** in the clone (tsc, unit, smoke, hygiene, shellcheck per the
   clone's Makefile): record each check's rc and its summary line.
4. **Doctor on the clone:** `scripts/doctor.sh`; record the rc and every ok / MISSING /
   PROBLEM line.
5. **Install into a throwaway repo:** create a fresh empty git repo under `$tmp`, run
   `scripts/install.sh` there FROM THE CLONE, then run `scripts/doctor.sh` there, and
   confirm the installed copies are BYTE-IDENTICAL mirrors of the clone's sources — for
   every mirror pair that exists in the clone: `.pi/agents/` vs `agents/`,
   `.pi/skills/<name>/SKILL.md` vs `skills/<name>/SKILL.md`,
   `.pi/extensions/multipi-devloop/index.ts` and `src/*.ts` vs `extension/index.ts` and
   `src/*.ts`, `.pi/templates/devloop.json` vs `templates/devloop.json`, and
   `scripts/verify-brief.template.md` vs `templates/verify-brief.md`. `cmp` per file;
   record each rc.
6. **Train-specific exercise:** {{EXERCISE}}

## Verdict and cleanup

- Report every command you ran with its rc (the steps above are the minimum; auxiliary
  commands count too).
- Conclude with EXACTLY one line, before your final STATUS line:
  `VERIFICATION: PASS` or `VERIFICATION: FAIL — <which expectation broke, with evidence>`.
  PASS only if every check is green, both doctors are clean, every mirror pair is
  byte-identical, and the exercise held.
- Clean up: remove `$tmp` (every throwaway dir and repo inside it) and confirm the
  removal.
