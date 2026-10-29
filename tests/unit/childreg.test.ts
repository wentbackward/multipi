import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	addChild,
	updateChild,
	runningChildren,
	liveChildren,
	onChange,
	resetChildren,
	formatElapsed,
	formatTokens,
	renderChildBar,
} from "../../extension/src/childreg.ts";

afterEach(() => resetChildren());

const base = {
	key: "2",
	role: "implementer",
	ticket: 2,
	branch: "multipi-issue-2-metrics",
	worktree: "/wt/2",
	startedAt: 1_000_000,
	status: "running" as const,
	turns: 0,
	usage: { input: 0, output: 0, cost: 0, totalTokens: 0 },
	activity: "starting",
	events: [],
};

test("add + running filter", () => {
	addChild({ ...base });
	addChild({ ...base, key: "3", ticket: 3, status: "done", endedAt: 2_000_000 });
	assert.equal(runningChildren().length, 1);
	assert.equal(runningChildren()[0].key, "2");
});

test("updateChild mutates live child and caps the event ring", () => {
	addChild({ ...base });
	for (let i = 0; i < 60; i++) {
		updateChild("2", { turns: i }, { at: 1_000_000 + i, kind: "tool", text: `bash: cmd-${i}` });
	}
	const c = liveChildren().find((x) => x.key === "2")!;
	assert.equal(c.turns, 59);
	assert.ok(c.events.length <= 40, `ring capped, got ${c.events.length}`);
	assert.equal(c.events[c.events.length - 1].text, "bash: cmd-59");
	assert.equal(c.events[0].text, "bash: cmd-20");
});

test("finished children are kept (cap 8) and ordered newest-first in liveChildren", () => {
	addChild({ ...base, key: "r", role: "code-reviewer", ticket: 1, status: "done", endedAt: 10 });
	for (let i = 0; i < 10; i++) {
		addChild({ ...base, key: `f${i}`, role: "implementer", ticket: 100 + i, status: "crashed", endedAt: 100 + i });
	}
	const fin = liveChildren().filter((c) => c.status !== "running");
	assert.equal(fin.length, 8, "finished kept within cap");
	const times = fin.map((c) => c.endedAt ?? 0);
	assert.deepEqual(times, [...times].sort((a, b) => (b ?? 0) - (a ?? 0)), "newest first");
	assert.ok(!fin.some((c) => c.key === "f0"), "oldest evicted");
});

test("onChange fires on add and update, unsubscribe stops it", () => {
	let n = 0;
	const off = onChange(() => n++);
	addChild({ ...base });
	updateChild("2", { turns: 1 });
	assert.equal(n, 2);
	off();
	addChild({ ...base, key: "9" });
	assert.equal(n, 2);
});

test("formatting helpers", () => {
	assert.equal(formatElapsed(0), "00:00");
	assert.equal(formatElapsed(95_000), "01:35");
	assert.equal(formatElapsed(3_600_000 + 61_000), "1:01:01");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(12_300), "12.3k");
	assert.equal(formatTokens(2_500_000), "2.5M");
});

test("renderChildBar: one line per running child, empty list -> no lines", () => {
	const running = [
		{ ...base, startedAt: 0, usage: { input: 100, output: 200, cost: 1.44, totalTokens: 132_000 }, activity: "bash: npm test" },
	];
	const lines = renderChildBar(running, 130_000);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^● implementer #2 · 02:10 · tok 132k · \$1\.44 · bash: npm test$/);
	assert.deepEqual(renderChildBar([], 130_000), []);
	assert.deepEqual(renderChildBar([{ ...running[0], status: "done" } as never], 130_000), []);
});

test("renderChildBar truncates to width", () => {
	const running = [{ ...base, startedAt: 0, usage: { input: 0, output: 0, cost: 0, totalTokens: 10 }, activity: "bash: very long command" }];
	const lines = renderChildBar(running, 130_000, 25);
	assert.equal(lines[0].length, 25);
	assert.ok(lines[0].endsWith("…"));
});
