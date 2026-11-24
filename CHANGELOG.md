# Changelog

Notes for projects running a multipi install. Newest last.

## Unreleased

### The engineering standard lands in the role briefs and the AGENTS.md template (#137)

The loop is now pedantic about *correctness and evidence*, not form: the code-reviewer
grades findings by likelihood x impact (must-fix = a plausible failure with real impact;
nits never block), the implementer writes behaviour-only tests with economy and verifies
grep-style criteria once in the report, and the analyst prefers behavioural acceptance
criteria. `templates/AGENTS.md` carries the full standard.

**If your project runs this loop, after updating the extension:**

1. Merge the "Engineering standard" section from the updated `templates/AGENTS.md` into
   your own project `AGENTS.md` (setup does not overwrite it).
2. Raise one cleanup ticket: "remove source-shape tests; keep or replace only those that
   guard real behaviour".
