import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { GUARDED_ROLES, GUARD_REFUSAL, callTouchesStore, initGuard } from "../../extension/src/guard.ts";
import { makeFixture } from "../fixtures.ts";

// Hermetic env: $HOME expansion resolves against this, never the test runner's real home.
const ENV = { HOME: "/h" } as NodeJS.ProcessEnv;
const STORE = "/h/st/scen";
const WORK = "/h/work";

/** callTouchesStore with the shared fixture store, cwd and env. */
const hits = (toolName: string, args: Record<string, unknown>, cwd = WORK): boolean =>
	callTouchesStore(STORE, cwd, toolName, args, ENV);

test("GUARDED_ROLES pins implementer, code-reviewer and verifier (spec §3)", () => {
	assert.deepEqual([...GUARDED_ROLES], ["implementer", "code-reviewer", "verifier"]);
});

test("the refusal names the guard and says nothing else", () => {
	assert.match(GUARD_REFUSAL, /role guard/i);
	assert.ok(!/scenario|store|path/i.test(GUARD_REFUSAL), "no hint about WHY in the refusal");
	assert.ok(GUARD_REFUSAL.length <= 60, "short");
});

// --- callTouchesStore: refused ---------------------------------------------

test("refuses an absolute in-store path (read)", () => {
	assert.equal(hits("read", { path: `${STORE}/a.md` }), true);
	assert.equal(hits("read", { path: `${STORE}/sub/deep.md` }), true);
});

test("refuses the store root itself (ls)", () => {
	assert.equal(hits("ls", { path: STORE }), true);
});

test("allows a path that shares the store's prefix but is a different directory", () => {
	// /h/st/scen-back is a different directory; string-prefix matching would false-refuse it.
	assert.equal(hits("read", { path: "/h/st/scen-back/x.md" }), false);
});

test("refuses ~-prefixed paths into the store", () => {
	assert.equal(hits("read", { path: "~/st/scen/a.md" }), true);
});

test("refuses $HOME-prefixed paths into the store", () => {
	assert.equal(hits("read", { path: "$HOME/st/scen/a.md" }), true);
	assert.equal(hits("grep", { path: "$HOME/st/scen", pattern: "x" }), true);
});

test("refuses cwd-relative paths into the store", () => {
	assert.equal(hits("read", { path: "scen/a.md" }, "/h/st"), true);
	assert.equal(hits("read", { path: "a.md" }, STORE), true);
	assert.equal(hits("read", { path: "../scen/a.md" }, "/h/st/other"), true);
});

test("refuses a bash command that cd's into the store", () => {
	assert.equal(hits("bash", { command: `cd ${STORE} && cat a.md` }), true);
	assert.equal(hits("bash", { command: `cd /h/st && ls scen/a.md` }), true, "relative path after cd into a sibling is resolved against the new cwd");
});

test("refuses a cd whose -X-style flags precede the in-store target", () => {
	// `cd -P scen` must move the base dir exactly like `cd scen`: the flags are options, not the target.
	assert.equal(hits("bash", { command: "cd -P scen && cat a.md" }, "/h/st"), true, "flag before a relative target is ignored");
	assert.equal(hits("bash", { command: `cd -P ${STORE}/sub && cat a.md` }), true);
	assert.equal(hits("bash", { command: "cd -- scen && cat a.md" }, "/h/st"), true, "`--` is a flag, not the target");
	// `cd -` (previous directory) has no resolvable target and stays out of scope.
	assert.equal(hits("bash", { command: "cd - && cat a.md" }, "/h/st"), false);
});

test("refuses a subshell cd whose relative target lands inside the store", () => {
	// `(cd /h/st && ...)` is the same cd for the reader of the command line: a subshell paren
	// does not hide the directory change from the rest of the command.
	assert.equal(hits("bash", { command: "(cd /h/st && ls scen/a.md)" }), true);
	assert.equal(hits("bash", { command: `(cd /h/st && cat scen/b.md)` }), true, "attached paren form is stripped too");
	// A subshell cd OUTSIDE the store stays allowed.
	assert.equal(hits("bash", { command: "(cd /h/else && cat x.md)" }), false);
});

test("refuses a nested-subshell cd (ALL leading parens stripped)", () => {
	// `((cd scen && cat a.md))`: stripping exactly one paren leaves `(cd`, which is not a
	// recognizable cd — the RELATIVE target then evaded the tracker entirely (reproduced
	// false in review round 1). Nested subshells repeat the paren: strip them ALL.
	assert.equal(hits("bash", { command: "((cd scen && cat a.md))" }, "/h/st"), true, "double parens, relative target");
	assert.equal(hits("bash", { command: "((cd /h/st && ls scen/a.md))" }), true, "double parens, attached form");
	assert.equal(hits("bash", { command: `(((cd ${STORE} && cat a.md)))` }), true, "triple parens, absolute target");
	// Nested subshells that never enter the store stay allowed.
	assert.equal(hits("bash", { command: "((cd /h/else && cat x.md))" }), false);
});

test("refuses a bash command naming an absolute in-store path", () => {
	assert.equal(hits("bash", { command: `cat ${STORE}/a.md` }), true);
	assert.equal(hits("bash", { command: `ls ${STORE}` }), true);
	assert.equal(hits("bash", { command: `cat '${STORE}/a.md'` }), true, "quoted paths count");
	assert.equal(hits("bash", { command: `cat ~/st/scen/a.md` }), true);
});

test("refuses a symlink that resolves into the store", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "multipi-guard-link-"));
	try {
		mkdirSync(path.join(dir, "scen"), { recursive: true });
		writeFileSync(path.join(dir, "scen", "a.md"), "x\n");
		symlinkSync(path.join(dir, "scen", "a.md"), path.join(dir, "link.md"));
		const store = path.join(dir, "scen");
		assert.equal(callTouchesStore(store, dir, "read", { path: path.join(dir, "link.md") }, ENV), true);
		assert.equal(callTouchesStore(store, dir, "bash", { command: `cat ${dir}/link.md` }, ENV), true);
		// A symlink OUT of the store is allowed.
		symlinkSync(path.join(dir, "elsewhere.md"), path.join(dir, "safe-link.md"));
		writeFileSync(path.join(dir, "elsewhere.md"), "x\n");
		assert.equal(callTouchesStore(store, dir, "read", { path: path.join(dir, "safe-link.md") }, ENV), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("refuses a shell glob whose expansion intersects the store", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "multipi-guard-glob-"));
	try {
		mkdirSync(path.join(dir, "scen", "s"), { recursive: true });
		writeFileSync(path.join(dir, "scen", "s", "one.md"), "x\n");
		const store = path.join(dir, "scen");
		assert.equal(callTouchesStore(store, dir, "bash", { command: `cat ${store}/s/*.md` }, ENV), true);
		assert.equal(callTouchesStore(store, dir, "bash", { command: `ls ${dir}/scen*` }, ENV), true, "glob naming the store dir itself intersects it");
		// A glob confined to a sibling never intersects.
		mkdirSync(path.join(dir, "notes"), { recursive: true });
		writeFileSync(path.join(dir, "notes", "one.md"), "x\n");
		assert.equal(callTouchesStore(store, dir, "bash", { command: `cat ${dir}/notes/*.md` }, ENV), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("refuses an in-store path even when the file does not exist yet", () => {
	assert.equal(hits("read", { path: `${STORE}/ghost.md` }), true);
	assert.equal(hits("write", { path: `${STORE}/new.md`, content: "x" }), true);
	assert.equal(hits("edit", { path: `${STORE}/a.md`, oldText: "a", newText: "b" }), true);
	assert.equal(hits("find", { path: STORE, pattern: "*.md" }), true);
});

// --- callTouchesStore: allowed ---------------------------------------------

test("allows a sibling path and an outside path", () => {
	assert.equal(hits("read", { path: "/h/st/notes/x.md" }), false);
	assert.equal(hits("read", { path: "/etc/hosts" }), false);
	assert.equal(hits("read", { path: "/h/elsewhere" }), false);
});

test("allows benign bash that never names the store", () => {
	assert.equal(hits("bash", { command: "git status && npm test" }), false);
	assert.equal(hits("bash", { command: "cd /h/work/src && grep -rn todo . | head" }), false);
});

test("ignores tools outside the guarded set even when they name the store", () => {
	assert.equal(hits("web_search", { query: `${STORE}/a.md` }), false);
	assert.equal(hits("devloop.dispatch", { ticket: `${STORE}/9` }), false);
	assert.equal(hits("bash", { command: "" }), false);
});

// --- initGuard: activation + fail-closed ------------------------------------

const GENV = (stateHome: string) => ({ HOME: "/h", MULTIPI_HOME: stateHome } as NodeJS.ProcessEnv);

test("initGuard: scenarios block present turns the guard on with the resolved store dir", () => {
	const store = mkdtempSync(path.join(tmpdir(), "multipi-guard-store-"));
	const fx = makeFixture(JSON.stringify({ factory: "collaborative", scenarios: { dir: store } }));
	try {
		const g = initGuard(fx.repo, GENV(`${fx.dir}/state`));
		assert.equal(g.enabled, true);
		assert.equal(g.storeDir, store);
	} finally { fx.cleanup(); }
});

test("initGuard: dark preset without scenarios block turns the guard on at the default dir", () => {
	const fx = makeFixture(JSON.stringify({ factory: "dark" }));
	try {
		const g = initGuard(fx.repo, GENV(`${fx.dir}/state`));
		assert.equal(g.enabled, true);
		assert.equal(g.storeDir, path.join(fx.dir, "state", "proj", "scenarios"));
	} finally { fx.cleanup(); }
});

test("initGuard: store off (collaborative, no block) registers nothing, ever", () => {
	const fx = makeFixture(JSON.stringify({}));
	try {
		assert.deepEqual(initGuard(fx.repo, GENV(`${fx.dir}/state`)), { enabled: false, storeDir: null });
	} finally { fx.cleanup(); }
});

test("initGuard: explicit scenarios:false wins over the dark preset", () => {
	const fx = makeFixture(JSON.stringify({ factory: "dark", scenarios: false }));
	try {
		assert.deepEqual(initGuard(fx.repo, GENV(`${fx.dir}/state`)), { enabled: false, storeDir: null });
	} finally { fx.cleanup(); }
});

test("initGuard: UNPARSEABLE .devloop.json fails closed (guard on, no known store dir)", () => {
	const fx = makeFixture(JSON.stringify({ factory: "dark" }));
	try {
		writeFileSync(fx.config, "{ this is not json");
		const g = initGuard(fx.repo, GENV(`${fx.dir}/state`));
		assert.equal(g.enabled, true, "the hook must still be present");
		assert.equal(g.storeDir, null, "fail closed: every guarded call is refused");
	} finally { fx.cleanup(); }
});

test("initGuard: missing .devloop.json fails closed like an unparseable one", () => {
	const fx = makeFixture(JSON.stringify({ factory: "dark" }));
	try {
		rmSync(fx.config);
		assert.deepEqual(initGuard(fx.repo, GENV(`${fx.dir}/state`)), { enabled: true, storeDir: null });
	} finally { fx.cleanup(); }
});

test("initGuard: not in a git repo at all fails closed", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "multipi-guard-no-repo-"));
	try {
		assert.deepEqual(initGuard(dir, GENV(`${dir}/state`)), { enabled: true, storeDir: null });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
