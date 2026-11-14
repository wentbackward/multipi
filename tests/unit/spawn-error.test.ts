import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runScript } from "../../extension/src/gate.ts";
import { runFastCheck } from "../../extension/src/stopgate.ts";

/**
 * Settle `p` within `ms`, or reject. A spawn failure must still settle (via "close"),
 * never hang the suite.
 */
async function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label}: did not settle within ${ms} ms`)), ms);
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

const BOUND_MS = 10_000;
/**
 * ENOENT trigger: a nonexistent child `cwd`. The spawn itself fails before exec — no
 * dependence on the child envp's PATH resolving (or not) to an interpreter, so the probe is
 * platform-neutral and mutates no global state (follow-up 3 of #59).
 */
const DEAD_CWD = "/nonexistent-multipi-test-cwd";

test("runScript: a failed spawn settles code 1 (fail-closed) with the spawn error in stderr", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "multipi-spawn-"));
	const scriptsDir = path.join(dir, "scripts");
	mkdirSync(scriptsDir);
	writeFileSync(path.join(scriptsDir, "noop.sh"), "#!/usr/bin/env bash\ntrue\n", { mode: 0o755 });
	// The real script exists and the real environment is inherited — the ONLY difference
	// from a healthy spawn is the nonexistent repoRoot (child cwd), which fails with ENOENT.
	const out = await within(
		runScript("noop.sh", { scriptsDir, repoRoot: DEAD_CWD, branches: [] }),
		BOUND_MS,
		"runScript spawn-error probe",
	);
	// Classification unchanged (a failed spawn was already code 1) — the message is NEW.
	assert.equal(out.code, 1);
	assert.match(out.stderr, /ENOENT/, "stderr must carry the spawn error for a diagnostic in the tail");
});

test("runFastCheck: a failed spawn settles RED (fail-closed) with the spawn error in the tail", async () => {
	// runFastCheck takes the child cwd as its `cwd` argument — a nonexistent one makes the
	// spawn fail with ENOENT under the inherited environment, with no env mutation.
	const out = await within(runFastCheck("true", DEAD_CWD), BOUND_MS, "runFastCheck spawn-error probe");
	assert.equal(out.passed, false);
	assert.match(out.tail, /ENOENT/, "the tail must carry the spawn error as the diagnostic");
});
