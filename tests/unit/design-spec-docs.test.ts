import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTools } from "../../extension/src/tools.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPECS = path.join(HERE, "..", "..", "docs", "superpowers", "specs");
const DESIGN_TEXT = readFileSync(path.join(SPECS, "2026-10-27-devloop-pi-design.md"), "utf8");
const POLICY_TEXT = readFileSync(path.join(SPECS, "2026-11-09-multipi-permission-policy.md"), "utf8");

/** `makeTools()` is the ground truth: whatever the registration says is what the spec must describe. */
const CODE_TOOL_NAMES = makeTools().map((t) => t.name);

/** Extract a top-level numbered section ("## 4. …") of the design spec. */
function designSection(marker: string): string {
	const rest = DESIGN_TEXT.split(`## ${marker}`);
	assert.ok(rest.length >= 2, `the design spec must carry a "## ${marker}" section`);
	const body = rest.slice(1).join("## ");
	const nl = body.indexOf("\n## ");
	return nl === -1 ? body : body.slice(0, nl);
}

/** The §2.2 subsection (### 2.2 … ### 2.3). */
function sec2_2(): string {
	const sec2 = DESIGN_TEXT.split("## 2.");
	assert.ok(sec2.length >= 2, `the design spec must carry a "## 2." (Architecture) section`);
	const body = sec2.slice(1).join("## 2.");
	const start = body.indexOf("### 2.2");
	const end = body.indexOf("### 2.3");
	assert.notEqual(start, -1, "the architecture section must carry a ### 2.2 (Extension) subsection");
	assert.notEqual(end, -1, "the architecture section must carry a ### 2.3 (Scripts) subsection");
	return body.slice(start, end);
}

/** The tool names listed as first-column rows of the §2.2 tools table. */
function tableToolNames(): string[] {
	const names: string[] = [];
	for (const m of sec2_2().matchAll(/^\|\s*`(devloop_[a-z]+)`\s*\|/gm)) names.push(m[1]);
	return names;
}

// --- item 1: shipped status headers ------------------------------------------

test("the design spec status header reflects shipped status (not 'proposed — awaiting owner review')", () => {
	const head = DESIGN_TEXT.split("\n").slice(0, 10).join("\n");
	assert.ok(head.includes("Status:"), "the header must carry a Status: line");
	const line = head.split("\n").find((l) => l.startsWith("Status:")) ?? "";
	assert.ok(!line.includes("proposed — awaiting owner review"), "the header must no longer claim the spec is unreviewed");
	assert.ok(line.includes("shipped"), "the header must say the system shipped");
});

test("the permission policy spec is no longer titled '(draft for operator review)'", () => {
	assert.ok(!POLICY_TEXT.includes("draft for operator review"), "the draft framing must be gone from the title");
	assert.ok(POLICY_TEXT.split("\n")[0].startsWith("# multipi permission policy"), "the title must keep its subject");
});

// --- item 2: six tools, cross-locked against makeTools() ----------------------

test("the §2.2 count sentence and tools table list exactly the registered control-plane tools (cross-locked against makeTools())", () => {
	const table = tableToolNames();
	assert.deepEqual(
		[...CODE_TOOL_NAMES].sort(),
		[...table].sort(),
		"the §2.2 tools table must contain exactly the names makeTools() registers — a missing row (or a stale one) is drift",
	);
	assert.equal(CODE_TOOL_NAMES.length, 6, "ground truth: six control-plane tools");
	assert.ok(!DESIGN_TEXT.includes("Five tools"), "the stale 'Five tools' count must be gone");
	assert.ok(sec2_2().includes("Six tools"), "the count sentence must carry the corrected count");
});

// --- item 3: the cap is heavy.slots, not a literal 3/4 ------------------------

test("the cap claim references heavy.slots in the spec AND the code (no literal 3/4 caps left)", () => {
	for (const stale of ["≤3 in-flight implementers", "a fourth concurrent dispatch", "≤3 implementers", "4th simultaneous dispatch"]) {
		assert.ok(!DESIGN_TEXT.includes(stale), `stale literal-cap phrasing still present: ${stale}`);
	}
	const dispatchRow = [...sec2_2().matchAll(/^\|\s*`devloop_dispatch`\s*\|[\s\S]*?(?=\n\|)/mg)][0]?.[0] ?? "";
	assert.ok(dispatchRow.includes("heavy.slots"), "the §2.2 dispatch row must pin the cap to heavy.slots");
	const dispatchDesc = makeTools().find((t) => t.name === "devloop_dispatch")?.description ?? "";
	assert.ok(dispatchDesc.includes("heavy.slots"), "ground truth: the dispatch tool description pins the cap to heavy.slots");
});

// --- item 4: the hygiene clause reconciles the watchdog exception ------------

test("the §2.2 hygiene clause names the sanctioned watchdog exception (multipi-watch.sh --daemon)", () => {
	assert.ok(!sec2_2().includes("no long-lived processes started in the factory;"), "the bare ban contradicts the liveness spec and must be reconciled");
	assert.ok(sec2_2().includes("multipi-watch.sh --daemon"), "the reconciliation must name the exception");
	assert.ok(sec2_2().includes("sanctioned exception") || sec2_2().includes("only exception"), "the clause must state it is the sanctioned/only exception");
});

// --- item 5: the close mechanism is manual, with the PR-close nuance (narrowed) ---------

test("the §4 merge step documents the actual close mechanism and the NARROWED PR-close nuance (open, unmerged PRs only)", () => {
	const sec4 = designSection("4.");
	assert.ok(!sec4.includes("close via `Closes #n`"), "the stale 'close via Closes #n' claim must be gone");
	assert.ok(sec4.includes("gh issue close"), "the actual mechanism (the orchestrator's manual gh issue close) must be documented");
	assert.ok(sec4.includes("open, unmerged PR"), "the nuance must be narrowed: branch deletion closes an OPEN, unmerged PR (a merged PR is unaffected)");
	assert.ok(/deleting a branch[^.]*open, unmerged PR[^.]*closes that PR/i.test(sec4), "the narrowed delete-then-push wording must be documented");
	assert.ok(!sec4.includes("git push --delete"), "the post-merge `git push --delete` cleanup must not be claimed to close the (already merged) PR");
	assert.ok(sec4.includes("#55"), "the observed incident it cites (#55) must be attributed");
});

// --- item 6: the §5 key list is complete --------------------------------------

test("the §5 config key list carries the keys that exist (worktree_dir, orchestrator.tool_timeout_minutes, child_silence_minutes, cleanup.stale_days, policy, scenarios, factory, review.max_followup_depth)", () => {
	const sec5 = designSection("5.");
	for (const key of ["worktree_dir", "orchestrator.tool_timeout_minutes", "child_silence_minutes", "cleanup.stale_days", "policy", "scenarios", "factory", "review.max_followup_depth"]) {
		assert.ok(sec5.includes(key), `the §5 key list is missing ${key}`);
	}
});
