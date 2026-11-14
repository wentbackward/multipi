// #54 should-fix 4: `multipi-approve --target ""` must be rejected at PARSE time.
// An explicit empty --target previously widened silently to "*" (the widest possible
// scope) — fail closed instead. Run hermetically from an empty temp dir: the parse
// guard fires before config load, so nothing reads or writes real state.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "multipi-approve");
const RULE = "Bash(git tag *)";

interface ExecErr extends Error { status: number | null; stderr: NodeJS.ArrayBufferView | string; }

/** The exit-2 + stderr pair for a failing script invocation. */
function fail(cwd: string, args: string[]): ExecErr {
	try {
		execFileSync("bash", [SCRIPT, ...args], { cwd, stdio: "pipe" });
	} catch (e) {
		return e as ExecErr;
	}
	assert.fail(`expected ${args.join(" ")} to fail`);
}

test("multipi-approve: an explicit EMPTY --target is rejected at parse time (exit 2, error names the option)", (t) => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "multipi-approve-cli-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const err = fail(dir, [RULE, "--target", ""]);
	assert.equal(err.status, 2, "usage/environment errors are exit code 2");
	assert.match(String(err.stderr), /--target/, "the error names the offending option");
	assert.match(String(err.stderr), /empty/, "the error says the value must not be empty");
});

test("multipi-approve: a NON-empty --target passes the parse stage (fails later, at config load — not at parse)", (t) => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "multipi-approve-cli-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// From an empty, non-git temp dir the script gets past parsing and dies at
	// `dl_load_config required` — proof the guard does not over-block real values.
	const err = fail(dir, [RULE, "--target", "main"]);
	assert.equal(err.status, 2);
	assert.match(String(err.stderr), /not inside a git repository|no config at/, "the failure is the config load, not the parse stage");
});
