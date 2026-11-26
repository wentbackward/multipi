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
// Phased loop drive (ticket #147): the drive classes by ticket facts —
// dispatchable / delivered-awaiting-review / approved-awaiting-gate /
// gated-awaiting-merge — each clause NAMING the tickets it counts. A child
// in flight (implementer or review) drives nothing; the 2026-11-25 livelock
// (an identical unnamed count naming an impossible action) is the incident
// shape pinned below.
// ---------------------------------------------------------------------------

const incidentIssues: IssueInfo[] = [
	// #110: delivered, under review — a RUNNING review entry suppresses every clause.
	{ number: 110, blocked: false, deps: [], labels: ["dl/in-review"], implementer: "done", reviewRunning: true },
	// #146: open, unlabelled, no entries — the one truly dispatchable ticket.
	{ number: 146, blocked: false, deps: [] },
];

test("incident shape: an in-review delivered ticket with a running review drives nothing — the block names only the dispatchable ticket", () => {
	const d = evaluateStopGate({ ...base, issues: incidentIssues, running: 0, cap: 2 });
	assert.equal(d.action, "block");
	assert.equal(d.bumpCounter, false, "the loop drive is unbounded — it never bumps the bounded counter");
	assert.ok((d as { message: string }).message.includes("#146"), "the block names the ticket it counts:");
	assert.ok(!(d as { message: string }).message.includes("#110"), "the in-pipeline ticket is NOT named (no clause applies to it):");
	assert.match(d.message, /running 0\/2/);
});

test("a lone dl/in-progress ticket with a RUNNING implementer entry drives nothing (solo-implementer livelock) — settle passes", () => {
	const d = evaluateStopGate({
		...base,
		issues: [{ number: 110, blocked: false, deps: [], labels: ["dl/in-progress"], implementer: "running" }],
	});
	assert.equal(d.action, "pass", "the child in flight IS the loop's work — the gate must not re-inject a startable count");
});

test("a terminal implementer entry (crashed / interrupted / blocked) drives the dispatch clause (re-dispatch/resume) — unbounded", () => {
	for (const status of ["crashed", "interrupted", "blocked"] as const) {
		const d = evaluateStopGate({
			...base,
			issues: [{ number: 110, blocked: false, deps: [], labels: ["dl/in-progress"], implementer: status }],
		});
		assert.equal(d.action, "block", `implementer ${status}: the ticket must drive the dispatch clause`);
		assert.match(d.message, /startable/i);
		assert.ok((d as { message: string }).message.includes("#110"), "the dispatch clause names the ticket");
	}
});

test("dl/approved (not dl/gated) drives the gate clause, naming the ticket and the concrete tool (devloop_gate) — unbounded", () => {
	const d = evaluateStopGate({
		...base,
		issues: [{ number: 41, blocked: false, deps: [], labels: ["dl/approved"], implementer: "done" }],
	});
	assert.equal(d.action, "block");
	assert.ok(!(d as { message: string }).message.toLowerCase().includes("startable"), "an approved ticket is NOT dispatched");
	assert.ok((d as { message: string }).message.includes("#41"), "the gate clause names the ticket");
	assert.ok((d as { message: string }).message.includes("devloop_gate"), "the gate clause names the concrete tool");
});

test("dl/gated drives the merge clause, naming the ticket and the concrete tool (devloop_merge) — unbounded", () => {
	const d = evaluateStopGate({
		...base,
		issues: [{ number: 42, blocked: false, deps: [], labels: ["dl/gated"], implementer: "done" }],
		currentBlocks: 999, // still unbounded at an absurd bounded-counter count
	});
	assert.equal(d.action, "block");
	assert.ok(!(d as { message: string }).message.toLowerCase().includes("startable"), "a gated ticket is NOT dispatched or re-gated");
	assert.ok((d as { message: string }).message.includes("#42"), "the merge clause names the ticket");
	assert.ok((d as { message: string }).message.includes("devloop_merge"), "the merge clause names the concrete tool");
});

// ---------------------------------------------------------------------------
// Late-report loop drive (ticket #121/#124): a done implementer entry with no
// RUNNING review is work-to-do — owned by the review clause, never the
// dispatch clause (a label anomaly must not re-dispatch the implementer).
// ---------------------------------------------------------------------------

test("pending review: a delivered branch awaiting the reviewer blocks settlement (unbounded, no counter bump)", () => {
	const d = evaluateStopGate({
		...base,
		issues: [{ number: 103, blocked: false, deps: [], labels: ["dl/in-progress"], implementer: "done" }],
	});
	assert.equal(d.action, "block");
	assert.equal(d.bumpCounter, false, "loop drive is unbounded — the harness invariant, not a bounded block");
	assert.match(d.message, /#103/);
	assert.match(d.message, /reviewer/i);
	assert.ok(!(d as { message: string }).message.toLowerCase().includes("startable"), "a delivered ticket is driven by the REVIEW clause, not re-dispatched");
	// even at an absurd block count the drive stands (unbounded)
	const d2 = evaluateStopGate({
		...base,
		issues: [{ number: 103, blocked: false, deps: [], labels: ["dl/in-progress"], implementer: "done" }],
		currentBlocks: 999,
	});
	assert.equal(d2.action, "block");
});

test("pending review: the clause follows the delivered entry, not the label (unlabelled done entry claims the review, not the dispatch)", () => {
	const d = evaluateStopGate({
		...base,
		issues: [{ number: 103, blocked: false, deps: [], implementer: "done" }], // no pipeline label at all
	});
	assert.equal(d.action, "block");
	assert.ok((d as { message: string }).message.includes("await the reviewer"), "the review clause claims the delivered branch:");
	assert.ok(!(d as { message: string }).message.toLowerCase().includes("startable"), "the dispatch clause must not claim it");
});

test("pending review: only a RUNNING review suppresses the clause — a terminal review entry of any kind re-arms it", () => {
	// Terminal review = reviewRunning false (the caller sets it true only for `running`):
	const rearm = evaluateStopGate({
		...base,
		issues: [{ number: 124, blocked: false, deps: [], labels: ["dl/in-review"], implementer: "done", reviewRunning: false }],
	});
	assert.equal(rearm.action, "block");
	assert.ok((rearm as { message: string }).message.includes("await the reviewer"), "the crashed/interrupted reviewer leaves the branch unreviewed:");
	// The live running reviewer is the incident shape: NOTHING drives.
	const live = evaluateStopGate({
		...base,
		issues: [{ number: 124, blocked: false, deps: [], labels: ["dl/in-review"], implementer: "done", reviewRunning: true }],
	});
	assert.equal(live.action, "pass", "delivered + running review = the incident shape: no clause applies");
});

test("pending review: absent facts leave the dispatch decisions byte-identical", () => {
	assert.equal(evaluateStopGate(base).action, "pass");
	const solo = evaluateStopGate({ ...base, issues: [{ number: 7, blocked: false, deps: [] }] });
	const withNoEntry = evaluateStopGate({ ...base, issues: [{ number: 7, blocked: false, deps: [], implementer: undefined, reviewRunning: undefined }] });
	assert.equal(solo.action, "block");
	assert.equal((solo as { message: string }).message, (withNoEntry as { message: string }).message, "the dispatch clause alone is unchanged when no entries exist");
});

test("pending review: dispatchable tickets AND delivered branches both drive, each named once", () => {
	const d = evaluateStopGate({
		...base,
		issues: [
			{ number: 7, blocked: false, deps: [] },
			{ number: 9, blocked: false, deps: [], labels: ["dl/in-progress"], implementer: "done" },
			{ number: 10, blocked: false, deps: [], labels: ["dl/in-review"], implementer: "done" },
		],
	});
	assert.equal(d.action, "block");
	assert.match(d.message, /startable/i);
	assert.match(d.message, /#7/);
	assert.match(d.message, /#9/);
	assert.match(d.message, /#10/);
	assert.match(d.message, /reviewer/i);
});

test("pending review: red fast check and dirty tree outrank the loop drive (priority ordering)", () => {
	const red = evaluateStopGate({
		...base,
		fastCheckPassed: false,
		fastCheckTail: "lint exploded",
		issues: [{ number: 9, blocked: false, deps: [], labels: ["dl/in-progress"], implementer: "done" }],
	});
	assert.equal(red.action, "block");
	assert.equal(red.bumpCounter, true);
	assert.match(red.message, /lint exploded/);
	assert.ok(!red.message.includes("#9"), "the fast-check message is not diluted by the drive clause");
});

// ---------------------------------------------------------------------------
// Drive repeat breaker (ticket #147): consecutive settles against an UNCHANGED
// drive state block at most K times, then the gate passes with an audit line;
// any state change re-blocks (the count restarts).
// ---------------------------------------------------------------------------

function mustBlock(d: import("../../extension/src/stopgate.ts").StopGateDecision): { message: string; bumpCounter: boolean; fingerprint?: string } {
	if (d.action !== "block") throw new Error(`expected a block, got: ${JSON.stringify(d)}`);
	return d;
}

test("drive repeat breaker: identical drive state blocks 3 times, the 4th settle passes with an audit line", () => {
	const attempt = (last: string | undefined, blocks: number) =>
		evaluateStopGate({ ...base, issues: incidentIssues, running: 0, cap: 2, lastDriveFingerprint: last, driveBlocks: blocks });
	// 1st, 2nd, 3rd identical attempt: block, carrying the same fingerprint.
	const b1 = mustBlock(attempt(undefined, 0));
	assert.ok(b1.fingerprint, "a drive block carries its fingerprint");
	const b2 = mustBlock(attempt(b1.fingerprint, 1));
	const b3 = mustBlock(attempt(b1.fingerprint, 2));
	assert.equal(b2.fingerprint, b1.fingerprint, "the unchanged state carries the same fingerprint");
	assert.equal(b3.fingerprint, b1.fingerprint);
	// 4th identical attempt: the gate PASSES with an audit line (console, not the counter file).
	const p4 = attempt(b1.fingerprint, 3);
	assert.equal(p4.action, "pass");
	assert.ok(p4.audit, "the release emits an audit line");
	// The release is sticky while the state stays unchanged: it does not re-block.
	const p5 = attempt(b1.fingerprint, 3);
	assert.equal(p5.action, "pass");
	assert.ok(p5.audit);
});

test("drive repeat breaker: a changed drive state re-blocks — the count restarts at the new state", () => {
	const changed = [...incidentIssues, { number: 148, blocked: false, deps: [] }];
	const attempt = (issues: IssueInfo[], last: string | undefined, blocks: number) =>
		evaluateStopGate({ ...base, issues, running: 0, cap: 2, lastDriveFingerprint: last, driveBlocks: blocks });
	const b1 = mustBlock(attempt(incidentIssues, undefined, 0));
	const b2 = mustBlock(attempt(changed, b1.fingerprint, 3));
	assert.notEqual(b2.fingerprint, b1.fingerprint, "a different state is a FRESH drive state — it blocks again with a fresh fingerprint");
	// Returning to the FIRST state (after the interruption) re-blocks too: the stored
	// fingerprint is the intermediate state's, so the reverted state is new again.
	const b3 = mustBlock(attempt(incidentIssues, b2.fingerprint, 1));
	assert.notEqual(b3.fingerprint, b2.fingerprint, "the reverted state re-blocks — the count restarted at the intermediate state");
});

test("drive fingerprint: running, cap and each clause list flip the fingerprint", () => {
	const gated: IssueInfo = { number: 42, blocked: false, deps: [], labels: ["dl/gated"], implementer: "done" };
	const pending: IssueInfo = { number: 43, blocked: false, deps: [], labels: ["dl/in-progress"], implementer: "done" };
	const fp = (extra: Partial<typeof base> = {}, issues: IssueInfo[] = [gated]): string => {
		const d = evaluateStopGate({ ...base, issues, ...extra });
		if (d.action !== "block") throw new Error("expected a drive block");
		assert.ok(d.fingerprint);
		return d.fingerprint!;
	};
	const ref = fp();
	assert.notEqual(fp({ running: 2 }), ref, "running moves the fingerprint");
	assert.notEqual(fp({ cap: 4 }), ref, "cap moves the fingerprint");
	assert.notEqual(fp({}, [pending]), ref, "the pending clause list moves the fingerprint");
	assert.notEqual(fp({}, [gated, pending]), ref, "adding a clause list moves the fingerprint");
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
