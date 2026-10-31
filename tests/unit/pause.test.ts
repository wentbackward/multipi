import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHandoff, pauseImpl, buildContext } from "../../extension/src/tools.ts";
import { writeState } from "../../extension/src/state.ts";
import { makeFixture, type Fixture } from "../fixtures.ts";

const CFG = JSON.stringify({
	fast_check: "true",
	checks: [{ name: "unit", command: "true" }],
	heavy: { slots: 2, port_base: 8700 },
});

function ghShim(dir: string): string {
	const bin = path.join(dir, "bin");
	execFileSync("mkdir", ["-p", bin]);
	const shim = path.join(bin, "gh");
	writeFileSync(shim, `#!/usr/bin/env bash\nFAKE_GH_DIR="${path.join(dir, "fakegh")}" exec "${path.resolve("tests/fake-gh")}" "$@"\n`);
	execFileSync("chmod", ["+x", shim]);
	return bin;
}

afterEach(() => {
	delete process.env.MULTIPI_HOME;
});

// --- buildHandoff (pure) ------------------------------------------------------

test("handoff: idle checkpoint (no children)", () => {
	const md = buildHandoff({ pausedAt: 1_000_000, children: [], board: [] });
	assert.ok(md.includes("loop paused by operator"));
	assert.ok(md.includes("No children were running at pause time"));
	assert.ok(md.includes("(no open issues)"));
	assert.ok(md.includes("## Resume"));
});

test("handoff: children table + board rows", () => {
	const md = buildHandoff({
		pausedAt: 1_980_000,
		children: [
			{ key: "7", role: "implementer", ticket: 7, branch: "proj-issue-7-x", worktree: "/wt/7", startedAt: 1_920_000, note: "paused now", head: "abc1234", dirty: 2 },
			{ key: "reviewer-3", role: "code-reviewer", ticket: 3, worktree: "/wt/r3", startedAt: 1_970_000, note: "earlier interruption" },
		],
		board: [{ number: 7, title: "Do thing", labels: "dl/in-progress" }],
	});
	assert.ok(md.includes("| 7 | implementer | proj-issue-7-x | 01:00 | paused now | abc1234 | 2 |"), "row with elapsed/head/dirty");
	assert.ok(md.includes("earlier interruption"));
	assert.ok(md.includes("| 7 | Do thing | dl/in-progress |"), "board row");
});

// --- pauseImpl (integration: fixture repo + fake gh + a live "child") --------

async function withFixture(t: (fx: Fixture, shimBin: string) => Promise<void>): Promise<void> {
	const fx = makeFixture(CFG);
	const shimBin = ghShim(fx.dir);
	const savedPath = process.env.PATH;
	const savedHome = process.env.MULTIPI_HOME;
	process.env.PATH = `${shimBin}:${savedPath ?? ""}`;
	process.env.MULTIPI_HOME = fx.dir; // state dir -> <fixture>/<repo>
	try {
		await t(fx, shimBin);
	} finally {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		if (savedHome === undefined) delete process.env.MULTIPI_HOME;
		else process.env.MULTIPI_HOME = savedHome;
		fx.cleanup();
	}
}

test("pause: interrupts the running child, writes HANDOFF.md, comments the ticket", async () => {
	await withFixture(async (fx) => {
		// Seed one "running" child backed by a live sleep process in its worktree.
		const wt = path.join(fx.dir, "wt-7");
		execFileSync("git", ["-C", fx.repo, "worktree", "add", "-q", "-b", "proj-issue-7-x", wt, "HEAD"]);
		execFileSync("git", ["-C", wt, "config", "user.email", "t@example.com"]);
		execFileSync("git", ["-C", wt, "config", "user.name", "T"]);
		writeFileSync(path.join(wt, "partial.txt"), "half-done\n"); // dirty worktree
		// A live "child": detached so it outlives this test process (detached sync spawn is unsupported).
		const child = spawn("sleep", ["120"], { stdio: "ignore", detached: true });
		child.unref();

		const ctx = buildContext(fx.repo);
		// A seed open issue for the board snapshot + comment target.
		execFileSync("bash", [path.resolve("tests/fake-gh"), "issue", "create", "Do thing", "body"], { env: { ...process.env, FAKE_GH_DIR: path.join(fx.dir, "fakegh") }, stdio: "pipe" });

		writeState(ctx.paths.stateDir, { "7": { pid: child.pid ?? 0, role: "implementer", branch: "proj-issue-7-x", worktree: wt, startedAt: Date.now() - 60_000, status: "running" } });
		const res = await pauseImpl(ctx);
		assert.ok(!res.isError, "pause succeeded");
		const body = (c: { type: string; text?: string }) => c.text ?? "";
		assert.ok(body(res.content![0] as { type: string; text?: string }).includes("interrupted 1"), body(res.content![0] as { type: string; text?: string }));

		// The "child" actually exited (wait for the exit event; a fresh zombie would fool kill(pid,0)).
		const exited = await new Promise<boolean>((resolve) => {
			const t = setTimeout(() => resolve(false), 5000);
			child.on("exit", () => {
				clearTimeout(t);
				resolve(true);
			});
		});
		assert.equal(exited, true, "child process terminated by pause");

		// Entry is interrupted, worktree kept with its partial file.
		const st = JSON.parse(readFileSync(path.join(ctx.paths.stateDir, "dispatch.json"), "utf8"));
		assert.equal(st["7"].status, "interrupted");
		assert.ok(readFileSync(path.join(wt, "partial.txt"), "utf8").includes("half-done"));

		// HANDOFF.md written with the child row and the board.
		const notesDir = path.join(ctx.paths.stateDir, "notes");
		const md = readFileSync(path.join(notesDir, "HANDOFF.md"), "utf8");
		assert.ok(md.includes("implementer"), "child row present");
		assert.ok(md.includes("Do thing"), "board snapshot present");
		assert.ok(md.includes("paused now"));

		// The ticket got the operator comment (fake-gh stores it under comments/).
		const commentsDir = path.join(fx.dir, "fakegh", "comments");
		const files = readdirSync(commentsDir);
		assert.ok(files.length >= 1, "a comment was filed");
	});
});

test("pause: idle checkpoint — no children, still writes the handoff", async () => {
	await withFixture(async (fx) => {
		const ctx = buildContext(fx.repo);
		writeState(ctx.paths.stateDir, {});
		const res = await pauseImpl(ctx);
		assert.ok(!res.isError);
		const body2 = (c: { type: string; text?: string }) => c.text ?? "";
		assert.ok(body2(res.content![0] as { type: string; text?: string }).includes("no children were running"));
		const notesDir = path.join(ctx.paths.stateDir, "notes");
		assert.ok(readFileSync(path.join(notesDir, "HANDOFF.md"), "utf8").includes("idle checkpoint"));
	});
});
