import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runGateTrain } from "../../extension/src/gate.ts";
import { runMergeTrain } from "../../extension/src/merge.ts";
import { makeFixture } from "../fixtures.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");

function env(fx: ReturnType<typeof makeFixture>) {
	const fakeBin = path.join(fx.dir, "bin");
	mkdirSync(fakeBin, { recursive: true });
	execFileSync("ln", ["-sf", path.join(ROOT, "tests", "fake-gh"), path.join(fakeBin, "gh")]);
	return {
		MULTIPI_HOME: path.join(fx.dir, "home"),
		MULTIPI_LOCK_DIR: path.join(fx.dir, "locks"),
		FAKE_GH_DIR: path.join(fx.dir, "gh"),
		MULTIPI_GH_SETTLE_SECONDS: "0",
		PATH: `${fakeBin}:${process.env.PATH}`,
	} as NodeJS.ProcessEnv;
}

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
function branch(fx: ReturnType<typeof makeFixture>, name: string, file: string, content: string) {
	sh(fx.repo, "checkout", "-qb", name, "origin/main");
	writeFileSync(path.join(fx.repo, file), content);
	sh(fx.repo, "add", "-A");
	sh(fx.repo, "commit", "-qm", name);
	sh(fx.repo, "push", "-q", "-u", "origin", name);
	sh(fx.repo, "checkout", "-q", "main");
}
function notes(fx: ReturnType<typeof makeFixture>, name: string, title: string) {
	const dir = path.join(fx.dir, "home", "proj", "notes");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, `pr-${name.replaceAll("/", "_")}.md`), `${title}\n\n## Summary\nx\n\nCloses #n\n`);
}

test("gate: green train is classified green with the banner in tail", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }] }));
	try {
		branch(fx, "feat/1-a", "a.txt", "a\n");
		branch(fx, "feat/2-b", "b.txt", "b\n");
		const out = await runGateTrain({ scriptsDir: SCRIPTS, repoRoot: fx.repo, branches: ["feat/1-a", "feat/2-b"], env: env(fx) });
		assert.equal(out.status, "green");
		assert.equal(out.exitCode, 0);
		assert.ok(out.tail.includes("TRAIN GREEN"));
	} finally { fx.cleanup(); }
});

test("gate: failing check is red and keeps no green record", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: ["false"] }));
	try {
		branch(fx, "feat/1-a", "a.txt", "a\n");
		const out = await runGateTrain({ scriptsDir: SCRIPTS, repoRoot: fx.repo, branches: ["feat/1-a"], env: env(fx) });
		assert.equal(out.status, "red");
		assert.equal(out.exitCode, 1);
		assert.ok(out.tail.includes("TRAIN RED"));
		assert.ok(!existsRecord(fx), "no green record after red");
	} finally { fx.cleanup(); }
});

test("gate: rebase conflict names the offending branch", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }] }));
	try {
		branch(fx, "feat/1-x", "same.txt", "alpha\n");
		branch(fx, "feat/2-x", "same.txt", "beta\n");
		const out = await runGateTrain({ scriptsDir: SCRIPTS, repoRoot: fx.repo, branches: ["feat/1-x", "feat/2-x"], env: env(fx) });
		assert.equal(out.status, "conflict");
		assert.equal(out.branch, "feat/2-x");
		assert.equal(out.exitCode, 3);
	} finally { fx.cleanup(); }
});

test("merge: green train merges in order and reports both branches", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }] }));
	try {
		const e = env(fx);
		branch(fx, "feat/1-a", "a.txt", "a\n");
		branch(fx, "feat/2-b", "b.txt", "b\n");
		notes(fx, "feat/1-a", "feat: a (#1)");
		notes(fx, "feat/2-b", "feat: b (#2)");
		const gate = await runGateTrain({ scriptsDir: SCRIPTS, repoRoot: fx.repo, branches: ["feat/1-a", "feat/2-b"], env: e });
		assert.equal(gate.status, "green");
		const out = await runMergeTrain({ scriptsDir: SCRIPTS, repoRoot: fx.repo, branches: ["feat/1-a", "feat/2-b"], env: e });
		assert.equal(out.status, "merged");
		assert.deepEqual(out.merged, ["feat/1-a", "feat/2-b"]);
		const log = sh(fx.repo, "log", "--format=%s", "-2", "origin/main").toString().trim().split("\n");
		assert.deepEqual(log, ["feat: b (#2)", "feat: a (#1)"]);
	} finally { fx.cleanup(); }
});

test("merge: no green record -> refused (8)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }] }));
	try {
		const e = env(fx);
		branch(fx, "feat/0-other", "other.txt", "o\n");
		branch(fx, "feat/1-a", "a.txt", "a\n");
		notes(fx, "feat/1-a", "feat: a (#1)");
		// Gate a DIFFERENT branch: creates the gate worktree and a green record.
		const gate = await runGateTrain({ scriptsDir: SCRIPTS, repoRoot: fx.repo, branches: ["feat/0-other"], env: e });
		assert.equal(gate.status, "green");
		execFileSync("rm", ["-f", path.join(fx.dir, "home", "proj", "train-green.txt")]);
		const out = await runMergeTrain({ scriptsDir: SCRIPTS, repoRoot: fx.repo, branches: ["feat/1-a"], env: e });
		assert.equal(out.status, "refused");
		assert.equal(out.exitCode, 8);
	} finally { fx.cleanup(); }
});

test("merge: missing notes -> notes-missing (5)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }] }));
	try {
		const e = env(fx);
		branch(fx, "feat/1-a", "a.txt", "a\n");
		const gate = await runGateTrain({ scriptsDir: SCRIPTS, repoRoot: fx.repo, branches: ["feat/1-a"], env: e });
		assert.equal(gate.status, "green");
		const out = await runMergeTrain({ scriptsDir: SCRIPTS, repoRoot: fx.repo, branches: ["feat/1-a"], env: e });
		assert.equal(out.status, "notes-missing");
		assert.equal(out.exitCode, 5);
	} finally { fx.cleanup(); }
});

test("merge: base moved after the gate -> tree-differs (4)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }] }));
	try {
		const e = env(fx);
		branch(fx, "feat/1-a", "a.txt", "a\n");
		notes(fx, "feat/1-a", "feat: a (#1)");
		const gate = await runGateTrain({ scriptsDir: SCRIPTS, repoRoot: fx.repo, branches: ["feat/1-a"], env: e });
		assert.equal(gate.status, "green");
		writeFileSync(path.join(fx.repo, "moved.txt"), "moved\n");
		sh(fx.repo, "add", "-A");
		sh(fx.repo, "commit", "-qm", "main moved");
		sh(fx.repo, "push", "-q", "origin", "main");
		const out = await runMergeTrain({ scriptsDir: SCRIPTS, repoRoot: fx.repo, branches: ["feat/1-a"], env: e });
		assert.equal(out.status, "tree-differs");
		assert.equal(out.exitCode, 4);
	} finally { fx.cleanup(); }
});

test("merge: branch changed after the gate -> branch-changed (6)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }] }));
	try {
		const e = env(fx);
		branch(fx, "feat/1-a", "a.txt", "a\n");
		notes(fx, "feat/1-a", "feat: a (#1)");
		const gate = await runGateTrain({ scriptsDir: SCRIPTS, repoRoot: fx.repo, branches: ["feat/1-a"], env: e });
		assert.equal(gate.status, "green");
		sh(fx.repo, "checkout", "-q", "feat/1-a");
		writeFileSync(path.join(fx.repo, "a.txt"), "a2\n");
		sh(fx.repo, "commit", "-qam", "more");
		sh(fx.repo, "push", "-q", "origin", "feat/1-a");
		sh(fx.repo, "checkout", "-q", "main");
		const out = await runMergeTrain({ scriptsDir: SCRIPTS, repoRoot: fx.repo, branches: ["feat/1-a"], env: e });
		assert.equal(out.status, "branch-changed");
		assert.equal(out.exitCode, 6);
	} finally { fx.cleanup(); }
});

function existsRecord(fx: ReturnType<typeof makeFixture>): boolean {
	try {
		execFileSync("test", ["-f", path.join(fx.dir, "home", "proj", "train-green.txt")], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}
