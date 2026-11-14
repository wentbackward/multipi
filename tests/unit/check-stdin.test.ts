import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runScript, normalizeCloseCode } from "../../extension/src/gate.ts";
import { runFastCheck } from "../../extension/src/stopgate.ts";

/**
 * Settle `p` within `ms`, or reject. If a child's stdin were still an open pipe the parent
 * holds, the child would block on `read` (runFastCheck: until its 10-minute timeout;
 * runScript: forever) and the suite would hang — the race converts that into a fast failure.
 *
 * Known limitation: when a probe DOES fail its deadline, the still-blocked child keeps
 * the event loop alive, so the suite hangs AFTER the failure is reported. The report is
 * authoritative; the post-report hang is the expected second symptom, not a separate bug.
 */
async function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label}: did not settle within ${ms} ms — child's stdin is an open pipe?`)),
			ms,
		);
		timer.unref?.();
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

const SETTLE_MS = 10_000;

test("runFastCheck: a check that reads stdin sees immediate EOF (bounded settle, not the 10-min timeout)", async () => {
	// `read` returns 1 on EOF; rc=1 in the tail proves EOF (not data) — the race proves no block.
	const out = await within(runFastCheck(`read -r line; echo "rc=$?"`, "/"), SETTLE_MS, "runFastCheck stdin probe");
	assert.equal(out.passed, true); // the check command itself succeeds (echo)
	assert.match(out.tail, /rc=1/);
});

test("runFastCheck: a well-behaved check is unaffected by the closed stdin", async () => {
	const out = await within(runFastCheck("echo ok", "/"), SETTLE_MS, "runFastCheck echo probe");
	assert.equal(out.passed, true);
	assert.match(out.tail, /^ok$/);
});

test("runScript: a script that reads stdin sees immediate EOF (bounded settle)", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "multipi-stdin-"));
	const scriptsDir = path.join(dir, "scripts");
	mkdirSync(scriptsDir);
	writeFileSync(path.join(scriptsDir, "probe.sh"), "#!/usr/bin/env bash\nread -r line\necho \"stdin:$?\"\n", {
		mode: 0o755,
	});
	const out = await within(runScript("probe.sh", { scriptsDir, repoRoot: dir, branches: [] }), SETTLE_MS, "runScript stdin probe");
	assert.equal(out.code, 0);
	assert.match(out.stdout, /stdin:1/);
});

test("runScript: a well-behaved script is unaffected by the closed stdin", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "multipi-stdin-"));
	const scriptsDir = path.join(dir, "scripts");
	mkdirSync(scriptsDir);
	writeFileSync(path.join(scriptsDir, "fine.sh"), "#!/usr/bin/env bash\necho fine\n", { mode: 0o755 });
	const out = await within(runScript("fine.sh", { scriptsDir, repoRoot: dir, branches: ["a"] }), SETTLE_MS, "runScript fine probe");
	assert.equal(out.code, 0);
	assert.match(out.stdout, /fine/);
});

test("normalizeCloseCode: signal-kill (null) and spawn-failure errno (-2) map to 1; exit codes pass through", () => {
	// execFile's callback delivered those as `err` (read as 1 downstream); spawn delivers
	// code=null (signal) or code=-errno (failed spawn, e.g. -2) on "close" — they must not
	// leak into the pinned gate classification (red=1 vs error).
	assert.equal(normalizeCloseCode(null), 1);
	assert.equal(normalizeCloseCode(-2), 1);
	assert.equal(normalizeCloseCode(0), 0);
	assert.equal(normalizeCloseCode(3), 3);
});

test("runScript: a script killed by a signal settles as exit code 1 (stays red, not error)", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "multipi-stdin-"));
	const scriptsDir = path.join(dir, "scripts");
	mkdirSync(scriptsDir);
	// `kill -TERM $$` makes "close" deliver code=null (signal, not exit code).
	writeFileSync(path.join(scriptsDir, "signaled.sh"), "#!/usr/bin/env bash\nkill -TERM $$\n", { mode: 0o755 });
	const out = await within(
		runScript("signaled.sh", { scriptsDir, repoRoot: dir, branches: [] }),
		SETTLE_MS,
		"runScript signaled probe",
	);
	assert.equal(out.code, 1);
});

test("runFastCheck: a probe printing >2MB settles RED within a bound (per-stream kill at cap, no hang)", async () => {
	// Prints 3MB (one line) — past the 2MB cap. Must be killed and settle RED fast, not hang
	// on unbounded buffering.
	const out = await within(
		runFastCheck(`head -c $((3 * 1024 * 1024)) /dev/zero | tr '\\0' x`, "/"),
		SETTLE_MS,
		"runFastCheck maxBuffer probe",
	);
	assert.equal(out.passed, false);
});

test("runScript: a script printing >20MB settles as exit code 1 within a bound (per-stream kill at cap, no hang)", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "multipi-stdin-"));
	const scriptsDir = path.join(dir, "scripts");
	mkdirSync(scriptsDir);
	writeFileSync(path.join(scriptsDir, "big.sh"), "#!/usr/bin/env bash\nhead -c $((21 * 1024 * 1024)) /dev/zero | tr '\\0' x\n", {
		mode: 0o755,
	});
	// The kill fires once >20MB has crossed the pipe, and 21MB of local pipe throughput
	// benches in tens of milliseconds — 5 s leaves ample margin for a slow CI while still
	// converting a hang into a fast failure (was 30 s: the loosest bound in the suite).
	const out = await within(runScript("big.sh", { scriptsDir, repoRoot: dir, branches: [] }), 5_000, "runScript maxBuffer probe");
	assert.equal(out.code, 1);
});
