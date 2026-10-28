import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type TSchema } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolvePaths, resolveState, type DevloopConfig, type Paths } from "./config.ts";
import { readState, writeState, pruneDead, runningCount, type DispatchEntry, type DispatchState } from "./state.ts";
import {
	branchSlug,
	worktreePath,
	portRange,
	assembleImplementerBrief,
	assembleReviewerBrief,
	assembleVerifierBrief,
} from "./brief.ts";
import { spawnPi, type ChildResult } from "./child.ts";
import { discoverRoles, findRole } from "./roles.ts";
import { listOpenIssues, listClosedIssueNumbers, addLabel } from "./issues.ts";
import {
	evaluateStopGate,
	runFastCheck,
	isDirty,
	counterPath,
	readCounter,
	writeCounter,
	resetCounter,
} from "./stopgate.ts";
import { runGateTrain, type GateOutcome } from "./gate.ts";
import { runMergeTrain, type MergeOutcome } from "./merge.ts";
import { formatTarget, applyFormat } from "./formatter.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This package's own scripts dir (the fallback when the host repo does not vendor the scripts). */
const PACKAGED_SCRIPTS = path.join(HERE, "..", "..", "scripts");
const PACKAGED_AGENTS = path.join(HERE, "..", "..", "agents");

export interface ToolContext {
	cwd: string;
	cfg: DevloopConfig;
	stateDir: string;
	paths: Paths;
	scriptsDir: string;
	bundledAgentsDir: string;
	projectAgentsDir: string;
}

export function buildContext(cwd: string): ToolContext {
	const cfg = loadConfig(cwd);
	if (!cfg) throw new Error(`no .devloop.json found at or above ${cwd}`);
	const p = resolvePaths(cfg);
	const repoScripts = path.join(cfg.root, "scripts");
	const scriptsDir = existsSync(path.join(repoScripts, "gate-train.sh")) ? repoScripts : PACKAGED_SCRIPTS;
	return {
		cwd,
		cfg,
		stateDir: resolveState(cwd),
		paths: p,
		scriptsDir,
		bundledAgentsDir: process.env.MULTIPI_AGENTS_DIR ?? PACKAGED_AGENTS,
		projectAgentsDir: path.join(cfg.root, ".pi", "agents"),
	};
}

/** Per-invocation context resolution: tools act on the repo the agent is standing in. */
async function runGuarded<T>(toolCtx: { cwd: string }, fn: (ctx: ToolContext) => Promise<AgentToolResult<T>>): Promise<AgentToolResult<T>> {
	try {
		return await fn(buildContext(toolCtx.cwd));
	} catch (e) {
		// Confined cast: the error result intentionally carries no details payload.
		return { ...text(`devloop unavailable here: ${(e as Error).message}`), details: undefined, isError: true } as AgentToolResult<T>;
	}
}

export function noteFilePath(ctx: ToolContext, branch: string): string {
	return path.join(ctx.paths.notesDir, `pr-${branch.replaceAll("/", "_")}.md`);
}

/** Abort controllers for children this session spawned (session-lifetime registry). */
const controllers = new Map<string, AbortController>();

export interface DispatchDetails {
	role: string;
	ticket?: number;
	branch?: string;
	worktree: string;
	status: string;
	aborted: boolean;
}

function text(result: string): { content: { type: "text"; text: string }[]; details: undefined } {
	return { content: [{ type: "text", text: result }], details: undefined };
}

function inFlightList(state: DispatchState): string {
	const rows = Object.entries(state)
		.filter(([, e]) => e.status === "running")
		.map(([k, e]) => `#${k} ${e.role} (${e.branch ?? e.worktree})`);
	return rows.length ? rows.join("; ") : "(none)";
}

function git(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

function parseReportStatus(report: string): "done" | "blocked" {
	return /STATUS:\s*BLOCKED/.test(report) ? "blocked" : "done";
}

interface DispatchParams {
	role: string;
	ticket?: number;
	branch?: string;
	worktree?: string;
	task?: string;
}

async function dispatchImpl(ctx: ToolContext, params: DispatchParams, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<unknown> | undefined): Promise<AgentToolResult<DispatchDetails | undefined>> {
	const role = findRole(ctx.bundledAgentsDir, params.role, ctx.projectAgentsDir);
	if (!role) {
		return { ...text(`Unknown role '${params.role}'. Available roles: ${findRoleNames(ctx).join(", ") || "(none)"}`), isError: true };
	}

	// ---- verifier: free-form read-only task ---------------------------------
	if (params.role === "verifier") {
		if (!params.task) return { ...text("verifier requires a `task` description"), isError: true };
		const worktree = params.worktree ?? ctx.cfg.root;
		const key = `verifier-${params.ticket ?? Date.now().toString(36)}`;
		const entry: DispatchEntry = {
			pid: 0,
			role: role.name,
			branch: params.branch,
			worktree,
			startedAt: Date.now(),
			status: "running",
		};
		persistEntry(ctx, key, entry);
		const ac = spawnAndTrack(ctx, key, role, {
			task: assembleVerifierBrief({ task: params.task, worktree }),
			worktree,
			signal,
			onUpdate,
		});
		const res = await ac.promise;
		finishEntry(ctx, key, entry, res, signal);
		return reportResult(role.name, params.ticket, entry, res);
	}

	// ---- code-reviewer: reviews an existing pushed branch -------------------
	if (params.role === "code-reviewer") {
		const state = pruneDead(readState(ctx.stateDir));
		const ticket = params.ticket;
		if (ticket === undefined) return { ...text("code-reviewer requires `ticket` (the branch defaults to the ticket's dispatch branch)"), isError: true };
		const entry = state[String(ticket)];
		const branch = params.branch ?? entry?.branch;
		if (!branch) return { ...text(`no known branch for ticket #${ticket}; pass \`branch\``), isError: true };
		const worktree = entry?.worktree ?? worktreePath(ctx.cfg.root, ticket);
		const key = `review-${ticket}`;
		const reviewEntry: DispatchEntry = {
			pid: 0,
			role: role.name,
			branch,
			worktree,
			startedAt: Date.now(),
			status: "running",
		};
		persistEntry(ctx, key, reviewEntry);
		const ac = spawnAndTrack(ctx, key, role, {
			task: assembleReviewerBrief({
				branch,
				baseBranch: ctx.cfg.baseBranch,
				remote: ctx.cfg.remote,
				worktree,
				ticket,
				fastCheck: ctx.cfg.fastCheck ?? "",
			}),
			worktree,
			signal,
			onUpdate,
		});
		const res = await ac.promise;
		finishEntry(ctx, key, reviewEntry, res, signal);
		return reportResult(role.name, ticket, reviewEntry, res);
	}

	// ---- implementer: the full deterministic pipeline -----------------------
	const ticket = params.ticket;
	if (ticket === undefined) return { ...text("implementer requires `ticket`"), isError: true };

	// Local refusals first (no GitHub dependency): busy ticket, then capacity.
	const state = pruneDead(readState(ctx.stateDir));
	writeState(ctx.stateDir, state); // persist prune (dead pids -> crashed)
	const prev = state[String(ticket)];
	if (prev?.status === "running") {
		return { ...text(`ticket #${ticket} already has an implementer running. In-flight: ${inFlightList(state)}`), isError: true };
	}
	const runningImplementers = Object.entries(state).filter(([, e]) => e.status === "running" && e.role === "implementer");
	const cap = ctx.cfg.heavy.slots;
	if (runningImplementers.length >= cap) {
		return { ...text(`capacity full: ${runningImplementers.length}/${cap} implementers in flight: ${inFlightList(state)}. Wait for a report (or cancel a ticket) and dispatch again.`), isError: true };
	}

	const issues = listOpenIssues();
	let issue = issues.find((i) => i.number === ticket);
	if (!issue) {
		// GitHub's list endpoint briefly lags a just-created issue; one bounded retry, then refuse.
		await new Promise((r) => setTimeout(r, 1500));
		issue = listOpenIssues().find((i) => i.number === ticket);
	}
	if (!issue) return { ...text(`ticket #${ticket} not found among open issues (already merged/closed?)`), isError: true };
	const slug = branchSlug(issue.title);
	const branch = prev?.branch ?? (slug ? `feat/${ticket}-${slug}` : `feat/${ticket}`);
	const worktree = prev?.worktree ?? worktreePath(ctx.cfg.root, ticket);
	ensureWorktree(ctx, branch, worktree, !prev);
	addLabel(ticket, "dl/in-progress");

	const key = String(ticket);
	const entry: DispatchEntry = {
		pid: 0,
		role: role.name,
		branch,
		worktree,
		startedAt: Date.now(),
		status: "running",
	};
	const idx = runningImplementers.length; // this child's port slice position
	const brief = assembleImplementerBrief({
		ticket,
		title: issue.title,
		worktree,
		branch,
		notes: noteFilePath(ctx, branch),
		fastCheck: ctx.cfg.fastCheck ?? "",
		heavy: path.join(ctx.scriptsDir, "heavy.sh"),
		remote: ctx.cfg.remote,
		baseBranch: ctx.cfg.baseBranch,
		portRange: portRange(ctx.cfg.heavy, idx),
		resumed: !!prev,
	});
	persistEntry(ctx, key, entry);
	const ac = spawnAndTrack(ctx, key, role, { task: brief, worktree, signal, onUpdate });
	const res = await ac.promise;
	finishEntry(ctx, key, entry, res, signal);
	git(["fetch", "-q", ctx.cfg.remote], ctx.cfg.root); // child pushed; refresh the main repo's view

	// Outcome-driven side effects: PR + labels (only when the child finished its job).
	let extra = "";
	const verdict = parseReportStatus(res.finalText);
	if (verdict === "done" && res.stopReason === "end") {
		try {
			const out = execFileSync("bash", [path.join(ctx.scriptsDir, "open-pr.sh"), branch], {
				cwd: ctx.cfg.root,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			})
				.toString()
				.trim();
			addLabel(ticket, "dl/in-review");
			extra = `\nPR: ${out}`;
		} catch (e) {
			extra = `\nWARNING: could not open the PR: ${(e as Error).message.split("\n")[0]}`;
		}
	} else if (verdict === "blocked") {
		try {
			addLabel(ticket, "dl/blocked");
		} catch {
			/* labelling is best-effort; the report carries the reason */
		}
	}
	return reportResult(role.name, ticket, entry, res, extra);
}

function findRoleNames(ctx: ToolContext): string[] {
	return discoverRoles(ctx.bundledAgentsDir, ctx.projectAgentsDir).map((r) => r.name);
}

/** Spawn the child under an AbortController; wire the external signal and the cancel registry. */
function spawnAndTrack(
	ctx: ToolContext,
	key: string,
	role: { name: string; filePath: string; tools?: string[]; model?: string },
	opts: { task: string; worktree: string; signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback<unknown> },
): { promise: Promise<ChildResult>; controller: AbortController } {
	const controller = new AbortController();
	if (opts.signal) {
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
	}
	controllers.set(key, controller);
	const promise = spawnPi({
		task: opts.task,
		appendSystemPrompt: role.filePath,
		tools: role.tools,
		model: role.model,
		cwd: opts.worktree,
		signal: controller.signal,
		onSpawn: (pid) => {
			if (pid === undefined) return;
			const st = readState(ctx.stateDir);
			if (st[key]?.status === "running") {
				st[key].pid = pid;
				writeState(ctx.stateDir, st);
			}
		},
		onUpdate: (p) => opts.onUpdate?.({ content: [{ type: "text", text: p.finalText }], details: p }),
	}).then((res) => {
		controllers.delete(key);
		return res;
	});
	return { promise, controller };
}

/** Record a freshly-created dispatch entry as running (idempotent per key). */
function persistEntry(ctx: ToolContext, key: string, entry: DispatchEntry): void {
	const state = readState(ctx.stateDir);
	state[key] = { ...state[key], ...entry };
	writeState(ctx.stateDir, state);
}

/** Record the terminal state of a dispatch entry (state key = ticket or ad-hoc). */
export function finishEntry(ctx: ToolContext, key: string, entry: DispatchEntry, res: { exitCode: number; finalText: string; aborted: boolean; stopReason?: string; errorMessage?: string; stderr: string }, signal?: AbortSignal): void {
	const state = readState(ctx.stateDir);
	entry.report = res.finalText || res.stderr || res.errorMessage || "";
	if (res.aborted || signal?.aborted) entry.status = "interrupted";
	else if (res.stopReason === "end" && /STATUS:\s*BLOCKED/.test(res.finalText)) entry.status = "blocked";
	else if (res.stopReason === "end" && /STATUS:\s*DONE/.test(res.finalText)) entry.status = "done";
	else entry.status = "crashed";
	state[key] = entry;
	writeState(ctx.stateDir, state);
}

function usageLine(res: { usage: { input: number; output: number; cost: number; totalTokens: number } }): string {
	const u = res.usage;
	return `tokens in/out ${u.input}/${u.output} · $${u.cost.toFixed(4)}`;
}

function reportResult(role: string, ticket: number | undefined, entry: DispatchEntry, res: { finalText: string; aborted: boolean; stopReason?: string; errorMessage?: string; stderr: string; usage: { input: number; output: number; cost: number; totalTokens: number } }, extra = ""): AgentToolResult<DispatchDetails | undefined> {
	const head = `${role} #${ticket ?? "?"} (${entry.branch ?? entry.worktree}) -> ${entry.status}`;
	const body = res.aborted
		? "interrupted before completion"
		: res.finalText || res.errorMessage || res.stderr || `(no output; stopReason=${res.stopReason ?? "n/a"})`;
	const isError = res.aborted || (res.stopReason !== "end" && !res.aborted);
	return {
		...text(`${head}\n[${usageLine(res)}]\n\n${body}${extra}`),
		details: { role, ticket, branch: entry.branch, worktree: entry.worktree, status: entry.status, aborted: res.aborted } as DispatchDetails,
		...(isError ? { isError: true } : {}),
	};
}

function ensureWorktree(ctx: ToolContext, branch: string, worktree: string, fresh: boolean): void {
	if (existsSync(worktree)) return; // re-dispatch: reuse
	git(["fetch", "-q", ctx.cfg.remote], ctx.cfg.root);
	if (fresh) {
		try {
			git(["rev-parse", "--verify", "-q", `refs/remotes/${ctx.cfg.remote}/${branch}`], ctx.cfg.root);
			git(["worktree", "add", "-B", branch, worktree, `refs/remotes/${ctx.cfg.remote}/${branch}`], ctx.cfg.root);
		} catch {
			git(["worktree", "add", "-b", branch, worktree, `refs/remotes/${ctx.cfg.remote}/${ctx.cfg.baseBranch}`], ctx.cfg.root);
		}
	} else {
		git(["worktree", "add", worktree, branch], ctx.cfg.root);
	}
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------
export function cancelImpl(ctx: ToolContext, key: string): AgentToolResult<undefined> {
	const state = pruneDead(readState(ctx.stateDir));
	const entry = state[key];
	if (!entry) return { ...text(`no dispatch known for '${key}'`), isError: true };
	if (entry.status !== "running") return { ...text(`dispatch '${key}' is ${entry.status}, not running`), isError: true };
	const controller = controllers.get(key);
	if (controller) controller.abort();
	else {
		try {
			process.kill(entry.pid, "SIGTERM");
		} catch {
			/* process already gone; status below records the intent */
		}
	}
	entry.status = "interrupted";
	writeState(ctx.stateDir, state);
	return { ...text(`cancel sent for '${key}' (pid ${entry.pid || "?"}); the worktree is kept for a re-dispatch`) };
}

// ---------------------------------------------------------------------------
// Stop gate (called from the agent_before_settle hook; also unit/smoke tested)
// ---------------------------------------------------------------------------
export async function evaluateSettle(cwd: string): Promise<{ entries: { type: "custom_message"; customType: string; content: string; display: boolean }[]; continue: boolean } | undefined> {
	try {
		const ctx = buildContext(cwd);
		const cfg = ctx.cfg;
		const [fc, issues, closed] = await Promise.all([runFastCheck(cfg.fastCheck ?? null, ctx.cfg.root), listOpenIssues(), listClosedIssueNumbers()]);
		const state = pruneDead(readState(ctx.stateDir));
		const running = Object.values(state).filter((e) => e.status === "running" && e.role === "implementer").length;
		const decision = evaluateStopGate({
			fastCheckPassed: fc.passed,
			fastCheckTail: fc.tail,
			dirty: isDirty(ctx.cfg.root),
			requireCleanTree: cfg.stopGate.requireCleanTree,
			maxBlocks: cfg.stopGate.maxBlocks,
			currentBlocks: readCounter(counterPath(ctx.cfg.root)),
			issues: issues.map((i) => ({
				number: i.number,
				blocked: i.labels.includes("dl/blocked"),
				deps: [...i.body.matchAll(/Depends on #(\d+)/g)].map((m) => Number(m[1])),
			})),
			closed,
			inFlight: Object.entries(state)
				.filter(([, e]) => e.status === "running" && e.role === "implementer")
				.map(([k]) => Number(k))
				.filter((n) => Number.isFinite(n)),
			running,
			cap: cfg.heavy.slots,
		});
		if (decision.action === "pass") {
			if (decision.gaveUp) resetCounter(counterPath(ctx.cfg.root));
			return undefined; // let the agent settle
		}
		if (decision.bumpCounter) {
			const cp = counterPath(ctx.cfg.root);
			writeCounter(cp, readCounter(cp) + 1);
		}
		return {
			entries: [{ type: "custom_message", customType: "devloop-stop-gate", content: decision.message, display: true }],
			continue: true,
		};
	} catch (e) {
		// A broken gate must never wedge the agent: fail open, report loudly.
		console.error(`devloop stop-gate error (settling anyway): ${(e as Error).message}`);
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Format-on-edit (tool_result hook)
// ---------------------------------------------------------------------------
export async function formatEditedFile(cwd: string, filePath: string): Promise<void> {
	const ctx = buildContext(cwd);
	const target = formatTarget({ format: ctx.cfg.format ?? null, formatExtensions: ctx.cfg.formatExtensions ?? null }, filePath);
	if (!target) return;
	const res = await applyFormat(target, path.dirname(filePath));
	if (!res.ok) console.error(`devloop format failed for ${filePath}: ${res.stderr.trim()}`);
}

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------
const DispatchSchema = Type.Object({
	role: Type.String({ description: "implementer | code-reviewer | verifier" }),
	ticket: Type.Optional(Type.Number({ description: "Issue number (required for implementer and code-reviewer)" })),
	branch: Type.Optional(Type.String({ description: "Branch override (code-reviewer)" })),
	worktree: Type.Optional(Type.String({ description: "Worktree for verifier (defaults to the repo root)" })),
	task: Type.Optional(Type.String({ description: "Free-form assignment (verifier)" })),
});

type Params<S extends TSchema> = import("typebox").Static<S>;

export function makeTools(instructions?: string): Array<ToolDefinition<TSchema, any, any>> {
	const dispatch = defineTool({
		name: "devloop.dispatch",
		label: "Dispatch dev-loop role agent",
		promptGuidelines: instructions ? [instructions] : undefined,
		description:
			"Dispatch one role agent (implementer / code-reviewer / verifier) as an isolated headless child working in its own git worktree. For implementer pass the ticket; everything else (branch, worktree, ports, notes path, brief) is computed deterministically. Blocks until the child reports. At most N implementers run concurrently (N = heavy.slots); a further dispatch is refused with the in-flight list.",
		parameters: DispatchSchema,
		execute: (_id, params: Params<typeof DispatchSchema>, signal, onUpdate, toolCtx) => runGuarded(toolCtx, (c) => dispatchImpl(c, params, signal, onUpdate)),
	});

	const cancelSchema = Type.Object({
		ticket: Type.Number({ description: "Ticket whose child should be cancelled" }),
	});
	const cancel = defineTool({
		name: "devloop.cancel",
		label: "Cancel dev-loop child",
		description: "Kill the child currently working on a ticket (the worktree and branch are kept; re-dispatch resumes).",
		parameters: cancelSchema,
		execute: (_id, params: Params<typeof cancelSchema>, _s, _u, toolCtx) => runGuarded(toolCtx, (c) => Promise.resolve(cancelImpl(c, String(params.ticket)))),
	});

	const branchesSchema = Type.Object({
		branches: Type.Array(Type.String(), { description: "Branch names, in the exact order to gate/merge" }),
	});
	const gate = defineTool({
		name: "devloop.gate",
		label: "Run batch gate",
		description:
			"Run the batch gate: stack the given branches (in order) on the latest base in the gate worktree and run every configured check once. Returns green / red (with failing output tail) / conflict (named branch) / error.",
		parameters: branchesSchema,
		execute: (_id, params: Params<typeof branchesSchema>, _s, _u, toolCtx) =>
			runGuarded(toolCtx, async (ctx) => {
						const out = await runGateTrain({ scriptsDir: ctx.scriptsDir, repoRoot: ctx.cfg.root, branches: params.branches });
			const label =
				out.status === "green"
					? "GATE GREEN — the train is gated. Record the label dl/gated on the covered tickets, then devloop.merge with the same branches, same order."
					: out.status === "red"
					  ? "GATE RED — nothing merges. Read the tail, dispatch the owning implementer to fix, re-push, re-gate."
					  : out.status === "conflict"
						? `GATE CONFLICT at ${out.branch ?? "?"} — drop it from the train (gate the rest, or have the implementer rebase), then re-gate.`
						: "GATE ERROR — inspect the tail; this is usually a usage/config problem.";
			return { ...text(`${label}\n${out.tail}`), details: out, ...(out.status !== "green" ? { isError: true } : {}) };
		}),
	});

	const merge = defineTool({
		name: "devloop.merge",
		label: "Merge gated train",
		description:
			"Merge a previously gated train: replays each branch on the current base, verifies the tree is exactly the gated tree, squashes each PR in order, deletes branches. Refusals: replay-conflict / tree-differs (re-gate) / notes-missing / branch-changed / pr-not-merged / not-gated-green.",
		parameters: branchesSchema,
		execute: (_id, params: Params<typeof branchesSchema>, _s, _u, toolCtx) =>
			runGuarded(toolCtx, async (ctx) => {
						const out = await runMergeTrain({ scriptsDir: ctx.scriptsDir, repoRoot: ctx.cfg.root, branches: params.branches });
			const label =
				out.status === "merged"
					? `MERGED ${out.merged.join(", ")} — mark the tickets dl/merged and close the issues.`
					: `MERGE REFUSED (${out.status}) — nothing was merged. ${out.status === "tree-differs" || out.status === "branch-changed" || out.status === "replay-conflict" ? "Re-gate the train first." : ""}`;
			return { ...text(`${label}\n${out.tail}`), details: out, ...(out.status !== "merged" ? { isError: true } : {}) };
		}),
	});

	const status = defineTool({
		name: "devloop.status",
		label: "Dev-loop status",
		description: "Show the loop's current state: in-flight children, open tickets with dl/ labels, capacity, and the last green gate record.",
		parameters: Type.Object({}),
		execute: (_id: string, _p: unknown, _s: AbortSignal | undefined, _u: unknown, toolCtx: { cwd: string }): Promise<AgentToolResult<undefined>> =>
			runGuarded(toolCtx, async (ctx) => {
			const state = pruneDead(readState(ctx.stateDir));
			const kids = Object.entries(state)
				.map(([k, e]) => `| #${k} | ${e.role} | ${e.branch ?? "-"} | ${e.status} | ${new Date(e.startedAt).toISOString().slice(0, 16).replace("T", " ")} |`)
				.join("\n");
			const issues = listOpenIssues()
				.map((i) => {
					const labels = i.labels.filter((l) => l.startsWith("dl/")).join(", ") || "-";
					const deps = [...i.body.matchAll(/Depends on #(\d+)/g)].map((m) => `#${m[1]}`).join(" ");
					return `| #${i.number} | ${i.title} | ${labels} | ${deps || "-"} |`;
				})
				.join("\n");
			const running = Object.values(state).filter((e) => e.status === "running" && e.role === "implementer").length;
			const trainFile = path.join(ctx.stateDir, "train-green.txt");
			let train = "(no gated train)";
			try {
				train = readFileSync(trainFile, "utf8").trim().replaceAll("\n", " | ");
			} catch {
				/* no record */
			}
			return text(
				[`# devloop status`, "", `Implementers in flight: ${running}/${ctx.cfg.heavy.slots}`, "", "## Children", "| ticket | role | branch | status | since |", "|---|---|---|---|---|", kids || "| - | - | - | (none) | - |", "", "## Open tickets", "| # | title | dl/ labels | depends |", "|---|---|---|---|", issues || "| - | (none) | - | - |", "", `## Last green gate`, train, ""].join("\n"),
			);
		}),
	});

	return [dispatch, cancel, gate, merge, status];
}

// Re-export for index.ts and tests.
export { runningCount };
