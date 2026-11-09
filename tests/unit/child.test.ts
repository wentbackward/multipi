import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn as cpSpawn } from "node:child_process";
import { spawnPi, resolvePiInvocation, killGroup, groupAlive, groupMemberCount } from "../../extension/src/child.ts";

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

test("spawnPi stamps MULTIPI_CHILD_ROLE next to MULTIPI_CHILD (role guard seam)", async () => {
	const os = await import("node:os");
	const fs = await import("node:fs");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-pi-role-"));
	const f = path.join(dir, "role.txt");
	const c = path.join(dir, "child.txt");
	await spawnPi({
		task: "x", cwd: process.cwd(), role: "implementer",
		env: { MULTIPI_PI_BIN: FAKE_PI, FAKE_PI_ECHO_ROLE: f, FAKE_PI_ECHO_ENV: c },
	});
	assert.equal(fs.readFileSync(c, "utf8"), "1", "MULTIPI_CHILD still set");
	assert.equal(fs.readFileSync(f, "utf8"), "implementer");
});

test("spawnPi omits MULTIPI_CHILD_ROLE when no role is given", async () => {
	const os = await import("node:os");
	const fs = await import("node:fs");
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "multi-pi-role-")), "role.txt");
	await spawnPi({ task: "x", cwd: process.cwd(), env: { MULTIPI_PI_BIN: FAKE_PI, FAKE_PI_ECHO_ROLE: f } });
	assert.equal(fs.readFileSync(f, "utf8"), "unset");
});

// --- watchdog: a silent child is killed, not waited on -----------------------

test("watchdog kills a child that emits no output for silenceMs", { timeout: 30_000 }, async () => {
	const t0 = Date.now();
	const res = await spawnPi({
		task: "hang",
		cwd: process.cwd(),
		env: { MULTIPI_PI_BIN: FAKE_PI, FAKE_PI_HANG: "1" },
		silenceMs: 900,
		killGraceMs: 400,
	});
	const elapsed = Date.now() - t0;
	assert.equal(res.aborted, false, "watchdog is not an abort");
	assert.equal(res.exitCode, 124);
	assert.match(res.errorMessage ?? "", /WATCHDOG: no child output for 1m/);
	assert.match(res.errorMessage ?? "", /last activity/);
	assert.ok(elapsed < 20_000, `settled promptly (took ${elapsed}ms)`);
});

test("watchdog disabled when silenceMs is unset (baseline path unchanged)", async () => {
	const res = await spawnPi({
		task: "x",
		cwd: process.cwd(),
		env: { MULTIPI_PI_BIN: FAKE_PI },
	});
	assert.equal(res.exitCode, 0);
	assert.equal(res.errorMessage, undefined);
});

// --- orphan reaping: a leaked grandchild cannot outlive the child ------------

test("a grandchild leaked by the child is reaped from its process tree", { timeout: 25_000 }, async () => {
	const pidFile = path.join(mkdtempSync(path.join(tmpdir(), "fake-pi-leak-")), "leak.pid");
	const res = await spawnPi({
		task: "leak",
		cwd: process.cwd(),
		env: { MULTIPI_PI_BIN: FAKE_PI, FAKE_PI_LEAK_PIDFILE: pidFile },
	});
	assert.equal(res.exitCode, 0, "the child itself exited cleanly");
	assert.match(res.stderr, /reaping .* orphaned subprocess/);
	const leakedPid = Number(readFileSync(pidFile, "utf8").trim());
	// The leaker is TERM-immune: the sweep must have escalated to SIGKILL.
	const deadline = Date.now() + 6_000;
	let alive = true;
	while (Date.now() < deadline) {
		try {
			process.kill(leakedPid, 0);
			await new Promise((r) => setTimeout(r, 200));
		} catch {
			alive = false;
			break;
		}
	}
	assert.equal(alive, false, "leaked grandchild is dead");
	try {
		unlinkSync(pidFile);
	} catch { /* */ }
});

// --- group helpers -------------------------------------------------------------

test("group helpers: detached group is counted, alive, and killed as a unit", async () => {
	const leader = cpSpawn("bash", ["-c", "sleep 300"], { detached: true, stdio: "ignore" });
	const pgid = leader.pid!;
	leader.unref();
	await new Promise((r) => setTimeout(r, 150));
	if (process.platform === "linux") {
		assert.ok(groupMemberCount(pgid) >= 1, "member visible in /proc scan");
	}
	assert.equal(groupAlive(pgid), true);
	killGroup(pgid, "SIGKILL");
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(groupAlive(pgid), false, "group gone after SIGKILL");
});
