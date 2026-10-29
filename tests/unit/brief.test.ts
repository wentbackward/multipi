import assert from "node:assert/strict";
import test from "node:test";
import {
	branchSlug, worktreePath, portRange,
	assembleImplementerBrief, assembleReviewerBrief, assembleAnalystBrief, assembleVerifierBrief,
} from "../../extension/src/brief.ts";

const REPO = "/home/u/src/proj";
const HEAVY = "/opt/multipi/scripts/heavy.sh";

test("branchSlug is deterministic and bounded", () => {
	assert.equal(branchSlug("Add Redis Caching to the Session Store"), "add-redis-caching");
	assert.equal(branchSlug("!!!  fix:   login   (401s)"), "fix-login-401s");
	assert.ok(branchSlug("a b c d e f g h i j k l m n o p q r s t u v w").length <= 24);
	assert.equal(branchSlug(""), "work");
});

test("worktreePath is the sibling of the repo root", () => {
	assert.equal(worktreePath(REPO, 7), "/home/u/src/proj-7");
});

test("portRange sits above the gate range", () => {
	const heavy = { portBase: 9100, portStep: 10, slots: 2 };
	assert.deepEqual(portRange(heavy, 0), [9121, 9130]);
	assert.deepEqual(portRange(heavy, 1), [9131, 9140]);
});

test("implementer brief carries every deterministic fact and the STATUS contract", () => {
	const brief = assembleImplementerBrief({
		ticket: 7, title: "Add thing",
		worktree: "/home/u/src/proj-7", branch: "feat/7-add-thing",
		stackOn: undefined,
		notes: "/state/notes/pr-feat_7-add-thing.md",
		fastCheck: "make fmt-check lint",
		heavy: HEAVY, remote: "origin", baseBranch: "main",
		portRange: [9121, 9130],
	});
	for (const needle of ["/home/u/src/proj-7", "feat/7-add-thing", "origin/main",
		"/state/notes/pr-feat_7-add-thing.md", "make fmt-check lint", HEAVY, "9121", "9130",
		"Refs #7", "Closes #7", "STATUS: DONE", "STATUS: BLOCKED", "docs/DECISIONS.md"]) {
		assert.ok(brief.includes(needle), `brief missing: ${needle}`);
	}
});

test("implementer brief names the stack base when stacking", () => {
	const brief = assembleImplementerBrief({
		ticket: 8, title: "Stack", worktree: "/w/8", branch: "feat/8-stack",
		stackOn: "feat/7-add-thing", notes: "/n.md", fastCheck: "true", heavy: "/h",
		remote: "origin", baseBranch: "main", portRange: [9121, 9130],
	});
	assert.ok(brief.includes("origin/feat/7-add-thing"));
});

test("implementer brief notes in-progress work on resume", () => {
	const fresh = assembleImplementerBrief({
		ticket: 7, title: "New", worktree: "/w/7", branch: "feat/7-new",
		stackOn: undefined, notes: "/n.md", fastCheck: "true", heavy: "/h",
		remote: "origin", baseBranch: "main", portRange: [9121, 9130],
	});
	assert.ok(!/work in progress/i.test(fresh));
	const resumed = assembleImplementerBrief({
		ticket: 7, title: "Resume", worktree: "/w/7", branch: "feat/7-resume",
		stackOn: undefined, notes: "/n.md", fastCheck: "true", heavy: "/h",
		remote: "origin", baseBranch: "main", portRange: [9121, 9130], resumed: true,
	});
	assert.ok(/work in progress/i.test(resumed));
});
test("implementer brief carries the latest ticket comment verbatim", () => {
	const brief = assembleImplementerBrief({
		ticket: 7,
		title: "T",
		worktree: "/w",
		branch: "b",
		notes: "/n.md",
		fastCheck: "true",
		heavy: "/h",
		remote: "origin",
		baseBranch: "main",
		portRange: [9000, 9009],
		reviewNote: "MUST FIX 1. scripts/doctor.sh:54 — do the thing",
	});
	assert.ok(brief.includes("Latest ticket comment"), "section present");
	assert.ok(brief.includes("MUST FIX 1. scripts/doctor.sh:54 — do the thing"), "verbatim");
	assert.ok(brief.includes("its latest comments"), "step 2 mandates reading comments");
	const plain = assembleImplementerBrief({
		ticket: 7, title: "T", worktree: "/w", branch: "b", notes: "/n.md", fastCheck: "true",
		heavy: "/h", remote: "origin", baseBranch: "main", portRange: [9000, 9009],
	});
	assert.ok(!plain.includes("Latest ticket comment"), "no section without a comment");
});


test("reviewer brief carries branch, base, verdict contract, tree-clean rule, safety note", () => {
	const brief = assembleReviewerBrief({
		branch: "feat/7-x", baseBranch: "main", remote: "origin", worktree: "/w/7", ticket: 7,
		fastCheck: "make lint", safetyNote: "touches money",
	});
	for (const needle of ["feat/7-x", "origin/main", "/w/7", "VERDICT: APPROVE", "VERDICT: CHANGES REQUIRED", "money", "git status --porcelain"]) {
		assert.ok(brief.includes(needle), `reviewer brief missing: ${needle}`);
	}
});

test("reviewer brief omits the safety note when not provided", () => {
	const brief = assembleReviewerBrief({
		branch: "b", baseBranch: "main", remote: "origin", worktree: "/w", ticket: 1, fastCheck: "true",
	});
	assert.ok(!/deeper safety checklist/i.test(brief));
});

test("verifier brief embeds the task and worktree", () => {
	const brief = assembleVerifierBrief({ task: "Audit the backfill of 2026-09 outputs", worktree: "/repo" });
	assert.ok(brief.includes("Audit the backfill of 2026-09 outputs"));
	assert.ok(brief.includes("/repo"));
});

test("analyst brief: spec mode carries spec, repo, plan path and the plan contract", () => {
	const brief = assembleAnalystBrief({ spec: "docs/prd.md", repoRoot: "/repo", planPath: "/h/multipi/proj/notes/tickets-prd.md" });
	assert.ok(brief.includes("`docs/prd.md`"), "spec path carried");
	assert.ok(brief.includes("relative to /repo"), "repo root context");
	assert.ok(brief.includes("/h/multipi/proj/notes/tickets-prd.md"), "plan path");
	assert.ok(brief.includes("## Ticket: <imperative title"), "plan format");
	assert.ok(brief.includes("Out of scope"), "out-of-scope deliverable");
	assert.ok(brief.includes("gh issue list"), "dedupes against open tickets");
	assert.ok(brief.includes("STATUS: DONE"), "report contract");
});

test("analyst brief: focus mode embeds the operator feedback verbatim", () => {
	const brief = assembleAnalystBrief({ focus: "the alert email arrived TWICE", repoRoot: "/repo", planPath: "/p.md" });
	assert.ok(brief.includes("the alert email arrived TWICE"), "feedback verbatim");
	assert.ok(!brief.includes("## Ticket: <imperative title") === false, "still has the plan format");
});
