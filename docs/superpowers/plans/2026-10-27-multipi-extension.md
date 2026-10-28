# multipi Part 2 — the pi extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pi extension: five namespaced tools (`devloop.dispatch`, `devloop.cancel`, `devloop.gate`, `devloop.merge`, `devloop.status`) and two hooks (three-way stop-gate on `agent_before_settle`, format-on-edit on `tool_result`), with every decision-bearing function unit-tested offline.

**Architecture:** The extension is a thin registration layer (`extension/index.ts`) over pure, injectable domain modules in `extension/src/`. Nothing that decides anything (brief assembly, state file, stop-gate decision, exit-code parsing, port/branch/slug computation) lives inside event handlers; handlers gather inputs and call the pure functions. Children are spawned as `pi -p --no-session --mode json` subprocesses (the mechanism validated by pi's own subagent example), with a documented test seam `MULTIPI_PI_BIN` (matching the `MULTIPI_*` override convention of Part 1). Node 24 runs erasable-only TypeScript natively: `tsc --noEmit` for types, `node --test` for tests, jiti (pi) for runtime loading — **no build step**.

**Tech Stack:** TypeScript (erasable syntax only: no enums/namespaces/parameter properties; imports use explicit `.ts` extensions), `typebox` v1 (pi's own version 1.3.27), `@earendil-works/pi-coding-agent` (dev dep for types + `parseFrontmatter`), node:test, bash fakes.

**Spec:** `docs/superpowers/specs/2026-10-27-devloop-pi-design.md` §2.2, §6, §7. Part 1's scripts and their pinned exit codes are the integration surface.

## Locked contracts (from reading pi 1.4.0 type declarations)

- `pi.registerTool(def)` with `namespace: { name: "devloop", aliases: ["dl"], description, instructions }`.
- Tool execute signature: `execute(toolCallId, params, signal, onUpdate, ctx)`, `ctx` is `ExtensionToolContext` (has `cwd`, `model?: {provider,id}`, `thinkingLevel?`, `signal`, `hasUI`, `ui`, `isProjectTrusted()`).
- `pi.on("agent_before_settle", h)`: result is `BoundaryResult = { entries?: SessionBoundaryDraft[]; continue?: boolean }`. To speak to the model: append `{ type: "custom_message", customType: "devloop-stop-gate", content: string, display: true }` and return `{ entries: [...], continue: true }`.
- `pi.on("tool_result", h)`: notification with `event.toolName`, `event.input`, `event.isError`; write/edit inputs carry the path as `path` (accept `file_path` defensively, as pi's own examples do).
- Child JSON mode: NDJSON lines `{type:"message_end", message}` / `{type:"tool_result_end", message}`; assistant messages carry `content[]` (`text` | `toolCall`), `usage {input,output,cacheRead,cacheWrite,cost:{total},totalTokens}`, `stopReason`, `model`, `errorMessage`.
- `parseFrontmatter` is exported by `@earendil-works/pi-coding-agent` — use it for role files.

## File structure (locked in)

```
package.json                      # type: module; devDeps: pi-coding-agent, typebox, typescript, @types/node; scripts.check
tsconfig.json                     # strict, noEmit, allowImportingTsExtensions, module nodenext
extension/index.ts                # factory: registers tools (namespace devloop) + 2 hooks; nothing else
extension/src/config.ts           # loadConfig(cwd), DevloopConfig, path resolution (TS mirror of common.sh)
extension/src/state.ts            # dispatch state file: read/write/pruneDead/runningCount
extension/src/brief.ts            # branchSlug, worktreePath, portRange, assembleImplementer/Reviewer/VerifierBrief
extension/src/roles.ts            # role discovery: bundled agents/ + .pi/agents override, frontmatter parse
extension/src/child.ts            # resolvePiBin, spawnPi (NDJSON stream, kill on abort), ChildResult
extension/src/issues.ts           # gh wrappers: listOpenIssues, listClosedNumbers, issueTitle, issueBody
extension/src/gate.ts             # runGateTrain → parsed {status, branch?, tail}
extension/src/merge.ts            # runMergeTrain → parsed {status, lines, tail}
extension/src/stopgate.ts         # evaluateStopGate(pure decision) + gatherStopGateInputs(io)
extension/src/formatter.ts        # formatTarget(pure) + applyFormat(io)
extension/src/tools.ts            # createTools(deps) → the 5 ToolDefinitions
agents/implementer.md             # (Part 3 content; Part 2 tests use fixture agents)
agents/code-reviewer.md
agents/verifier.md
tests/fake-pi                     # NDJSON-emitting stand-in for `pi -p --no-session --mode json`
tests/fixtures.ts                 # shared fixture builders (temp repo + bare origin + config)
tests/unit/config.test.ts
tests/unit/state.test.ts
tests/unit/brief.test.ts
tests/unit/child.test.ts
tests/unit/gate-merge.test.ts     # runs Part 1 scripts for real, asserts parsing
tests/unit/stopgate.test.ts
tests/unit/formatter.test.ts
tests/unit/tools.test.ts          # dispatch/cancel/status through createTools with fake-pi + stub ctx
```

Dependency rule: `index.ts` → `tools.ts` → domain modules; domain modules never import `index.ts` or pi UI types; `config.ts`/`state.ts`/`brief.ts` have **zero** pi imports (pure node) so they test in isolation.

Dev-dependency versions: match pi 1.4.0's own (`"typebox": "1.3.27"`, `"@earendil-works/pi-coding-agent": "1.4.0"`, `typescript ^5.9`, `@types/node ^24`).

---

### Task 1: Package skeleton

**Files:** Create `package.json`, `tsconfig.json`; Modify `Makefile` (add `ts` target), `README.md` (layout line is already accurate).

- [ ] **Step 1: Write the files**

`package.json`:

```json
{
  "name": "multipi",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "check": "tsc --noEmit && node --test tests/unit/"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "1.4.0",
    "@types/node": "^24.0.0",
    "typebox": "1.3.27",
    "typescript": "^5.9.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "types": ["node"]
  },
  "include": ["extension/**/*.ts", "tests/**/*.ts"]
}
```

Replace the `Makefile` `check` target's dependency list so it runs both legs:

```make
check: ts shellcheck smoke

ts:
	npm run check
```

- [ ] **Step 2: Install dev dependencies**

Run: `npm install --no-audit --no-fund`
Expected: `node_modules` populated, `package-lock.json` written, exit 0.

- [ ] **Step 3: Verify the toolchain before any code exists**

Run: `npx tsc --noEmit && echo OK`
Expected: `OK` (no inputs yet — this proves config + deps resolve).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json Makefile
git commit -m "chore: TS package skeleton (node 24 type stripping, no build step)"
```

---

### Task 2: `config.ts` (pure)

**Files:** Create `extension/src/config.ts`, `tests/unit/config.test.ts`, `tests/fixtures.ts`

- [ ] **Step 1: Write the failing tests**

`tests/fixtures.ts` (shared builder used by every later unit test):

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Fixture {
	dir: string;       // scratch root
	repo: string;      // main worktree
	origin: string;    // bare origin
	config: string;    // path of .devloop.json
	cleanup: () => void;
}

const sh = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

export function makeFixture(configJson: string): Fixture {
	const dir = mkdtempSync(path.join(tmpdir(), "multipi-unit-"));
	const origin = path.join(dir, "origin.git");
	const repo = path.join(dir, "proj");
	execFileSync("git", ["init", "-q", "--bare", origin]);
	execFileSync("git", ["clone", "-q", origin, repo], { stdio: "pipe" });
	sh(repo, "config", "user.email", "t@example.com");
	sh(repo, "config", "user.name", "Test");
	sh(repo, "config", "commit.gpgsign", "false");
	writeFileSync(path.join(repo, "README.md"), "x\n");
	sh(repo, "add", "-A");
	sh(repo, "commit", "-qm", "init");
	sh(repo, "push", "-q", "-u", "origin", "HEAD:main");
	const cfgPath = path.join(repo, ".devloop.json");
	writeFileSync(cfgPath, configJson);
	return {
		dir,
		repo,
		origin,
		config: cfgPath,
		cleanup: () => { try { execFileSync("rm", ["-rf", dir], { stdio: "ignore" }); } catch { /* */ } },
	};
}

export const BASE_CONFIG = JSON.stringify({
	base_branch: "main",
	remote: "origin",
	fast_check: "test -f README.md",
	format: "echo formatted {file} >> fmt.log",
	format_extensions: [".txt"],
	checks: [{ name: "unit", command: "true", heavy: false }],
	heavy: { slots: 2, poll_seconds: 1, port_env: "E2E_PORT", port_base: 9100, port_step: 10 },
	stop_gate: { require_clean_tree: true, max_blocks: 5 },
	merge: { method: "squash", delete_branch: true },
});
```

`tests/unit/config.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { loadConfig, resolveState } from "../../extension/src/config.ts";
import { makeFixture, BASE_CONFIG } from "../fixtures.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

test("loadConfig reads the repo config with defaults filled", () => {
	const fx = makeFixture(BASE_CONFIG);
	try {
		const cfg = loadConfig(fx.repo);
		assert.ok(cfg);
		assert.equal(cfg.baseBranch, "main");
		assert.equal(cfg.remote, "origin");
		assert.equal(cfg.fastCheck, "test -f README.md");
		assert.equal(cfg.checks.length, 1);
		assert.equal(cfg.heavy.slots, 2);
		assert.equal(cfg.stopGate.maxBlocks, 5);
		assert.equal(cfg.merge.method, "squash");
	} finally { fx.cleanup(); }
});

test("loadConfig returns null outside a git repo", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "np-"));
	assert.equal(loadConfig(dir), null);
});

test("loadConfig applies defaults for an empty config", () => {
	const fx = makeFixture("{}");
	try {
		const cfg = loadConfig(fx.repo);
		assert.ok(cfg);
		assert.equal(cfg.baseBranch, "main");
		assert.equal(cfg.remote, "origin");
		assert.equal(cfg.heavy.slots, 2);
		assert.equal(cfg.heavy.portBase, 8600);
		assert.equal(cfg.stopGate.maxBlocks, 5);
		assert.equal(cfg.checks.length, 0);
	} finally { fx.cleanup(); }
});

test("resolveState is ~/.multipi/<repo> (env-overridable)", () => {
	const fx = makeFixture(BASE_CONFIG);
	try {
		const home = path.join(fx.dir, "home");
		const st = resolveState(fx.repo, { "MULTIPI_HOME": home });
		assert.equal(st, path.join(home, "proj"));
	} finally { fx.cleanup(); }
});

test("loadConfig parses object and plain-string checks uniformly", () => {
	const fx = makeFixture(JSON.stringify({ checks: ["false", { name: "e", command: "true", heavy: false }] }));
	try {
		const cfg = loadConfig(fx.repo);
		assert.ok(cfg);
		assert.deepEqual(cfg.checks.map((c) => c.command), ["false", "true"]);
		assert.equal(cfg.checks[0].heavy, true);
		assert.equal(cfg.checks[1].name, "e");
	} finally { fx.cleanup(); }
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/unit/config.test.ts`
Expected: fails — cannot find module `../../extension/src/config.ts`.

- [ ] **Step 3: Implement `extension/src/config.ts`**

```ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface CheckSpec { name: string; command: string; heavy: boolean; summary?: string; }
export interface HeavyConfig {
	slots: number; memoryMax?: string; portEnv?: string; portBase: number; portStep: number;
	cleanTemp: string[]; cleanTempMinutes: number; pollSeconds: number;
}
export interface StopGateConfig { requireCleanTree: boolean; maxBlocks: number; }
export interface MergeConfig { method: string; deleteBranch: boolean; }

export interface DevloopConfig {
	root: string;
	baseBranch: string;
	remote: string;
	fastCheck?: string;
	format?: string;
	formatExtensions?: string[];
	checks: CheckSpec[];
	gateSetup?: string;
	gateWorktree?: string;
	notesDir?: string;
	logsDir?: string;
	heavy: HeavyConfig;
	stopGate: StopGateConfig;
	merge: MergeConfig;
	deploy?: string;
}

export interface Paths {
	stateDir: string;
	notesDir: string;
	logsDir: string;
	gateDir: string;
}

const DEFAULTS = {
	heavy: { slots: 2, memoryMax: "", portEnv: "", portBase: 8600, portStep: 10, cleanTemp: [] as string[], cleanTempMinutes: 120, pollSeconds: 10 },
	stopGate: { requireCleanTree: true, maxBlocks: 5 },
	merge: { method: "squash", deleteBranch: true },
};

function str(v: unknown, d = ""): string { return typeof v === "string" && v.length > 0 ? v : d; }
function num(v: unknown, d: number): number { return typeof v === "number" && Number.isFinite(v) ? v : d; }
function bool(v: unknown, d: boolean): boolean { return typeof v === "boolean" ? v : d; }

function mainRoot(cwd: string): string | null {
	try {
		const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, stdio: "pipe" }).toString().trim();
		return path.basename(out) === ".git" ? path.dirname(out) : execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe" }).toString().trim();
	} catch { return null; }
}

/** Locate and parse .devloop.json for the repo containing cwd. Null when not in a repo or no config. */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): DevloopConfig | null {
	const root = mainRoot(cwd);
	if (!root) return null;
	const cfgPath = env.MULTIPI_CONFIG ?? path.join(root, ".devloop.json");
	if (!existsSync(cfgPath)) return null;
	let raw: Record<string, unknown>;
	try { raw = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { return null; }
	const h = (raw.heavy ?? {}) as Record<string, unknown>;
	const sg = (raw.stop_gate ?? {}) as Record<string, unknown>;
	const mg = (raw.merge ?? {}) as Record<string, unknown>;
	const checksRaw = Array.isArray(raw.checks) ? raw.checks : [];
	const checks: CheckSpec[] = checksRaw.map((c, i) =>
		typeof c === "string"
			? { name: `check-${i + 1}`, command: c, heavy: true }
			: { name: str((c as Record<string, unknown>).name, `check-${i + 1}`), command: str((c as Record<string, unknown>).command), heavy: bool((c as Record<string, unknown>).heavy, true), summary: str((c as Record<string, unknown>).summary) || undefined });
	return {
		root,
		baseBranch: str(raw.base_branch, "main"),
		remote: str(raw.remote, "origin"),
		fastCheck: str(raw.fast_check) || undefined,
		format: str(raw.format) || undefined,
		formatExtensions: Array.isArray(raw.format_extensions) ? (raw.format_extensions as string[]) : undefined,
		checks,
		gateSetup: str(raw.gate_setup) || undefined,
		gateWorktree: str(raw.gate_worktree) || undefined,
		notesDir: str(raw.notes_dir) || undefined,
		logsDir: str(raw.logs_dir) || undefined,
		heavy: {
			slots: num(h.slots, DEFAULTS.heavy.slots), memoryMax: str(h.memory_max) || undefined,
			portEnv: str(h.port_env) || undefined, portBase: num(h.port_base, 8600), portStep: num(h.port_step, 10),
			cleanTemp: Array.isArray(h.clean_temp) ? (h.clean_temp as string[]) : [],
			cleanTempMinutes: num(h.clean_temp_minutes, 120), pollSeconds: num(h.poll_seconds, 10),
		},
		stopGate: { requireCleanTree: bool(sg.require_clean_tree, true), maxBlocks: num(sg.max_blocks, 5) },
		merge: { method: str(mg.method, "squash"), deleteBranch: bool(mg.delete_branch, true) },
		deploy: str(raw.deploy) || undefined,
	};
}

/** State dirs, mirroring scripts/lib/common.sh (MULTIPI_HOME override, <repo> scoping). */
export function resolveState(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const root = mainRoot(cwd) ?? cwd;
	const home = env.MULTIPI_HOME ?? path.join(os.homedir(), ".multipi");
	return path.join(home, path.basename(root));
}

export function resolvePaths(cfg: DevloopConfig, env: NodeJS.ProcessEnv = process.env): Paths {
	const state = resolveState(cfg.root, env);
	const rel = (p?: string) => (p ? (p.startsWith("/") || p.startsWith("~") ? p : path.join(cfg.root, p)) : "");
	return {
		stateDir: state,
		notesDir: path.resolve(rel(cfg.notesDir) || path.join(state, "notes")),
		logsDir: path.resolve(rel(cfg.logsDir) || path.join(state, "logs")),
		gateDir: path.resolve(rel(cfg.gateWorktree) || path.join(path.dirname(cfg.root), `${path.basename(cfg.root)}-gate`)),
	};
}
```

- [ ] **Step 4: Run, verify pass; run `npx tsc --noEmit`**

Run: `node --test tests/unit/config.test.ts && npx tsc --noEmit`
Expected: 5 pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json extension/src/config.ts tests/fixtures.ts tests/unit/config.test.ts
git commit -m "feat(ext): config layer with defaults (pure, env-overridable)"
```

---

### Task 3: `state.ts` (dispatch state file)

**Files:** Create `extension/src/state.ts`, `tests/unit/state.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { readState, writeState, pruneDead, runningCount, type DispatchState } from "../../extension/src/state.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

test("write then read round-trips", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "st-"));
	const me = process.pid;
	const st: DispatchState = { "7": { pid: me, role: "implementer", branch: "feat/7-x", worktree: "/wt", startedAt: 1 } };
	writeState(dir, st);
	assert.deepEqual(readState(dir), st);
});

test("runningCount counts live running entries only", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "st-"));
	const alive = spawn("sleep", ["30"]);
	const dead = spawn("sleep", ["0.2"]); await new Promise((r) => dead.on("close", r));
	const st: DispatchState = {
		"a": { pid: alive.pid, role: "implementer", branch: "b", worktree: "/w", startedAt: 1 },
		"b": { pid: dead.pid, role: "implementer", branch: "b", worktree: "/w", startedAt: 1, status: "interrupted" },
	};
	st["a"]!.status = "running";
	assert.equal(runningCount(pruneDead(st)), 1);
	alive.kill("SIGKILL");
});

test("pruneDead flips dead running entries to crashed without deleting them", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "st-"));
	const dead = spawn("sleep", ["0.2"]); await new Promise((r) => dead.on("close", r));
	const st: DispatchState = { "x": { pid: dead.pid, role: "implementer", branch: "b", worktree: "/w", startedAt: 1, status: "running" } };
	const pruned = pruneDead(st);
	assert.equal(pruned["x"]!.status, "crashed");
});

test("missing or corrupt state file reads as empty", () => {
	const fs = await import("node:fs");
	const dir = fs.default.mkdtempSync(path.join(tmpdir(), "st-"));
	assert.deepEqual(readState(dir), {});
	fs.writeFileSync(path.join(dir, "dispatch.json"), "{not json");
	assert.deepEqual(readState(dir), {});
});
```

- [ ] **Step 2: Run, verify failure**, then **Step 3: implement**

```ts
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

export interface DispatchEntry {
	pid: number;
	role: string;
	branch?: string;
	worktree: string;
	startedAt: number;
	status: "running" | "interrupted" | "crashed" | "done" | "blocked";
	report?: string;
}
export type DispatchState = Record<string, DispatchEntry>;

const FILE = "dispatch.json";

function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export function readState(stateDir: string): DispatchState {
	try { return JSON.parse(readFileSync(path.join(stateDir, FILE), "utf8")) as DispatchState; }
	catch { return {}; }
}

export function writeState(stateDir: string, state: DispatchState): void {
	mkdirSync(stateDir, { recursive: true });
	const tmp = path.join(stateDir, `${FILE}.tmp`);
	writeFileSync(tmp, JSON.stringify(state, null, 2));
	renameSync(tmp, path.join(stateDir, FILE));
}

/** Flip dead running entries to crashed; keep history (status tool shows it). */
export function pruneDead(state: DispatchState): DispatchState {
	for (const e of Object.values(state)) {
		if (e.status === "running" && !isAlive(e.pid)) e.status = "crashed";
	}
	return state;
}

export function runningCount(state: DispatchState): number {
	return Object.values(pruneDead(state)).filter((e) => e.status === "running").length;
}
```

- [ ] **Step 4: Run, verify pass** — `node --test tests/unit/state.test.ts`
- [ ] **Step 5: Commit** — `git add -A extension/src/state.ts tests/unit/state.test.ts && git commit -m "feat(ext): dispatch state file (atomic, prune dead pids)"`

---

### Task 4: `brief.ts` (deterministic brief assembly)

**Files:** Create `extension/src/brief.ts`, `tests/unit/brief.test.ts`

Contract (assertions lock these down): `branchSlug` lowercases, keeps `[a-z0-9]` runs, joins up to 3 with `-`, caps 24 chars; `worktreePath` is the sibling `<parent>/<basename>-<n>`; `portRange` sits above the gate's (`portBase + slots*portStep + 1 + idx*portStep .. +portStep-1`); implementer brief contains the worktree path, branch, notes path, fast check command, heavy.sh absolute path, port range, `Refs #<n>` rule, and ends with the `STATUS:` line contract; reviewer brief contains branch, base ref, worktree, VERDICT contract; verifier brief embeds the task verbatim.

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
	branchSlug, worktreePath, portRange,
	assembleImplementerBrief, assembleReviewerBrief, assembleVerifierBrief,
} from "../../extension/src/brief.ts";

const REPO = "/home/u/src/proj";
const HEAVY = "/opt/multipi/scripts/heavy.sh";

test("branchSlug is deterministic and bounded", () => {
	assert.equal(branchSlug("Add Redis Caching to the Session Store"), "add-redis-caching");
	assert.equal(branchSlug("!!!  fix:   login   (401s)"), "fix-login");
	assert.ok(branchSlug("a b c d e f g h i j k l m n o p q r s t u v w").length <= 24);
});

test("worktreePath is the sibling of the repo root", () => {
	assert.equal(worktreePath(REPO, 7), "/home/u/src/proj-7");
});

test("portRange sits above the gate range", () => {
	const heavy = { portBase: 9100, portStep: 10, slots: 2 };
	assert.deepEqual(portRange(heavy, 0), [9121, 9130]);
	assert.deepEqual(portRange(heavy, 1), [9131, 9140]);
});

test("implementer brief carries every deterministic fact and the STATUS contract", () => {
	const brief = assembleImplementerBrief({
		ticket: 7, title: "Add thing",
		worktree: "/home/u/src/proj-7", branch: "feat/7-add-thing",
		stackOn: undefined,
		notes: "/state/notes/pr-feat_7-add-thing.md",
		fastCheck: "make fmt-check lint",
		heavy: HEAVY, remote: "origin", baseBranch: "main",
		portRange: [9121, 9130],
	});
	for (const needle of ["/home/u/src/proj-7", "feat/7-add-thing", "origin/main",
		"/state/notes/pr-feat_7-add-thing.md", "make fmt-check lint", HEAVY, "9121", "9130",
		"Refs #7", "Closes #7", "STATUS: DONE", "STATUS: BLOCKED", "docs/DECISIONS.md"]) {
		assert.ok(brief.includes(needle), `brief missing: ${needle}`);
	}
	assert.ok(!brief.includes("origin/feat/6"), "no foreign branch leaks in");
});

test("implementer brief names the stack base when stacking", () => {
	const brief = assembleImplementerBrief({
		ticket: 8, title: "Stack", worktree: "/w/8", branch: "feat/8-stack",
		stackOn: "feat/7-add-thing", notes: "/n.md", fastCheck: "true", heavy: "/h",
		remote: "origin", baseBranch: "main", portRange: [9121, 9130],
	});
	assert.ok(brief.includes("origin/feat/7-add-thing"));
});

test("implementer brief notes an in-progress worktree on resume", () => {
	const brief = assembleImplementerBrief({
		ticket: 7, title: "Resume", worktree: "/w/7", branch: "feat/7-resume",
		stackOn: undefined, notes: "/n.md", fastCheck: "true", heavy: "/h",
		remote: "origin", baseBranch: "main", portRange: [9121, 9130], resumed: true,
	});
	assert.ok(/work in progress/i.test(brief));
});

test("reviewer brief carries branch, base, verdict contract, tree-clean rule", () => {
	const brief = assembleReviewerBrief({
		branch: "feat/7-x", baseBranch: "main", remote: "origin", worktree: "/w/7", ticket: 7,
		fastCheck: "make lint", safetyNote: "touches money",
	});
	for (const needle of ["feat/7-x", "origin/main", "/w/7", "VERDICT: APPROVE", "VERDICT: CHANGES REQUIRED", "money", "git status --porcelain"]) {
		assert.ok(brief.includes(needle), `reviewer brief missing: ${needle}`);
	}
});

test("verifier brief embeds the task", () => {
	const brief = assembleVerifierBrief({ task: "Audit the backfill of 2026-09 outputs", worktree: "/repo" });
	assert.ok(brief.includes("Audit the backfill of 2026-09 outputs"));
	assert.ok(brief.includes("/repo"));
});
```

- [ ] **Step 2: Run, verify failure**, then **Step 3: implement** — `branchSlug`, `worktreePath`, `portRange` per the contract; `assembleImplementerBrief` emits the ground rules (work only in worktree; no base-branch pushes / force-push / PRs; no secrets or personal identifiers; fakes only), the test-first steps (criteria → named tests, confirm failing, smallest implementation, Conventional Commits `Refs #<n>`, targeted tests + fast check only, heavy only via `<heavy>` path, ports only in range), the notes-file contract (title line / `## Summary` / `Closes #<n>` / `## Test evidence`), decisions-log rule, resume paragraph when `resumed` is true (re-read ticket first; `git status && git log` before anything), and the final report contract ending with `STATUS: DONE` / `STATUS: BLOCKED — reason` plus optional `## Questions`. Reviewer/verifier briefs per the test needles. (Full text goes in the file — these are prompt content, write them in full, no placeholders.)
- [ ] **Step 4: Run, verify pass** — `node --test tests/unit/brief.test.ts`
- [ ] **Step 5: Commit** — `git add -A extension/src/brief.ts tests/unit/brief.test.ts && git commit -m "feat(ext): deterministic brief assembly (branch/worktree/ports + role briefs)"`

---

### Task 5: `roles.ts` + `child.ts` (spawn protocol) + `tests/fake-pi`

**Files:** Create `extension/src/roles.ts`, `extension/src/child.ts`, `tests/fake-pi`, `tests/unit/child.test.ts`

- [ ] **Step 1: Write `tests/fake-pi`** (chmod +x; committed 755)

```bash
#!/usr/bin/env bash
# Stand-in for: pi -p --no-session --mode json [--append-system-prompt F] [--tools ...] [--model M] TASK...
# FAKE_PI_MODE: ok (default) | fail | slow. Streams NDJSON events the real pi emits.
set -u
mode=${FAKE_PI_MODE:-ok}
sleep_s=${FAKE_PI_SLEEP:-0.1}
task=""
for a in "$@"; do task="$task $a"; done
emit() { printf '%s\n' "$1"; }
if [ "$mode" = slow ]; then
  trap 'exit 143' TERM
  sleep "$sleep_s" &
  wait $! || exit 143
fi
if [ "$mode" = fail ]; then
  echo "fake-pi: model blew up" >&2
  exit 3
fi
emit "{\"type\":\"tool_result_end\",\"message\":{\"role\":\"toolResult\",\"toolName\":\"bash\",\"content\":[{\"type\":\"text\",\"text\":\"ls\"}],\"details\":null}}"
emit "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Ran the task. Tests pass.\\n\\nSTATUS: DONE\"}],\"model\":\"fake/model\",\"stopReason\":\"end\",\"usage\":{\"input\":10,\"output\":20,\"cacheRead\":0,\"cacheWrite\":0,\"cost\":{\"total\":0.001},\"totalTokens\":30}}}"
[ -n "$FAKE_PI_ECHO_TASK" ] && emit "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"TASK WAS: $task\"}],\"model\":\"fake/model\",\"stopReason\":\"end\",\"usage\":{\"input\":1,\"output\":1,\"cacheRead\":0,\"cacheWrite\":0,\"cost\":{\"total\":0},\"totalTokens\":2}}}"
exit 0
```

- [ ] **Step 2: Write the failing tests** (`tests/unit/child.test.ts`)

```ts
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPi, resolvePiInvocation } from "../../extension/src/child.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_PI = path.join(HERE, "..", "fake-pi");

test("resolvePiInvocation honours MULTIPI_PI_BIN", () => {
	const inv = resolvePiInvocation([], { MULTIPI_PI_BIN: FAKE_PI });
	assert.equal(inv.command, FAKE_PI);
});

test("spawnPi streams updates and captures final output + usage", async () => {
	const updates: string[] = [];
	const res = await spawnPi({
		task: "do the thing",
		appendSystemPrompt: "/tmp/role.md",
		cwd: process.cwd(),
		env: { MULTIPI_PI_BIN: FAKE_PI },
		onUpdate: (u) => updates.push(u),
	});
	assert.equal(res.exitCode, 0);
	assert.equal(res.stopReason, "end");
	assert.match(res.finalText, /STATUS: DONE/);
	assert.equal(res.usage.output, 20);
	assert.ok(res.toolCalls.length >= 1);
	assert.ok(updates.length >= 1, "streamed at least one update");
});

test("spawnPi reports non-zero exits with stderr", async () => {
	const res = await spawnPi({
		task: "x", appendSystemPrompt: undefined, cwd: process.cwd(),
		env: { MULTIPI_PI_BIN: FAKE_PI, FAKE_PI_MODE: "fail" },
	});
	assert.equal(res.exitCode, 3);
	assert.match(res.stderr, /blew up/);
});

test("spawnPi abort kills the child (slow mode)", async () => {
	const ac = new AbortController();
	const p = spawnPi({
		task: "x", appendSystemPrompt: undefined, cwd: process.cwd(),
		env: { MULTIPI_PI_BIN: FAKE_PI, FAKE_PI_MODE: "slow", FAKE_PI_SLEEP: "5" },
		signal: ac.signal,
	});
	setTimeout(() => ac.abort(), 150);
	const res = await p;
	assert.notEqual(res.exitCode, 0);
	assert.ok(res.aborted);
});
```

- [ ] **Step 3: Run, verify failure**, then **Step 4: implement**

`roles.ts`: `interface RoleDef { name, description, tools?: string[], model?: string, systemPrompt: string }`; `discoverRoles(extAgentsDir, projectAgentsDir?)` loads `agents/*.md` from the bundled dir then project `.pi/agents/` (override by name), using `parseFrontmatter` from `@earendil-works/pi-coding-agent`; `findRole(dirs, name)`.

`child.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ChildUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; totalTokens: number; }
export interface ChildResult {
	exitCode: number;
	finalText: string;
	stderr: string;
	usage: ChildUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	aborted: boolean;
	toolCalls: string[];
}
export interface SpawnOpts {
	task: string;
	appendSystemPrompt?: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	onUpdate?: (partial: { finalText: string; toolCalls: string[] }) => void;
}

export function resolvePiInvocation(args: string[], env: NodeJS.ProcessEnv): { command: string; args: string[] } {
	if (env.MULTIPI_PI_BIN) return { command: env.MULTIPI_PI_BIN, args };
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	return { command: "pi", args };
}

export function spawnPi(opts: SpawnOpts): Promise<ChildResult> {
	const args = ["-p", "--no-session", "--mode", "json"];
	let promptFile: string | undefined;
	if (opts.appendSystemPrompt) {
		// The role prompt file path is passed through directly; pi reads it.
		promptFile = opts.appendSystemPrompt;
		args.push("--append-system-prompt", promptFile);
	}
	if (opts.tools?.length) args.push("--tools", opts.tools.join(","));
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinking) args.push("--thinking", opts.thinking);
	args.push(opts.task);
	const { command, args: fullArgs } = resolvePiInvocation(args, opts.env ?? process.env);

	return new Promise((resolve) => {
		const res: ChildResult = { exitCode: 0, finalText: "", stderr: "", aborted: false, toolCalls: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 } };
		let proc: ChildProcess;
		try {
			proc = spawn(command, fullArgs, { cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...opts.env } });
		} catch (e) {
			res.exitCode = 1; res.stderr = String(e); resolve(res); return;
		}
		let buf = "";
		const finishSoon = (code: number) => { setTimeout(() => resolve({ ...res, exitCode: code }), 50); };
		proc.stdout.on("data", (d: Buffer) => {
			buf += d.toString();
			const lines = buf.split("\n"); buf = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let ev: any; try { ev = JSON.parse(line); } catch { continue; }
				if (ev.type === "message_end" && ev.message?.role === "assistant") {
					for (const part of ev.message.content ?? []) {
						if (part.type === "text") res.finalText = part.text;
						if (part.type === "toolCall") res.toolCalls.push(part.name);
					}
					const u = ev.message.usage;
					if (u) { res.usage.input += u.input ?? 0; res.usage.output += u.output ?? 0; res.usage.cacheRead += u.cacheRead ?? 0; res.usage.cacheWrite += u.cacheWrite ?? 0; res.usage.cost += u.cost?.total ?? 0; res.usage.totalTokens = u.totalTokens ?? res.usage.totalTokens; }
					if (ev.message.model) res.model = ev.message.model;
					if (ev.message.stopReason) res.stopReason = ev.message.stopReason;
					if (ev.message.errorMessage) res.errorMessage = ev.message.errorMessage;
					opts.onUpdate?.({ finalText: res.finalText, toolCalls: res.toolCalls });
				}
				if (ev.type === "tool_result_end") opts.onUpdate?.({ finalText: res.finalText, toolCalls: res.toolCalls });
			}
		});
		proc.stderr.on("data", (d: Buffer) => { res.stderr += d.toString(); });
		let killed = false;
		const onAbort = () => { if (killed) return; killed = true; res.aborted = true; proc.kill("SIGTERM"); setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* */ } }, 5000); };
		if (opts.signal) { opts.signal.aborted ? onAbort() : opts.signal.addEventListener("abort", onAbort, { once: true }); }
		proc.on("close", (code) => resolve({ ...res, exitCode: code ?? 0 }));
		proc.on("error", (e) => { res.stderr += String(e); finishSoon(1); });
	});
}
```

(The `promptFile` variable above is vestigial — the implementation must not keep unused locals; tsc strict will reject it. Write the file clean.)

- [ ] **Step 5: Run, verify pass** — `node --test tests/unit/child.test.ts`
- [ ] **Step 6: Commit** — `git add -A extension/src/child.ts extension/src/roles.ts tests/fake-pi tests/unit/child.test.ts && git commit -m "feat(ext): child spawn protocol with streaming, abort, and MULTIPI_PI_BIN test seam"`

---

### Task 6: `gate.ts` + `merge.ts` (parsing Part 1's contract)

**Files:** Create `extension/src/gate.ts`, `extension/src/merge.ts`, `tests/unit/gate-merge.test.ts`

These run the real Part 1 scripts against a fixture repo (like Part 1's smoke fixture) and parse stdout + exit code:

- [ ] **Step 1: Write the failing tests** — build the fixture (config with one `heavy:false` check, two branches pushed, notes files), then:

```ts
// green train → {status:"green"} and tail includes "TRAIN GREEN"
// red check (second fixture, check "false") → {status:"red"}
// conflicting pair → {status:"conflict", branch:"feat/2-x"}
// merge-train on the green train → {status:"merged", merged:[b1,b2]}
// merge-train after base moved (push a commit to main post-gate) → {status:"tree-differs"}
// merge-train with no green record → {status:"refused"}
```

- [ ] **Step 2: Run, verify failure**, then **Step 3: implement** — both modules `execFile("bash", [script, ...branches], {cwd: repoRoot, timeout: heavy? no cap: 0, maxBuffer: 10MB, env})`, capture stdout/stderr/rc, and classify:
  - gate: rc 0 → green; rc 1 → red; rc 3 → conflict with branch parsed from `/TRAIN rebase conflict at (\S+)/`; rc 2 → error(usage). `tail` = last 30 non-empty lines of stdout.
  - merge: rc 0 → merged (branches echoed as `merged <b> ->` lines); rc 3 → replay-conflict; rc 4 → tree-differs; rc 5 → notes-missing; rc 6 → branch-changed; rc 7 → pr-not-merged; rc 8 → refused; other → error.
- [ ] **Step 4: Run, verify pass** (these tests take ~10s — real git + scripts)
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(ext): gate/merge runners parsing the pinned script exit-code contract"`

---

### Task 7: `stopgate.ts` (the three-way decision) + `formatter.ts`

**Files:** Create `extension/src/stopgate.ts`, `extension/src/formatter.ts`, `tests/unit/stopgate.test.ts`, `tests/unit/formatter.test.ts`

- [ ] **Step 1: Write the failing tests**

stopgate — the pure `evaluateStopGate(input)` matrix (all cases):

```ts
interface Inputs {
	fastCheckPassed: boolean;       // true when unconfigured
	dirty: boolean;
	requireCleanTree: boolean;
	maxBlocks: number;
	currentBlocks: number;          // counter file content before this evaluation
	openIssues: { number: number; blocked: boolean; startable: boolean }[];
	running: number;
	cap: number;                    // 3
}
// returns { action: "pass" } | { action: "block", message: string, countAfter: number }
```

Cases: (1) all clean, no open → pass; (2) fastCheckPassed=false → block, countAfter 1; (3) block repeated to maxBlocks (currentBlocks=maxBlocks) → pass with give-up semantics (countAfter 0 — counter reset, message says it gave up and to open an issue); (4) dirty + requireCleanTree → block; dirty + !requireCleanTree → pass; (5) open startable issue + running<cap → block with the loop-drive message, unbounded (currentBlocks irrelevant, countAfter 0, counter NOT incremented); (6) open issues but all blocked → pass; (7) startable but running==cap → pass (children will report); (8) fast-check red beats loop drive (priority ordering asserted via message content).

formatter — pure `formatTarget(cfg, filePath)`: no format configured → null; extension mismatch → null; `{file}` substitution shellsafe (uses `shellQuote`); matching extension → command string. `applyFormat` io part: runs via `bash -c`, 60s timeout, returns {ok, stderr} (tested with a real temp file).

- [ ] **Step 2: Run, verify failure**, then **Step 3: implement**

`stopgate.ts` additionally exports `gatherInputs(cwd, env)` which performs the IO (fast check via `bash -c` 60s timeout; `git status --porcelain --untracked-files=normal` in the main root; open issues via `issues.listOpenIssues` parsing labels for `dl/blocked` and `Depends on #n` bodies against closed numbers; counter file `.git/devloop-stop-count` — resolved via `git rev-parse --git-common-dir`), and `bumpCounter(counterPath, n)` / `resetCounter(counterPath)`. Issue parsing is a separate pure `classifyIssues(open, closed, running)` so the whole decision stays unit-testable.

Priority: fast-check > dirty tree > loop drive. Loop-drive message: `<n> startable ticket(s) open, <free> dispatch slot(s) free — start the next ticket (devloop.dispatch).` Blocking messages quote the failing output tail (last 20 lines).

- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(ext): three-way stop-gate decision + format-on-edit"`

---

### Task 8: `tools.ts` + `index.ts` (registration, dispatch/cancel/status)

**Files:** Create `extension/src/tools.ts`, `extension/src/issues.ts`, `extension/index.ts`, `tests/unit/tools.test.ts`

- [ ] **Step 1: Write the failing tests** — `createTools(deps)` with stub `ctx` (`{cwd: fixture.repo, model: undefined, thinkingLevel: undefined, signal: undefined, hasUI: false, ui: {}, isProjectTrusted: () => true}`) and deps wired to fake-pi/fixture:

```ts
// dispatch implementer: creates worktree proj-7 with branch feat/7-<slug> from origin/main,
//   state entry running→done, result content contains "STATUS: DONE", details.branch set
// dispatch with no config → isError true "no .devloop.json"
// 4th concurrent dispatch (pre-seed 3 live sleep pids in state) → isError "slot cap"
// cancel: dispatch slow fake-pi (FAKE_PI_SLEEP 5 via env in deps), cancel kills pid,
//   state status interrupted, slot freed (next dispatch allowed)
// dispatch of an already-crashed ticket reuses the existing worktree (no branch error)
// status: text contains open issue numbers (seeded via gh stub), worktree name, and "cap 3"
// gate/merge tools: delegate to gate.ts/merge.ts (covered there) — assert they return
//   structured content for the fixture green/red cases
```

gh stub for these tests: extend `tests/fake-gh` with `issue list --state open --json number,title,labels,body` (reads `$FAKE_GH_DIR/issues.json`) and `issue view <n> --json title --jq .title`; put it on PATH in the harness.

- [ ] **Step 2: Run, verify failure**, then **Step 3: implement**

`issues.ts`: `gh(args)` wrapper (throw on rc≠0 with stderr); `listOpenIssues()`, `listClosedNumbers()`, `issueTitle(n)` — all via `gh -q issue ... --json ...` parsed with JSON.

`tools.ts`: `createTools(deps: { env; agentsDirs: string[] })` returns the five `ToolDefinition`s:
- `dispatch` — params `{ role, ticket?, branch?, worktree?, task?, stackOn? }`; for implementer: load config (absent → error result), resolve worktree (existing state entry wins; else `git fetch` + `git worktree add -b <branch> <path> <base>`), allocate port slice by index among running, assemble brief (ticket title via `issues.issueTitle`; `task` override allowed for reviewer/verifier/fix rounds), cap check via `runningCount`, spawn child with role prompt (model/tools from role frontmatter, inheriting `ctx.model`/`ctx.thinkingLevel`), update state, return `{content:[{type:"text",text: report + "\n(branch ..., head ...)" }], details: {...}}`; on child failure return `isError: true` with stderr tail, state → crashed.
- `cancel` — params `{ ticket }`; find entry, SIGTERM, escalate KILL +5s (fire-and-forget), mark interrupted.
- `gate` / `merge` — params `{ branches: string[] }`; call Part-6 modules; `onUpdate` streams the tail; return structured details + human text.
- `status` — no params; composed text (open issues w/ labels, worktrees, dispatch table, last train record, cap).
- All renderers: minimal one-line `renderCall`, plain-text `renderResult` (TUI polish is out of scope; correctness first).

`index.ts`: default export factory — `pi.registerTool(...)` for each (namespace `{name:"devloop", aliases:["dl"], description:"Autonomous dev-loop control plane", instructions:<one paragraph: when to dispatch/gate/merge/status/cancel>}`); `pi.on("agent_before_settle", ...)` wires `gatherInputs` + `evaluateStopGate` (config absent → return undefined; block → append custom_message + continue:true); `pi.on("tool_result", ...)` wires format-on-edit for `write`/`edit` (skip on error; notify via `ctx.ui` when `ctx.hasUI`). Factory body stays allocation-light (no timers, no processes) per pi's lifecycle rules.

- [ ] **Step 4: Run, verify pass** — `node --test tests/unit/tools.test.ts`
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(ext): devloop tools (dispatch/cancel/gate/merge/status) + hooks registration"`

---

### Task 9: Whole-leg `make check` green + load-in-pi smoke

**Files:** Modify `Makefile`, `README.md`

- [ ] **Step 1:** `make check` — all three legs green (ts = tsc + unit tests; shellcheck warning; smoke 56/56).
- [ ] **Step 2: Load the extension inside a real pi process to prove registration works** (offline, no model call): run a headless pi with the extension loaded and a no-op prompt against a dummy endpoint is NOT possible offline — instead use the RPC/JSON probe: `echo '' | timeout 10 pi --extension extension/index.ts --help >/dev/null 2>&1; echo $?` — pi must boot with the extension without a factory error (factory errors surface at load). Assert exit 0 and no "extension" error text on stderr. (If pi requires auth to boot, fall back to: `node -e "import('./extension/index.ts').then(m=>console.log(typeof m.default))"` printing `function` — proves the module loads and exports under type stripping.)
- [ ] **Step 3: Commit** — `git add -A && git commit -m "chore: make check green across all legs; extension boots in pi"`

## Completion criteria

- `make check` fully green (ts leg: tsc + ~40 unit assertions incl. real script runs; smoke 56/56).
- `extension/index.ts` boots inside pi without error (load probe).
- Every refusal/classification path of gate/merge parsing asserted; stop-gate decision matrix fully covered; state file crash-proof (corrupt → empty, dead pids pruned).
- No module outside `tools.ts`/`index.ts` imports pi UI types; `config.ts`/`state.ts`/`brief.ts` are pure node.
- Part 3 (agents content, skills, dogfood) builds against this unchanged.
