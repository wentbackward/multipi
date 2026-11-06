import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import devloopExtension from "../../extension/index.ts";
import { GUARD_REFUSAL } from "../../extension/src/guard.ts";
import { makeFixture } from "../fixtures.ts";

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

/** Extension load resolves config from the CHILD'S cwd: chdir for the duration of fn. */
function withCwd(dir: string, fn: () => void): void {
	const old = process.cwd();
	process.chdir(dir);
	try {
		fn();
	} finally {
		process.chdir(old);
	}
}

function loadChild(role: string | undefined, repo: string) {
	const { pi, tools, hooks, commands } = fakePi();
	withCwd(repo, () => withChildEnv(role, () => devloopExtension(pi)));
	return { tools, hooks, commands };
}

/** A unique, real directory standing in for the scenario store. */
const storePath = (): string => mkdtempSync(path.join(tmpdir(), "multipi-guard-store-"));

test("extension registers 6 tools, 4 hooks and the /devloop-agents command for an orchestrator session", () => {
	const savedChild = process.env.MULTIPI_CHILD;
	const savedRole = process.env.MULTIPI_CHILD_ROLE;
	delete process.env.MULTIPI_CHILD; // hermetic: a loop child's env carries MULTIPI_CHILD=1
	delete process.env.MULTIPI_CHILD_ROLE;
	try {
		const { pi, tools, hooks, commands } = fakePi();
		devloopExtension(pi);
		assert.equal(tools.length, 6);
		assert.ok(tools.includes("devloop.pause"));
		assert.ok(tools.includes("devloop.dispatch"));
		assert.deepEqual(hookNames(hooks).sort(), ["agent_before_settle", "session_start", "session_tree", "tool_result"]);
		assert.deepEqual(commands, ["devloop-agents"]);
	} finally {
		if (savedChild === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = savedChild;
		if (savedRole === undefined) delete process.env.MULTIPI_CHILD_ROLE;
		else process.env.MULTIPI_CHILD_ROLE = savedRole;
	}
});

// --- the guard matrix (spec §3): what a child may register ------------------

test("child without a role registers NOTHING — no tools, hooks, or commands", () => {
	const fx = makeFixture(JSON.stringify({ factory: "dark", scenarios: { dir: storePath() } }));
	try {
		const { tools, hooks, commands } = loadChild(undefined, fx.repo);
		assert.equal(tools.length, 0, "no tools in a child");
		assert.equal(hooks.length, 0, "no hooks in a child");
		assert.equal(commands.length, 0, "no commands in a child");
	} finally { fx.cleanup(); }
});

for (const role of ["implementer", "code-reviewer", "verifier"]) {
	test(`child of guarded role '${role}' with the store on registers exactly ONE tool_call hook and nothing else`, () => {
		const fx = makeFixture(JSON.stringify({ factory: "dark", scenarios: { dir: storePath() } }));
		try {
			const { tools, hooks, commands } = loadChild(role, fx.repo);
			assert.deepEqual(hookNames(hooks), ["tool_call"], "exactly one hook, and it is the block-capable tool_call");
			assert.equal(tools.length, 0, "no tools: a guarded child still cannot drive the loop");
			assert.equal(commands.length, 0, "no UI: no /devloop-agents");
		} finally { fx.cleanup(); }
	});
}

for (const role of ["analyst", "scenario-writer", "scenario-judge"]) {
	test(`child of UNGUARDED role '${role}' with the store on registers nothing (it must reach the store freely)`, () => {
		const fx = makeFixture(JSON.stringify({ factory: "dark", scenarios: { dir: storePath() } }));
		try {
			const { tools, hooks, commands } = loadChild(role, fx.repo);
			assert.equal(tools.length, 0);
			assert.equal(hooks.length, 0);
			assert.equal(commands.length, 0);
		} finally { fx.cleanup(); }
	});
}

test("child of a guarded role with the store OFF registers nothing, ever (collaborative, no block)", () => {
	const fx = makeFixture("{}");
	try {
		const { tools, hooks, commands } = loadChild("implementer", fx.repo);
		assert.equal(tools.length, 0);
		assert.equal(hooks.length, 0);
		assert.equal(commands.length, 0);
	} finally { fx.cleanup(); }
});

test("child of a guarded role: explicit scenarios:false wins over the dark preset — nothing registered", () => {
	const fx = makeFixture(JSON.stringify({ factory: "dark", scenarios: false }));
	try {
		const { tools, hooks, commands } = loadChild("verifier", fx.repo);
		assert.equal(tools.length, 0);
		assert.equal(hooks.length, 0);
		assert.equal(commands.length, 0);
	} finally { fx.cleanup(); }
});

// --- the one hook, wired: fail closed and active refusal --------------------

async function callGuardHook(hooks: HookRec[], repo: string, toolName: string, input: Record<string, unknown>): Promise<unknown> {
	const rec = hooks.find((h) => h.name === "tool_call");
	assert.ok(rec, "the tool_call hook is registered");
	return (rec as { fn: (e: unknown, c: unknown) => unknown }).fn({ toolName, input }, { cwd: repo });
}

test("FAIL CLOSED: unparseable .devloop.json — hook present, EVERY guarded call refused with the generic text", async () => {
	const fx = makeFixture(JSON.stringify({ factory: "dark", scenarios: { dir: storePath() } }));
	try {
		writeFileSync(fx.config, "{ this is not json");
		const { tools, hooks, commands } = loadChild("implementer", fx.repo);
		assert.deepEqual(hookNames(hooks), ["tool_call"]);
		assert.equal(tools.length, 0);
		assert.equal(commands.length, 0);
		// Even a call that names no path at all is refused when the store is unknowable.
		const cases: [string, Record<string, unknown>][] = [
			["bash", { command: "git status" }],
			["read", { path: "/etc/hosts" }],
			["write", { path: "/etc/hosts", content: "x" }],
		];
		for (const [name, input] of cases) {
			const res = (await callGuardHook(hooks, fx.repo, name, input)) as { block?: boolean; reason?: string } | undefined;
			assert.equal(res?.block, true, `fail-closed refuses ${name}`);
			assert.equal(res?.reason, GUARD_REFUSAL, "refusal names the guard, nothing else");
		}
	} finally { fx.cleanup(); }
});

test("ACTIVE GUARD: store known — in-store calls blocked, everything else allowed", async () => {
	const store = storePath();
	const fx = makeFixture(JSON.stringify({ factory: "dark", scenarios: { dir: store } }));
	try {
		const { tools, hooks } = loadChild("code-reviewer", fx.repo);
		assert.deepEqual(hookNames(hooks), ["tool_call"]);
		assert.equal(tools.length, 0);
		const blocked: [string, Record<string, unknown>][] = [
			["read", { path: `${store}/s/one.md` }],
			["bash", { command: `cd ${store} && cat one.md` }],
			["bash", { command: `cat ${store}/s/*.md` }],
		];
		for (const [name, input] of blocked) {
			const res = (await callGuardHook(hooks, fx.repo, name, input)) as { block?: boolean; reason?: string } | undefined;
			assert.equal(res?.block, true, `active guard blocks ${name}`);
			assert.equal(res?.reason, GUARD_REFUSAL);
		}
		const allowed: [string, Record<string, unknown>][] = [
			["read", { path: "/etc/hosts" }],
			["bash", { command: "git status && npm test" }],
		];
		for (const [name, input] of allowed) {
			const res = (await callGuardHook(hooks, fx.repo, name, input)) as { block?: boolean } | null | undefined;
			assert.ok(res == null || res.block !== true, `allowed: ${name}`);
		}
	} finally { fx.cleanup(); }
});
