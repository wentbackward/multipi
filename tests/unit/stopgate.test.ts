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
