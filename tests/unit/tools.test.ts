import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeTools, evaluateSettle, buildContext, cancelImpl } from "../../extension/src/tools.ts";
import { makeFixture } from "../fixtures.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

function setupEnv(fx: ReturnType<typeof makeFixture>) {
	const bin = path.join(fx.dir, "bin");
	mkdirSync(bin, { recursive: true });
	execFileSync("ln", ["-sf", path.join(ROOT, "tests", "fake-gh"), path.join(bin, "gh")]);
	process.env.MULTIPI_HOME = path.join(fx.dir, "home");
	process.env.MULTIPI_LOCK_DIR = path.join(fx.dir, "locks");
	process.env.FAKE_GH_DIR = path.join(fx.dir, "gh");
	process.env.MULTIPI_GH_SETTLE_SECONDS = "0";
	process.env.MULTIPI_PI_BIN = path.join(ROOT, "tests", "fake-pi");
	process.env.MULTIPI_AGENTS_DIR = agentsDir(fx);
	process.env.PATH = `${bin}:${process.env.PATH}`;
}

function agentsDir(fx: ReturnType<typeof makeFixture>): string {
	const d = path.join(fx.dir, "agents");
	mkdirSync(d, { recursive: true });
	writeFileSync(
		path.join(d, "implementer.md"),
		"---\nname: implementer\ndescription: builds the ticket\ntools: read, bash\n---\nImplement the ticket and end with STATUS: DONE.\n",
	);
	writeFileSync(path.join(d, "code-reviewer.md"), "---\nname: code-reviewer\ndescription: reviews\ntools: read, bash\n---\nReview. End with VERDICT: APPROVE.\n");
	writeFileSync(path.join(d, "verifier.md"), "---\nname: verifier\ndescription: audits\ntools: read, bash\n---\nAudit. End with STATUS: DONE.\n");
	return d;
}

function ctxWithAgents(fx: ReturnType<typeof makeFixture>) {
	return buildContext(fx.repo);
}

function createIssue(fx: ReturnType<typeof makeFixture>, title: string, body = ""): number {
	const url = execFileSync("gh", ["issue", "create", title, body], { cwd: fx.repo, stdio: "pipe" })
		.toString()
		.trim();
	return Number(url.split("/").pop());
}

function notesFor(fx: ReturnType<typeof makeFixture>, branch: string): string {
	const note = path.join(fx.dir, "home", "proj", "notes", `pr-${branch.replaceAll("/", "_")}.md`);
	mkdirSync(path.dirname(note), { recursive: true });
	writeFileSync(note, `${titleOf(fx, branch)}\n\n## Summary\nx\n\nCloses #n\n`);
	return note;
}
function titleOf(_fx: ReturnType<typeof makeFixture>, branch: string): string {
	return `feat: work for ${branch} (#${branch.split("-")[1] ?? "?"})`;
}

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
function pushBranch(fx: ReturnType<typeof makeFixture>, branch: string, file: string) {
	sh(fx.repo, "checkout", "-qb", branch, "origin/main");
	writeFileSync(path.join(fx.repo, file), `${file}\n`);
	sh(fx.repo, "add", "-A");
	sh(fx.repo, "commit", "-qm", branch);
	sh(fx.repo, "push", "-q", "-u", "origin", branch);
	sh(fx.repo, "checkout", "-q", "main");
}

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
	return r.content.map((c) => c.text ?? "").join("");
}

async function call(ctx: ReturnType<typeof ctxWithAgents>, name: string, args: Record<string, unknown>) {
	const tools = makeTools();
	const tool = tools.find((t) => t.name === name)!;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test harness drives raw tool executes
	const res = await (tool.execute as unknown as (id: string, params: Record<string, unknown>, s: unknown, u: unknown, tc: unknown) => Promise<any>)("tc-test", args, new AbortController().signal, undefined, { cwd: ctx.cwd });
	return res;
}

test("dispatch(implementer) runs the child, opens the PR, labels in-review", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], format: null, format_extensions: null, fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Add a feature X");
		const res = await call(ctx, "devloop.dispatch", { role: "implementer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.match(textOf(res), /implementer #\d+ .* -> done/);
		// worktree created beside the repo
		assert.ok(existsSync(path.join(path.dirname(fx.repo), `proj-${n}`)), "worktree exists");
		// branch pushed
		assert.ok(sh(fx.repo, "rev-parse", "--verify", `-q`, `origin/feat/${n}-add-a-feature`).toString().length > 0, "branch on origin");
		// PR opened (fake gh flat file)
		assert.ok(existsSync(path.join(fx.dir, "gh", `feat_${n}-add-a-feature.title`)), "PR title file exists");
		// label dl/in-review applied
		const labels = (existsSync(path.join(fx.dir, "gh", "labels", String(n))) ? execFileSync("cat", [path.join(fx.dir, "gh", "labels", String(n))]).toString().trim().split("\n") : []);
		assert.ok(labels.includes("dl/in-progress") && labels.includes("dl/in-review"), JSON.stringify(labels));
	} finally { fx.cleanup(); }
});

test("dispatch refuses a second implementer on the same ticket while one is in flight", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		// simulate an in-flight entry with a live pid (this process)
		const state = ctx.stateDir;
		mkdirSync(state, { recursive: true });
		writeFileSync(
			path.join(state, "dispatch.json"),
			JSON.stringify({ "77": { pid: process.pid, role: "implementer", branch: "feat/77-x", worktree: "/wt/77", startedAt: 1, status: "running" } }),
		);
		const res = await call(ctx, "devloop.dispatch", { role: "implementer", ticket: 77 });
		assert.equal(res.isError, true);
		assert.match(textOf(res), /already has an implementer running/);
	} finally { fx.cleanup(); }
});

test("dispatch refuses the (slots+1)-th concurrent implementer and lists in-flight tickets", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", heavy: { slots: 2 } }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const state = ctx.stateDir;
		mkdirSync(state, { recursive: true });
		const mk = (k: string, br: string) => ({ pid: process.pid, role: "implementer", branch: br, worktree: `/wt/${k}`, startedAt: 1, status: "running" });
		writeFileSync(path.join(state, "dispatch.json"), JSON.stringify({ "11": mk("11", "feat/11-a"), "12": mk("12", "feat/12-b") }));
		const res = await call(ctx, "devloop.dispatch", { role: "implementer", ticket: 13 });
		assert.equal(res.isError, true);
		const t = textOf(res);
		assert.match(t, /capacity full: 2\/2/);
		assert.match(t, /#11/);
		assert.match(t, /#12/);
	} finally { fx.cleanup(); }
});

test("cancel marks the entry interrupted and kills via the controller registry (fake slow child)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	process.env.FAKE_PI_MODE = "slow";
	process.env.FAKE_PI_SLEEP = "30";
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Long task");
		const tools = makeTools();
		const dispatch = tools.find((t) => t.name === "devloop.dispatch")!;
		const p = (dispatch.execute as unknown as (...a: unknown[]) => Promise<any>)("tc-slow", { role: "implementer", ticket: n }, new AbortController().signal, undefined, { cwd: ctx.cwd });
		await new Promise((r) => setTimeout(r, 400)); // let the child start
		const cancel = cancelImpl(ctx, String(n));
		assert.match(textOf(cancel), /cancel sent/);
		const res = await p; // resolves once the fake child is killed
		assert.match(textOf(res), /interrupted/);
	} finally {
		delete process.env.FAKE_PI_MODE;
		delete process.env.FAKE_PI_SLEEP;
		fx.cleanup();
	}
});

test("gate and merge tools drive the trains through the real scripts", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		pushBranch(fx, "feat/1-a", "a.txt");
		pushBranch(fx, "feat/2-b", "b.txt");
		const gateRes = await call(ctx, "devloop.gate", { branches: ["feat/1-a", "feat/2-b"] });
		assert.equal(gateRes.isError ?? false, false, textOf(gateRes));
		assert.match(textOf(gateRes), /GATE GREEN/);
		notesFor(fx, "feat/1-a");
		notesFor(fx, "feat/2-b");
		const mergeRes = await call(ctx, "devloop.merge", { branches: ["feat/1-a", "feat/2-b"] });
		assert.equal(mergeRes.isError ?? false, false, textOf(mergeRes));
		assert.match(textOf(mergeRes), /MERGED feat\/1-a, feat\/2-b/);
		const log = sh(fx.repo, "log", "--format=%s", "-2", "origin/main").toString().trim().split("\n");
		assert.equal(log.length, 2);
		assert.match(log[0], /feat: work for feat\/2-b/);
	} finally { fx.cleanup(); }
});

test("merge tool surfaces refusal reasons verbatim (not gated green)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		pushBranch(fx, "feat/0-other", "o.txt");
		pushBranch(fx, "feat/1-a", "a.txt");
		// Establish the gate worktree (gate a different branch green), then drop the record.
		const g = await call(ctx, "devloop.gate", { branches: ["feat/0-other"] });
		assert.equal(g.isError ?? false, false, textOf(g));
		execFileSync("rm", ["-f", path.join(ctx.stateDir, "train-green.txt")]);
		const res = await call(ctx, "devloop.merge", { branches: ["feat/1-a"] });
		assert.equal(res.isError, true);
		assert.match(textOf(res), /MERGE REFUSED \(refused\)/);
	} finally { fx.cleanup(); }
});

test("status renders children, tickets and the gate record", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Ticket for status");
		mkdirSync(ctx.stateDir, { recursive: true });
		writeFileSync(
			path.join(ctx.stateDir, "dispatch.json"),
			JSON.stringify({ [String(n)]: { pid: process.pid, role: "implementer", branch: "feat/x", worktree: "/wt", startedAt: 1, status: "running" } }),
		);
		const res = await call(ctx, "devloop.status", {});
		assert.equal(res.isError ?? false, false);
		const t = textOf(res);
		assert.match(t, /Implementers in flight: 1\//);
		assert.match(t, /Ticket for status/);
		assert.match(t, /running/);
	} finally { fx.cleanup(); }
});

test("stop gate: red fast check blocks settlement (fake-gh offline)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", fast_check: "false" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const d = await evaluateSettle(ctx.cwd);
		assert.ok(d, "should block");
		assert.equal(d!.continue, true);
		assert.equal(d!.entries[0].customType, "devloop-stop-gate");
		assert.match(d!.entries[0].content, /fast check is RED/);
	} finally { fx.cleanup(); }
});

test("stop gate: startable ticket + free slot blocks without touching the bounded counter", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		createIssue(fx, "Startable ticket");
		const before = readCounterFile(fx);
		const d = await evaluateSettle(ctx.cwd);
		assert.ok(d);
		assert.match(d!.entries[0].content, /startable/i);
		assert.equal(before, readCounterFile(fx), "loop drive must not bump the bounded counter");
	} finally { fx.cleanup(); }
});

test("stop gate: all clean and nothing startable -> settle (undefined)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const d = await evaluateSettle(ctx.cwd);
		assert.equal(d, undefined);
	} finally { fx.cleanup(); }
});

function readCounterFile(fx: ReturnType<typeof makeFixture>): string {
	try {
		const p = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: fx.repo, stdio: "pipe" })
			.toString()
			.trim();
		const abs = path.isAbsolute(p) ? p : path.join(fx.repo, p);
		return execFileSync("cat", [path.join(abs, "devloop-stop-count")]).toString().trim();
	} catch {
		return "0";
	}
}
