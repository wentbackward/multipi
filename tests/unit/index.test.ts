import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import devloopExtension, { livenessWriteAttempts, resolveWatchScript } from "../../extension/index.ts";
import { GUARD_REFUSAL } from "../../extension/src/guard.ts";
import { loadState, sidecarPath, writeState } from "../../extension/src/liveness.ts";
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
		assert.deepEqual(hookNames(hooks).sort(), ["agent_before_settle", "message_update", "session_shutdown", "session_start", "session_start", "session_start", "session_start", "session_tree", "tool_call", "tool_execution_end", "tool_execution_start", "tool_result"]);
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

// --- watchdog script anchor (round-2 review item 1; candidate 3 deleted round-3) -----
// The auto-start must find the repo's vendored scripts/ (installed loops version their
// scripts with the target); when it is missing (a session not rooted in an installed loop,
// e.g. the source tree) the module-relative fallback serves it (../scripts). The repo
// PARENT (a bare ../../ from the source tree) must never win.

test("resolveWatchScript: the repo's vendored copy wins, wherever the module was loaded from", () => {
	const root = mkdtempSync(path.join(tmpdir(), "multipi-watch-root-"));
	try {
		mkdirSync(path.join(root, "scripts"));
		writeFileSync(path.join(root, "scripts", "multipi-watch.sh"), "#!/usr/bin/env bash\n");
		assert.equal(resolveWatchScript(root), path.join(root, "scripts", "multipi-watch.sh"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolveWatchScript: the module-relative fallback lands in the REPO's scripts dir, never the repo parent's", () => {
	const empty = mkdtempSync(path.join(tmpdir(), "multipi-watch-empty-"));
	const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	try {
		const resolved = resolveWatchScript(empty);
		assert.ok(resolved, "the fallback found a packaged multipi-watch.sh");
		assert.ok(existsSync(resolved!), "the fallback resolves to a real file");
		assert.equal(path.resolve(path.dirname(path.dirname(resolved!))), ROOT,
			"the fallback script sits in this repo's scripts/ — not the repo parent's");
	} finally { rmSync(empty, { recursive: true, force: true }); }
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

function fakePiLoadOrchestrator() {
	const { pi, tools, hooks, commands } = fakePi();
	devloopExtension(pi);
	return { tools, hooks, commands };
}

// --- the guard matrix (spec §3): what a child may register ------------------

test("child without a role registers NOTHING — no tools, hooks, or commands", () => {
	const store = storePath();
	const fx = makeFixture(JSON.stringify({ factory: "dark", scenarios: { dir: store } }));
	try {
		const { tools, hooks, commands } = loadChild(undefined, fx.repo);
		assert.equal(tools.length, 0, "no tools in a child");
		assert.equal(hooks.length, 0, "no hooks in a child");
		assert.equal(commands.length, 0, "no commands in a child");
	} finally { fx.cleanup(); rmSync(store, { recursive: true }); }
});

for (const role of ["implementer", "code-reviewer", "verifier"]) {
	test(`child of guarded role '${role}' with the store on registers exactly ONE tool_call hook and nothing else`, () => {
		const store = storePath();
		const fx = makeFixture(JSON.stringify({ factory: "dark", scenarios: { dir: store } }));
		try {
			const { tools, hooks, commands } = loadChild(role, fx.repo);
			assert.deepEqual(hookNames(hooks), ["tool_call"], "exactly one hook, and it is the block-capable tool_call");
			assert.equal(tools.length, 0, "no tools: a guarded child still cannot drive the loop");
			assert.equal(commands.length, 0, "no UI: no /devloop-agents");
		} finally { fx.cleanup(); rmSync(store, { recursive: true }); }
	});
}

for (const role of ["analyst", "scenario-writer", "scenario-judge"]) {
	test(`child of UNGUARDED role '${role}' with the store on registers nothing (it must reach the store freely)`, () => {
		const store = storePath();
		const fx = makeFixture(JSON.stringify({ factory: "dark", scenarios: { dir: store } }));
		try {
			const { tools, hooks, commands } = loadChild(role, fx.repo);
			assert.equal(tools.length, 0);
			assert.equal(hooks.length, 0);
			assert.equal(commands.length, 0);
		} finally { fx.cleanup(); rmSync(store, { recursive: true }); }
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
	const store = storePath();
	const fx = makeFixture(JSON.stringify({ factory: "dark", scenarios: { dir: store } }));
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
	} finally { fx.cleanup(); rmSync(store, { recursive: true }); }
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
			["bash", { command: `ls ${store}*` }],
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
	} finally { fx.cleanup(); rmSync(store, { recursive: true }); }
});

// --- Layer-2 policy shims: the session_start PATH prepend (ticket #41, spec §4-L2) ----------

test("orchestrator session_start prepends the installed policy shims to PATH (idempotent; absent dir ⇒ no-op)", () => {
	const fx = makeFixture("{}");
	const saved = process.env.PATH;
	const savedChild = process.env.MULTIPI_CHILD;
	delete process.env.MULTIPI_CHILD;
	const savedHome = process.env.MULTIPI_HOME; // liveness must not write a sidecar into the real home
	process.env.MULTIPI_HOME = path.join(fx.dir, "home");
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
		if (savedHome === undefined) delete process.env.MULTIPI_HOME;
		else process.env.MULTIPI_HOME = savedHome;
		if (savedChild === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = savedChild;
		fx.cleanup();
	}
});

test("session_start shim PATH idempotency is CANONICAL (round-13 should-fix): an aliased or relative spelling of the shims dir on PATH is not double-prepended", () => {
	const fx = makeFixture("{}");
	const saved = process.env.PATH;
	const savedChild = process.env.MULTIPI_CHILD;
	delete process.env.MULTIPI_CHILD;
	const savedHome = process.env.MULTIPI_HOME;
	process.env.MULTIPI_HOME = path.join(fx.dir, "home");
	const shims = path.join(fx.repo, "scripts", "policy-shims");
	mkdirSync(shims, { recursive: true });
	const real = realpathSync(shims);
	// A symlink ALIAS of the shims dir: the surface spelling a session of the
	// symlinked main worktree builds differs from the physical entry an earlier
	// session already prepended — exact-string compare misses it.
	const alias = path.join(fx.dir, "shims-alias");
	symlinkSync(shims, alias);
	const canon = (p: string): string => { try { return realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };
	// Count shims-dir entries resolving AGAINST fx.repo: that is the root the hook's
	// own resolution uses while the session cwd is fx.repo (see fire below).
	const countRepoCanon = (): number => (process.env.PATH ?? "").split(path.delimiter).filter(
		(e) => e && canon(path.isAbsolute(e) ? e : path.join(fx.repo, e)) === real,
	).length;
	const fire = (): void => {
		const { pi, hooks } = fakePi();
		// Round-14 test-validity fix: fire the session_start hooks INSIDE withCwd — the
		// production shape. The hook resolves PATH entries against process.cwd(), so
		// firing after withCwd restored the runner's cwd made the relative entry
		// unrecognisable while the same wrong cwd kept the count from seeing the
		// double-prepend: the old case 2 pinned nothing.
		withCwd(fx.repo, () => {
			devloopExtension(pi);
			const ctx = { cwd: fx.repo, hasUI: false, mode: "rpc" } as never;
			for (const h of hooks.filter((x) => x.name === "session_start")) h.fn({}, ctx);
		});
	};
	try {
		// Case 1: a symlink alias of the shims dir already leads PATH (surface A armed it;
		// this session of surface B must recognise it, not prepend a second entry).
		process.env.PATH = `${alias}:${saved}`;
		fire();
		assert.equal(countRepoCanon(), 1, `the aliased entry must count as the shims dir, got: ${process.env.PATH}`);
		assert.equal(process.env.PATH, `${alias}:${saved}`, "the alias was recognised — PATH untouched, nothing prepended");
		// Case 2: a cwd-relative spelling of the shims dir is the same dir too.
		process.env.PATH = `scripts/policy-shims:${saved}`;
		fire();
		assert.equal(countRepoCanon(), 1, `the relative entry must count as the shims dir, got: ${process.env.PATH}`);
		assert.equal(process.env.PATH, `scripts/policy-shims:${saved}`, "the relative entry was recognised — PATH untouched, nothing prepended");
	} finally {
		process.env.PATH = saved;
		if (savedHome === undefined) delete process.env.MULTIPI_HOME;
		else process.env.MULTIPI_HOME = savedHome;
		if (savedChild === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = savedChild;
		fx.cleanup();
		rmSync(alias, { force: true });
	}
});

test("session_start with no installed shims leaves PATH untouched (the loop is not armed there)", () => {
	const fx = makeFixture("{}");
	const saved = process.env.PATH;
	const savedChild = process.env.MULTIPI_CHILD;
	delete process.env.MULTIPI_CHILD;
	const savedHome = process.env.MULTIPI_HOME;
	process.env.MULTIPI_HOME = path.join(fx.dir, "home");
	try {
		const { pi, hooks } = fakePi();
		withCwd(fx.repo, () => devloopExtension(pi));
		for (const h of hooks.filter((x) => x.name === "session_start")) h.fn({}, { cwd: fx.repo, hasUI: false, mode: "rpc" } as never);
		assert.equal(process.env.PATH, saved, "no shims dir ⇒ PATH unchanged");
	} finally {
		process.env.PATH = saved;
		if (savedHome === undefined) delete process.env.MULTIPI_HOME;
		else process.env.MULTIPI_HOME = savedHome;
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

// --- Orchestrator liveness (spec 2026-11-15 §1): the sidecar is kept from events ---

test("orchestrator liveness: session_start seeds the sidecar, tool_execution_* drives tool/seq/state, shutdown writes ended", async () => {
	const fx = makeFixture(BASE_CONFIG);
	const home = path.join(fx.dir, "home");
	const stDir = path.join(home, "proj"); // resolveState: MULTIPI_HOME/<repo basename>
	const savedHome = process.env.MULTIPI_HOME;
	const savedChild = process.env.MULTIPI_CHILD;
	const savedRole = process.env.MULTIPI_CHILD_ROLE;
	process.env.MULTIPI_HOME = home;
	delete process.env.MULTIPI_CHILD;
	delete process.env.MULTIPI_CHILD_ROLE;
	try {
		await withCwd(fx.repo, async () => {
			const { hooks } = fakePiLoadOrchestrator();
			const ctx = { cwd: fx.repo, hasUI: false, mode: "rpc", sessionManager: { getSessionId: () => "sess-live" } } as never;
			const fire = (name: string, event: unknown) =>
				Promise.all(hooks.filter((h) => h.name === name).map((h) => h.fn(event, ctx)));

			await fire("session_start", { reason: "startup" });
			let s = loadState(stDir);
			assert.ok(s, "the sidecar exists after session_start");
			assert.equal(s!.state, "active");
			assert.equal(s!.pid, process.pid, "the in-process pid is the sidecar's pid");
			assert.equal(s!.sessionId, "sess-live");
			assert.equal(s!.tool, null);

			await fire("tool_execution_start", { toolCallId: "c1", toolName: "devloop.gate", args: {} });
			s = loadState(stDir);
			assert.equal(s!.tool?.name, "devloop.gate");
			assert.equal(s!.tool?.seq, 1, "the first tool call starts the sequence at 1");
			assert.equal(s!.state, "active");

			await fire("tool_execution_start", { toolCallId: "c2", toolName: "devloop.status", args: {} });
			assert.equal(loadState(stDir)!.tool?.seq, 2, "seq increments on every start");

			const evBefore = loadState(stDir)!.lastEventAt;
			await fire("message_update", {});
			const evAfter = loadState(stDir)!.lastEventAt;
			assert.ok(evAfter >= evBefore, "high-frequency events tick lastEventAt");

			await fire("tool_execution_end", { toolCallId: "c2", toolName: "devloop.status" });
			s = loadState(stDir);
			assert.equal(s!.tool, null, "the tool is cleared on end");
			assert.equal(s!.state, "idle", "back to idle with no tool in flight");

			await fire("session_shutdown", { reason: "quit" });
			assert.equal(loadState(stDir)!.state, "ended", "shutdown writes state:ended");
		});
	} finally {
		if (savedHome === undefined) delete process.env.MULTIPI_HOME;
		else process.env.MULTIPI_HOME = savedHome;
		if (savedChild === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = savedChild;
		if (savedRole === undefined) delete process.env.MULTIPI_CHILD_ROLE;
		else process.env.MULTIPI_CHILD_ROLE = savedRole;
		fx.cleanup();
	}
});

test("orchestrator liveness: shutdown makes the sidecar TERMINAL — the trailing tool event (pi's shutdown-mid-tool) never rewrites the ended tombstone", async () => {
	const fx = makeFixture(BASE_CONFIG);
	const home = path.join(fx.dir, "home");
	const stDir = path.join(home, "proj");
	const savedHome = process.env.MULTIPI_HOME;
	const savedChild = process.env.MULTIPI_CHILD;
	const savedRole = process.env.MULTIPI_CHILD_ROLE;
	process.env.MULTIPI_HOME = home;
	delete process.env.MULTIPI_CHILD;
	delete process.env.MULTIPI_CHILD_ROLE;
	try {
		await withCwd(fx.repo, async () => {
			const { hooks } = fakePiLoadOrchestrator();
			const ctx = { cwd: fx.repo, hasUI: false, mode: "rpc", sessionManager: { getSessionId: () => "sess-term" } } as never;
			const fire = (name: string, event: unknown) =>
				Promise.all(hooks.filter((h) => h.name === name).map((h) => h.fn(event, ctx)));

			// The exact incident this ticket exists for: shutdown WHILE a tool is in flight.
			await fire("session_start", { reason: "startup" });
			await fire("tool_execution_start", { toolCallId: "c1", toolName: "devloop.gate", args: {} });
			assert.equal(loadState(stDir)!.state, "active");
			await fire("session_shutdown", { reason: "quit" });
			assert.equal(loadState(stDir)!.state, "ended", "shutdown writes the tombstone");
			// pi's docs guarantee the trailing tool_execution_end is delivered AFTER the shutdown.
			// The tombstone (in-flight tool snapshot included) must not be TOUCHED by any
			// later event — byte-identical is the sharpest pin.
			const tombstone = readFileSync(sidecarPath(stDir), "utf8");
			await fire("tool_execution_end", { toolCallId: "c1", toolName: "devloop.gate" });
			assert.equal(loadState(stDir)!.state, "ended", "the trailing end does NOT rewrite the tombstone to idle");
			// A late start and a late message tick are dead too.
			await fire("tool_execution_start", { toolCallId: "c2", toolName: "devloop.status", args: {} });
			await fire("message_update", {});
			assert.equal(readFileSync(sidecarPath(stDir), "utf8"), tombstone, "late events never rewrite a shut-down doc");
			assert.equal(loadState(stDir)!.state, "ended");
		});
	} finally {
		if (savedHome === undefined) delete process.env.MULTIPI_HOME;
		else process.env.MULTIPI_HOME = savedHome;
		if (savedChild === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = savedChild;
		if (savedRole === undefined) delete process.env.MULTIPI_CHILD_ROLE;
		else process.env.MULTIPI_CHILD_ROLE = savedRole;
		fx.cleanup();
	}
});

test("orchestrator liveness: two same-millisecond message_update ticks cause at most ONE sidecar write (throttle pinned on count/content, not mtime)", async () => {
	const fx = makeFixture(BASE_CONFIG);
	const home = path.join(fx.dir, "home");
	const stDir = path.join(home, "proj");
	const savedHome = process.env.MULTIPI_HOME;
	const savedChild = process.env.MULTIPI_CHILD;
	const savedRole = process.env.MULTIPI_CHILD_ROLE;
	process.env.MULTIPI_HOME = home;
	delete process.env.MULTIPI_CHILD;
	delete process.env.MULTIPI_CHILD_ROLE;
	const realNow = Date.now;
	try {
		await withCwd(fx.repo, async () => {
			const { hooks } = fakePiLoadOrchestrator();
			const ctx = { cwd: fx.repo, hasUI: false, mode: "rpc", sessionManager: { getSessionId: () => "sess-thr" } } as never;
			const fire = (name: string, event: unknown) =>
				Promise.all(hooks.filter((h) => h.name === name).map((h) => h.fn(event, ctx)));

			// Frozen clock, two windows: session_start lands 2 s before the tick pair (the
			// throttle window is already elapsed by the first tick), and both ticks then
			// land in the SAME millisecond — the worst case for mtime-based assertions,
			// which is exactly why we pin on the write COUNT and the resulting content.
			const frozen = realNow() + 60_000;
			Date.now = () => frozen - 2_000;
			await fire("session_start", { reason: "startup" });
			livenessWriteAttempts.count = 0;

			Date.now = () => frozen;
			await fire("message_update", {});
			await fire("message_update", {});
			assert.ok(livenessWriteAttempts.count <= 1, `at most one sidecar write in the window, got ${livenessWriteAttempts.count}`);
			assert.equal(livenessWriteAttempts.count, 1, "the first tick wrote, the same-millisecond twin was dropped");
			assert.equal(loadState(stDir)!.lastEventAt, frozen, "the surviving write carried the tick (in-memory update persisted once)");

			// Once the window has elapsed, the next tick writes again — the throttle
			// drops duplicates, not events.
			Date.now = () => frozen + 2_000;
			await fire("message_update", {});
			assert.equal(livenessWriteAttempts.count, 2, "the next window's tick writes");
			assert.equal(loadState(stDir)!.lastEventAt, frozen + 2_000, "and its content carries the newer tick");
			Date.now = realNow;
			// Housekeeping: end this session so its 15 s tick cannot outlive the test.
			await fire("session_shutdown", { reason: "quit" });
		});
	} finally {
		Date.now = realNow;
		if (savedHome === undefined) delete process.env.MULTIPI_HOME;
		else process.env.MULTIPI_HOME = savedHome;
		if (savedChild === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = savedChild;
		if (savedRole === undefined) delete process.env.MULTIPI_CHILD_ROLE;
		else process.env.MULTIPI_CHILD_ROLE = savedRole;
		fx.cleanup();
	}
});

test("orchestrator liveness: an externally raised lastWakeSeq is never regressed by a persist (the watchdog's watermark)", async () => {
	const fx = makeFixture(BASE_CONFIG);
	const home = path.join(fx.dir, "home");
	const stDir = path.join(home, "proj");
	const savedHome = process.env.MULTIPI_HOME;
	const savedChild = process.env.MULTIPI_CHILD;
	const savedRole = process.env.MULTIPI_CHILD_ROLE;
	process.env.MULTIPI_HOME = home;
	delete process.env.MULTIPI_CHILD;
	delete process.env.MULTIPI_CHILD_ROLE;
	try {
		await withCwd(fx.repo, async () => {
			const { hooks } = fakePiLoadOrchestrator();
			const ctx = { cwd: fx.repo, hasUI: false, mode: "rpc", sessionManager: { getSessionId: () => "sess-wm" } } as never;
			const fire = (name: string, event: unknown) =>
				Promise.all(hooks.filter((h) => h.name === name).map((h) => h.fn(event, ctx)));

			await fire("session_start", { reason: "startup" });
			// The watchdog raised the watermark between two tool calls (it writes the sidecar too).
			writeState(stDir, { ...loadState(stDir)!, lastWakeSeq: 3 });
			await fire("tool_execution_start", { toolCallId: "c9", toolName: "devloop.gate", args: {} });
			assert.equal(loadState(stDir)!.lastWakeSeq, 3, "the persist adopted the higher watermark instead of regressing it");
		});
	} finally {
		if (savedHome === undefined) delete process.env.MULTIPI_HOME;
		else process.env.MULTIPI_HOME = savedHome;
		if (savedChild === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = savedChild;
		if (savedRole === undefined) delete process.env.MULTIPI_CHILD_ROLE;
		else process.env.MULTIPI_CHILD_ROLE = savedRole;
		fx.cleanup();
	}
});
