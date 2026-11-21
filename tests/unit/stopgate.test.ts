import assert from "node:assert/strict";
import test from "node:test";
import { evaluateStopGate, countStartable } from "../../extension/src/stopgate.ts";
import type { IssueInfo } from "../../extension/src/stopgate.ts";

const base = {
	fastCheckPassed: true,
	fastCheckTail: "",
	dirty: false,
	requireCleanTree: true,
	maxBlocks: 5,
	currentBlocks: 0,
	issues: [] as IssueInfo[],
	closed: [] as number[],
	inFlight: [] as number[],
	running: 0,
	cap: 3,
};

test("all clean, nothing open -> pass", () => {
	const d = evaluateStopGate(base);
	assert.equal(d.action, "pass");
});

test("red fast check -> bounded block, counter bumps", () => {
	const d = evaluateStopGate({ ...base, fastCheckPassed: false, fastCheckTail: "2 tests failed" });
	assert.equal(d.action, "block");
	assert.equal(d.bumpCounter, true);
	assert.match(d.message, /2 tests failed/);
});

test("red fast check at max blocks -> give up (pass, counter reset)", () => {
	const d = evaluateStopGate({ ...base, fastCheckPassed: false, fastCheckTail: "x", currentBlocks: 5 });
	assert.equal(d.action, "pass");
	assert.equal(d.gaveUp, true);
});

test("dirty tree with requireCleanTree -> bounded block", () => {
	const d = evaluateStopGate({ ...base, dirty: true });
	assert.equal(d.action, "block");
	assert.match(d.message, /uncommitted/i);
});

test("dirty tree with requireCleanTree=false -> pass", () => {
	const d = evaluateStopGate({ ...base, dirty: true, requireCleanTree: false });
	assert.equal(d.action, "pass");
});

test("startable ticket + free slot -> loop-drive block, unbounded, no counter bump", () => {
	const d = evaluateStopGate({ ...base, issues: [{ number: 7, blocked: false, deps: [] }], currentBlocks: 999 });
	assert.equal(d.action, "block");
	assert.equal(d.bumpCounter, false);
	assert.match(d.message, /startable/i);
	assert.match(d.message, /slot/i);
});

test("all open tickets blocked -> pass", () => {
	const d = evaluateStopGate({ ...base, issues: [{ number: 7, blocked: true, deps: [] }] });
	assert.equal(d.action, "pass");
});

test("startable but at capacity -> pass (children will report)", () => {
	const d = evaluateStopGate({ ...base, issues: [{ number: 7, blocked: false, deps: [] }], running: 3 });
	assert.equal(d.action, "pass");
});

test("ticket waiting on an open dependency is not startable", () => {
	const d = evaluateStopGate({ ...base, issues: [{ number: 9, blocked: false, deps: [7] }], closed: [] });
	assert.equal(d.action, "pass");
	const d2 = evaluateStopGate({ ...base, issues: [{ number: 9, blocked: false, deps: [7] }], closed: [7] });
	assert.equal(d2.action, "block");
	// A dep that is merely in flight satisfies the loop-drive definition of startable.
	const d3 = evaluateStopGate({ ...base, issues: [{ number: 9, blocked: false, deps: [7] }], inFlight: [7] });
	assert.equal(d3.action, "block");
});

test("red fast check outranks the loop drive (priority ordering)", () => {
	const d = evaluateStopGate({
		...base,
		fastCheckPassed: false,
		fastCheckTail: "lint exploded",
		issues: [{ number: 7, blocked: false, deps: [] }],
	});
	assert.equal(d.action, "block");
	assert.match(d.message, /lint exploded/);
	assert.equal(d.bumpCounter, true);
});

test("countStartable counts unblocked issues whose deps are all closed", () => {
	const issues: IssueInfo[] = [
		{ number: 1, blocked: false, deps: [] },
		{ number: 2, blocked: true, deps: [] },
		{ number: 3, blocked: false, deps: [2] },
		{ number: 4, blocked: false, deps: [1] },
	];
	assert.equal(countStartable(issues, []), 1); // only #1
	assert.equal(countStartable(issues, [2]), 2); // #3 unblocks
	assert.equal(countStartable(issues, [1, 2]), 3); // #4 unblocks too
	assert.equal(countStartable(issues, [], [2]), 2); // in-flight counts as satisfied
	assert.equal(countStartable(issues, [1], [2]), 3);
});

// ---------------------------------------------------------------------------
// Late-report loop drive (ticket #121): a child that delivered a branch (done)
// with no reviewer dispatched is work-to-do — the stop-gate must not settle.
// ---------------------------------------------------------------------------

test("pending review: a delivered branch awaiting the reviewer blocks settlement (unbounded, no counter bump)", () => {
	const d = evaluateStopGate({ ...base, pendingReviews: [103] });
	assert.equal(d.action, "block");
	assert.equal(d.bumpCounter, false, "loop drive is unbounded — the harness invariant, not a bounded block");
	assert.match(d.message, /#103/);
	assert.match(d.message, /reviewer/i);
	// even at an absurd block count the drive stands (unbounded)
	const d2 = evaluateStopGate({ ...base, pendingReviews: [103], currentBlocks: 999 });
	assert.equal(d2.action, "block");
});

test("pending review: absent or empty pendingReviews leaves the existing decisions byte-identical", () => {
	assert.equal(evaluateStopGate(base).action, "pass");
	assert.equal(evaluateStopGate({ ...base, pendingReviews: [] }).action, "pass");
	const solo = evaluateStopGate({ ...base, issues: [{ number: 7, blocked: false, deps: [] }] });
	const withEmpty = evaluateStopGate({ ...base, issues: [{ number: 7, blocked: false, deps: [] }], pendingReviews: [] });
	assert.equal(solo.action, "block");
	assert.equal((solo as { message: string }).message, (withEmpty as { message: string }).message, "the startable clause alone is unchanged when there is no pending review");
});

test("pending review: startable tickets AND pending reviews both drive, each named once", () => {
	const d = evaluateStopGate({ ...base, issues: [{ number: 7, blocked: false, deps: [] }], pendingReviews: [9, 10] });
	assert.equal(d.action, "block");
	assert.match(d.message, /startable/i);
	assert.match(d.message, /#9/);
	assert.match(d.message, /#10/);
	assert.match(d.message, /reviewer/i);
});

test("pending review: red fast check and dirty tree outrank the loop drive (priority ordering)", () => {
	const red = evaluateStopGate({ ...base, fastCheckPassed: false, fastCheckTail: "lint exploded", pendingReviews: [9] });
	assert.equal(red.action, "block");
	assert.equal(red.bumpCounter, true);
	assert.match(red.message, /lint exploded/);
	assert.ok(!red.message.includes("#9"), "the fast-check message is not diluted by the drive clause");
});

// ---------------------------------------------------------------------------
// Startability rule with the scenario store on (dark-factory spec §4):
// a ticket is startable only if the store holds a valid t<ticket>- scenario.
// ---------------------------------------------------------------------------

test("countStartable: store off (absent or explicit false) ignores coverage — identical decisions to today", () => {
	const issues: IssueInfo[] = [
		{ number: 7, blocked: false, deps: [] },
		{ number: 8, blocked: false, deps: [] },
	];
	assert.equal(countStartable(issues, []), 2);
	assert.equal(countStartable(issues, [], [], { on: false, covered: [7] }), 2);
	assert.equal(countStartable(issues, [], [], { on: false, covered: [] }), 2);
});

test("countStartable: store on — only tickets covered by a valid t<n>- scenario count", () => {
	const issues: IssueInfo[] = [
		{ number: 7, blocked: false, deps: [] }, // covered
		{ number: 8, blocked: false, deps: [] }, // uncovered
		{ number: 9, blocked: true, deps: [] }, // blocked, covered — blocked still wins
		{ number: 10, blocked: false, deps: [7] }, // uncovered AND dependent
	];
	assert.equal(countStartable(issues, [], [], { on: true, covered: [7, 9] }), 1); // only #7
	assert.equal(countStartable(issues, [], [], { on: true, covered: [7, 8, 9] }), 2); // #7 and #8
	assert.equal(countStartable(issues, [], [], { on: true, covered: [] }), 0); // nothing covered
	// dependency logic still applies ON TOP of coverage
	const depIssues: IssueInfo[] = [{ number: 9, blocked: false, deps: [7] }, { number: 7, blocked: false, deps: [] }];
	assert.equal(countStartable(depIssues, [], [], { on: true, covered: [7, 9] }), 1); // #9 waits on #7
	assert.equal(countStartable(depIssues, [7], [], { on: true, covered: [7, 9] }), 2); // #7 closed frees #9
});

test("store on + covered ticket + free slot -> loop-drive block (unbounded)", () => {
	const d = evaluateStopGate({
		...base,
		issues: [{ number: 7, blocked: false, deps: [] }],
		currentBlocks: 999,
		scenariosOn: true,
		covered: [7],
	});
	assert.equal(d.action, "block");
	assert.equal(d.bumpCounter, false);
	assert.match(d.message, /startable/i);
});

test("store on + uncovered ticket is not startable — stop-gate passes when nothing else is pending", () => {
	const d = evaluateStopGate({ ...base, issues: [{ number: 7, blocked: false, deps: [] }], scenariosOn: true, covered: [] });
	assert.equal(d.action, "pass");
	const d2 = evaluateStopGate({ ...base, issues: [{ number: 7, blocked: false, deps: [] }], scenariosOn: true, covered: [42] });
	assert.equal(d2.action, "pass"); // a foreign ticket's scenario does not cover #7
});

test("store on: mixed covered/uncovered board blocks only on the covered share", () => {
	const d = evaluateStopGate({
		...base,
		issues: [
			{ number: 7, blocked: false, deps: [] },
			{ number: 8, blocked: false, deps: [] },
		],
		scenariosOn: true,
		covered: [8],
	});
	assert.equal(d.action, "block");
	assert.match(d.message, /1 ticket\(s\) are startable/);
	// at capacity the covered ticket no longer forces continuation
	const d2 = evaluateStopGate({ ...base, issues: [{ number: 8, blocked: false, deps: [] }], scenariosOn: true, covered: [8], running: 3 });
	assert.equal(d2.action, "pass");
});
