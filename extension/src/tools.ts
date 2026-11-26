import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type TSchema } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolvePaths, resolveState, repoSlugFromRemote, scenariosOn, type DevloopConfig, type Paths } from "./config.ts";
import { TOOL_NAMES } from "./toolnames.ts";
import { readState, updateState, pruneDead, reconcileState, runningCount, unseenTerminals, ackTerminals, readSeen, terminalTime, type DispatchEntry, type DispatchState } from "./state.ts";
import {
	branchSlug,
	worktreePath,
	portRange,
	assembleImplementerBrief,
	assembleReviewerBrief,
	assembleVerifierBrief,
	assembleAnalystBrief,
	assembleScenarioWriterBrief,
	parseScenarioLines,
	scenarioLinesForTicket,
	buildScenarioComment,
} from "./brief.ts";
import * as childreg from "./childreg.ts";
import { spawnPi, parentModelArg, type ChildResult } from "./child.ts";
import { discoverRoles, findRole } from "./roles.ts";
import { listOpenIssues, listClosedIssueNumbers, addLabel, latestComment, issueComments, addComment, type Issue } from "./issues.ts";
import { countShouldFixRounds, acceptTailDue } from "./polish.ts";
import { scanStore, coveredTicketsFromScan } from "./scenarios.ts";
import {
	evaluateStopGate,
	runFastCheck,
	isDirty,
	counterPath,
	readCounter,
	writeCounter,
	resetCounter,
	driveStatePath,
	readDriveState,
	writeDriveState,
	resetDriveState,
} from "./stopgate.ts";
import { runGateTrain, type GateOutcome } from "./gate.ts";
import { runMergeTrain, type MergeOutcome } from "./merge.ts";
import { formatTarget, applyFormat } from "./formatter.ts";
import { resolveToolTimeoutMs, timeoutText, withTimeout } from "./liveness.ts";

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
	/** `owner/name` of the configured remote — every gh call pins it (gh defaults to the PARENT tracker inside a fork). */
	repoSlug: string;
}

/** DEFAULT when no config resolves at all (spec 2026-11-15 §2: absent ⇒ 45). */
const DEFAULT_TOOL_TIMEOUT_MINUTES = 45;

/**
 * Explicit test seam (tools.test.ts single-construction pin): counts buildContext calls.
 * The bound probe and the guarded run historically constructed the context TWICE per
 * bounded tool call (a config read + a git subprocess each); the pin asserts exactly one.
 * One named object — production reads none of it (#65 round-4: no loose mutable exports).
 */
export const testSeams = {
	/** buildContext invocations (the single-construction pin counts deltas of this). */
	contextBuilds: 0,
};

export function buildContext(cwd: string): ToolContext {
	testSeams.contextBuilds += 1;
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
		repoSlug: repoSlugFromRemote(cfg.root, cfg.remote),
	};
}

/** Per-invocation context resolution: tools act on the repo the agent is standing in.
 * `prebuilt` reuses runBounded's single construction (its bound probe already built it).
 */
async function runGuarded<T>(toolCtx: { cwd: string }, fn: (ctx: ToolContext) => Promise<AgentToolResult<T>>, prebuilt?: ToolContext): Promise<AgentToolResult<T>> {
	try {
		return await fn(prebuilt ?? buildContext(toolCtx.cwd));
	} catch (e) {
		// Confined cast: the error result intentionally carries no details payload.
		return { ...text(`devloop unavailable here: ${(e as Error).message}`), details: undefined, isError: true } as AgentToolResult<T>;
	}
}

/**
 * The bounded run (spec 2026-11-15 §2 — the unwedge): every devloop_* call races the
 * `.devloop.json` orchestrator.tool_timeout_minutes bound (MULTIPI_TOOL_TIMEOUT_MS seam,
 * 0 = disabled). On expiry the call RESOLVES with the reconciliation error text — it never
 * rejects and never hangs; the abandoned promise's side effects (a spawned child, a pushed
 * branch) continue, which is exactly what the text tells the operator to reconcile.
 */
async function runBounded<T>(name: string, toolCtx: { cwd: string }, fn: (ctx: ToolContext) => Promise<AgentToolResult<T>>): Promise<AgentToolResult<T>> {
	let ctx: ToolContext | undefined;
	try {
		ctx = buildContext(toolCtx.cwd);
	} catch {
		// config unreachable: the default bound; runGuarded rebuilds once to surface the message
	}
	const ms = resolveToolTimeoutMs(ctx?.cfg.orchestrator.toolTimeoutMinutes ?? DEFAULT_TOOL_TIMEOUT_MINUTES);
	const r = await withTimeout(() => runGuarded(toolCtx, fn, ctx), ms);
	if (r.status === "ok") return r.value;
	return { ...text(timeoutText(name, r.ms)), isError: true } as AgentToolResult<T>;
}

export function noteFilePath(ctx: ToolContext, branch: string): string {
	return path.join(ctx.paths.notesDir, `pr-${branch.replaceAll("/", "_")}.md`);
}

/** Abort controllers for children this session spawned (session-lifetime registry). */
const controllers = new Map<string, AbortController>();

/** Soft per-role duration hints for the receipt (a hint, not a timer — the child's silence
 * watchdog, the board's OVER BOUND tag and devloop_cancel are the real net for a stuck child). */
const EXPECTED_MINUTES: Record<string, number> = {
	implementer: 45,
	"code-reviewer": 15,
	verifier: 20,
	nalyst: 15,
	"scenario-writer": 15,
};

/** The child's full report file (the receipt names it; written on completion). */
export function reportFilePath(ctx: ToolContext, key: string): string {
	return path.join(ctx.stateDir, "reports", `${key}.md`);
}

/** Persist the child's full report beside the dispatch state, after any side-effect
 * warnings have been appended to the entry. Atomic (tmp + rename), like the state writers.
 * Carries a usage footer (the pre-#133 tool result showed it; the report file is the
 * post-mortem surface now). */
function writeReportFile(ctx: ToolContext, key: string, res: ChildResult): void {
	const e = readState(ctx.stateDir)[key];
	if (!e || e.status === "running") return;
	const p = reportFilePath(ctx, key);
	mkdirSync(path.dirname(p), { recursive: true });
	const u = res.usage;
	const footer = `\n\n[usage: tokens in/out ${u.input}/${u.output} · $${u.cost.toFixed(4)}]`;
	const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmp, e.report ? `${e.report.replace(/\n+$/, "")}${footer}\n` : `(no report)${footer}\n`);
	renameSync(tmp, p);
}

/** Fire-and-poll receipt (ticket #133): the dispatch contract the orchestrator acts on.
 * The child key, ticket, role, branch, worktree, notes/plan path, the report file path and
 * a duration hint — the session is free again, the child keeps running. */
function dispatchReceipt(ctx: ToolContext, role: string, key: string, ticket: number | undefined, entry: DispatchEntry, extra: { notes?: string; plan?: string }): AgentToolResult<DispatchDetails | undefined> {
	const id = ticket !== undefined ? ` #${ticket}` : "";
	const branchPart = entry.branch ? ` (${entry.branch})` : "";
	const minutes = EXPECTED_MINUTES[role] ?? 15;
	const lines: string[] = [
		`DISPATCHED ${role}${id}${branchPart} -> running`,
		`  key: ${key}`,
	];
	if (entry.branch) lines.push(`  branch: ${entry.branch}`);
	lines.push(`  worktree: ${entry.worktree}`);
	if (extra.notes) lines.push(`  notes: ${extra.notes}`);
	if (extra.plan) lines.push(`  plan file: ${extra.plan}`);
	lines.push(`  report: ${reportFilePath(ctx, key)} (written when the child finishes)`);
	lines.push(`  expected: ~${minutes} min — the child runs in the BACKGROUND; this session stays free. Poll devloop_status to collect the report (at most once per turn); the watchdog wakes the session when a report lands.`);
	const details: DispatchDetails = {
		role,
		ticket,
		key,
		branch: entry.branch,
		worktree: entry.worktree,
		notes: extra.notes,
		reportPath: reportFilePath(ctx, key),
		expectedMinutes: minutes,
		status: "dispatched",
		aborted: false,
	};
	return { ...text(lines.join("\n")), details };
}

/** Role-specific side effects that run when the child reaches a terminal state. */
type CompletionFn = (ctx: ToolContext, key: string, entry: DispatchEntry, res: ChildResult, warns: string[]) => Promise<void>;

/** Wire the completion handler to the child's promise (fire-and-poll, #133): the terminal
 * state, the report file and the outcome-driven side effects land AFTER the receipt has
 * resolved — never inside the tool call. Failures are contained (a side effect that throws
 * must never surface as an unhandled rejection of a settled tool call). */
function attachCompletion(ctx: ToolContext, promise: Promise<ChildResult>, key: string, entry: DispatchEntry, completer?: CompletionFn): void {
	void promise.then((res) => completeChild(ctx, key, entry, completer, res), () => {
		/* spawnPi never rejects: a spawn failure resolves with exitCode 1 */
	});
}

async function completeChild(ctx: ToolContext, key: string, entry: DispatchEntry, completer: CompletionFn | undefined, res: ChildResult): Promise<void> {
	try {
		finishEntry(ctx, key, entry, res);
		const warns: string[] = [];
		if (completer) await completer(ctx, key, entry, res, warns);
		if (warns.length > 0) {
			// A side effect that failed (PR open, scenario comment) is surfaced where the report
			// is collected: appended to the entry's report, so the late-report tail shows it.
			updateState(ctx.stateDir, (s) => {
				const e = s[key];
				if (e && e.status !== "running") {
					e.report = `${e.report ?? ""}\n\nWARNING: ${warns.join("; ")}`.replace(/^\n+/, "");
				}
			});
		}
		writeReportFile(ctx, key, res);
	} catch (e) {
		console.error(`devloop child-complete handler error (${key}): ${(e as Error).message}`);
	}
}

/** Implementer completion: refresh the remote view, then the outcome-driven side effects
 * (PR + dl/in-review on DONE; dl/blocked on BLOCKED) — the terminal-line classifier decides,
 * not the transport's stop reason (the pre-#133 rule, now running post-receipt). */
async function implementerCompletion(ctx: ToolContext, key: string, entry: DispatchEntry, res: ChildResult, warns: string[]): Promise<void> {
	const ticket = Number(key);
	git(["fetch", "-q", ctx.cfg.remote], ctx.cfg.root); // child pushed; refresh the main repo's view
	const verdict = classifyReport(entry.role, res.finalText);
	if (verdict === "done" && !res.aborted) {
		try {
			execFileSync("bash", [path.join(ctx.scriptsDir, "open-pr.sh"), entry.branch ?? `feat/${ticket}`], {
				cwd: ctx.cfg.root,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			addLabel(ctx.repoSlug, ticket, "dl/in-review");
		} catch (e) {
			warns.push(`could not open the PR: ${(e as Error).message.split("\n")[0]}`);
		}
	} else if (verdict === "blocked") {
		try {
			addLabel(ctx.repoSlug, ticket, "dl/blocked");
		} catch {
			/* labelling is best-effort; the report carries the reason */
		}
	}
}

/** Scenario-writer completion: DONE posts the scenario TITLES (the dark-mode review list);
 * BLOCKED labels the ticket dl/blocked (the #11 rule, now running post-receipt). */
async function scenarioWriterCompletion(ctx: ToolContext, key: string, entry: DispatchEntry, res: ChildResult, warns: string[]): Promise<void> {
	const ticket = Number(key.replace("scenario-writer-", ""));
	const verdict = classifyReport(entry.role, res.finalText);
	if (verdict === "done" && !res.aborted) {
		// Only this ticket's own lines (t<ticket>-) may land on its review list; a writer
		// reporting a foreign id cannot pollute it.
		const lines = scenarioLinesForTicket(ticket, parseScenarioLines(res.finalText));
		if (lines.length > 0) {
			try {
				addComment(ctx.repoSlug, ticket, buildScenarioComment(ticket, lines));
			} catch (e) {
				warns.push(`could not comment the scenarios: ${(e as Error).message.split("\n")[0]}`);
			}
		}
	} else if (verdict === "blocked") {
		try {
			addLabel(ctx.repoSlug, ticket, "dl/blocked");
		} catch {
			/* labelling is best-effort; the report carries the reason */
		}
	}
}

export interface DispatchDetails {
	role: string;
	ticket?: number;
	/** The dispatch-state key the child runs under (the devloop_cancel target). */
	key: string;
	branch?: string;
	worktree: string;
	/** The notes file path (implementer). */
	notes?: string;
	/** Where the child's full report lands on completion. */
	reportPath: string;
	/** Soft expected-duration hint (minutes). */
	expectedMinutes: number;
	status: "dispatched";
	aborted: false;
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

/** Report tail for the late-report surface: the last few non-empty lines, bounded, the
 * terminal line (STATUS/VERDICT) at the end is what the orchestrator acts on. */
function reportTail(report: string | undefined, maxLines = 4, maxChars = 400): string {
	if (!report) return "(no report)";
	const lines = report.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
	const tail = lines.slice(-maxLines).join("\n");
	return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

/** Render the late-report section (non-table on purpose: the structural pin keeps the
 * operator board to its pipe tables). Empty input yields the (none) fallback line. */
function lateReportsBlock(late: Array<[string, DispatchEntry]>): string[] {
	if (late.length === 0) return ["(none)"];
	const lines: string[] = [];
	for (const [k, e] of late) {
		// Numeric keys are tickets; ad-hoc keys (review-/analyst-/verifier-/scenario-writer-)
		// are not ticket numbers and name plainly (#121 review round 2).
		const id = /^\d+$/.test(k) ? `#${k}` : k;
		const when = e.endedAt ? new Date(e.endedAt).toISOString().slice(0, 16).replace("T", " ") : "?";
		lines.push(`- ${id} ${e.role} (${e.branch ?? e.worktree}) -> ${e.status} — ended ${when}`);
		for (const l of reportTail(e.report).split("\n")) lines.push(`  ${l}`);
	}
	return lines;
}

function git(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** Default delay for the single retry when GitHub's issue list lags a just-created ticket.
 * Module-private: `listLagRetryMs` is the only consumer, and a named constant the tests
 * could not reach anyway (the wait is driven by the documented MULTIPI_LIST_LAG_RETRY_MS
 * seam) is not public API. */
const LIST_LAG_RETRY_MS_DEFAULT = 1500;

/**
 * The one bounded list-lag retry wait. Documented env seam `MULTIPI_LIST_LAG_RETRY_MS` (ms):
 * tests drive dispatch without the real 1.5 s wall-clock wait; unset or non-positive values
 * fall back to the 1500 ms default. (Supersedes the no-seam clause of the 2026-11-09
 * findOpenTicket DECISIONS entry — review of #11, round 2.)
 */
function listLagRetryMs(): number {
	const raw = Number(process.env.MULTIPI_LIST_LAG_RETRY_MS);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : LIST_LAG_RETRY_MS_DEFAULT;
}

/**
 * Find an open ticket with one bounded retry. GitHub's list endpoint briefly lags a
 * just-created issue — precisely the moment at which the scenario-writer (and the
 * implementer) gets dispatched — so re-list once after a short wait before refusing.
 */
export async function findOpenTicket(repoSlug: string, ticket: number): Promise<Issue | undefined> {
	let issue = listOpenIssues(repoSlug).find((i) => i.number === ticket);
	if (!issue) {
		await new Promise((r) => setTimeout(r, listLagRetryMs()));
		issue = listOpenIssues(repoSlug).find((i) => i.number === ticket);
	}
	return issue;
}

/**
 * Terminal-line classification of a role report — the one uniform rule for every role.
 * Only the report's LAST non-empty line decides, and it must match the role's contract:
 *  - implementer / scenario-writer / analyst / verifier: `STATUS: DONE` | `STATUS: BLOCKED`
 *  - code-reviewer: `VERDICT: APPROVE` | `VERDICT: CHANGES [REQUIRED]` (a finished review → done)
 * Marker mentions anywhere else in the body (quotes, documented contracts) can never decide;
 * a report lacking a terminal marker keeps the crashed semantics (ticket #22).
 */
export function classifyReport(role: string, report: string): "done" | "blocked" | "crashed" {
	const last = report.split("\n").map((l) => l.trim()).reverse().find((l) => l !== "") ?? "";
	if (role === "code-reviewer") {
		return /^VERDICT:\s*(APPROVE\b|CHANGES(?:\s+REQUIRED)?\b)/.test(last) ? "done" : "crashed";
	}
	if (/^STATUS:\s*BLOCKED\b/.test(last)) return "blocked";
	if (/^STATUS:\s*DONE\b/.test(last)) return "done";
	return "crashed";
}

interface DispatchParams {
	role: string;
	ticket?: number;
	branch?: string;
	worktree?: string;
	task?: string;
	spec?: string;
	focus?: string;
}

async function dispatchImpl(ctx: ToolContext, params: DispatchParams, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<unknown> | undefined, parentModel?: string): Promise<AgentToolResult<DispatchDetails | undefined>> {
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
			ticket: params.ticket,
			parentModel,
		});
		attachCompletion(ctx, ac.promise, key, entry);
		return dispatchReceipt(ctx, role.name, key, params.ticket, entry, {});
	}

	// ---- analyst: spec/feedback -> ticket plan (no ticket, no capacity slot) --
	if (params.role === "analyst") {
		if (!params.spec && !params.focus) return { ...text("analyst requires `spec` (a spec path) or `focus` (operator feedback)"), isError: true };
		const state = readState(ctx.stateDir);
		pruneDead(state);
		const slug = branchSlug(params.spec ? path.basename(params.spec) : "operator-feedback") || "analysis";
		const key = `analyst-${slug}`;
		if (state[key]?.status === "running") {
			return { ...text(`an analyst for '${slug}' is already running. In-flight: ${inFlightList(state)}`), isError: true };
		}
		const planPath = path.join(ctx.paths.notesDir, `tickets-${slug}.md`);
		const analystEntry: DispatchEntry = {
			pid: 0,
			role: role.name,
			worktree: ctx.cfg.root,
			startedAt: Date.now(),
			status: "running",
		};
		persistEntry(ctx, key, analystEntry);
		const ac = spawnAndTrack(ctx, key, role, {
			task: assembleAnalystBrief({ spec: params.spec, focus: params.focus, repoRoot: ctx.cfg.root, planPath, repoSlug: ctx.repoSlug }),
			worktree: ctx.cfg.root,
			signal,
			onUpdate,
			parentModel,
		});
		attachCompletion(ctx, ac.promise, key, analystEntry);
		return dispatchReceipt(ctx, role.name, key, undefined, analystEntry, { plan: planPath });
	}

	// ---- scenario-writer: holdout scenarios for a ticket (repo root, no worktree, no capacity slot)
	if (params.role === "scenario-writer") {
		const ticket = params.ticket;
		if (ticket === undefined) return { ...text("scenario-writer requires `ticket`"), isError: true };
		if (!scenariosOn(ctx.cfg)) {
			return { ...text("the scenario store is off in this repo's config (a `scenarios` block or `factory: dark` turns it on) — there is nowhere to write the ticket's scenarios"), isError: true };
		}
		const key = `scenario-writer-${ticket}`; // distinct from the implementer's <ticket> key
		const state = readState(ctx.stateDir);
		pruneDead(state);
		if (state[key]?.status === "running") {
			return { ...text(`a scenario-writer for #${ticket} is already running. In-flight: ${inFlightList(state)}`), isError: true };
		}
		const issue = await findOpenTicket(ctx.repoSlug, ticket);
		if (!issue) return { ...text(`ticket #${ticket} not found among open issues (already merged/closed?)`), isError: true };
		const entry: DispatchEntry = {
			pid: 0,
			role: role.name,
			worktree: ctx.cfg.root,
			startedAt: Date.now(),
			status: "running",
		};
		persistEntry(ctx, key, entry);
		const brief = assembleScenarioWriterBrief({
			ticket,
			title: issue.title,
			body: issue.body,
			storeDir: ctx.paths.scenariosDir,
			repoRoot: ctx.cfg.root,
		});
		const ac = spawnAndTrack(ctx, key, role, { task: brief, worktree: ctx.cfg.root, signal, onUpdate, ticket, parentModel });
		attachCompletion(ctx, ac.promise, key, entry, scenarioWriterCompletion);
		return dispatchReceipt(ctx, role.name, key, ticket, entry, {});
	}

	// ---- code-reviewer: reviews an existing pushed branch -------------------
	if (params.role === "code-reviewer") {
		const state = readState(ctx.stateDir);
		pruneDead(state);
		const ticket = params.ticket;
		if (ticket === undefined) return { ...text("code-reviewer requires `ticket` (the branch defaults to the ticket's dispatch branch)"), isError: true };
		const entry = state[String(ticket)];
		const branch = params.branch ?? entry?.branch;
		if (!branch) return { ...text(`no known branch for ticket #${ticket}; pass \`branch\``), isError: true };
		const worktree = entry?.worktree ?? worktreePath(ctx.cfg.root, ticket, ctx.paths.worktreeDir);
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
			ticket,
			branch,
			parentModel,
		});
		attachCompletion(ctx, ac.promise, key, reviewEntry);
		return dispatchReceipt(ctx, role.name, key, ticket, reviewEntry, {});
	}

	// ---- implementer: the full deterministic pipeline -----------------------
	const ticket = params.ticket;
	if (ticket === undefined) return { ...text("implementer requires `ticket`"), isError: true };

	// Local refusals first (no GitHub dependency): busy ticket, then capacity.
	// Persisted read-modify-write: dead running entries are reclaimed to crashed (with
	// endedAt) BEFORE the busy check, so an orphaned child (the dispatch tool bound resolved
	// while the child kept running, then died) frees its ticket and slot — the stale-
	// "already running" refusal of ticket #121 can no longer happen.
	const state = reconcileState(ctx.stateDir).state;
	const prev = state[String(ticket)];
	if (prev?.status === "running") {
		return { ...text(`ticket #${ticket} already has an implementer running. In-flight: ${inFlightList(state)}`), isError: true };
	}
	const runningImplementers = Object.entries(state).filter(([, e]) => e.status === "running" && e.role === "implementer");
	const cap = ctx.cfg.heavy.slots;
	if (runningImplementers.length >= cap) {
		return { ...text(`capacity full: ${runningImplementers.length}/${cap} implementers in flight: ${inFlightList(state)}. Wait for a report (or cancel a ticket) and dispatch again.`), isError: true };
	}

	// Startability rule (spec §4): with the store on, a ticket needs a valid t<ticket>- scenario
	// BEFORE any implementation can start. Local refusal (the scan is a plain read), placed with
	// the other local refusals so no worktree/label/GitHub side effect precedes it. An UNREADABLE
	// store covers nothing (fail-closed) — a broken store never starts work it cannot verify.
	if (scenariosOn(ctx.cfg) && !coveredTicketsFromScan(scanStore(ctx.paths.scenariosDir)).includes(ticket)) {
		return {
			...text(`ticket #${ticket} is not startable: the scenario store holds no valid t${ticket}- scenario covering it (dark-factory spec §4). Dispatch the scenario-writer for #${ticket} first, then re-dispatch the implementer.`),
			isError: true,
		};
	}

	const issue = await findOpenTicket(ctx.repoSlug, ticket);
	if (!issue) return { ...text(`ticket #${ticket} not found among open issues (already merged/closed?)`), isError: true };
	const slug = branchSlug(issue.title);
	const branch = prev?.branch ?? (slug ? `feat/${ticket}-${slug}` : `feat/${ticket}`);
	const worktree = prev?.worktree ?? worktreePath(ctx.cfg.root, ticket, ctx.paths.worktreeDir);
	ensureWorktree(ctx, branch, worktree, !prev);
	addLabel(ctx.repoSlug, ticket, "dl/in-progress");

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
	const reviewNote = latestComment(ctx.repoSlug, ticket);
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
		reviewNote,
	});
	persistEntry(ctx, key, entry);
	const ac = spawnAndTrack(ctx, key, role, { task: brief, worktree, signal, onUpdate, parentModel });
	attachCompletion(ctx, ac.promise, key, entry, implementerCompletion);
	return dispatchReceipt(ctx, role.name, key, ticket, entry, { notes: noteFilePath(ctx, branch) });
}

function findRoleNames(ctx: ToolContext): string[] {
	return discoverRoles(ctx.bundledAgentsDir, ctx.projectAgentsDir).map((r) => r.name);
}

/** Spawn the child under an AbortController; wire the external signal and the cancel registry. */
function spawnAndTrack(
	ctx: ToolContext,
	key: string,
	role: { name: string; filePath: string; tools?: string[]; model?: string },
	opts: { task: string; worktree: string; signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback<unknown>; ticket?: number; branch?: string; parentModel?: string },
): { promise: Promise<ChildResult>; controller: AbortController } {
	const controller = new AbortController();
	if (opts.signal) {
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
	}
	controllers.set(key, controller);
	childreg.addChild({
		key,
		role: role.name,
		ticket: opts.ticket,
		branch: opts.branch,
		worktree: opts.worktree,
		startedAt: Date.now(),
		status: "running",
		turns: 0,
		usage: { input: 0, output: 0, cost: 0, totalTokens: 0 },
		activity: "starting",
		events: [{ at: Date.now(), kind: "start", text: "dispatched" }],
	});
	let lastTurnText = "";
	let lastActivity = "";
	const promise = spawnPi({
		task: opts.task,
		appendSystemPrompt: role.filePath,
		tools: role.tools,
		model: role.model,
		// #130 / spec §6.1: without a role model the child rides the parent session's
		// model; neither set ⇒ no --model (the settings-default fast path).
		parentModel: opts.parentModel,
		role: role.name,
		cwd: opts.worktree,
		signal: controller.signal,
		silenceMs: ctx.cfg.childSilenceMinutes * 60_000,
		onSpawn: (pid) => {
			if (pid === undefined) return;
			updateState(ctx.stateDir, (st) => {
				if (st[key]?.status === "running") st[key].pid = pid;
			});
		},
		onUpdate: (p) => {
			const st = p.status;
			const line = st ? `\n[${role.name} ${statusStamp(st.elapsedMs)} · tok ${compactTokens(st.usage.totalTokens)} · $${st.usage.cost.toFixed(2)} · ${st.activity}]` : "";
			opts.onUpdate?.({ content: [{ type: "text", text: `${p.finalText}${line}` }], details: { ...p, status: st } });
			// Live registry (widget bar + /devloop-agents): progress + a bounded event ring.
			if (st) {
				const events: childreg.ChildEvent[] = [];
				if (p.finalText !== lastTurnText && p.finalText) {
					events.push({ at: Date.now(), kind: "turn", text: p.finalText.slice(-300) });
					lastTurnText = p.finalText;
				}
				if (st.activity !== lastActivity) {
					events.push({ at: Date.now(), kind: "tool", text: st.activity });
					lastActivity = st.activity;
				}
				childreg.updateChild(key, {
					turns: st.turns,
					usage: { input: st.usage.input, output: st.usage.output, cost: st.usage.cost, totalTokens: st.usage.totalTokens },
					activity: st.activity,
				}, events.length ? events[0] : undefined);
				for (const e of events.slice(1)) childreg.updateChild(key, {}, e);
			}
		},
	}).then((res) => {
		controllers.delete(key);
		const now = Date.now();
		const status = res.aborted ? "interrupted" : classifyReport(role.name, res.finalText);
		childreg.updateChild(key, { status, endedAt: now }, { at: now, kind: "end", text: `finished (${status}, $${res.usage.cost.toFixed(2)})` });
		return res;
	});
	return { promise, controller };
}

/** Record a freshly-created dispatch entry as running (idempotent per key). */
function persistEntry(ctx: ToolContext, key: string, entry: DispatchEntry): void {
	updateState(ctx.stateDir, (state) => {
		// (#121 review M1) The fresh entry is the entry: every caller passes a complete one,
		// and the old merge carried the PREVIOUS generation's terminal fields (stale
		// endedAt/report/error/stopReason) into the new running entry — when that generation
		// was itself reaped, reapDead's `endedAt ??= now` kept the stale value, terminalTime
		// equaled the already-acked time, and the second orphan never resurfaced. The pid
		// stamp is a separate updateState, so the merge bought nothing.
		state[key] = { ...entry };
	});
}

/** Record the terminal state of a dispatch entry (state key = ticket or ad-hoc). */
export function finishEntry(ctx: ToolContext, key: string, entry: DispatchEntry, res: { exitCode: number; finalText: string; aborted: boolean; stopReason?: string; errorMessage?: string; stderr: string }, signal?: AbortSignal): void {
	updateState(ctx.stateDir, (state) => {
		// Generation guard (#121): the reap-then-re-dispatch race. This entry belongs to the
		// generation that STARTED with this startedAt; if the key now carries a different
		// startedAt, a re-dispatch took over while the old child's finish was in flight, and a
		// stale terminal would stomp the new child's running entry.
		const cur = state[key];
		if (cur && cur.startedAt !== entry.startedAt) return;
		entry.report = res.finalText || res.stderr || res.errorMessage || "";
		entry.stopReason = res.stopReason;
		if (res.errorMessage) entry.error = res.errorMessage;
		// One uniform rule for every role: the last non-empty line decides, against the role's
		// contract (STATUS for implementer/analyst/verifier/scenario-writer, VERDICT for the
		// reviewer). Marker quotes in the body never decide; no terminal marker -> crashed (#22).
		entry.status = res.aborted || signal?.aborted ? "interrupted" : classifyReport(entry.role, res.finalText);
		entry.endedAt = Date.now();
		// Keep the live pid recorded at spawn time (the entry object still carries the 0 placeholder).
		state[key] = { ...entry, pid: state[key]?.pid ?? entry.pid };
	});
}

/** mm:ss (or h:mm:ss) for a child's elapsed time. */
function statusStamp(ms: number): string {
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
	const mmss = `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	return h ? `${h}:${mmss}` : mmss;
}

/** 123456 -> "123k" for the status line. */
function compactTokens(n: number): string {
	return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
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
	const state = readState(ctx.stateDir);
	pruneDead(state);
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
	updateState(ctx.stateDir, (s) => {
		const e = s[key];
		if (e && e.status === "running") {
			e.status = "interrupted";
			e.endedAt = Date.now();
		}
	});
	return { ...text(`cancel sent for '${key}' (pid ${entry.pid || "?"}); the worktree is kept for a re-dispatch`) };
}

// ---------------------------------------------------------------------------
// Pause / handoff (operator-initiated stop for loops that run for days)
// ---------------------------------------------------------------------------

export interface HandoffChild {
	key: string;
	role: string;
	ticket?: number;
	branch?: string;
	worktree: string;
	startedAt: number;
	note: string;
	head?: string;
	/** dirty files in the worktree at pause time (undefined = not determined) */
	dirty?: number;
}

export interface HandoffBoardRow {
	number: number;
	title: string;
	labels: string;
}

/** Pure: build the HANDOFF.md document. */
export function buildHandoff(opts: { pausedAt: number; children: HandoffChild[]; board: HandoffBoardRow[] }): string {
	const lines: string[] = [];
	lines.push("# Devloop handoff — loop paused by operator");
	lines.push("");
	lines.push(`Paused: ${new Date(opts.pausedAt).toISOString()}`);
	lines.push("");
	if (opts.children.length === 0) {
		lines.push("No children were running at pause time (idle checkpoint).");
	} else {
		lines.push("The children below were interrupted at the operator's request. Worktrees and");
		lines.push("branches are intact; committed work sits on the branch.");
		lines.push("");
		lines.push("| ticket | role | branch | elapsed | note | HEAD | dirty |")
		lines.push("|---|---|---|---|---|---|---|");
		for (const c of opts.children) {
			lines.push(`| ${c.ticket ?? "—"} | ${c.role} | ${c.branch ?? "—"} | ${childreg.formatElapsed(opts.pausedAt - c.startedAt)} | ${c.note} | ${c.head ?? "—"} | ${c.dirty === undefined ? "—" : String(c.dirty)} |`);
		}
	}
	lines.push("");
	lines.push("## Board at pause time");
	lines.push("");
	if (opts.board.length === 0) lines.push("(no open issues)");
	else {
		lines.push("| # | title | labels |");
		lines.push("|---|---|---|");
		for (const b of opts.board) lines.push(`| ${b.number} | ${b.title} | ${b.labels || "—"} |`);
	}
	lines.push("");
	lines.push("## Resume");
	lines.push("");
	lines.push("1. Start a fresh pi session in this repo and say \"keep going\".");
	lines.push("2. Step 0 re-dispatches the interrupted children (same ticket -> same worktree) and the");
	lines.push("   pipeline continues from the labels (review -> gate -> merge).");
	lines.push("3. Do not re-plan work that is already committed; each new child inspects its worktree first.");
	lines.push("");
	lines.push("This file is overwritten on the next pause.");
	return lines.join("\n") + "\n";
}

function gitHeadAndDirty(worktree: string): { head?: string; dirty?: number } {
	try {
		const head = execFileSync("git", ["-C", worktree, "rev-parse", "--short", "HEAD"], { stdio: "pipe" }).toString().trim();
		const porcelain = execFileSync("git", ["-C", worktree, "status", "--porcelain"], { stdio: "pipe" }).toString();
		const dirty = porcelain.split("\n").filter((l) => l.trim().length > 0).length;
		return { head, dirty };
	} catch {
		return {};
	}
}

const PAUSE_EXIT_GRACE_MS = 15_000;

export async function pauseImpl(ctx: ToolContext): Promise<AgentToolResult<undefined>> {
	const state = readState(ctx.stateDir);
	pruneDead(state);
	const runningKeys = Object.keys(state).filter((k) => state[k]?.status === "running");
	const now = Date.now();

	// 1) Terminate every running child (worktrees are kept).
	for (const key of runningKeys) {
		const controller = controllers.get(key);
		if (controller) controller.abort();
		else {
			try {
				process.kill(state[key]!.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
		}
	}
	for (const key of runningKeys) {
		updateState(ctx.stateDir, (s) => {
			const e = s[key];
			if (e && e.status === "running") {
				e.status = "interrupted";
				e.endedAt = Date.now();
			}
		});
	}

	// 2) Bounded wait for the processes to actually die.
	const deadline = Date.now() + PAUSE_EXIT_GRACE_MS;
	while (childreg.runningChildren().length > 0 && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 500));
	}
	const laggards = childreg.runningChildren().map((c) => c.key);

	// 3) Per-child forensics (re-read: statuses are now 'interrupted') + board snapshot.
	const after = readState(ctx.stateDir);
	pruneDead(after);
	const interruptedKeys = Object.keys(after).filter((k) => after[k]?.status === "interrupted");
	const children: HandoffChild[] = interruptedKeys.map((key) => {
		const e = after[key]!;
		return {
			key,
			role: e.role,
			ticket: /^\d+$/.test(key) ? Number(key) : undefined,
			branch: e.branch,
			worktree: e.worktree,
			startedAt: e.startedAt,
			note: laggards.includes(key) ? "PAUSE DID NOT KILL IT" : runningKeys.includes(key) ? "paused now" : "earlier interruption",
			...gitHeadAndDirty(e.worktree),
		};
	});
	let board: HandoffBoardRow[] = [];
	let boardError: string | undefined;
	try {
		board = listOpenIssues(ctx.repoSlug).map((i) => ({ number: i.number, title: i.title, labels: i.labels.join(", ") }));
	} catch (e) {
		boardError = (e as Error).message;
	}

	// 4) Write HANDOFF.md (the durable record; the comments are the ping).
	mkdirSync(ctx.paths.notesDir, { recursive: true });
	const handoffPath = path.join(ctx.paths.notesDir, "HANDOFF.md");
	writeFileSync(handoffPath, buildHandoff({ pausedAt: now, children, board }));

	// 5) One-line comment on each ticket interrupted by this pause.
	const commented: number[] = [];
	for (const key of runningKeys) {
		if (!/^\d+$/.test(key)) continue;
		const n = Number(key);
		try {
			addComment(ctx.repoSlug, n, `⏸ Paused by operator at ${new Date(now).toISOString()} — the child was interrupted; its worktree and branch are kept. It will be re-dispatched on resume (see HANDOFF.md in the loop notes).`);
			commented.push(n);
		} catch {
			/* non-fatal: the handoff file is the record */
		}
	}

	const parts: string[] = [];
	parts.push(runningKeys.length > 0 ? `Paused: interrupted ${runningKeys.length} child(ren): ${runningKeys.join(", ")}` : "Paused: no children were running (idle checkpoint)");
	if (laggards.length > 0) parts.push(`WARNING: ${laggards.join(", ")} did not die within ${PAUSE_EXIT_GRACE_MS / 1000}s — kill by pid or re-run devloop_cancel`);
	if (boardError) parts.push(`board snapshot unavailable: ${boardError}`);
	parts.push(`handoff: ${handoffPath}`);
	if (commented.length > 0) parts.push(`commented tickets: ${commented.join(", ")}`);
	parts.push('Resume: fresh pi session in this repo + "keep going" (step 0 reads the handoff).');
	return { ...text(parts.join("; ")) };
}

// ---------------------------------------------------------------------------
// Stop gate (called from the agent_before_settle hook; also unit/smoke tested)
// ---------------------------------------------------------------------------
export async function evaluateSettle(cwd: string): Promise<{ entries: { type: "custom_message"; customType: string; content: string; display: boolean }[]; continue: boolean } | undefined> {
	try {
		const ctx = buildContext(cwd);
		const cfg = ctx.cfg;
		const [fc, issues, closed] = await Promise.all([runFastCheck(cfg.fastCheck ?? null, ctx.cfg.root), listOpenIssues(ctx.repoSlug), listClosedIssueNumbers(ctx.repoSlug)]);
		// Reclaimed (persisted) state: a child that died out from under a bounded dispatch is
		// crashed here, not phantom-running — its slot and its ticket free for the drive below.
		const { state } = reconcileState(ctx.stateDir);
		const running = Object.values(state).filter((e) => e.status === "running" && e.role === "implementer").length;
		// Phased loop drive (ticket #147): each open issue carries its own facts (phase labels,
		// its implementer entry's status, whether its review is RUNNING) so the gate classifies
		// the drive clauses — dispatchable / delivered-awaiting-review / approved-awaiting-gate /
		// gated-awaiting-merge — and every clause names the tickets it counts. A child in
		// flight (implementer or running review) drives NOTHING: the 2026-11-25 livelock
		// miscounted in-pipeline tickets as "startable" and re-injected one identical message
		// per settle. A terminal entry (crashed/interrupted/blocked) still drives the dispatch
		// clause, and a done entry with no RUNNING review drives the review clause (the #121/
		// #124 shapes, now owned by the classification in stopgate.ts).
		const storeOn = scenariosOn(cfg);
		// Repeat-breaker state (ticket #147): persisted next to the bounded counter file (it
		// survives session restarts; any change to the drive state resets the count).
		const dpath = driveStatePath(ctx.cfg.root);
		const dstate = readDriveState(dpath);
		const decision = evaluateStopGate({
			fastCheckPassed: fc.passed,
			fastCheckTail: fc.tail,
			dirty: isDirty(ctx.cfg.root),
			requireCleanTree: cfg.stopGate.requireCleanTree,
			maxBlocks: cfg.stopGate.maxBlocks,
			currentBlocks: readCounter(counterPath(ctx.cfg.root)),
			issues: issues.map((i) => {
				const impl = state[String(i.number)];
				return {
					number: i.number,
					blocked: i.labels.includes("dl/blocked"),
					deps: [...i.body.matchAll(/Depends on #(\d+)/g)].map((m) => Number(m[1])),
					labels: i.labels,
					implementer: impl?.role === "implementer" ? impl.status : undefined,
					reviewRunning: state[`review-${i.number}`]?.status === "running",
				};
			}),
			closed,
			inFlight: Object.entries(state)
				.filter(([, e]) => e.status === "running" && e.role === "implementer")
				.map(([k]) => Number(k))
				.filter((n) => Number.isFinite(n)),
			running,
			cap: cfg.heavy.slots,
			scenariosOn: storeOn,
			covered: storeOn ? coveredTicketsFromScan(scanStore(ctx.paths.scenariosDir)) : [],
			lastDriveFingerprint: dstate?.fp,
			driveBlocks: dstate?.n ?? 0,
		});
		if (decision.action === "pass") {
			if (decision.gaveUp) resetCounter(counterPath(ctx.cfg.root));
			// A passed settle ends the repeat state: the gate blocks only while the same
			// fingerprint keeps arriving, so a drive state that vanishes (child in flight) and
			// later returns must restart the K-cycle from block 1, not inherit a stale
			// (fingerprint, K) — the audit line's "any change re-blocks" promise (ticket #147
			// review follow-up). The pass is the only path that clears the file.
			resetDriveState(dpath);
			// The K-repeat release audit rides the console — never the bounded-counter file.
			if (decision.audit) console.error(decision.audit);
			return undefined; // let the agent settle
		}
		if (decision.bumpCounter) {
			const cp = counterPath(ctx.cfg.root);
			writeCounter(cp, readCounter(cp) + 1);
		} else if (decision.fingerprint) {
			// A drive block: advance the repeat state (a fresh fingerprint restarts the count).
			writeDriveState(dpath, decision.fingerprint, (dstate && dstate.fp === decision.fingerprint ? dstate.n : 0) + 1);
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
// The registered control-plane tool names live in ./toolnames.ts (the single
// source of truth shared with the provider tool-name grammar probe, #107)
// and are re-exported verbatim below for existing importers.
export { TOOL_NAMES } from "./toolnames.ts";

const DispatchSchema = Type.Object({
	role: Type.String({ description: "implementer | code-reviewer | verifier | analyst | scenario-writer" }),
	ticket: Type.Optional(Type.Number({ description: "Issue number (required for implementer, code-reviewer and scenario-writer)" })),
	branch: Type.Optional(Type.String({ description: "Branch override (code-reviewer)" })),
	worktree: Type.Optional(Type.String({ description: "Worktree for verifier (defaults to the repo root)" })),
	task: Type.Optional(Type.String({ description: "Free-form assignment (verifier)" })),
	spec: Type.Optional(Type.String({ description: "Spec path to decompose into a ticket plan (analyst)" })),
	focus: Type.Optional(Type.String({ description: "Operator feedback to turn into 1-3 tickets (analyst, steering mode)" })),
});

type Params<S extends TSchema> = import("typebox").Static<S>;

export function makeTools(instructions?: string): Array<ToolDefinition<TSchema, any, any>> {
	const dispatch = defineTool({
		name: TOOL_NAMES.dispatch,
		label: "Dispatch dev-loop role agent",
		promptGuidelines: instructions ? [instructions] : undefined,
		description:
			"Dispatch one role agent (implementer / code-reviewer / verifier / analyst / scenario-writer) as an isolated headless child. Implementer runs in its own git worktree; analyst and scenario-writer run at the repo root (no worktree, no capacity slot). For implementer and scenario-writer pass the ticket; everything else (branch, worktree, ports, notes path, brief) is computed deterministically. FIRE-AND-POLL: spawns the child and returns a RECEIPT immediately (child key, branch, worktree, notes path, report file path, expected duration) — the child keeps running in the background and the session stays free; the report is collected at the next devloop_status (presented exactly once; the watchdog wakes the session when a report lands). At most N implementers run concurrently (N = heavy.slots); a further dispatch is refused with the in-flight list.",
		parameters: DispatchSchema,
		execute: (_id, params: Params<typeof DispatchSchema>, signal, onUpdate, toolCtx) => {
			// The child outlives the tool call (fire-and-poll, #133): once the receipt resolves,
			// further onUpdate calls would hit a settled call — drop them, never throw.
			let live = true;
			const guarded: AgentToolUpdateCallback<unknown> | undefined = onUpdate
				? (u) => {
					if (!live) return;
					try {
						onUpdate(u);
					} catch {
						/* settled tool call: post-receipt updates are dropped, not fatal */
					}
				}
				: undefined;
			return runBounded(TOOL_NAMES.dispatch, toolCtx, (c) => dispatchImpl(c, params, signal, guarded, parentModelArg(toolCtx.model))).finally(() => {
				live = false;
			});
		},
	});

	const cancelSchema = Type.Object({
		ticket: Type.Number({ description: "Ticket whose child should be cancelled" }),
	});
	const cancel = defineTool({
		name: TOOL_NAMES.cancel,
		label: "Cancel dev-loop child",
		description: "Kill the child currently working on a ticket (the worktree and branch are kept; re-dispatch resumes).",
		parameters: cancelSchema,
		execute: (_id, params: Params<typeof cancelSchema>, _s, _u, toolCtx) => runBounded(TOOL_NAMES.cancel, toolCtx, (c) => Promise.resolve(cancelImpl(c, String(params.ticket)))),
	});

	const branchesSchema = Type.Object({
		branches: Type.Array(Type.String(), { description: "Branch names, in the exact order to gate/merge" }),
	});
	const gate = defineTool({
		name: TOOL_NAMES.gate,
		label: "Run batch gate",
		description:
			"Run the batch gate: stack the given branches (in order) on the latest base in the gate worktree and run every configured check once. Returns green / red (with failing output tail) / conflict (named branch) / error.",
		parameters: branchesSchema,
		execute: (_id, params: Params<typeof branchesSchema>, _s, _u, toolCtx) =>
			runBounded(TOOL_NAMES.gate, toolCtx, async (ctx) => {
				const out = await runGateTrain({ scriptsDir: ctx.scriptsDir, repoRoot: ctx.cfg.root, branches: params.branches });
				const label =
					out.status === "green"
						? "GATE GREEN — the train is gated. Record the label dl/gated on the covered tickets, then devloop_merge with the same branches, same order."
						: out.status === "red"
						  ? "GATE RED — nothing merges. Read the tail, dispatch the owning implementer to fix, re-push, re-gate."
						  : out.status === "conflict"
							? `GATE CONFLICT at ${out.branch ?? "?"} — drop it from the train (gate the rest, or have the implementer rebase), then re-gate.`
							: "GATE ERROR — inspect the tail; this is usually a usage/config problem.";
				return { ...text(`${label}\n${out.tail}`), details: out, ...(out.status !== "green" ? { isError: true } : {}) };
		}),
	});

	const merge = defineTool({
		name: TOOL_NAMES.merge,
		label: "Merge gated train",
		description:
			"Merge a previously gated train: replays each branch on the current base, verifies the tree is exactly the gated tree, squashes each PR in order, deletes branches. Refusals: replay-conflict / tree-differs (re-gate) / notes-missing / branch-changed / pr-not-merged / not-gated-green.",
		parameters: branchesSchema,
		execute: (_id, params: Params<typeof branchesSchema>, _s, _u, toolCtx) =>
			runBounded(TOOL_NAMES.merge, toolCtx, async (ctx) => {
				const out = await runMergeTrain({ scriptsDir: ctx.scriptsDir, repoRoot: ctx.cfg.root, branches: params.branches });
				const label =
					out.status === "merged"
						? `MERGED ${out.merged.join(", ")} — mark the tickets dl/merged and close the issues.`
						: `MERGE REFUSED (${out.status}) — nothing was merged. ${out.status === "tree-differs" || out.status === "branch-changed" || out.status === "replay-conflict" ? "Re-gate the train first." : ""}`;
				return { ...text(`${label}\n${out.tail}`), details: out, ...(out.status !== "merged" ? { isError: true } : {}) };
		}),
	});

	const status = defineTool({
		name: TOOL_NAMES.status,
		label: "Dev-loop status",
		description: "Show the loop's current state: in-flight children, open tickets with dl/ labels, capacity, and the last green gate record. Reclaims orphaned children (a dead pid reclassifies running -> crashed, freeing the slot and allowing a re-dispatch) and lists the children that reached a terminal state since the last status (late reports, with their report tail).",
		parameters: Type.Object({}),
		execute: (_id: string, _p: unknown, _s: AbortSignal | undefined, _u: unknown, toolCtx: { cwd: string }): Promise<AgentToolResult<undefined>> =>
			runBounded(TOOL_NAMES.status, toolCtx, async (ctx) => {
				// The reconcile pass: dead running entries are reclassified crashed WITH endedAt
				// and persisted, so this status (and the board, and the next dispatch) all agree
				// the slot is free. Late reports surface the terminals since the last status, then
				// ack them (a re-terminal of the same child carries a new endedAt and resurfaces).
				const { state } = reconcileState(ctx.stateDir);
				const late = unseenTerminals(state, readSeen(ctx.stateDir));
				const kids = Object.entries(state)
					.map(([k, e]) => `| #${k} | ${e.role} | ${e.branch ?? "-"} | ${e.status} | ${new Date(e.startedAt).toISOString().slice(0, 16).replace("T", " ")} |`)
					.join("\n");
				const issues = listOpenIssues(ctx.repoSlug)
					.map((i) => {
						const labels = i.labels.filter((l) => l.startsWith("dl/"));
						const labelNames = labels.join(", ") || "-";
						const deps = [...i.body.matchAll(/Depends on #(\d+)/g)].map((m) => `#${m[1]}`).join(" ");
						// Polish depth (ticket #105): only a ticket in the review window can accrue
						// should-fix rounds; a tracker blip there degrades to "-" (status never fails
						// on an auxiliary probe) and an at-cap depth is flagged for the accept-tail branch.
						let polish = "-";
						if (labels.includes("dl/in-review") || labels.includes("dl/approved")) {
							try {
								const rounds = countShouldFixRounds(issueComments(ctx.repoSlug, i.number));
								polish = `${rounds}/${ctx.cfg.review.maxFollowupDepth}${acceptTailDue(rounds, ctx.cfg.review.maxFollowupDepth) ? " cap" : ""}`;
							} catch {
								/* depth unknown; the row still renders */
							}
						}
						return `| #${i.number} | ${i.title} | ${labelNames} | ${deps || "-"} | ${polish} |`;
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
				// (#121 review M2) The ack is the LAST fallibility-free step: the tracker calls
				// above can error the tool after the report is rendered — if the ledger were
				// updated first, a gh blip would consume the late report and it would never
				// surface again. Building the text first means an errored status re-lists it next.
				if (late.length > 0) {
					ackTerminals(ctx.stateDir, Object.fromEntries(late.map(([k, e]) => [k, terminalTime(e)])));
				}
				return text(
					[`# devloop status`, "", `Implementers in flight: ${running}/${ctx.cfg.heavy.slots}`, "", "## Children", "| ticket | role | branch | status | since |", "|---|---|---|---|---|", kids || "| - | - | - | (none) | - |", "", "## Late reports (terminal since your last status)", ...lateReportsBlock(late), "", "## Open tickets", "| # | title | dl/ labels | depends | polish |", "|---|---|---|---|---|", issues || "| - | (none) | - | - | - |", "", `## Last green gate`, train, ""].join("\n"),
				);
		}),
	});

	const pause = defineTool({
		name: TOOL_NAMES.pause,
		label: "Pause dev-loop",
		description:
			"Operator pause: terminate every running child (worktrees kept), write HANDOFF.md (per-child positions + board snapshot) in the notes dir, and comment on the interrupted tickets. On resume (fresh session + 'keep going'), step 0 reads the handoff and re-dispatches the interrupted children.",
		parameters: Type.Object({}),
		execute: (_id, _params, _s, _u, toolCtx) => runBounded(TOOL_NAMES.pause, toolCtx, (c) => pauseImpl(c)),
	});

	return [dispatch, cancel, pause, gate, merge, status];
}

// Re-export for index.ts and tests.
export { runningCount };
