import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeTools, evaluateSettle, buildContext, cancelImpl, classifyReport, finishEntry, findOpenTicket } from "../../extension/src/tools.ts";
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
		const res = await call(ctx, "devloop.dispatch", { role: "implementer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.ok(existsSync(roleFile), "the child saw the FAKE_PI_ECHO_ROLE seam");
		assert.equal(readFileSync(roleFile, "utf8"), "implementer", "child env carried its role name");
	} finally {
		delete process.env.FAKE_PI_ECHO_ROLE;
		fx.cleanup();
	}
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
		const res = await call(ctx, "devloop.dispatch", { role: "analyst" });
		assert.equal(res.isError, true);
		assert.match(textOf(res), /requires `spec`.*`focus`/);
	} finally { fx.cleanup(); }
});

test("dispatch(analyst) plans from a spec, writes no ticket, records a done entry", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], format: null, format_extensions: null, fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const res = await call(ctx, "devloop.dispatch", { role: "analyst", spec: "docs/prd.md" });
		assert.equal(res.isError ?? false, false, textOf(res));
		const out = textOf(res);
		assert.match(out, /analyst .* -> done/);
		assert.match(out, /plan file: .*notes\/tickets-prd-md\.md/);
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
		const res = await call(ctx, "devloop.dispatch", { role: "scenario-writer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
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
		const res = await call(ctx, "devloop.dispatch", { role: "scenario-writer", ticket: n });
		assert.match(textOf(res), /scenario-writer #\d+ .* -> done/, textOf(res));
		const commentFile = path.join(fx.dir, "gh", "comments", String(n));
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
		const res = await call(ctx, "devloop.dispatch", { role: "scenario-writer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.match(textOf(res), /scenario-writer #\d+ .* -> blocked/, textOf(res));
		const labelFile = path.join(fx.dir, "gh", "labels", String(n));
		assert.ok(existsSync(labelFile), "the label was recorded");
		assert.ok(readFileSync(labelFile, "utf8").trim().split("\n").includes("dl/blocked"), "dl/blocked applied");
		assert.ok(!existsSync(path.join(fx.dir, "gh", "comments", String(n))), "no scenario comment on a blocked ticket");
		const state = JSON.parse(readFileSync(path.join(fx.dir, "home", "proj", "dispatch.json"), "utf8"));
		assert.equal(state[`scenario-writer-${n}`].status, "blocked");
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
		const res = await call(ctx, "devloop.dispatch", { role: "scenario-writer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.match(textOf(res), /scenario-writer #\d+ .* -> done/, textOf(res));
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
		const res = await call(ctx, "devloop.dispatch", { role: "scenario-writer", ticket: n });
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
		const res1 = await call(ctx, "devloop.dispatch", { role: "scenario-writer" });
		assert.equal(res1.isError, true);
		assert.match(textOf(res1), /scenario-writer requires `ticket`/);
		const res2 = await call(ctx, "devloop.dispatch", { role: "scenario-writer", ticket: 9999 });
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
		const res = await call(ctx, "devloop.dispatch", { role: "scenario-writer", ticket: 77 });
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
		const res = await call(ctx, "devloop.dispatch", { role: "implementer", ticket: n });
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
		const res = await call(ctx, "devloop.dispatch", { role: "implementer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
		assert.match(textOf(res), new RegExp(`implementer #${n} .* -> done`), textOf(res));
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
		const res = await call(ctx, "devloop.dispatch", { role: "implementer", ticket: n });
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
		const res = await call(ctx, "devloop.dispatch", { role: "implementer", ticket: n });
		assert.equal(res.isError ?? false, false, textOf(res));
	} finally { fx.cleanup(); }
});

test("dispatch streams a status line (elapsed, tokens, cost, activity) while the child runs", async () => {
	const fx = makeFixture(JSON.stringify({ base_branch: "main", checks: [{ name: "unit", command: "true", heavy: false }], format: null, format_extensions: null, fast_check: "true" }));
	setupEnv(fx);
	try {
		const ctx = ctxWithAgents(fx);
		const n = createIssue(fx, "Stream a status line");
		const updates: string[] = [];
		const tools = makeTools();
		const tool = tools.find((t) => t.name === "devloop.dispatch")!;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test harness drives raw tool executes
		const res = await (tool.execute as unknown as (id: string, p: Record<string, unknown>, s: unknown, u: (u: { content?: { text?: string }[] }) => void, tc: unknown) => Promise<any>)(
			"tc-test",
			{ role: "implementer", ticket: n },
			new AbortController().signal,
			(u: { content?: { text?: string }[] }) => {
				const t = (u.content ?? []).map((c) => c.text ?? "").join("");
				if (t) updates.push(t);
			},
			{ cwd: ctx.cwd },
		);
		assert.equal(res.isError ?? false, false, textOf(res));
		const statusLines = updates.filter((t) => /tok [^ ]* · \$\d/.test(t));
		assert.ok(statusLines.length >= 1, "a status update streamed: " + JSON.stringify(updates).slice(0, 400));
		assert.match(statusLines[statusLines.length - 1], /implementer/);
	} finally { fx.cleanup(); }
});
