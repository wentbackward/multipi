import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPi, resolvePiInvocation } from "../../extension/src/child.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_PI = path.join(HERE, "..", "fake-pi");

test("resolvePiInvocation honours MULTIPI_PI_BIN", () => {
	const inv = resolvePiInvocation(["-p"], { MULTIPI_PI_BIN: FAKE_PI });
	assert.equal(inv.command, FAKE_PI);
	assert.deepEqual(inv.args, ["-p"]);
});

test("spawnPi streams updates and captures final output + usage", async () => {
	const updates: { finalText: string; toolCalls: string[] }[] = [];
	const res = await spawnPi({
		task: "do the thing",
		appendSystemPrompt: undefined,
		cwd: process.cwd(),
		env: { MULTIPI_PI_BIN: FAKE_PI },
		onUpdate: (u) => updates.push(u),
	});
	assert.equal(res.exitCode, 0);
	assert.equal(res.stopReason, "end");
	assert.match(res.finalText, /STATUS: DONE/);
	assert.equal(res.usage.output, 20);
	assert.equal(res.usage.cost, 0.001);
	assert.equal(res.model, "fake/model");
	assert.ok(res.toolCalls.length >= 1, "saw the tool result event");
	assert.ok(updates.length >= 1, "streamed at least one update");
});

test("spawnPi passes the task through as the trailing argument", async () => {
	const res = await spawnPi({
		task: "remember this exact phrase: alpha-bravo",
		cwd: process.cwd(),
		env: { MULTIPI_PI_BIN: FAKE_PI, FAKE_PI_ECHO_TASK: "1" },
	});
	assert.match(res.finalText, /alpha-bravo/);
});

test("spawnPi reports non-zero exits with stderr", async () => {
	const res = await spawnPi({
		task: "x",
		cwd: process.cwd(),
		env: { MULTIPI_PI_BIN: FAKE_PI, FAKE_PI_MODE: "fail" },
	});
	assert.equal(res.exitCode, 3);
	assert.match(res.stderr, /blew up/);
	assert.equal(res.aborted, false);
});

test("spawnPi abort kills the child (slow mode) and flags aborted", async () => {
	const ac = new AbortController();
	const p = spawnPi({
		task: "x",
		cwd: process.cwd(),
		env: { MULTIPI_PI_BIN: FAKE_PI, FAKE_PI_MODE: "slow", FAKE_PI_SLEEP: "5" },
		signal: ac.signal,
	});
	setTimeout(() => ac.abort(), 150);
	const res = await p;
	assert.notEqual(res.exitCode, 0);
	assert.equal(res.aborted, true);
});

test("spawnPi resolves the missing binary as an error result, not a throw", async () => {
	const res = await spawnPi({
		task: "x",
		cwd: process.cwd(),
		env: { MULTIPI_PI_BIN: "/nonexistent/pi-binary" },
	});
	assert.equal(res.exitCode, 1);
	assert.ok(res.stderr.length > 0);
});

test("spawnPi streams throttled status (elapsed, usage, activity) with the report", async () => {
	const updates: { finalText: string; toolCalls: string[]; status?: { elapsedMs: number; turns: number; usage: { cost: number; totalTokens: number }; activity: string } }[] = [];
	const res = await spawnPi({
		task: "measure me",
		cwd: process.cwd(),
		env: { MULTIPI_PI_BIN: FAKE_PI },
		onUpdate: (u) => updates.push(u),
	});
	assert.equal(res.exitCode, 0);
	const withStatus = updates.filter((u) => u.status);
	assert.ok(withStatus.length >= 1, "at least one status update");
	const last = withStatus[withStatus.length - 1];
	assert.equal(last.status!.turns, 1);
	assert.equal(last.status!.usage.cost, 0.001);
	assert.equal(last.status!.usage.totalTokens, 30);
	assert.ok(last.status!.elapsedMs >= 0);
	assert.match(last.status!.activity, /^bash/);
	assert.match(updates[updates.length - 1].finalText, /STATUS: DONE/);
});

test("spawnPi marks the child process with MULTIPI_CHILD (extension guard)", async () => {
	const os = await import("node:os");
	const fs = await import("node:fs");
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "multi-pi-env-")), "env.txt");
	await spawnPi({ task: "x", cwd: process.cwd(), env: { MULTIPI_PI_BIN: FAKE_PI, FAKE_PI_ECHO_ENV: f } });
	assert.equal(fs.readFileSync(f, "utf8"), "1");
});
