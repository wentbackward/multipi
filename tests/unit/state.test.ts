import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { readState, writeState, updateState, pruneDead, reapDead, reconcileState, runningCount, unseenTerminals, ackTerminals, readSeen, terminalTime, type DispatchState } from "../../extension/src/state.ts";

test("write then read round-trips", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "st-"));
	const me = process.pid;
	const st: DispatchState = { "7": { pid: me, role: "implementer", branch: "feat/7-x", worktree: "/wt", startedAt: 1, status: "running" } };
	writeState(dir, st);
	assert.deepEqual(readState(dir), st);
});

test("runningCount counts live running entries only", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "st-"));
	const alive = spawn("sleep", ["30"]);
	const dead = spawn("sleep", ["0.2"]);
	await new Promise((r) => dead.on("close", r));
	const st: DispatchState = {
		a: { pid: alive.pid!, role: "implementer", branch: "b", worktree: "/w", startedAt: 1, status: "running" },
		b: { pid: dead.pid!, role: "implementer", branch: "b", worktree: "/w", startedAt: 1, status: "interrupted" },
		c: { pid: dead.pid!, role: "implementer", branch: "b", worktree: "/w", startedAt: 1, status: "running" },
	};
	writeState(dir, st);
	const read = readState(dir);
	assert.equal(runningCount(pruneDead(read)), 1);
	alive.kill("SIGKILL");
});

test("pruneDead flips dead running entries to crashed without deleting them", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "st-"));
	const dead = spawn("sleep", ["0.2"]);
	await new Promise((r) => dead.on("close", r));
	const st: DispatchState = { x: { pid: dead.pid!, role: "implementer", branch: "b", worktree: "/w", startedAt: 1, status: "running" } };
	const pruned = pruneDead(st);
	assert.equal(pruned.x.status, "crashed");
	assert.ok("x" in pruned, "history kept");
});

test("missing or corrupt state file reads as empty", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "st-"));
	assert.deepEqual(readState(dir), {});
	writeFileSync(path.join(dir, "dispatch.json"), "{not json");
	assert.deepEqual(readState(dir), {});
});

test("writeState is atomic (tmp+rename) and creates the dir", () => {
	const dir = path.join(mkdtempSync(path.join(tmpdir(), "st-")), "nested", "state");
	writeState(dir, {});
	assert.deepEqual(readState(dir), {});
});

test("concurrent updateState cycles keep every entry (lost-update guard)", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "multipi-state-"));
	for (let i = 0; i < 20; i++) {
		// Interleave two writers at the same tick; the lock must serialise them.
		updateState(dir, (s) => {
			s[`a-${i}`] = { pid: 0, role: "r", worktree: "/w", startedAt: 0, status: "running" };
		});
		updateState(dir, (s) => {
			s[`b-${i}`] = { pid: 0, role: "r", worktree: "/w", startedAt: 0, status: "running" };
		});
	}
	const st = readState(dir);
	assert.equal(Object.keys(st).length, 40, "no lost updates");
});

// ---------------------------------------------------------------------------
// Stale-running reconciliation (ticket #121): a child that outlives its bounded
// dispatch tool call must be reclaimed — a dead pid is a crashed child, with
// endedAt, so the slot frees and re-dispatch is allowed.
// ---------------------------------------------------------------------------

const GRACE = 60_000; // the spawn grace (state.ts RECONCILE_GRACE_MS); ages are driven past it

test("reapDead: a running entry with a dead pid is reclassified crashed with endedAt set", async () => {
	const dead = spawn("sleep", ["0.2"]);
	await new Promise((r) => dead.on("close", r));
	const st: DispatchState = { x: { pid: dead.pid!, role: "implementer", worktree: "/w", startedAt: Date.now() - GRACE - 1000, status: "running" } };
	assert.equal(reapDead(st), true, "the reap reports a change");
	assert.equal(st.x.status, "crashed");
	assert.equal(typeof st.x.endedAt, "number", "endedAt is stamped at the reclassification");
	assert.ok(st.x.endedAt! >= Date.now() - 60_000 && st.x.endedAt! <= Date.now(), "endedAt is roughly now");
});

test("reapDead: a running entry with a LIVE pid is left running (no false reap)", async () => {
	const alive = spawn("sleep", ["30"]);
	try {
		const st: DispatchState = { x: { pid: alive.pid!, role: "implementer", worktree: "/w", startedAt: Date.now() - GRACE - 1000, status: "running" } };
		assert.equal(reapDead(st), false);
		assert.equal(st.x.status, "running");
		assert.equal(st.x.endedAt, undefined);
	} finally {
		alive.kill("SIGKILL");
	}
});

test("reapDead: a fresh pid-less entry (the spawn phase) is NOT reaped — grace protects the pid-stamp window", () => {
	const st: DispatchState = { x: { pid: 0, role: "implementer", worktree: "/w", startedAt: Date.now() - 1000, status: "running" } };
	assert.equal(reapDead(st), false, "pid 0 inside the grace reads as spawning, not dead");
	assert.equal(st.x.status, "running");
});

test("reapDead: a pid-less entry PAST the grace is reaped (the pid-never-arrived #104 shape)", () => {
	const st: DispatchState = { x: { pid: 0, role: "implementer", worktree: "/w", startedAt: Date.now() - GRACE - 1000, status: "running" } };
	assert.equal(reapDead(st), true);
	assert.equal(st.x.status, "crashed");
	assert.equal(typeof st.x.endedAt, "number");
});

test("reapDead: non-running entries are untouched and repeated reaps are idempotent", async () => {
	const dead = spawn("sleep", ["0.2"]);
	await new Promise((r) => dead.on("close", r));
	const st: DispatchState = {
		term: { pid: dead.pid!, role: "implementer", worktree: "/w", startedAt: 1, status: "done", endedAt: 123 },
		run: { pid: dead.pid!, role: "implementer", worktree: "/w", startedAt: Date.now() - GRACE - 1000, status: "running" },
	};
	assert.equal(reapDead(st), true);
	assert.equal(st.term.status, "done");
	assert.equal(st.term.endedAt, 123, "an existing endedAt is never rewritten");
	assert.equal(st.run.status, "crashed");
	const firstEnded = st.run.endedAt!;
	assert.equal(reapDead(st), false, "a second reap over settled state changes nothing");
	assert.equal(st.run.endedAt, firstEnded, "endedAt is stable across reaps");
});

test("reconcileState: persists the reap — a subsequent plain read shows crashed + endedAt", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "st-rec-"));
	const dead = spawn("sleep", ["0.2"]);
	await new Promise((r) => dead.on("close", r));
	writeState(dir, { x: { pid: dead.pid!, role: "implementer", worktree: "/w", startedAt: Date.now() - GRACE - 1000, status: "running" } });
	const { state, changed } = reconcileState(dir);
	assert.equal(changed, true);
	assert.equal(state.x.status, "crashed");
	const reread = readState(dir);
	assert.equal(reread.x.status, "crashed", "the reclassification survives a plain read (the slot is free for everyone, not just this process)");
	assert.equal(typeof reread.x.endedAt, "number");
});

test("reconcileState: nothing to reap ⇒ no write (the file's mtime is untouched)", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "st-rec2-"));
	const st: DispatchState = { x: { pid: process.pid, role: "implementer", worktree: "/w", startedAt: 1, status: "running" } };
	writeState(dir, st);
	const f = path.join(dir, "dispatch.json");
	const before = statSync(f).mtimeMs;
	const { changed } = reconcileState(dir);
	assert.equal(changed, false);
	assert.equal(statSync(f).mtimeMs, before, "no spurious rewrite");
});

test("reapDead is wired into pruneDead (existing callers reap with endedAt too)", async () => {
	const dead = spawn("sleep", ["0.2"]);
	await new Promise((r) => dead.on("close", r));
	const st: DispatchState = { x: { pid: dead.pid!, role: "implementer", worktree: "/w", startedAt: Date.now() - GRACE - 1000, status: "running" } };
	const out = pruneDead(st);
	assert.equal(out.x.status, "crashed");
	assert.equal(typeof out.x.endedAt, "number");
});

// ---------------------------------------------------------------------------
// The late-report surface (ticket #121): terminal children the orchestrator has
// not seen yet, acked into a separate seen-ledger (never the dispatch state).
// ---------------------------------------------------------------------------

test("unseenTerminals: terminal entries not in the seen ledger surface, keyed, in one pass", () => {
	const t0 = 1_000_000, t1 = 2_000_000;
	const st: DispatchState = {
		"7": { pid: 1, role: "implementer", worktree: "/w", startedAt: 1, status: "done", endedAt: t0 },
		"8": { pid: 1, role: "implementer", worktree: "/w", startedAt: 1, status: "crashed", endedAt: t1 },
		"9": { pid: 1, role: "implementer", worktree: "/w", startedAt: 1, status: "running" },
		"10": { pid: 1, role: "implementer", worktree: "/w", startedAt: 1, status: "done", endedAt: 3_000_000 }, // seen
	};
	const seen = { "10": 3_000_000 };
	const late = unseenTerminals(st, seen);
	assert.deepEqual(late.map(([k]) => k).sort(), ["7", "8"], "exactly the un-acked terminals surface");
	assert.equal(late.length, 2);
});

test("unseenTerminals: a re-terminal (re-dispatch) entry with a NEW endedAt resurfaces after its earlier ack", () => {
	const st: DispatchState = {
		"7": { pid: 1, role: "implementer", worktree: "/w", startedAt: 1, status: "crashed", endedAt: 5_000_000 },
	};
	const seen = { "7": 4_000_000 }; // the FIRST generation was acked
	assert.deepEqual(unseenTerminals(st, seen).map(([k]) => k), ["7"], "a fresh terminal beats the stale ack");
});

test("unseenTerminals: a legacy terminal without endedAt acks on startedAt (forward-compat)", () => {
	const st: DispatchState = { "7": { pid: 1, role: "implementer", worktree: "/w", startedAt: 777, status: "done" } };
	assert.equal(terminalTime(st["7"]), 777);
	assert.deepEqual(unseenTerminals(st, {}).map(([k]) => k), ["7"]);
	assert.deepEqual(unseenTerminals(st, { "7": 777 }), []);
});

test("ackTerminals: the ledger persists and merges (later acks keep earlier ones)", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "st-seen-"));
	assert.deepEqual(readSeen(dir), {}, "a missing ledger reads empty (fail soft)");
	ackTerminals(dir, { "7": 100 });
	ackTerminals(dir, { "8": 200 });
	assert.deepEqual(readSeen(dir), { "7": 100, "8": 200 });
	writeFileSync(path.join(dir, "reconcile-seen.json"), "{corrupt");
	assert.deepEqual(readSeen(dir), {}, "a corrupt ledger reads empty (history is lossy)");
});

test("ackTerminals: a no-op ack does not rewrite the ledger (write-only-on-change, no mtime churn)", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "st-seen-noop-"));
	const f = path.join(dir, "reconcile-seen.json");
	ackTerminals(dir, { "7": 100 });
	const before = statSync(f);
	ackTerminals(dir, { "7": 100 }); // identical values: nothing changed
	const after = statSync(f);
	assert.equal(after.ino, before.ino, "an identical ack leaves the file alone (no rename over it)");
	assert.equal(after.mtimeMs, before.mtimeMs, "an identical ack does not churn the mtime");
	assert.deepEqual(readSeen(dir), { "7": 100 });
	ackTerminals(dir, { "7": 999 }); // a real change still writes
	assert.notEqual(statSync(f).ino, before.ino, "a changed ack rewrites the ledger");
	assert.deepEqual(readSeen(dir), { "7": 999 });
});
