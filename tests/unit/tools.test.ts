import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeTools, evaluateSettle, buildContext, cancelImpl, classifyReport, finishEntry, findOpenTicket, testSeams } from "../../extension/src/tools.ts";
import { readState, type DispatchEntry } from "../../extension/src/state.ts";
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
	writeFileSync(path.join(d, "analyst.md"), "---\nname: analyst\ndescription: plans tickets\ntools: read, bash\n---\nPlan. End with STATUS: DONE.\n");
	writeFileSync(path.join(d, "scenario-writer.md"), "---\nname: scenario-writer\ndescription: writes holdout scenarios\ntools: read, write, bash\n---\nWrite scenarios. End with STATUS: DONE.\n");
	return d;
}

/** Write a child report to a scratch file and point the FAKE_PI_REPORT seam at it. */
let reportSeq = 0; // per-process counter: the scratch name must be deterministic and unique without randomness
function fakeReport(fx: ReturnType<typeof makeFixture>, content: string): void {
	const p = path.join(fx.dir, `report-${++reportSeq}.md`);
	writeFileSync(p, content);
	process.env.FAKE_PI_REPORT = p;
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

/** Bounded wait for ANY dispatch key with the given prefix to reach a terminal state
 * (the ad-hoc keys — verifier-<ts> — are not predictable, so the prefix is the handle). */
async function waitTerminalPrefix(ctx: ReturnType<typeof ctxWithAgents>, prefix: string, timeoutMs = 20_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const hits = Object.entries(readState(ctx.stateDir)).filter(([k, e]) => k.startsWith(prefix) && e.status !== "running");
		if (hits.length > 0) return hits[0][0];
		if (Date.now() > deadline) throw new Error(`no '${prefix}-*' entry reached a terminal state within ${timeoutMs} ms`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** Bounded wait for a dispatch entry to reach a terminal state. Fire-and-poll (#133):
 * the completion handler writes the terminal entry asynchronously, so tests poll the
 * shared state (a bounded poll, the smoke's #82 idiom) instead of assuming when it lands. */
async function waitTerminal(ctx: ReturnType<typeof ctxWithAgents>, key: string, timeoutMs = 20_000): Promise<DispatchEntry> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const e = readState(ctx.stateDir)[key];
		if (e && e.status !== "running") return e;
		if (Date.now() > deadline) throw new Error(`entry '${key}' did not reach a terminal state within ${timeoutMs} ms (last seen: ${JSON.stringify(e ?? null)})`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

async function call(ctx: ReturnType<typeof ctxWithAgents>, name: string, args: Record<string, unknown>, session: Record<string, unknown> = {}) {
	const tools = makeTools();
	const tool = tools.find((t) => t.name === name)!;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test harness drives raw tool executes
	const res = await (tool.execute as unknown as (id: string, params: Record<string, unknown>, s: unknown, u: unknown, tc: unknown) => Promise<any>)("tc-test", args, new AbortController().signal, undefined, { cwd: ctx.cwd, ...session });
	return res;
}

test("dispatch(implementer) spawns the child and the completion handler opens the PR and labels in-review", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], format: null, format_extensions: null, fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Add a feature X");
		const res = await call(ctx, "devloop_dispatch", { role: "implementer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		// Fire-and-poll (#133): the dispatch resolves with the RECEIPT (child left running),
		// not with the child's report — the side effects land on completion.
		assert.ok(textOf(res).includes(`DISPATCHED implementer #${n} (feat/${n}-add-a-feature) -> running`), textOf(res));
		await waitTerminal(ctx, String(n));
		assert.equal(readState(ctx.stateDir)[String(n)].status, "done");
		// worktree created in the consolidated worktree dir (<state>/worktrees/<repo>/issue-<n>)
		assert.ok(existsSync(path.join(fx.dir, "home", "proj", "worktrees", "proj", `issue-${n}`)), "worktree exists");
		// branch pushed
		assert.ok(sh(fx.repo, "rev-parse", "--verify", `-q`, `origin/feat/${n}-add-a-feature`).toString().length > 0, "branch on origin");
		// PR opened (fake gh flat file)
		assert.ok(existsSync(path.join(fx.dir, "gh", `feat_${n}-add-a-feature.title`)), "PR title file exists");
		// label dl/in-review applied
		const labels = (existsSync(path.join(fx.dir, "gh", "labels", String(n))) ? execFileSync("cat", [path.join(fx.dir, "gh", "labels", String(n))]).toString().trim().split("\n") : []);
		assert.ok(labels.includes("dl/in-progress") && labels.includes("dl/in-review"), JSON.stringify(labels));
	} finally { fx.cleanup(); }
});

test("dispatch stamps the child with its role (MULTIPI_CHILD_ROLE via the spawn env)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], format: null, format_extensions: null, fast_check: "true" }));
	setupEnv(fx);
	const roleFile = path.join(fx.dir, "role.txt");
	process.env.FAKE_PI_ECHO_ROLE = roleFile;
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Role plumbing check");
		const res = await call(ctx, "devloop_dispatch", { role: "implementer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		await waitTerminal(ctx, String(n)); // the (background) child wrote the role echo on exit
		assert.ok(existsSync(roleFile), "the child saw the FAKE_PI_ECHO_ROLE seam");
		assert.equal(readFileSync(roleFile, "utf8"), "implementer", "child env carried its role name");
	} finally {
		delete process.env.FAKE_PI_ECHO_ROLE;
		fx.cleanup();
	}
});

// --- model inheritance (#130): a child rides the parent session's model ------
//
// The verifier path is the lightest end-to-end dispatch (no ticket, no worktree,
// no tracker): it spawns the child straight from the role definition. fake-pi's
// FAKE_PI_ECHO_TASK writes the child's ENTIRE argv to a file, so the composed
// child command is assertable as plain text.

const CFG_JSON = JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], format: null, format_extensions: null, fast_check: "true" });

async function verifierArgv(extra: { session?: Record<string, unknown>; agentOverride?: string } = {}): Promise<string> {
	const fx = makeFixture(CFG_JSON);
	setupEnv(fx);
	if (extra.agentOverride) {
		writeFileSync(path.join(fx.dir, "agents", "verifier.md"), extra.agentOverride);
	}
	const argvFile = path.join(fx.dir, "argv.txt");
	process.env.FAKE_PI_ECHO_TASK = argvFile;
	try {
		const ctx = ctxWithAgents(fx);
		const res = await call(ctx, "devloop_dispatch", { role: "verifier", task: "audit it" }, extra.session ?? {});
		assert.equal(res.isError ?? false, false, textOf(res));
		await waitTerminalPrefix(ctx, "verifier-"); // the background child wrote the argv echo on exit
		return readFileSync(argvFile, "utf8");
	} finally {
		delete process.env.FAKE_PI_ECHO_TASK;
		fx.cleanup();
	}
}

test("dispatch renders the parent session's model for a role with no model: line (--model P, #130)", async () => {
	const argv = await verifierArgv({ session: { model: { provider: "prov", id: "model-id" } } });
	assert.match(argv, /\s--model prov\/model-id(\s|$)/, `composed args: ${argv}`);
});

test("dispatch: a role frontmatter model: line beats the parent session's model (override wins, #130)", async () => {
	const argv = await verifierArgv({
		session: { model: { provider: "prov", id: "model-id" } },
		agentOverride: "---\nname: verifier\ndescription: audits\ntools: read, bash\nmodel: custom/role-model\n---\nAudit. End with STATUS: DONE.\n",
	});
	assert.match(argv, /\s--model custom\/role-model(\s|$)/, `composed args: ${argv}`);
	assert.ok(!argv.includes("prov/model-id"), `the parent model must not ride along: ${argv}`);
});

test("dispatch: a parent session with no model selected leaves --model unset (settings-default fallback, #130)", async () => {
	const argv = await verifierArgv();
	assert.ok(!/(^|\s)--model(\s|$)/.test(argv), `no --model flag: ${argv}`);
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
		const res = await call(ctx, "devloop_dispatch", { role: "implementer", ticket: 77 });
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
		const res = await call(ctx, "devloop_dispatch", { role: "implementer", ticket: 13 });
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
		const dispatch = tools.find((t) => t.name === "devloop_dispatch")!;
		const p = (dispatch.execute as unknown as (...a: unknown[]) => Promise<any>)("tc-slow", { role: "implementer", ticket: n }, new AbortController().signal, undefined, { cwd: ctx.cwd });
		const receipt = await p; // fire-and-poll: the receipt comes back at once, child left running
		assert.equal(receipt.isError ?? false, false, textOf(receipt));
		assert.match(textOf(receipt), /-> running/);
		await new Promise((r) => setTimeout(r, 400)); // let the child start
		const cancel = cancelImpl(ctx, String(n));
		assert.match(textOf(cancel), /cancel sent/);
		// The completion handler settles the entry asynchronously once the killed child exits.
		const entry = await waitTerminal(ctx, String(n));
		assert.equal(entry.status, "interrupted");
	} finally {
		delete process.env.FAKE_PI_MODE;
		delete process.env.FAKE_PI_SLEEP;
		fx.cleanup();
	}
});

// --- fire-and-poll (ticket #133): the receipt, exactly-once collection, the retired block ----

test("dispatch returns a receipt in bounded time with the child left running (fire-and-poll, #133)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], format: null, format_extensions: null, fast_check: "true" }));
	setupEnv(fx);
	process.env.FAKE_PI_MODE = "slow";
	process.env.FAKE_PI_SLEEP = "30"; // a child that would block a blocking dispatch for 30 s
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Fire and poll");
		const start = Date.now();
		const res = await call(ctx, "devloop_dispatch", { role: "implementer", ticket: n });
		const elapsed = Date.now() - start;
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.ok(elapsed < 10_000, `the receipt came back after ${elapsed} ms — dispatch must not wait on the 30 s child`);
		const t = textOf(res);
		// The receipt: child key, ticket, role, branch, worktree, notes path, report file path,
		// expected-duration hint.
		assert.ok(t.includes(`DISPATCHED implementer #${n} (feat/${n}-fire-and-poll) -> running`), t);
		assert.match(t, new RegExp(`key: ${n}$`, "m"));
		assert.ok(t.includes(`branch: feat/${n}-fire-and-poll`), t);
		assert.match(t, /worktree: .*/);
		assert.match(t, new RegExp(`notes: .*pr-feat_${n}-fire-and-poll\.md`), t);
		assert.match(t, new RegExp(`report: .*reports/${n}\.md`));
		assert.match(t, /expected: ~45 min/);
		// The child is LEFT RUNNING: the entry is running and the report file is not written yet.
		const entry = readState(ctx.stateDir)[String(n)];
		assert.equal(entry.status, "running", "the child keeps running after the receipt");
		assert.ok(!existsSync(path.join(ctx.stateDir, "reports", `${n}.md`)), "the report file lands on completion, not on dispatch");
		// Tidy: cancel the slow child and let the completion handler settle it.
		assert.match(textOf(cancelImpl(ctx, String(n))), /cancel sent/);
		assert.equal((await waitTerminal(ctx, String(n))).status, "interrupted");
	} finally {
		delete process.env.FAKE_PI_MODE;
		delete process.env.FAKE_PI_SLEEP;
		fx.cleanup();
	}
});

test("a completed child's report is presented exactly once at the next collection (ledger-pinned, #133)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], format: null, format_extensions: null, fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Collected exactly once");
		const res = await call(ctx, "devloop_dispatch", { role: "implementer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.equal((await waitTerminal(ctx, String(n))).status, "done", "the fake implementer delivered (its report ends with STATUS: DONE)");
		// The completion side effects ran (PR + in-review label + report file).
		assert.ok(existsSync(path.join(fx.dir, "gh", `feat_${n}-collected-exactly-once.title`)), "the completion handler opened the PR");
		assert.ok(readFileSync(path.join(fx.dir, "gh", "labels", String(n)), "utf8").includes("dl/in-review"));
		const reportFile = path.join(ctx.stateDir, "reports", `${n}.md`);
		assert.match(readFileSync(reportFile, "utf8"), /STATUS: DONE/);
		// First collection (devloop_status): the report is presented ...
		const s1 = textOf(await call(ctx, "devloop_status", {}));
		assert.match(s1, /## Late reports/);
		assert.match(s1, new RegExp(`- #${n} implementer \\(`));
		assert.match(s1, /STATUS: DONE/);
		// ... and acked into the ledger: the next collection presents NOTHING (exactly once).
		const s2 = textOf(await call(ctx, "devloop_status", {}));
		const sec2 = s2.slice(s2.indexOf("## Late reports"), s2.indexOf("## Open tickets"));
		assert.match(sec2, /\(none\)/, `the second collection must not re-present the report:\n${sec2}`);
	} finally { fx.cleanup(); }
});

test("a hung dispatch preflight is still bounded: the call RESOLVES with the reconciliation text (spec 2026-11-15 §2), without waiting on a child", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	process.env.FAKE_PI_MODE = "slow"; // the child is slow too — the bound must not even be its waiting
	process.env.FAKE_PI_SLEEP = "30";
	process.env.MULTIPI_LIST_LAG_RETRY_MS = "4000"; // the stuck preflight: the list-lag retry wait
	process.env.MULTIPI_TOOL_TIMEOUT_MS = "500";    // documented seam: no wall-clock minutes in tests
	try {
		const ctx = ctxWithAgents(fx);
		const start = Date.now();
		const res = await call(ctx, "devloop_dispatch", { role: "implementer", ticket: 9999 }); // missing: the retry never finds it
		assert.ok(Date.now() - start < 10_000, "resolved at the bound");
		assert.equal(res.isError, true, "the timeout is an error RESULT");
		const t = textOf(res);
		assert.match(t, /devloop_dispatch timed out after 1s/);
		assert.match(t, /UNTOUCHED/);
		assert.match(t, /devloop_cancel/);
		// No child was ever spawned (the preflight died at the ticket lookup).
		assert.ok(!existsSync(path.join(ctx.stateDir, "dispatch.json")), "no dispatch entry for a preflight that timed out");
	} finally {
		delete process.env.FAKE_PI_MODE;
		delete process.env.FAKE_PI_SLEEP;
		delete process.env.MULTIPI_LIST_LAG_RETRY_MS;
		delete process.env.MULTIPI_TOOL_TIMEOUT_MS;
		fx.cleanup();
	}
});

test("a bounded devloop_* call builds the tool context exactly ONCE (bound probe and run share one construction)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		createIssue(fx, "Bound budget check");
		const before = testSeams.contextBuilds;
		const res = await call(ctx, "devloop_status", {});
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.equal(testSeams.contextBuilds - before, 1, "the bound probe must not rebuild the context (a config read + git subprocess each)");
	} finally { fx.cleanup(); }
});

test("gate and merge tools drive the trains through the real scripts", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		pushBranch(fx, "feat/1-a", "a.txt");
		pushBranch(fx, "feat/2-b", "b.txt");
		const gateRes = await call(ctx, "devloop_gate", { branches: ["feat/1-a", "feat/2-b"] });
		assert.equal(gateRes.isError ?? false, false, textOf(gateRes));
		assert.match(textOf(gateRes), /GATE GREEN/);
		notesFor(fx, "feat/1-a");
		notesFor(fx, "feat/2-b");
		const mergeRes = await call(ctx, "devloop_merge", { branches: ["feat/1-a", "feat/2-b"] });
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
		const g = await call(ctx, "devloop_gate", { branches: ["feat/0-other"] });
		assert.equal(g.isError ?? false, false, textOf(g));
		execFileSync("rm", ["-f", path.join(ctx.stateDir, "train-green.txt")]);
		const res = await call(ctx, "devloop_merge", { branches: ["feat/1-a"] });
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
		const res = await call(ctx, "devloop_status", {});
		assert.equal(res.isError ?? false, false);
		const t = textOf(res);
		assert.match(t, /Implementers in flight: 1\//);
		assert.match(t, /Ticket for status/);
		assert.match(t, /running/);
	} finally { fx.cleanup(); }
});

test("status shows the per-ticket polish depth for in-review tickets (ticket #105)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Cache layer");
		// no dl/ label: depth is not even queried ("-")
		let res = await call(ctx, "devloop_status", {});
		let t = textOf(res);
		assert.match(t, /Cache layer \| - \| - \| - \|/m, `unlabelled ticket shows no depth:\n${t}`);
		// one should-fix round in the review window: 1/2 under the default cap
		execFileSync("gh", ["issue", "edit", String(n), "--add-label", "dl/in-review"], { cwd: fx.repo, stdio: "pipe" });
		execFileSync("gh", ["issue", "comment", String(n), "--body", "should-fix follow-up: round one"], { cwd: fx.repo, stdio: "pipe" });
		res = await call(ctx, "devloop_status", {});
		t = textOf(res);
		assert.match(t, /Cache layer \| dl\/in-review \| - \| 1\/2 /, `one round shows 1/2:\n${t}`);
		// the second round puts the ticket AT the cap: flagged
		execFileSync("gh", ["issue", "comment", String(n), "--body", "should-fix follow-up: round two"], { cwd: fx.repo, stdio: "pipe" });
		res = await call(ctx, "devloop_status", {});
		assert.match(textOf(res), /Cache layer \| dl\/in-review \| - \| 2\/2 cap /, `at the cap, the depth is flagged\n${textOf(res)}`);
	} finally { fx.cleanup(); }
});

// Structural guard (review round 2, must-fix 2): GFM derives the table's column COUNT from the
// delimiter row — a header, separator or data row with a different cell count silently degrades
// the operator board from a table to raw pipes. Every pipe row in the status output must agree
// with its table's delimiter row. Byte-level inspection of the reviewed HEAD found the
// Open-tickets table consistent (5/5/5/5; renders as a real table under a GFM parser); this pin
// keeps it that way whenever the columns change again.
function pipeTables(md: string): string[][][] {
	const tables: string[][][] = [];
	let cur: string[][] = [];
	for (const line of md.split("\n")) {
		const s = line.trim();
		if (s.startsWith("|") && s.endsWith("|") && s.length > 1) cur.push(s.slice(1, -1).split("|"));
		else {
			if (cur.length) tables.push(cur);
			cur = [];
		}
	}
	if (cur.length) tables.push(cur);
	return tables;
}

test("status board tables stay structurally renderable: header, separator and rows agree on cell count", async () => {
	const checkTables = (t: string, expectTables: number): void => {
		const tables = pipeTables(t);
		assert.equal(tables.length, expectTables, `expected ${expectTables} pipe tables:\n${t}`);
		for (const tb of tables) {
			assert.ok(tb.length >= 3, `every table has a header, a separator and at least one row:\n${tb.map((r) => r.join(" | ")).join("\n")}`);
			assert.ok(tb[1].every((c) => /^:?-+:?$/.test(c.trim())), `row 2 is the delimiter row:\n${tb[1].join(" | ")}`);
			const width = tb[1].length;
			for (const [i, row] of tb.entries()) {
				assert.equal(row.length, width, `table row ${i} has ${row.length} cells, the delimiter has ${width}:\n${row.join(" | ")}\n${tb[1].join(" | ")}`);
			}
		}
	};
	// populated board: a child row and a ticket row carrying polish depth
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Cache layer");
		mkdirSync(ctx.stateDir, { recursive: true });
		writeFileSync(
			path.join(ctx.stateDir, "dispatch.json"),
			JSON.stringify({ [String(n)]: { pid: process.pid, role: "implementer", branch: "feat/x", worktree: "/wt", startedAt: 1, status: "running" } }),
		);
		execFileSync("gh", ["issue", "edit", String(n), "--add-label", "dl/in-review"], { cwd: fx.repo, stdio: "pipe" });
		execFileSync("gh", ["issue", "comment", String(n), "--body", "should-fix follow-up: round one"], { cwd: fx.repo, stdio: "pipe" });
		const res = await call(ctx, "devloop_status", {});
		assert.equal(res.isError ?? false, false);
		checkTables(textOf(res), 2);
	} finally { fx.cleanup(); }
	// empty board: both (none) fallback rows render
	const fx0 = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx0);
	try {
		const ctx = ctxWithAgents(fx0);
		const res = await call(ctx, "devloop_status", {});
		assert.equal(res.isError ?? false, false);
		const t = textOf(res);
		assert.match(t, /\(none\)/, "the empty board carries the fallback rows");
		checkTables(t, 2);
	} finally { fx0.cleanup(); }
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

// ---------------------------------------------------------------------------
// Report classification: anchored on the LAST non-empty line vs the role's contract (#22).
// Marker mentions anywhere in the body (quotes, documented contracts) must never decide;
// a report with no terminal marker keeps the crashed semantics.
// ---------------------------------------------------------------------------

/** Analyst/writer-style report whose body QUOTES `STATUS: BLOCKED` (documents the writer role's
 *  contract) and whose last non-empty line is `STATUS: DONE`. The live defect: recorded blocked. */
const REPORT_DONE_QUOTING_BLOCKED = [
	"## Plan",
	"",
	"Contract reminder (quoted from the scenario-writer role file): a child that is stuck ends with",
	"`STATUS: BLOCKED — <one-line reason>` so the orchestrator labels the ticket dl/blocked.",
	"",
	"### Tickets",
	"1. implement the thing",
	"",
	"## Questions",
	"none",
	"",
	"STATUS: DONE",
].join("\n");

const REPORT_BLOCKED_QUOTING_DONE = [
	"Tried the approach.",
	"",
	"The report protocol (quoted) ends `STATUS: DONE` on success.",
	"We are stuck on the credential seam; cannot proceed offline.",
	"",
	"STATUS: BLOCKED — credential seam unfakeable",
].join("\n");

const REVIEW_APPROVE_QUOTING_STATUS = [
	"Reviewed the diff.",
	"",
	"Side note: implementers must end their reports with `STATUS: DONE` (quoted contract).",
	"No issues found.",
	"",
	"VERDICT: APPROVE",
].join("\n");

function stateEntry(fx: ReturnType<typeof makeFixture>, ctx: ReturnType<typeof ctxWithAgents>, key: string): { status?: string } {
	const state = JSON.parse(execFileSync("cat", [path.join(ctx.stateDir, "dispatch.json")]).toString()) as Record<string, { status?: string }>;
	return state[key] ?? {};
}

function runFinishEntry(fx: ReturnType<typeof makeFixture>, ctx: ReturnType<typeof ctxWithAgents>, key: string, role: string, finalText: string): { status?: string } {
	const entry = { pid: 12345, role, worktree: fx.repo, startedAt: 1, status: "running" as const };
	finishEntry(ctx, key, entry, { exitCode: 0, finalText, aborted: false, stopReason: "end", stderr: "" });
	return stateEntry(fx, ctx, key);
}

test("finishEntry (repro #22): analyst report that quotes STATUS: BLOCKED in the body but ends with STATUS: DONE is recorded done", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const e = runFinishEntry(fx, ctx, "analyst-plan", "analyst", REPORT_DONE_QUOTING_BLOCKED);
		assert.equal(e.status, "done");
	} finally { fx.cleanup(); }
});

test("finishEntry: routes every role dispatch path (incl. scenario-writer) through the terminal-line rule", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const cases: Array<[string, string, string]> = [
			["implementer", REPORT_DONE_QUOTING_BLOCKED, "done"],
			["scenario-writer", REPORT_DONE_QUOTING_BLOCKED, "done"],
			["analyst", REPORT_BLOCKED_QUOTING_DONE, "blocked"],
			["verifier", REPORT_DONE_QUOTING_BLOCKED, "done"],
			["code-reviewer", REVIEW_APPROVE_QUOTING_STATUS, "done"],
		];
		cases.forEach(([role, report, want], i) => {
			const key = `${role}-${i}`;
			const e = runFinishEntry(fx, ctx, key, role, report);
			assert.equal(e.status, want, `${role} on terminal line ${report.trim().split("\n").pop()!}`);
		});
	} finally { fx.cleanup(); }
});

test("classifyReport: the last non-empty line decides for every STATUS contract role; body quotes never decide", async () => {
	for (const role of ["implementer", "analyst", "verifier", "scenario-writer"]) {
		assert.equal(classifyReport(role, REPORT_DONE_QUOTING_BLOCKED), "done", `${role}: terminal DONE despite quoted BLOCKED`);
		assert.equal(classifyReport(role, REPORT_BLOCKED_QUOTING_DONE), "blocked", `${role}: terminal BLOCKED despite quoted DONE`);
	}
});

test("classifyReport: code-reviewer anchors on the terminal VERDICT; a STATUS: DONE quote in the body never decides", async () => {
	assert.equal(classifyReport("code-reviewer", REVIEW_APPROVE_QUOTING_STATUS), "done", "APPROVE with quoted STATUS: DONE");
	assert.equal(classifyReport("code-reviewer", "Changes needed.\n\nVERDICT: CHANGES REQUIRED"), "done", "CHANGES REQUIRED is a finished review");
});

test("classifyReport: no terminal marker stays crashed, even when a marker sits mid-body", async () => {
	assert.equal(classifyReport("implementer", "mid-body STATUS: DONE quote\n## Left open\nmore prose"), "crashed", "STATUS mid-body");
	assert.equal(classifyReport("code-reviewer", "saw a VERDICT: APPROVE earlier\nstill investigating"), "crashed", "VERDICT mid-body");
	assert.equal(classifyReport("code-reviewer", "reviewed.\n\nSTATUS: DONE"), "crashed", "reviewer's terminal line is the wrong contract");
});

test("classifyReport: trailing blank lines (and blank/empty reports) do not break anchoring", async () => {
	assert.equal(classifyReport("analyst", "body\n\nSTATUS: DONE\n\n  \n"), "done", "trailing blanks after DONE");
	assert.equal(classifyReport("verifier", "body\n\nSTATUS: BLOCKED — why\n\n"), "blocked", "trailing blanks after BLOCKED");
	assert.equal(classifyReport("implementer", ""), "crashed", "empty report");
	assert.equal(classifyReport("implementer", "\n\n  \n"), "crashed", "blank report");
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

test("dispatch(analyst) refuses without spec or focus", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], format: null, format_extensions: null, fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const res = await call(ctx, "devloop_dispatch", { role: "analyst" });
		assert.equal(res.isError, true);
		assert.match(textOf(res), /requires `spec`.*`focus`/);
	} finally { fx.cleanup(); }
});

test("dispatch(analyst) plans from a spec, writes no ticket, records a done entry", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], format: null, format_extensions: null, fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const res = await call(ctx, "devloop_dispatch", { role: "analyst", spec: "docs/prd.md" });
		assert.equal(res.isError ?? false, false, textOf(res));
		const out = textOf(res);
		assert.match(out, /DISPATCHED analyst -> running/);
		assert.match(out, /plan file: .*notes\/tickets-prd-md\.md/);
		await waitTerminal(ctx, "analyst-prd-md");
		const state = JSON.parse(execFileSync("cat", [path.join(fx.dir, "home", "proj", "dispatch.json")]).toString());
		assert.equal(state["analyst-prd-md"].status, "done");
		assert.equal(state["analyst-prd-md"].worktree, fx.repo);
	} finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// Scenario-writer dispatch (dark-factory spec §4; ticket #11).
// ---------------------------------------------------------------------------

test("findOpenTicket: one bounded retry recovers a ticket missing on the first list (GitHub list lag)", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	try {
		const n = createIssue(fx, "Created moments ago");
		const issuesDir = path.join(fx.dir, "gh", "issues");
		// Simulate GitHub's list lag: the ticket is hidden from the first list and
		// reappears well before the bounded retry fires.
		renameSync(path.join(issuesDir, String(n)), path.join(issuesDir, `.${n}.hidden`));
		setTimeout(() => renameSync(path.join(issuesDir, `.${n}.hidden`), path.join(issuesDir, String(n))), 400);
		const t0 = Date.now();
		const issue = await findOpenTicket("", n);
		assert.equal(issue?.number, n, "the retry found the ticket");
		assert.ok(Date.now() - t0 >= 1400, "the retry waited before re-listing");
	} finally { fx.cleanup(); }
});

test("findOpenTicket: a genuinely missing ticket is refused after the single retry", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	try {
		process.env.MULTIPI_LIST_LAG_RETRY_MS = "100"; // the seam: no real 1.5 s wall-clock wait in tests
		const t0 = Date.now();
		const issue = await findOpenTicket("", 9999);
		assert.equal(issue, undefined, "refused, not guessed");
		assert.ok(Date.now() - t0 >= 100, "the single retry happened");
	} finally {
		delete process.env.MULTIPI_LIST_LAG_RETRY_MS;
		fx.cleanup();
	}
});

test("findOpenTicket honours MULTIPI_LIST_LAG_RETRY_MS (the retry wait is a documented env seam)", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	try {
		const n = createIssue(fx, "Created moments ago");
		const issuesDir = path.join(fx.dir, "gh", "issues");
		process.env.MULTIPI_LIST_LAG_RETRY_MS = "100";
		// Hide the ticket from the first list; it reappears well before the SHORTENED retry fires,
		// so the re-list after the 100 ms seam wait is what finds it. The seam is proven by the
		// lower bound plus this hidden-then-found re-list — no upper bound: under load the wall
		// clock can exceed 1500 ms without the seam being wrong (the ticket's flake note).
		renameSync(path.join(issuesDir, String(n)), path.join(issuesDir, `.${n}.hidden`));
		setTimeout(() => renameSync(path.join(issuesDir, `.${n}.hidden`), path.join(issuesDir, String(n))), 30);
		const t0 = Date.now();
		const issue = await findOpenTicket("", n);
		const dt = Date.now() - t0;
		assert.equal(issue?.number, n, "the shortened retry still re-lists and finds the ticket");
		assert.ok(dt >= 100, `the configured 100 ms wait happened (took ${dt} ms)`);
	} finally {
		delete process.env.MULTIPI_LIST_LAG_RETRY_MS;
		fx.cleanup();
	}
});

const SC_WRITER_BODY = [
	"## Why",
	"Spec §4 — a ticket is judged by its holdout scenarios.",
	"",
	"Reads docs/superpowers/specs/2026-11-01-multipi-dark-factory.md §4.",
	"",
	"## Acceptance criteria",
	"- [ ] CRITERION-CACHE-HIT is met",
	"- [ ] CRITERION-CACHE-MISS is met",
].join("\n");

/** Fixture with the scenario store ON (dark preset); store defaults to <state>/scenarios. */
function scenarioWriterFx() {
	return makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], fast_check: "true", factory: "dark" }));
}

test("dispatch(scenario-writer) runs the child at the repo root (no worktree, no branch) and the brief carries ticket, criteria, cited spec and store dir", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	const echo = path.join(fx.dir, "echo-task");
	process.env.FAKE_PI_ECHO_TASK = echo; // the child's final message echoes the brief it received
	// The brief's LAST line is the literal contract sample `STATUS: BLOCKED — <one-line reason>`;
	// without an explicit report the terminal-line classifier would take the BLOCKED path by
	// accident. Drive the outcome with a DONE report and assert it, so the expectation is documented.
	fakeReport(fx, "Wrote the holdout scenarios into the store.\n\nSTATUS: DONE\n");
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Cache hit skips recompute", SC_WRITER_BODY);
		const res = await call(ctx, "devloop_dispatch", { role: "scenario-writer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.ok(textOf(res).includes(`DISPATCHED scenario-writer #${n} -> running`), textOf(res));
		await waitTerminal(ctx, `scenario-writer-${n}`);
		// The echoed task IS the brief (written verbatim to the echo file): it must carry the
		// ticket number, its acceptance criteria, the cited spec section and the store dir.
		assert.ok(existsSync(echo), "the FAKE_PI_ECHO_TASK seam captured the brief");
		const t = readFileSync(echo, "utf8");
		for (const needle of [
			`# ${n}: Cache hit skips recompute`,
			"CRITERION-CACHE-HIT", "CRITERION-CACHE-MISS",
			"docs/superpowers/specs/2026-11-01-multipi-dark-factory.md §4",
			path.join(fx.dir, "home", "proj", "scenarios"), // the store dir (default under the state dir)
			fx.repo, // the repo root (cwd of the child)
		]) assert.ok(t.includes(needle), `brief missing: ${needle}`);
		// The child runs AT the repo root: no worktree, no branch, recorded under its own key.
		const state = JSON.parse(readFileSync(path.join(fx.dir, "home", "proj", "dispatch.json"), "utf8"));
		assert.equal(state[`scenario-writer-${n}`].worktree, fx.repo);
		assert.equal(state[`scenario-writer-${n}`].branch, undefined);
		assert.equal(state[`scenario-writer-${n}`].status, "done", "the explicit DONE report decided the outcome");
		assert.ok(!existsSync(path.join(fx.dir, "home", "proj", "worktrees")), "no issue worktree was created");
	} finally {
		delete process.env.FAKE_PI_ECHO_TASK;
		delete process.env.FAKE_PI_REPORT;
		fx.cleanup();
	}
});

test("dispatch(scenario-writer) DONE posts the scenario TITLES (id, title, required, new/changed) — never the bodies — on the ticket", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Cache hit skips recompute", SC_WRITER_BODY);
		fakeReport(fx, [
			"Wrote the scenarios for the ticket.",
			"",
			`t${n}-cache-hit — Cache hit returns the stored value (required, new) — SECRET-BODY-ALPHA must never leave the store`,
			`t${n}-cache-miss — A miss recomputes once (scored, changed) SECRET-BODY-BETA must never leave the store`,
			`t${n + 7}-foreign — A foreign-ticket scenario (scored, new) SECRET-FORBODY-GAMMA must never appear`,
			"",
			"## Questions",
			"none",
			"",
			"STATUS: DONE",
		].join("\n"));
		const res = await call(ctx, "devloop_dispatch", { role: "scenario-writer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.ok(textOf(res).includes(`DISPATCHED scenario-writer #${n} -> running`), textOf(res));
		await waitTerminal(ctx, `scenario-writer-${n}`);
		const commentFile = path.join(fx.dir, "gh", "comments", String(n), "0001");
		assert.ok(existsSync(commentFile), "a comment was posted on the ticket");
		const comment = readFileSync(commentFile, "utf8");
		for (const needle of [
			`t${n}-cache-hit`, "Cache hit returns the stored value", "required", "new",
			`t${n}-cache-miss`, "A miss recomputes once", "scored", "changed",
		]) assert.ok(comment.includes(needle), `comment missing: ${needle}`);
		assert.ok(!comment.includes("SECRET-BODY-ALPHA") && !comment.includes("SECRET-BODY-BETA"), "the scenario bodies never leave the store");
		assert.ok(!comment.includes(`t${n + 7}-foreign`) && !comment.includes("A foreign-ticket scenario"), "a foreign-ticket id cannot pollute the review list");
		const state = JSON.parse(readFileSync(path.join(fx.dir, "home", "proj", "dispatch.json"), "utf8"));
		assert.equal(state[`scenario-writer-${n}`].status, "done");
	} finally {
		delete process.env.FAKE_PI_REPORT;
		fx.cleanup();
	}
});

test("dispatch(scenario-writer) BLOCKED labels the ticket dl/blocked and posts no comment", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	fakeReport(fx, [
		"The store directory resolves inside the repository; refusing to write holdout material in judged ground.",
		"",
		"STATUS: BLOCKED — store lies inside the repository",
	].join("\n"));
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Cache hit skips recompute", SC_WRITER_BODY);
		const res = await call(ctx, "devloop_dispatch", { role: "scenario-writer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.ok(textOf(res).includes(`DISPATCHED scenario-writer #${n} -> running`), textOf(res));
		await waitTerminal(ctx, `scenario-writer-${n}`);
		assert.equal(readState(ctx.stateDir)[`scenario-writer-${n}`].status, "blocked");
		const labelFile = path.join(fx.dir, "gh", "labels", String(n));
		assert.ok(existsSync(labelFile), "the label was recorded");
		assert.ok(readFileSync(labelFile, "utf8").trim().split("\n").includes("dl/blocked"), "dl/blocked applied");
		assert.ok(!existsSync(path.join(fx.dir, "gh", "comments", String(n))), "no scenario comment on a blocked ticket");
	} finally {
		delete process.env.FAKE_PI_REPORT;
		fx.cleanup();
	}
});

test("dispatch(scenario-writer) DONE with no scenario lines posts no comment", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	fakeReport(fx, "Nothing new to write; the store already covers this ticket.\n\nSTATUS: DONE\n");
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Cache hit skips recompute", SC_WRITER_BODY);
		const res = await call(ctx, "devloop_dispatch", { role: "scenario-writer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.ok(textOf(res).includes(`DISPATCHED scenario-writer #${n} -> running`), textOf(res));
		await waitTerminal(ctx, `scenario-writer-${n}`);
		assert.ok(!existsSync(path.join(fx.dir, "gh", "comments", String(n))), "no comment without scenario lines");
		assert.ok(!existsSync(path.join(fx.dir, "home", "proj", "worktrees")), "the writer ran at the repo root, no worktree");
		const state = JSON.parse(readFileSync(path.join(fx.dir, "home", "proj", "dispatch.json"), "utf8"));
		assert.equal(state[`scenario-writer-${n}`].status, "done");
	} finally {
		delete process.env.FAKE_PI_REPORT;
		fx.cleanup();
	}
});

test("dispatch(scenario-writer) refuses when the scenario store is off in the config", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" })); // collaborative, no scenarios block
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Cache hit skips recompute", SC_WRITER_BODY);
		const res = await call(ctx, "devloop_dispatch", { role: "scenario-writer", ticket: n });
		assert.equal(res.isError, true);
		assert.match(textOf(res), /scenario store is off/i);
	} finally { fx.cleanup(); }
});

test("dispatch(scenario-writer) requires a ticket and finds it among open issues", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	process.env.MULTIPI_LIST_LAG_RETRY_MS = "50"; // the not-found refusal retries once; the seam keeps it off the wall clock
	try {
		const ctx = ctxWithAgents(fx);
		const res1 = await call(ctx, "devloop_dispatch", { role: "scenario-writer" });
		assert.equal(res1.isError, true);
		assert.match(textOf(res1), /scenario-writer requires `ticket`/);
		const res2 = await call(ctx, "devloop_dispatch", { role: "scenario-writer", ticket: 9999 });
		assert.equal(res2.isError, true);
		assert.match(textOf(res2), /not found among open issues/);
	} finally {
		delete process.env.MULTIPI_LIST_LAG_RETRY_MS;
		fx.cleanup();
	}
});

test("dispatch(scenario-writer) refuses a second writer on the same ticket while one is in flight", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		mkdirSync(ctx.stateDir, { recursive: true });
		writeFileSync(
			path.join(ctx.stateDir, "dispatch.json"),
			JSON.stringify({ "scenario-writer-77": { pid: process.pid, role: "scenario-writer", worktree: fx.repo, startedAt: 1, status: "running" } }),
		);
		const res = await call(ctx, "devloop_dispatch", { role: "scenario-writer", ticket: 77 });
		assert.equal(res.isError, true);
		assert.match(textOf(res), /already running/);
	} finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// Scenario startability (dark-factory spec §4; ticket #12): with the store on, a
// ticket is startable only if the store holds a valid t<ticket>- scenario.
// ---------------------------------------------------------------------------

/** Seed one VALID scenario file into the store (default dir: <state>/scenarios under MULTIPI_HOME). */
function seedScenario(fx: ReturnType<typeof makeFixture>, id: string, title = "Holdout behaviour"): void {
	const p = path.join(fx.dir, "home", "proj", "scenarios", `${id}.md`);
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(
		p,
		`---\nid: ${id}\ntitle: ${title}\nrequired: true\n---\n## User and goal\nThe behaviour under test.\n\n## Satisfied when\nIt happens observably.\n`,
	);
}

test("stop gate (store on): an open ticket with NO covering scenario settles — no forced continuation", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		createIssue(fx, "Uncovered open ticket");
		const d = await evaluateSettle(ctx.cwd);
		assert.equal(d, undefined, "only-uncovered open tickets + a free slot must not force a continuation");
	} finally { fx.cleanup(); }
});

test("stop gate (store on): an open ticket covered by a valid t<n>- scenario blocks with the keep-going message", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Covered open ticket");
		seedScenario(fx, `t${n}-covers-it`);
		const before = readCounterFile(fx);
		const d = await evaluateSettle(ctx.cwd);
		assert.ok(d, "covered ticket + free slot must force a continuation");
		assert.equal(d!.continue, true);
		assert.match(d!.entries[0].content, /startable/i);
		assert.equal(before, readCounterFile(fx), "loop drive must not bump the bounded counter");
	} finally { fx.cleanup(); }
});

test("dispatch(implementer) (store on, uncovered): refuses, naming the ticket and the missing t<n>- scenario", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "No scenario yet");
		const res = await call(ctx, "devloop_dispatch", { role: "implementer", ticket: n });
		assert.equal(res.isError, true, textOf(res));
		const t = textOf(res);
		assert.match(t, new RegExp(`ticket #${n} is not startable`), t);
		assert.match(t, new RegExp(`t${n}-`), "the message names the t<ticket>- prefix the store lacks");
		assert.ok(!existsSync(path.join(fx.dir, "home", "proj", "worktrees")), "no worktree for a refused dispatch");
	} finally { fx.cleanup(); }
});

test("dispatch(implementer) (store on, covered by a valid t<n>- scenario): proceeds with the normal pipeline", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Covered ticket gets implemented");
		seedScenario(fx, `t${n}-the-behaviour`);
		const res = await call(ctx, "devloop_dispatch", { role: "implementer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.match(textOf(res), new RegExp(`DISPATCHED implementer #${n} \\(feat/${n}-covered-ticket-gets\\) -> running`), textOf(res));
		await waitTerminal(ctx, String(n));
		const labels = readFileSync(path.join(fx.dir, "gh", "labels", String(n)), "utf8").trim().split("\n");
		assert.ok(labels.includes("dl/in-progress") && labels.includes("dl/in-review"), JSON.stringify(labels));
	} finally { fx.cleanup(); }
});

/** Lock the scenario store dir (permission 0) so scanStore gets the unreadable-store error path. */
function lockStoreDir(fx: ReturnType<typeof makeFixture>): string {
	const d = path.join(fx.dir, "home", "proj", "scenarios");
	chmodSync(d, 0);
	return d;
}
function unlockStoreDir(d: string): void {
	chmodSync(d, 0o755);
}

test("stop gate (store on, store unreadable): covers nothing — fail-closed, the gate settles without crashing", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	let storeDir = "";
	const origError = console.error;
	let gateErrors = "";
	try {
		console.error = (msg: unknown) => { gateErrors += String(msg) + "\n"; };
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Covered but store locked");
		seedScenario(fx, `t${n}-covers-it`); // covered while the store is readable
		storeDir = lockStoreDir(fx);
		const d = await evaluateSettle(ctx.cwd);
		assert.equal(d, undefined, "an unreadable store is treated as no coverage: nothing startable, the gate settles (fail-closed)");
		assert.ok(!gateErrors.includes("devloop stop-gate error"), "the gate settled cleanly — no swallowed store-scan throw: " + gateErrors);
	} finally {
		console.error = origError;
		if (storeDir) unlockStoreDir(storeDir);
		fx.cleanup();
	}
});

test("dispatch(implementer) (store on, store unreadable): refuses as not startable — unreadable store = nothing covered (fail-closed)", async () => {
	const fx = scenarioWriterFx();
	setupEnv(fx);
	let storeDir = "";
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Locked store ticket");
		seedScenario(fx, `t${n}-would-cover-it`); // covered while the store is readable
		storeDir = lockStoreDir(fx);
		const res = await call(ctx, "devloop_dispatch", { role: "implementer", ticket: n });
		assert.equal(res.isError, true, textOf(res));
		const t = textOf(res);
		assert.match(t, new RegExp(`ticket #${n} is not startable`), t);
		assert.match(t, new RegExp(`t${n}-`), "the refusal names the t<ticket>- prefix that cannot be confirmed covered");
		assert.ok(!existsSync(path.join(fx.dir, "home", "proj", "worktrees")), "no worktree for a refused dispatch");
	} finally {
		if (storeDir) unlockStoreDir(storeDir);
		fx.cleanup();
	}
});

test("stop gate (store off): coverage fields absent — a store-less config behaves exactly as before", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", fast_check: "true" })); // collaborative, no store
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Ordinary open ticket");
		const d = await evaluateSettle(ctx.cwd);
		assert.ok(d, "without a store, an open ticket is startable as always");
		assert.match(d!.entries[0].content, /startable/i);
		// and the dispatch still proceeds without any scenario
		const res = await call(ctx, "devloop_dispatch", { role: "implementer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
	} finally { fx.cleanup(); }
});

test("dispatch tolerates child output arriving after the receipt (settled-tool-call updates are dropped, not fatal, #133)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], format: null, format_extensions: null, fast_check: "true" }));
	setupEnv(fx);
	process.env.FAKE_PI_MODE = "slow"; // child outlives the tool call by a wide margin
	process.env.FAKE_PI_SLEEP = "2";
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Settled call updates");
		const tools = makeTools();
		const tool = tools.find((t) => t.name === "devloop_dispatch")!;
		let updates = 0;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test harness drives raw tool executes
		const res = await (tool.execute as unknown as (id: string, p: Record<string, unknown>, s: unknown, u: (u: { content?: { text?: string }[] }) => void, tc: unknown) => Promise<any>)(
			"tc-settled",
			{ role: "implementer", ticket: n },
			new AbortController().signal,
			(u: { content?: { text?: string }[] }) => { updates++; },
			{ cwd: ctx.cwd },
		);
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.match(textOf(res), /-> running/);
		// Whatever streamed (or not) before the receipt, the child that keeps emitting after the
		// tool call has settled must not error the session: the terminal lands, no update throws.
		await waitTerminal(ctx, String(n));
		void updates; // the count is timing-dependent (pre- vs post-settle output); the pin is the non-fatality
	} finally {
		delete process.env.FAKE_PI_MODE;
		delete process.env.FAKE_PI_SLEEP;
		fx.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Orphaned-child reclaim (ticket #121): the dispatch tool bound resolves without
// the child's fate; the loop must reclaim the child at the next status and
// surface the late report, and re-dispatch must no longer be refused by a
// stale running entry.
// ---------------------------------------------------------------------------

async function deadPid(): Promise<number> {
	const dead = spawn("sleep", ["0.2"]);
	await new Promise((r) => dead.on("close", r));
	return dead.pid!;
}

function plantDispatch(ctx: ReturnType<typeof ctxWithAgents>, obj: unknown): void {
	mkdirSync(ctx.stateDir, { recursive: true });
	writeFileSync(path.join(ctx.stateDir, "dispatch.json"), JSON.stringify(obj, null, 2));
}

test("reclaim: a running entry with a dead pid is reconciled to crashed on status, and the re-dispatch is no longer refused (#104 dead end)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Orphaned child reclaim");
		// The orphan's branch exists on origin (the child pushed before dying); the
		// re-dispatch must reuse it, exactly as a resume would.
		const branch = `feat/${n}-orphaned`;
		sh(fx.repo, "checkout", "-qb", branch, "origin/main");
		sh(fx.repo, "push", "-q", "-u", "origin", branch);
		sh(fx.repo, "checkout", "-q", "main");
		plantDispatch(ctx, {
			[String(n)]: {
				pid: await deadPid(),
				role: "implementer",
				branch,
				worktree: path.join(fx.dir, "home", "proj", "worktrees", "proj", `issue-${n}`),
				startedAt: Date.now() - 10 * 60_000, // well past the spawn grace
				status: "running",
			},
		});
		// Status reconciles: the child row reads crashed, the slot is free…
		const s1 = await call(ctx, "devloop_status", {});
		assert.equal(s1.isError ?? false, false, textOf(s1));
		assert.match(textOf(s1), /crashed/, `the dead child renders crashed:\n${textOf(s1)}`);
		assert.match(textOf(s1), /Implementers in flight: 0\//, "the slot is free");
		// …and persisted (a fresh plain read agrees):
		const onDisk = JSON.parse(execFileSync("cat", [path.join(ctx.stateDir, "dispatch.json")]).toString());
		assert.equal(onDisk[String(n)].status, "crashed");
		assert.equal(typeof onDisk[String(n)].endedAt, "number", "endedAt is stamped");
		// …and the #104 dead end is gone: the re-dispatch proceeds instead of "already running".
		const res = await call(ctx, "devloop_dispatch", { role: "implementer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.match(textOf(res), new RegExp(`DISPATCHED implementer #${n} \\(feat/${n}-orphaned\\) -> running`));
		await waitTerminal(ctx, String(n));
		// the re-dispatch reused the orphan's branch (resume semantics)
		assert.ok(sh(fx.repo, "rev-parse", "--verify", "-q", `origin/${branch}`).toString().length > 0, "branch pushed under the same name");
	} finally { fx.cleanup(); }
});

test("reclaim: status surfaces a late report (terminal since the last status) with its report tail, then acks it", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Late reporter");
		const report = "Implemented and pushed.\nBranch is on origin.\n\n## Questions\nnone\n\nSTATUS: DONE";
		plantDispatch(ctx, {
			[String(n)]: { pid: 1, role: "implementer", branch: `feat/${n}-late`, worktree: "/wt", startedAt: 1000, status: "done", report, endedAt: 2000 },
		});
		const s1 = textOf(await call(ctx, "devloop_status", {}));
		assert.match(s1, /## Late reports/, `the late-report section renders:\n${s1}`);
		assert.match(s1, new RegExp(`#${n} .*done`), "the late child is named with its status");
		assert.match(s1, /STATUS: DONE/, "the report tail carries the terminal line");
		assert.ok(existsSync(path.join(ctx.stateDir, "reconcile-seen.json")), "the ack ledger was written");
		// Second status: nothing new — the child is seen.
		const s2 = textOf(await call(ctx, "devloop_status", {}));
		assert.match(s2, /## Late reports[\s\S]*\(none\)/, `no repeat listing:\n${s2}`);
		// A RE-terminal of the same child (re-dispatch finished/crashed again) resurfaces.
		plantDispatch(ctx, {
			[String(n)]: { pid: 1, role: "implementer", branch: `feat/${n}-late`, worktree: "/wt", startedAt: 3000, status: "crashed", endedAt: 4000 },
		});
		const s3 = textOf(await call(ctx, "devloop_status", {}));
		assert.match(s3, new RegExp(`#${n} .*crashed`), `a fresh terminal beats the earlier ack:\n${s3}`);
	} finally { fx.cleanup(); }
});

test("reclaim: a crashed child's late report without a report renders the (no report) tail", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Crashed with no words");
		plantDispatch(ctx, {
			[String(n)]: { pid: 1, role: "implementer", branch: `feat/${n}-silent`, worktree: "/wt", startedAt: 1000, status: "crashed", endedAt: 2000 },
		});
		const s1 = textOf(await call(ctx, "devloop_status", {}));
		assert.match(s1, /\(no report\)/, `the report-less child is named:\n${s1}`);
	} finally { fx.cleanup(); }
});

test("finishEntry: a stale-generation finish does not clobber a re-dispatched entry (the reap-then-redispatch race)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const gen1 = { pid: 424242, role: "implementer" as const, worktree: fx.repo, startedAt: 1, status: "running" as const };
		finishEntry(ctx, "gen1", gen1, { exitCode: 0, finalText: "STATUS: DONE", aborted: false, stopReason: "end", stderr: "" });
		let st = stateEntry(fx, ctx, "gen1");
		assert.equal(st.status, "done", "the current generation finishes normally");
		// A re-dispatch starts a NEW generation for the same key (fresh startedAt):
		plantDispatch(ctx, { gen1: { pid: 0, role: "implementer", worktree: fx.repo, startedAt: Date.now(), status: "running" } });
		// The old generation's finish now resolves (child died after the reap): it must not
		// stomp the new entry with a stale terminal state.
		finishEntry(ctx, "gen1", gen1, { exitCode: 0, finalText: "STATUS: DONE", aborted: false, stopReason: "end", stderr: "" });
		st = stateEntry(fx, ctx, "gen1");
		assert.equal(st.status, "running", "the re-dispatch's entry is intact");
	} finally { fx.cleanup(); }
});

test("reclaim: a SECOND orphan on the same ticket resurfaces — re-dispatch persists a clean entry, the second reap stamps a fresh endedAt and beats the first ack (#121 review M1)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Second orphan");
		const branch = `feat/${n}-again`;
		sh(fx.repo, "checkout", "-qb", branch, "origin/main");
		sh(fx.repo, "push", "-q", "-u", "origin", branch);
		sh(fx.repo, "checkout", "-q", "main");
		plantDispatch(ctx, {
			[String(n)]: {
				pid: await deadPid(),
				role: "implementer",
				branch,
				worktree: path.join(fx.dir, "home", "proj", "worktrees", "proj", `issue-${n}`),
				startedAt: Date.now() - 10 * 60_000,
				status: "running",
			},
		});
		// Generation 1 is reaped by the status pass and acked into the ledger.
		const s1 = textOf(await call(ctx, "devloop_status", {}));
		assert.match(s1, /crashed/, `gen-1's reap surfaces:\n${s1}`);
		const gen1 = JSON.parse(readFileSync(path.join(ctx.stateDir, "dispatch.json"), "utf8"))[String(n)];
		assert.equal(gen1.status, "crashed");
		const ackedAt = gen1.endedAt;
		assert.deepEqual(JSON.parse(readFileSync(path.join(ctx.stateDir, "reconcile-seen.json"), "utf8")), { [String(n)]: ackedAt }, "the gen-1 terminal is acked");
		// The re-dispatch takes the ticket back (a slow fake child stays up).
		process.env.FAKE_PI_MODE = "slow";
		process.env.FAKE_PI_SLEEP = "30";
		const pending = call(ctx, "devloop_dispatch", { role: "implementer", ticket: n });
		let gen2: Record<string, unknown>;
		const deadline = Date.now() + 5_000;
		for (;;) {
			const cur = JSON.parse(readFileSync(path.join(ctx.stateDir, "dispatch.json"), "utf8"))[String(n)];
			if (cur.status === "running" && typeof cur.pid === "number" && cur.pid > 0 && cur.startedAt > gen1.startedAt) {
				gen2 = cur;
				break;
			}
			if (Date.now() > deadline) throw new Error("the re-dispatch never persisted a pid-stamped running entry");
			await new Promise((r) => setTimeout(r, 25));
		}
		// The fresh running entry must be CLEAN: a merged-in stale endedAt would let the second
		// reap keep it (endedAt ??=), making terminalTime equal the already-acked gen-1 time.
		assert.equal(gen2.endedAt, undefined, "the re-dispatched entry carries no endedAt");
		assert.equal(gen2.report, undefined, "the re-dispatched entry carries no report");
		assert.equal(gen2.error, undefined, "the re-dispatched entry carries no error");
		assert.equal(gen2.stopReason, undefined, "the re-dispatched entry carries no stopReason");
		// Generation 2 is orphaned in the same shape: the recorded pid dies, the harness never sees it.
		const swap = JSON.parse(readFileSync(path.join(ctx.stateDir, "dispatch.json"), "utf8"));
		swap[String(n)].pid = await deadPid();
		writeFileSync(path.join(ctx.stateDir, "dispatch.json"), JSON.stringify(swap, null, 2));
		const s2 = textOf(await call(ctx, "devloop_status", {}));
		const on2 = JSON.parse(readFileSync(path.join(ctx.stateDir, "dispatch.json"), "utf8"))[String(n)];
		assert.equal(on2.status, "crashed", "the second orphan is reaped");
		assert.ok(on2.endedAt > ackedAt, `the second reap stamps a FRESH endedAt (stamped ${on2.endedAt}, first ack ${ackedAt})`);
		assert.match(s2, new RegExp(`- #${n} implementer \\(`), `the second orphan resurfaces in the late reports despite the first ack:\n${s2}`);
		assert.match(s2, /-> crashed/);
		// cleanup: stop the still-sleeping fake child and drain the pending dispatch.
		try { process.kill(Number(gen2.pid), "SIGKILL"); } catch { /* already gone */ }
		await pending;
	} finally {
		delete process.env.FAKE_PI_MODE;
		delete process.env.FAKE_PI_SLEEP;
		fx.cleanup();
	}
});

test("status: a tracker failure errors the tool WITHOUT consuming the late report — it must surface on the next status (#121 review M2)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Tracker blip");
		plantDispatch(ctx, {
			[String(n)]: { pid: 1, role: "implementer", branch: `feat/${n}-blip`, worktree: "/wt", startedAt: 1000, status: "done", report: "Pushed and green.\nSTATUS: DONE", endedAt: 2000 },
		});
		// Break gh so the tracker list throws mid-render (a blip, not a missing tracker).
		const ghBin = path.join(fx.dir, "bin", "gh");
		unlinkSync(ghBin);
		writeFileSync(ghBin, "#!/bin/sh\necho 'gh: connection refused' >&2\nexit 1\n");
		chmodSync(ghBin, 0o755);
		const s1 = await call(ctx, "devloop_status", {});
		assert.equal(s1.isError, true, `the tracker blip errors the tool:\n${textOf(s1)}`);
		assert.ok(!existsSync(path.join(ctx.stateDir, "reconcile-seen.json")), "the failed status must NOT ack the late report into the ledger");
		// The blip clears: the same report surfaces (nothing was consumed).
		unlinkSync(ghBin);
		execFileSync("ln", ["-sf", path.join(ROOT, "tests", "fake-gh"), ghBin]);
		const s2 = textOf(await call(ctx, "devloop_status", {}));
		assert.match(s2, new RegExp(`- #${n} implementer`), `the un-acked late report surfaces:\n${s2}`);
		assert.match(s2, /STATUS: DONE/);
	} finally { fx.cleanup(); }
});

test("status: late reports name non-numeric keys plainly (review-/analyst- keys are not ticket numbers)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		plantDispatch(ctx, {
			"review-5": { pid: 1, role: "code-reviewer", worktree: "/wt", startedAt: 1000, status: "done", report: "Looks right.\nVERDICT: APPROVE", endedAt: 2000 },
			"analyst-feedback": { pid: 1, role: "analyst", worktree: "/wt", startedAt: 1100, status: "done", report: "Plan posted.\nSTATUS: DONE", endedAt: 2100 },
		});
		const s = textOf(await call(ctx, "devloop_status", {}));
		assert.match(s, /- review-5 code-reviewer /, `the review key names plainly:\n${s}`);
		assert.match(s, /- analyst-feedback analyst /, `the analyst key names plainly:\n${s}`);
		// Scope to the late-report section (the children table keeps its # prefix; only the
		// late-report lines were asked to name non-numeric keys plainly).
		const section = s.slice(s.indexOf("## Late reports"), s.indexOf("## Open tickets"));
		assert.ok(!section.includes("#review-5") && !section.includes("#analyst-feedback"), `no ticket-number prefix on non-numeric keys:\n${section}`);
	} finally { fx.cleanup(); }
});

test("stop gate: a done implementer entry whose branch awaits the reviewer drives the settle (ticket #121)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Delivered, unreviewed");
		execFileSync("gh", ["issue", "edit", String(n), "--add-label", "dl/in-progress"], { cwd: fx.repo, stdio: "pipe" });
		plantDispatch(ctx, {
			[String(n)]: { pid: 1, role: "implementer", branch: `feat/${n}-delivered`, worktree: "/wt", startedAt: 1000, status: "done", report: "STATUS: DONE", endedAt: 2000 },
		});
		const d = await evaluateSettle(ctx.cwd);
		assert.ok(d, "a delivered unreviewed branch is work-to-do: the gate must not settle");
		assert.equal(d!.continue, true);
		assert.match(d!.entries[0].content, /await the reviewer/);
		assert.match(d!.entries[0].content, new RegExp(`#${n}`));
		// The moment a reviewer is dispatched, the review clause retires — and the incident
		// shape pins here (ticket #147): a delivered in-pipeline ticket with a RUNNING review
		// drives NOTHING (no dispatch, no review claim). The old startable count was the
		// 2026-11-25 livelock.
		plantDispatch(ctx, {
			[String(n)]: { pid: 1, role: "implementer", branch: `feat/${n}-delivered`, worktree: "/wt", startedAt: 1000, status: "done", report: "STATUS: DONE", endedAt: 2000 },
			[`review-${n}`]: { pid: process.pid, role: "code-reviewer", branch: `feat/${n}-delivered`, worktree: "/wt", startedAt: 3000, status: "running" },
		});
		const d2 = await evaluateSettle(ctx.cwd);
		assert.equal(d2, undefined, "delivered + running review drives nothing (the incident shape) — settle passes");
	} finally { fx.cleanup(); }
});

test("stop gate: a crashed or interrupted reviewer re-arms the review drive — only a RUNNING review suppresses (ticket #124)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Delivered, reviewer died");
		execFileSync("gh", ["issue", "edit", String(n), "--add-label", "dl/in-review"], { cwd: fx.repo, stdio: "pipe" });
		const doneImpl = { pid: 1, role: "implementer", branch: `feat/${n}-delivered`, worktree: "/wt", startedAt: 1000, status: "done", report: "STATUS: DONE", endedAt: 2000 };
		// The exact #124 repro: the reviewer ran, then died — reapDead leaves the terminal
		// `crashed` entry in the state FOREVER, and the ticket sits dl/in-review unreviewed.
		plantDispatch(ctx, {
			[String(n)]: doneImpl,
			[`review-${n}`]: { pid: await deadPid(), role: "code-reviewer", branch: `feat/${n}-delivered`, worktree: "/wt", startedAt: 3000, status: "crashed", endedAt: 4000 },
		});
		const d = await evaluateSettle(ctx.cwd);
		assert.ok(d, "a crashed reviewer leaves the branch unreviewed: the gate must not settle");
		assert.match(d!.entries[0].content, /await the reviewer/);
		assert.match(d!.entries[0].content, new RegExp(`#${n}`));
		// An interrupted reviewer (operator pause / SIGINT) is terminal in exactly the same way.
		plantDispatch(ctx, {
			[String(n)]: doneImpl,
			[`review-${n}`]: { pid: 1, role: "code-reviewer", branch: `feat/${n}-delivered`, worktree: "/wt", startedAt: 3000, status: "interrupted", endedAt: 4000 },
		});
		const di = await evaluateSettle(ctx.cwd);
		assert.ok(di, "an interrupted reviewer is terminal too: the review clause must stand");
		assert.match(di!.entries[0].content, /await the reviewer/);
		assert.match(di!.entries[0].content, new RegExp(`#${n}`));
		// Contrast pin: a LIVE running reviewer suppresses the clause entirely (ticket #147
		// incident shape): delivered + running review drives NOTHING — settle passes.
		plantDispatch(ctx, {
			[String(n)]: doneImpl,
			[`review-${n}`]: { pid: process.pid, role: "code-reviewer", branch: `feat/${n}-delivered`, worktree: "/wt", startedAt: 3000, status: "running" },
		});
		const dr = await evaluateSettle(ctx.cwd);
		assert.equal(dr, undefined, "a running review suppresses every clause — settle passes (the incident shape)");
	} finally { fx.cleanup(); }
});

test("stop gate: a done entry on an UNLABELLED ticket (or a label-less tracker) still claims the review clause — a label anomaly must not re-dispatch the implementer (ticket #147)", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Delivered but unlabelled");
		plantDispatch(ctx, {
			[String(n)]: { pid: 1, role: "implementer", branch: `feat/${n}-x`, worktree: "/wt", startedAt: 1000, status: "done", report: "STATUS: DONE", endedAt: 2000 },
		});
		const d = await evaluateSettle(ctx.cwd);
		assert.ok(d, "the delivered branch is work-to-do: the review clause claims it regardless of the label");
		assert.match(d!.entries[0].content, /await the reviewer/);
		assert.match(d!.entries[0].content, new RegExp(`#${n}`));
		assert.ok(!d!.entries[0].content.toLowerCase().includes("startable"), "the dispatch clause must NOT claim a delivered ticket");
	} finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// Grammar pin (#99): providers validating tool names against the OpenAI
// function-name grammar reject a DOT (observed: Kimi 400 "function name is
// invalid"). Every registered control-plane tool name must stay inside the
// portable character set — the list is derived from the registration, not a
// hardcoded echo, so a future rename cannot drift back out silently.
// ---------------------------------------------------------------------------
test("pin: every registered control-plane tool name matches the OpenAI function-name grammar /^[A-Za-z][A-Za-z0-9_-]*$/ (no dots)", () => {
	const names = makeTools().map((t) => t.name);
	assert.ok(names.length > 0, "makeTools() returned no tools");
	for (const name of names) {
		assert.match(
			name,
			/^[A-Za-z][A-Za-z0-9_-]*$/,
			`registered tool name ${JSON.stringify(name)} violates the OpenAI function-name grammar — a dot (or any other character outside [A-Za-z0-9_-]) makes every grammar-validating provider reject the whole request (Kimi 400)`,
		);
	}
});
