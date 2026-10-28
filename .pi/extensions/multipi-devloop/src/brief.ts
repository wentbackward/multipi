import path from "node:path";
import type { HeavyConfig } from "./config.ts";

/** Lowercase [a-z0-9] runs, up to 3, joined with '-', capped at 24 chars. Deterministic. */
export function branchSlug(title: string): string {
	const words = title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 3);
	const slug = words.join("-").slice(0, 24).replace(/-+$/, "");
	return slug || "work";
}

/** Sibling of the repo root, named after it and the ticket number. */
export function worktreePath(repoRoot: string, ticket: number): string {
	return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-${ticket}`);
}

/**
 * The gate's heavy checks use ports portBase+portStep .. portBase+slots*portStep
 * (one per slot, slot numbers 1..slots). Implementers get slices strictly above that:
 * slice idx (0-based) = [portBase + slots*step + 1 + idx*step, ... + step].
 */
export function portRange(heavy: Pick<HeavyConfig, "portBase" | "portStep" | "slots">, idx: number): [number, number] {
	const start = heavy.portBase + heavy.slots * heavy.portStep + 1 + idx * heavy.portStep;
	return [start, start + heavy.portStep - 1];
}

export interface ImplementerBriefInput {
	ticket: number;
	title: string;
	worktree: string;
	branch: string;
	/** Dependency branch to base on (otherwise the remote base branch). */
	stackOn?: string;
	notes: string;
	fastCheck: string;
	/** Absolute path of scripts/heavy.sh. */
	heavy: string;
	remote: string;
	baseBranch: string;
	portRange: [number, number];
	/** True when re-dispatching into a worktree that already holds partial work. */
	resumed?: boolean;
	/** Latest comment on the ticket (verbatim) — reviewer findings and requirement changes ride here. */
	reviewNote?: string;
}

export function assembleImplementerBrief(i: ImplementerBriefInput): string {
	const base = i.stackOn ? `${i.remote}/${i.stackOn}` : `${i.remote}/${i.baseBranch}`;
	const resume = i.resumed
		? `
## Resume: there is work in progress in this worktree
A previous run was interrupted. Before anything else: \`git status && git log --oneline -5\` to see what
exists, re-read the ticket (it may have changed), and either finish or discard invalidated work
(decision to docs/DECISIONS.md). Do not blindly redo committed work.
`
		: "";
	const review = i.reviewNote
		? `
## Latest ticket comment (READ IT — review findings and requirement changes are posted here)
${i.reviewNote}
`
		: "";
	return `Implement ticket #${i.ticket}: ${i.title}
${review}
## Grounds you were given (from the orchestrator — authoritative)
- Worktree: ${i.worktree}   (branch ${i.branch}, based on ${base})
- Notes file (outside git, do NOT commit): ${i.notes}
  Line 1: plain title, NO leading "#", e.g. "feat(scope): what changed (#${i.ticket})". Then a blank line,
  ## Summary, "Closes #${i.ticket}", ## Decisions (if any), ## Test evidence (exact commands + pass counts).
- Ports for any server you start: ${i.portRange[0]}..${i.portRange[1]} (the gate's range is yours to never touch)
- Fast check: ${i.fastCheck}
- Heavy-job queue: ${i.heavy}

${resume}
## Ground rules
- Work ONLY inside your worktree. Your shell cwd resets between commands: use absolute paths or prefix
  every command with \`cd ${i.worktree} &&\`.
- Read the project's AGENTS.md first and follow it; it overrides this brief where they differ.
- Never read, print or copy .env files, credential files, keys or tokens. Never write secrets or personal
  identifiers (real user names, account numbers, emails, private hostnames) into code, tests, docs, commits
  or notes. Use role words and placeholders.
- Never push to the base branch, never force-push a branch you did not create, never open, approve or
  merge a PR. The orchestrator owns PRs and merges.
- Never run anything that spends money, sends real orders or messages, deletes real data, or changes a
  production system. Fakes, fixtures and test environments only.

## Steps
1. \`cd ${i.worktree} && git status && git log --oneline -3\`: confirm you are on ${i.branch} based on ${base}.
2. Read the ticket AND its latest comments (\`gh issue view ${i.ticket}\`; the newest comment carries review findings) and the spec sections it cites, plus the code it touches.
3. TESTS FIRST. Turn every acceptance criterion into at least one named test whose name states the
   behaviour; add the edge cases that matter (empty input, boundaries, duplicates, out-of-order input,
   failure of each dependency). Replace external services with fakes. No network in unit tests. Run them
   and confirm they FAIL for the right reason. Commit: "test: what (Refs #${i.ticket})".
4. Implement the smallest change that meets the criteria. Commit at every green step: small Conventional
   Commits (feat/fix/refactor/chore/docs), each ending "Refs #${i.ticket}".
5. Where the spec is silent: choose the simplest option that fits, append one entry to docs/DECISIONS.md
   (date, decision, reason, alternatives), continue. Stop and report only for the project's stop conditions.
6. Self-review \`git diff ${base}...HEAD\` against the acceptance criteria and AGENTS.md: every criterion
   tested, no dead or commented-out code, no debug output, no secrets.
7. Run ONLY the tests for what you touched plus the fast check ("${i.fastCheck}"). Both green.
   Do NOT run the full suite, coverage gate, e2e or long builds — the batch gate does that once for all
   ready branches. If one heavy run is truly unavoidable, run it through: ${i.heavy} <command>
   (never a raw \`timeout\` wrapper).
8. Push the branch: \`git push -u ${i.remote} ${i.branch}\`.
9. Write the notes file at: ${i.notes} (format above).

## Final report (short, then the status line)
Branch and head commit; tests added (which criterion each covers); commands run with results; decisions
recorded; anything left open. End the report with EXACTLY one of:
STATUS: DONE
STATUS: BLOCKED — <one-line reason>
Add a "## Questions" section (may say "none") listing anything that needs the orchestrator or the user.
`;
}

export interface ReviewerBriefInput {
	branch: string;
	baseBranch: string;
	remote: string;
	worktree: string;
	ticket: number;
	fastCheck: string;
	/** Set when the diff touches money, orders, auth, secrets, deletion, migrations — enables the deeper checklist. */
	safetyNote?: string;
}

export function assembleReviewerBrief(i: ReviewerBriefInput): string {
	const safety = i.safetyNote
		? `
## Deeper safety checklist — APPLIES (this change ${i.safetyNote})
- Every acting path has a guard, and a test proves the guard REFUSES (wrong mode/account/user, limit
  exceeded, missing confirmation).
- No path bypasses configured limits or the confirmation step, including retries, fallbacks, reconnects
  and error handlers.
- Failure is safe: on exception/timeout/partial response the system does nothing or rolls back — never
  acts twice (idempotency keys, duplicate detection).
- Outside inputs are validated before use; amounts, units, signs and rounding are explicit.
- Auditable logging without logging secrets; tests cover boundary values and refusal cases.
Any gap here is a MUST FIX.
`
		: "";
	return `Strictly review branch ${i.branch} (ticket #${i.ticket}) checked out at ${i.worktree}, against ${i.remote}/${i.baseBranch}.
Your review is INDEPENDENT of the implementer's self-review: assume nothing it says; check the diff.

## Steps
1. \`cd ${i.worktree} && git fetch -q && git diff ${i.remote}/${i.baseBranch}...HEAD --stat\`, then read EVERY
   changed file in full (not just hunks) and its callers.
2. Read the project's AGENTS.md, the ticket (\`gh issue view ${i.ticket}\`) and the spec sections it cites.
3. Check, in order:
   - CORRECTNESS against the spec and every acceptance criterion — name each criterion not met.
   - SAFETY AND DATA: secrets/personal identifiers anywhere; raw data never modified; destructive ops
     guarded; time zones explicit; errors not swallowed.
   - TESTS: each criterion has a test; tests check behaviour not internals; deterministic (no network,
     no wall clock, no sleeps, seeded randomness); the edge cases that matter are covered.
   - CLEAN CODE: small single-purpose functions, clear names, dependencies injected, no module state,
     complete types, no dead/commented-out code, no debug output.
   - SIMPLICITY: flag anything more complex than the ticket needs.
4. REPRODUCE, do not speculate: suspect a bug → write a throwaway test (obviously temporary name), run it,
   record the result, DELETE it. Finish with \`git status --porcelain\` EMPTY. Never commit.
5. Run the targeted tests of the changed modules and the fast check ("${i.fastCheck}"); report results.
   Do NOT run the full suite or e2e — the batch gate does that once for the whole train.
${safety}
## Output
Exactly two lists:
- MUST FIX (blocks merge): file:line, problem, evidence (reproducing test output when you have one), fix.
- SHOULD FIX (does not block): file:line, suggestion.
End with EXACTLY one of:
VERDICT: APPROVE
VERDICT: CHANGES REQUIRED
`;
}

export interface VerifierBriefInput {
	task: string;
	worktree: string;
}

export function assembleVerifierBrief(i: VerifierBriefInput): string {
	return `You are a read-only auditor. Work at ${i.worktree}.

## Assignment
${i.task}

## Rules
- READ-ONLY: never modify tracked or untracked files, never push, never change any system state.
- Spot-check real outputs against the ticket's expectation: data integrity, invariants, log plausibility,
  counts and ranges.
- Report anomalies WITH EVIDENCE (the exact command, the exact observed value, the expected value).
- End with EXACTLY one of:
STATUS: DONE
STATUS: BLOCKED — <one-line reason>
`;
}
