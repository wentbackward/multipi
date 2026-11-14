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
/** A directory that contains no executables: binary lookup fails with ENOENT. */
const DEAD_PATH = "/nonexistent-multipi-test-path";

test("runScript: a failed spawn settles code 1 (fail-closed) with the spawn error in stderr", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "multipi-spawn-"));
	const scriptsDir = path.join(dir, "scripts");
	mkdirSync(scriptsDir);
	writeFileSync(path.join(scriptsDir, "noop.sh"), "#!/usr/bin/env bash\ntrue\n", { mode: 0o755 });
	// PATH override is a documented seam of TrainRunOptions.env — no global mutation needed.
	const out = await within(
		runScript("noop.sh", { scriptsDir, repoRoot: dir, branches: [], env: { PATH: DEAD_PATH } }),
		BOUND_MS,
		"runScript spawn-error probe",
	);
	// Classification unchanged (missing interpreter was already code 1) — the message is NEW.
	assert.equal(out.code, 1);
	assert.match(out.stderr, /ENOENT/, "stderr must carry the spawn error for a diagnostic in the tail");
});

test("runFastCheck: a failed spawn settles RED (fail-closed) with the spawn error in the tail", async () => {
	// runFastCheck spawns with the inherited environment, so the lookup failure is driven by
	// scoping a PATH swap to this test (node --test gives each file its own process; top-level
	// tests in a file run sequentially).
	const saved = process.env.PATH;
	process.env.PATH = DEAD_PATH;
	try {
		const out = await within(runFastCheck("true", "/"), BOUND_MS, "runFastCheck spawn-error probe");
		assert.equal(out.passed, false);
		assert.match(out.tail, /ENOENT/, "the tail must carry the spawn error as the diagnostic");
	} finally {
		process.env.PATH = saved;
	}
});
