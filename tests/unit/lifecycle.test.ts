import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finishEntry } from "../../extension/src/tools.ts";
import type { ToolContext } from "../../extension/src/tools.ts";
import type { DispatchEntry } from "../../extension/src/state.ts";
import { worktreePath } from "../../extension/src/brief.ts";
import { loadConfig, resolvePaths } from "../../extension/src/config.ts";
import { readState } from "../../extension/src/state.ts";
import { makeFixture } from "../fixtures.ts";

const ctx = (stateDir: string): ToolContext => ({ stateDir } as unknown as ToolContext);
const entry = (role: string): DispatchEntry => ({ pid: 0, role, worktree: "/wt", startedAt: 1, status: "running" });
const res = (finalText: string) => ({ exitCode: 0, finalText, stderr: "", aborted: false, stopReason: "stop" as const });

test("finishEntry: reviewer VERDICT APPROVE records done (not crashed)", () => {
	const d = mkdtempSync(path.join(tmpdir(), "dlc-"));
	finishEntry(ctx(d), "review-9", entry("code-reviewer"), res("Reviewed everything.\n\nVERDICT: APPROVE"));
	assert.equal(readState(d)["review-9"].status, "done");
});

test("finishEntry: reviewer VERDICT CHANGES REQUIRED records done (verdict delivered)", () => {
	const d = mkdtempSync(path.join(tmpdir(), "dlc-"));
	finishEntry(ctx(d), "review-9", entry("code-reviewer"), res("Issues found.\n\nVERDICT: CHANGES REQUIRED"));
	assert.equal(readState(d)["review-9"].status, "done");
});

test("finishEntry: reviewer WITHOUT a verdict is a crash (contract violation)", () => {
	const d = mkdtempSync(path.join(tmpdir(), "dlc-"));
	finishEntry(ctx(d), "review-9", entry("code-reviewer"), res("I read some of the diff…"));
	assert.equal(readState(d)["review-9"].status, "crashed");
});

test("finishEntry: implementer STATUS contract unchanged", () => {
	const d = mkdtempSync(path.join(tmpdir(), "dlc-"));
	finishEntry(ctx(d), "7", entry("implementer"), res("Done.\n\nSTATUS: DONE"));
	assert.equal(readState(d)["7"].status, "done");
	const d2 = mkdtempSync(path.join(tmpdir(), "dlc-"));
	finishEntry(ctx(d2), "8", entry("implementer"), res("Stuck.\n\nSTATUS: BLOCKED — auth"));
	assert.equal(readState(d2)["8"].status, "blocked");
});

test("worktreePath: consolidated dir by default contract, legacy without one", () => {
	assert.equal(worktreePath("/p/repo", 7, "/p/.devloop-worktrees/repo"), "/p/.devloop-worktrees/repo/issue-7");
	assert.equal(worktreePath("/p/repo", 7), "/p/repo-7");
});

test("config: worktree_dir default, absolute and parent-relative", () => {
	const fx = makeFixture('{}');
	try {
		const cfg = loadConfig(fx.repo);
		const wt = resolvePaths(cfg!, { ...process.env, MULTIPI_HOME: fx.dir });
		// default: <stateDir>/worktrees/<repo> — under MULTIPI_HOME, not next to the repo
		assert.equal(wt.worktreeDir, path.join(fx.dir, path.basename(fx.repo), "worktrees", path.basename(fx.repo)));
	} finally { fx.cleanup(); }

	const abs = mkdtempSync(path.join(tmpdir(), "wtabs-"));
	const fx2 = makeFixture(JSON.stringify({ worktree_dir: abs }));
	try {
		assert.equal(resolvePaths(loadConfig(fx2.repo)!, { ...process.env, MULTIPI_HOME: fx2.dir }).worktreeDir, abs);
	} finally { fx2.cleanup(); }

	const fx3 = makeFixture(JSON.stringify({ worktree_dir: "wt" }));
	try {
		assert.equal(resolvePaths(loadConfig(fx3.repo)!, { ...process.env, MULTIPI_HOME: fx3.dir }).worktreeDir, path.join(path.dirname(fx3.repo), "wt"));
	} finally { fx3.cleanup(); }
});
