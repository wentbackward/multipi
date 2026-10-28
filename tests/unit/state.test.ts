import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { readState, writeState, pruneDead, runningCount, type DispatchState } from "../../extension/src/state.ts";

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
		a: { pid: alive.pid, role: "implementer", branch: "b", worktree: "/w", startedAt: 1, status: "running" },
		b: { pid: dead.pid, role: "implementer", branch: "b", worktree: "/w", startedAt: 1, status: "interrupted" },
		c: { pid: dead.pid, role: "implementer", branch: "b", worktree: "/w", startedAt: 1, status: "running" },
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
	const st: DispatchState = { x: { pid: dead.pid, role: "implementer", branch: "b", worktree: "/w", startedAt: 1, status: "running" } };
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
