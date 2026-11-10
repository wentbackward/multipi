import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import devloopExtension from "../../extension/index.ts";
import { GUARD_REFUSAL } from "../../extension/src/guard.ts";
import { BASE_CONFIG, makeFixture } from "../fixtures.ts";

interface HookRec { name: string; fn: (event: unknown, ctx: unknown) => unknown; }

function fakePi() {
	const tools: string[] = [];
	const hooks: HookRec[] = [];
	const commands: string[] = [];
	// Minimal ExtensionAPI surface as used by the factory.
	const pi = {
		registerTool: (t: { name?: string }) => {
			if (t?.name) tools.push(t.name);
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		on: (name: string, fn: HookRec["fn"]) => {
			hooks.push({ name, fn });
		},
	};
	return { pi: pi as unknown as Parameters<typeof devloopExtension>[0], tools, hooks, commands };
}

const hookNames = (hooks: HookRec[]): string[] => hooks.map((h) => h.name);

/** Save/restore the child env pair (hermetic: the test runner is an "orchestrator"). */
function withChildEnv(role: string | undefined, fn: () => void): void {
	const sChild = process.env.MULTIPI_CHILD;
	const sRole = process.env.MULTIPI_CHILD_ROLE;
	process.env.MULTIPI_CHILD = "1";
	if (role === undefined) delete process.env.MULTIPI_CHILD_ROLE;
	else process.env.MULTIPI_CHILD_ROLE = role;
	try {
		fn();
	} finally {
		if (sChild === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = sChild;
		if (sRole === undefined) delete process.env.MULTIPI_CHILD_ROLE;
		else process.env.MULTIPI_CHILD_ROLE = sRole;
	}
}

/** Extension load resolves config from the CHILD'S cwd: chdir for the duration of fn (sync or promise). */
function withCwd<T>(dir: string, fn: () => T | Promise<T>): T | Promise<T> {
	const old = process.cwd();
	process.chdir(dir);
	const r = fn();
	if (r instanceof Promise) return r.finally(() => process.chdir(old));
	process.chdir(old);
	return r;
}

function loadChild(role: string | undefined, repo: string) {
	const { pi, tools, hooks, commands } = fakePi();
	withCwd(repo, () => withChildEnv(role, () => devloopExtension(pi)));
	return { tools, hooks, commands };
}

/** A unique, real directory standing in for the scenario store. */
const storePath = (): string => mkdtempSync(path.join(tmpdir(), "multipi-guard-store-"));

test("extension registers 6 tools, the full orchestrator hook set and the /devloop-agents command", () => {
	const savedChild = process.env.MULTIPI_CHILD;
	const savedRole = process.env.MULTIPI_CHILD_ROLE;
	const savedHome = process.env.MULTIPI_HOME;
	delete process.env.MULTIPI_CHILD; // hermetic: a loop child's env carries MULTIPI_CHILD=1
	delete process.env.MULTIPI_CHILD_ROLE;
	// The policy enforcer resolves its state dir from env at load: steer it into a scratch dir.
	const home = mkdtempSync(path.join(tmpdir(), "multipi-idx-home-"));
	process.env.MULTIPI_HOME = home;
	try {
		const { pi, tools, hooks, commands } = fakePi();
		devloopExtension(pi);
		assert.equal(tools.length, 6);
		assert.ok(tools.includes("devloop.pause"));
		assert.ok(tools.includes("devloop.dispatch"));
		// P2: the orchestrator gains the policy tool_call hook and a policy session_start seat
		// on top of the pre-existing four (the UI session_start remains); P3's shim-PATH arm
		// is a third session_start seat (the hook set otherwise stays put).
		assert.deepEqual(hookNames(hooks).sort(), ["agent_before_settle", "session_start", "session_start", "session_start", "session_tree", "tool_call", "tool_result"]);
		assert.deepEqual(commands, ["devloop-agents"]);
	} finally {
		if (savedChild === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = savedChild;
		if (savedRole === undefined) delete process.env.MULTIPI_CHILD_ROLE;
		else process.env.MULTIPI_CHILD_ROLE = savedRole;
		if (savedHome === undefined) delete process.env.MULTIPI_HOME;
		else process.env.MULTIPI_HOME = savedHome;
		rmSync(home, { recursive: true, force: true });
	}
});

// --- P2: the policy hook, wired end to end for the orchestrator --------------

test("orchestrator tool_call hook: seeded deny blocks with the exact tripwire text and lands an audit line; session_start records the policy hash", async () => {
	const fx = makeFixture(JSON.stringify({ ...JSON.parse(BASE_CONFIG) }));
	const home = path.join(fx.dir, "home");
	writeFileSync(path.join(fx.repo, "permissions.json"), JSON.stringify({ permissions: { deny: ["Bash(sudo:*)"], ask: [], allow: [] } }));
	const savedHome = process.env.MULTIPI_HOME;
	const savedChild = process.env.MULTIPI_CHILD;
	process.env.MULTIPI_HOME = home;
	delete process.env.MULTIPI_CHILD;
	try {
		await withCwd(fx.repo, async () => {
			const { hooks } = fakePiLoadOrchestrator();
			const call = hooks.find((h) => h.name === "tool_call");
			assert.ok(call, "the orchestrator registers the policy tool_call hook");
			// Real lifecycle: the session-start seats fire before the first tool call.
			for (const h of hooks.filter((x) => x.name === "session_start")) {
				await (h as { fn: (e: unknown, c: unknown) => unknown }).fn({}, { cwd: fx.repo, hasUI: false, mode: "rpc", sessionManager: { getSessionId: () => "sess-idx" } });
			}
			const res = (await (call as { fn: (e: unknown, c: unknown) => unknown }).fn(
				{ toolName: "bash", input: { command: "sudo reboot" } },
				{ cwd: fx.repo, sessionManager: { getSessionId: () => "sess-idx" } },
			)) as { block?: boolean; reason?: string } | undefined;
			assert.equal(res?.block, true);
			assert.equal(res?.reason, "DENIED Bash(sudo:*): denied by rule: Bash(sudo:*)");
			// A pass stays a pass.
			const pass = (await (call as { fn: (e: unknown, c: unknown) => unknown }).fn(
				{ toolName: "read", input: { path: "src/plain.txt" } },
				{ cwd: fx.repo, sessionManager: { getSessionId: () => "sess-idx" } },
			));
			assert.ok(pass == null || (pass as { block?: boolean }).block !== true, "default posture passes");
			const log = path.join(home, "proj", "logs", "policy-audit.jsonl");
			assert.ok(existsSync(log), "the audit log exists under the state dir's logs");
			const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
			assert.equal(lines.length, 2, "session-start line + one verdict line");
			assert.equal(lines[0].event, "policy_session_start");
			assert.equal(typeof lines[0].policyHash, "string");
			assert.equal(lines[1].verdict, "deny");
			assert.equal(lines[1].layer, "hook");
		});
	} finally {
		if (savedHome === undefined) delete process.env.MULTIPI_HOME;
		else process.env.MULTIPI_HOME = savedHome;
		if (savedChild === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = savedChild;
		fx.cleanup();
	}
});

// --- Layer-2 policy shims: the session_start PATH prepend (ticket #41, spec §4-L2) ----------

test("orchestrator session_start prepends the installed policy shims to PATH (idempotent; absent dir ⇒ no-op)", () => {
	const fx = makeFixture("{}");
	const saved = process.env.PATH;
	const savedChild = process.env.MULTIPI_CHILD;
	delete process.env.MULTIPI_CHILD;
	const shims = path.join(fx.repo, "scripts", "policy-shims");
	mkdirSync(shims, { recursive: true });
	try {
		const { pi, hooks } = fakePi();
		withCwd(fx.repo, () => devloopExtension(pi));
		const starts = hooks.filter((h) => h.name === "session_start");
		const ctx = { cwd: fx.repo, hasUI: false, mode: "rpc" };
		for (const h of starts) h.fn({}, ctx as never);
		assert.ok((process.env.PATH ?? "").startsWith(shims + path.delimiter), `PATH must lead with the shims dir, got: ${process.env.PATH}`);
		const count = () => (process.env.PATH ?? "").split(path.delimiter).filter((e) => e === shims).length;
		const n = count();
		assert.equal(n, 1, "prepended exactly once");
		for (const h of starts) h.fn({}, ctx as never);
		assert.equal(count(), 1, "a restarted session never prepends twice");
	} finally {
		process.env.PATH = saved;
		if (savedChild === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = savedChild;
		fx.cleanup();
	}
});

function fakePiLoadOrchestrator() {
	const { pi, tools, hooks, commands } = fakePi();
	devloopExtension(pi);
	return { tools, hooks, commands };
}

test("session_start with no installed shims leaves PATH untouched (the loop is not armed there)", () => {
	const fx = makeFixture("{}");
	const saved = process.env.PATH;
	const savedChild = process.env.MULTIPI_CHILD;
	delete process.env.MULTIPI_CHILD;
	try {
		const { pi, hooks } = fakePi();
		withCwd(fx.repo, () => devloopExtension(pi));
		for (const h of hooks.filter((x) => x.name === "session_start")) h.fn({}, { cwd: fx.repo, hasUI: false, mode: "rpc" } as never);
		assert.equal(process.env.PATH, saved, "no shims dir ⇒ PATH unchanged");
	} finally {
		process.env.PATH = saved;
		if (savedChild === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = savedChild;
		fx.cleanup();
	}
});

test("a child session never registers the shim PATH (inheritance comes from spawnPi's env spread)", () => {
	const fx = makeFixture("{}");
	const saved = process.env.PATH;
	const shims = path.join(fx.repo, "scripts", "policy-shims");
	mkdirSync(shims, { recursive: true });
	try {
		const { hooks } = loadChild("implementer", fx.repo);
		assert.equal(hooks.filter((h) => h.name === "session_start").length, 0, "a child registers no session_start at all");
		assert.equal(process.env.PATH, saved);
	} finally {
		process.env.PATH = saved;
		fx.cleanup();
	}
});