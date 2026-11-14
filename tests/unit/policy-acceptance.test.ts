// P5 acceptance (permission-policy spec 2026-11-09-multipi-permission-policy.md §10):
// the FULL-TRAIN ZERO-DENY — a real dispatch -> review -> gate -> merge against the
// offline fixture (fake-gh/fake-pi, local bare origin), with the policy ARMED and the
// Layer-2 shims on PATH for every process the loop spawns (the tools, the fake-pi
// children, the train scripts). The loop's own operations — including merge-train's main
// push, which travels as `gh pr merge` — must run CLEAN through the shims: zero denies
// and zero asks in the audit log, the merge proven to pass via the §5 trusted-program
// EXEMPTION (a trusted-exempt allow line for the merge action, not silence), the
// train-green record written by the gate, and origin/main advanced by the squash.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTools, buildContext } from "../../extension/src/tools.ts";
import { loadConfig, resolvePaths } from "../../extension/src/config.ts";
import { makeFixture } from "../fixtures.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

/** The fixture project's config: an ordinary train PLUS the armed policy block (self-only). */
const POLICY_TRAIN_CONFIG = JSON.stringify({
	base_branch: "main",
	remote: "origin",
	fast_check: "test -f README.md",
	format: null,
	format_extensions: null,
	checks: [{ name: "unit", command: "true", heavy: false }],
	heavy: { slots: 2, poll_seconds: 1 },
	stop_gate: { require_clean_tree: true, max_blocks: 5 },
	merge: { method: "squash", delete_branch: true },
	policy: { posture: "allow", repos: ["self"], secondaries: [], token_ttl_minutes: 10 },
});

function setupEnv(fx: ReturnType<typeof makeFixture>) {
	const bin = path.join(fx.dir, "bin");
	mkdirSync(bin, { recursive: true });
	execFileSync("ln", ["-sf", path.join(ROOT, "tests", "fake-gh"), path.join(bin, "gh")]);
	process.env.MULTIPI_HOME = path.join(fx.dir, "home");
	process.env.MULTIPI_LOCK_DIR = path.join(fx.dir, "locks");
	process.env.FAKE_GH_DIR = path.join(fx.dir, "gh");
	process.env.MULTIPI_GH_SETTLE_SECONDS = "0";
	process.env.MULTIPI_PI_BIN = path.join(ROOT, "tests", "fake-pi");
	const d = path.join(fx.dir, "agents");
	mkdirSync(d, { recursive: true });
	for (const [name, prompt] of [
		["implementer", "Implement the ticket and end with STATUS: DONE."],
		["code-reviewer", "Review. End with VERDICT: APPROVE."],
	] as const) {
		writeFileSync(path.join(d, `${name}.md`), `---\nname: ${name}\ndescription: x\ntools: read, bash\n---\n${prompt}\n`);
	}
	process.env.MULTIPI_AGENTS_DIR = d;
	process.env.PATH = `${bin}:${process.env.PATH}`;
}

/** Snapshot the env vars the test arms, so the finally block can restore them exactly like
 * PATH/FAKE_PI_REPORT (the test process must not leak armed policy state across tests). */
const ENV_KEYS = [
	"PATH",
	"MULTIPI_HOME",
	"MULTIPI_LOCK_DIR",
	"FAKE_GH_DIR",
	"MULTIPI_GH_SETTLE_SECONDS",
	"MULTIPI_PI_BIN",
	"MULTIPI_AGENTS_DIR",
] as const;

/** Install the loop INTO the fixture and arm the policy: the Layer-2 shims (the
 * installer-owned copies in the fixture's own tree) go first on PATH for EVERY process
 * this test spawns — the loop scripts, the fake-pi children, and the test's own git. */
function armPolicy(fx: ReturnType<typeof makeFixture>) {
	execFileSync("bash", [path.join(ROOT, "scripts", "install.sh"), fx.repo], { stdio: "pipe" });
	// The install artifacts are loop-owned; keep the tree clean for the train's fail-closed
	// probes (this git runs BEFORE the shims join PATH, so it is unshimmed by construction).
	writeFileSync(path.join(fx.repo, ".gitignore"), "scripts/\n.pi/\npermissions.json\n");
	execFileSync("git", ["add", ".gitignore"], { cwd: fx.repo, stdio: "pipe" });
	execFileSync("git", ["commit", "-qm", "chore: ignore loop install artifacts"], { cwd: fx.repo, stdio: "pipe" });
	execFileSync("git", ["push", "-q", "origin", "main"], { cwd: fx.repo, stdio: "pipe" });
	// Arm the policy: an explicit permissions.json (zero rules — the audit baseline stays
	// empty so every non-default line and every rule-backed/trusted allow is signal).
	writeFileSync(
		path.join(fx.repo, "permissions.json"),
		JSON.stringify({ permissions: { deny: [], ask: [], allow: [] } }),
	);
	process.env.PATH = `${fx.repo}/scripts/policy-shims:${process.env.PATH}`;
}

function stateDir(fx: ReturnType<typeof makeFixture>): string {
	return path.join(fx.dir, "home", "proj");
}
function auditLines(fx: ReturnType<typeof makeFixture>): Array<Record<string, string>> {
	const cfg = loadConfig(fx.repo);
	assert.ok(cfg, "fixture config loads");
	const p = path.join(resolvePaths(cfg).logsDir, "policy-audit.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>);
}
function createIssue(fx: ReturnType<typeof makeFixture>, title: string): number {
	const url = execFileSync("gh", ["issue", "create", title], { cwd: fx.repo, stdio: "pipe" }).toString().trim();
	return Number(url.split("/").pop());
}
function notesFor(fx: ReturnType<typeof makeFixture>, branch: string): void {
	const note = path.join(stateDir(fx), "notes", `pr-${branch.replaceAll("/", "_")}.md`);
	mkdirSync(path.dirname(note), { recursive: true });
	writeFileSync(note, `feat: work for ${branch}\n\n## Summary\nx\n\nCloses #n\n`);
}
async function call(ctx: ReturnType<typeof buildContext>, name: string, args: Record<string, unknown>) {
	const tools = makeTools();
	const tool = tools.find((t) => t.name === name)!;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test harness drives raw tool executes
	const res = await (tool.execute as unknown as (id: string, p: Record<string, unknown>, s: unknown, u: unknown, tc: unknown) => Promise<any>)("tc-p5", args, new AbortController().signal, undefined, { cwd: ctx.cwd });
	return res;
}
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
	r.content.map((c) => c.text ?? "").join("");

test("P5 acceptance: the full train (dispatch -> review -> gate -> merge) runs zero-deny through the armed shims", async () => {
	const fx = makeFixture(POLICY_TRAIN_CONFIG);
	const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
	setupEnv(fx);
	try {
		armPolicy(fx);
		const ctx = buildContext(fx.repo);
		const mainBefore = execFileSync("git", ["-C", fx.origin, "rev-parse", "refs/heads/main"], { stdio: "pipe" }).toString().trim();
		assert.ok(auditLines(fx).length === 0, "the audit log starts empty (arming ran unshimmed)");

		// DISPATCH: the implementer child (fake-pi) commits in its worktree and pushes its
		// branch — through the shims, as a self-repo mutation.
		const n = createIssue(fx, "Train ticket zero deny");
		const dispatch = await call(ctx, "devloop.dispatch", { role: "implementer", ticket: n });
		assert.equal(dispatch.isError ?? false, false, textOf(dispatch));
		assert.match(textOf(dispatch), /implementer #\d+ .* -> done/);
		const branch = JSON.parse(readFileSync(path.join(stateDir(fx), "dispatch.json"), "utf8"))[String(n)].branch as string;
		assert.ok(branch.startsWith("feat/"), "the dispatch branch is recorded");

		// REVIEW: the code-reviewer child reports a terminal VERDICT (fake-pi report seam).
		const reportFile = path.join(fx.dir, "review-verdict.md");
		writeFileSync(reportFile, "Reviewed the diff. No issues.\n\nVERDICT: APPROVE\n");
		process.env.FAKE_PI_REPORT = reportFile;
		const review = await call(ctx, "devloop.dispatch", { role: "code-reviewer", ticket: n });
		delete process.env.FAKE_PI_REPORT;
		assert.equal(review.isError ?? false, false, textOf(review));
		assert.match(textOf(review), /code-reviewer #\d+ .* -> done/);

		// GATE: green across the train; the train-green record is written.
		const gate = await call(ctx, "devloop.gate", { branches: [branch] });
		assert.equal(gate.isError ?? false, false, textOf(gate));
		assert.match(textOf(gate), /GATE GREEN/);
		assert.ok(existsSync(path.join(stateDir(fx), "train-green.txt")), "the train-green record was written");

		// MERGE: merge-train replays and squashes through `gh pr merge` — the main push.
		notesFor(fx, branch);
		const merge = await call(ctx, "devloop.merge", { branches: [branch] });
		assert.equal(merge.isError ?? false, false, textOf(merge));
		assert.match(textOf(merge), /MERGED/);
		const mainAfter = execFileSync("git", ["-C", fx.origin, "rev-parse", "refs/heads/main"], { stdio: "pipe" }).toString().trim();
		assert.notEqual(mainAfter, mainBefore, "the train landed: origin/main advanced by the squash");

		// THE ACCEPTANCE ASSERTIONS on the audit log: zero unexpected denies (and no asks —
		// an ask would have blocked the train anyway), and the merge's pass is PROVEN to be
		// the §5 trusted-program exemption (an audited trusted-exempt allow for the merge
		// action), not a silent hole in the shims.
		const lines = auditLines(fx);
		assert.ok(lines.length >= 1, "the shims wrote audit evidence for the train");
		const denies = lines.filter((l) => l.verdict === "deny");
		assert.equal(denies.length, 0, `zero unexpected denies (got: ${JSON.stringify(denies)})`);
		const asks = lines.filter((l) => l.verdict === "ask");
		assert.equal(asks.length, 0, `no ask blocks the train (got: ${JSON.stringify(asks)})`);
		const mergeExempt = lines.filter(
			(l) => l.ruleId === "trusted:exemption" && l.verdict === "allow" && l.layer === "shim" && /pr merge/.test(l.actionSummary),
		);
		assert.ok(mergeExempt.length >= 1, "merge-train's main push passed via the trusted:exemption allow (ruleId + layer shim + the merge action)");
	} finally {
		delete process.env.FAKE_PI_REPORT;
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k]!;
		}
		fx.cleanup();
	}
});
