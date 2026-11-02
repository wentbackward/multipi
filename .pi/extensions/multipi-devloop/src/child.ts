import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

export interface ChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	totalTokens: number;
}

export interface ChildResult {
	exitCode: number;
	/** Text of the LAST assistant message (the role's final report). */
	finalText: string;
	stderr: string;
	usage: ChildUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	aborted: boolean;
	/** Names of tool calls seen, in order. */
	toolCalls: string[];
}

export interface ChildStatus {
	elapsedMs: number;
	turns: number;
	usage: ChildUsage;
	/** Most recent tool activity: "bash: npm run test:unit", "edit: src/x.ts", "…". */
	activity: string;
}

export interface SpawnOpts {
	task: string;
	/** Path of the role prompt file, passed via --append-system-prompt. */
	appendSystemPrompt?: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	/** Watchdog: no child OUTPUT for this long kills the whole process tree (unset = disabled). */
	silenceMs?: number;
	/** Grace between the watchdog's SIGTERM and SIGKILL (default 15 s). */
	killGraceMs?: number;
	/** Called once the process has started, with its (possibly undefined) pid. */
	onSpawn?: (pid: number | undefined) => void;
	onUpdate?: (partial: { finalText: string; toolCalls: string[]; status: ChildStatus }) => void;
}

/** Minimum wall time between status emissions while the child is quiet (heartbeats). */
const STATUS_HEARTBEAT_MS = 30_000;
/** Status emissions are rate-limited: at most one per tick while events are flowing. */
const STATUS_TICK_MS = 20_000;
/** Default grace between watchdog SIGTERM and SIGKILL. */
const DEFAULT_KILL_GRACE_MS = 15_000;
/** Wait between the child's exit and the orphan sweep's SIGKILL escalation. */
const SWEEP_ESCALATION_MS = 5_000;

const CAN_PGID = process.platform !== "win32";

// ---------------------------------------------------------------------------
// Process-tree discipline.
//
// Children are spawned in their own process group (detached), so their entire
// descendant tree (bash, test runners, browsers) shares one pgid and can be
// signalled in one shot. Consequences this buys:
//   1. A child's leaked grandchild can never outlive the child unchallenged —
//      every child exit sweeps the group for survivors.
//   2. The orchestrator's death takes the whole spawned tree with it (exit hook).
// Both exist because observed in the wild: a wedged child left a browser and a
// test running for 10+ hours after the child itself was gone.
// ---------------------------------------------------------------------------

/** pgids of children spawned in this process that have not yet settled. */
const liveTrees = new Set<number>();
let guardsRegistered = false;

/** Signal an entire process group; no-op when the group is already gone. */
export function killGroup(pgid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(CAN_PGID ? -pgid : pgid, sig);
	} catch {
		/* group gone */
	}
}

/** True when any member of the group is still alive (or owned by another uid). */
export function groupAlive(pgid: number): boolean {
	try {
		process.kill(CAN_PGID ? -pgid : pgid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Count live members of the group (Linux /proc only; -1 when not determinable). */
export function groupMemberCount(pgid: number): number {
	if (process.platform !== "linux" || !existsSync("/proc")) return -1;
	let n = 0;
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			// stat: "pid (comm) state ppid pgrp ..." — comm may contain spaces/parens, so slice after the last ')'.
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) === pgid) n++;
		} catch {
			/* the process went away mid-scan */
		}
	}
	return n;
}

/** Kill every still-live child tree. Safe to call from a process exit handler (sync, no throws). */
export function killAllChildTrees(): void {
	for (const pg of [...liveTrees]) killGroup(pg, "SIGKILL");
	liveTrees.clear();
}

/**
 * Register the best-effort shutdown hook: when THIS process exits, no child tree
 * survives. Idempotent. Limitation: a hard kill (SIGKILL) of the orchestrator
 * bypasses all hooks — that residue is what the next session's step-0 recovery
 * finds and cleans.
 */
export function registerChildProcessGuards(): void {
	if (guardsRegistered) return;
	guardsRegistered = true;
	process.on("exit", killAllChildTrees);
}

/**
 * Resolve the pi binary. Precedence:
 * 1. MULTIPI_PI_BIN (test seam / explicit override, same convention as the MULTIPI_* script overrides);
 * 2. re-execute the running pi entry script (when this extension runs inside pi);
 * 3. `pi` on PATH.
 */
export function resolvePiInvocation(args: string[], env: NodeJS.ProcessEnv): { command: string; args: string[] } {
	if (env.MULTIPI_PI_BIN) return { command: env.MULTIPI_PI_BIN, args };
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	return { command: "pi", args };
}

/**
 * Spawn a one-shot headless pi (`-p --no-session --mode json`), stream its NDJSON events,
 * and resolve with the aggregated result. Never throws for child failures; `signal`
 * aborts by killing the child's WHOLE process tree (SIGTERM, SIGKILL after 5 s) and
 * sets `aborted`. If `silenceMs` is set, a child that emits no output for that long
 * is killed the same way (exitCode 124, errorMessage `WATCHDOG: …`).
 */
export function spawnPi(opts: SpawnOpts): Promise<ChildResult> {
	const args = ["-p", "--no-session", "--mode", "json"];
	if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
	if (opts.tools?.length) args.push("--tools", opts.tools.join(","));
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinking) args.push("--thinking", opts.thinking);
	args.push(opts.task);
	const { command, args: fullArgs } = resolvePiInvocation(args, opts.env ?? process.env);
	const killGrace = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

	return new Promise((resolve) => {
		const res: ChildResult = {
			exitCode: 0,
			finalText: "",
			stderr: "",
			aborted: false,
			toolCalls: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 },
		};
		let proc: ReturnType<typeof spawn>;
		let spawnFailed = false;
		let settled = false;
		let killed = false;
		let watchdogFired = false;
		let lastActivityAt = Date.now();
		try {
			// detached: the child leads its own process group (its pgid == its pid),
			// so the tree is signallable as one unit. See "Process-tree discipline" above.
			proc = spawn(command, fullArgs, {
				cwd: opts.cwd,
				shell: false,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...opts.env, MULTIPI_CHILD: "1" },
			});
		} catch (e) {
			res.exitCode = 1;
			res.stderr = String(e);
			resolve(res);
			return;
		}
		const pgid = proc.pid;
		if (pgid) liveTrees.add(pgid);

		let buf = "";
		const startedAt = Date.now();
		let turns = 0;
		let activity = "starting";
		let lastStatusTick = 0;
		let lastEmittedActivity = "";
		const usageNow = (): ChildUsage => ({ ...res.usage });
		const emitStatus = (force = false) => {
			const now = Date.now();
			if (!force && now - lastStatusTick < STATUS_TICK_MS && activity === lastEmittedActivity) return;
			lastStatusTick = now;
			lastEmittedActivity = activity;
			opts.onUpdate?.({ finalText: res.finalText, toolCalls: res.toolCalls, status: { elapsedMs: now - startedAt, turns, usage: usageNow(), activity } });
		};
		const heartbeat = setInterval(() => {
			emitStatus(true);
		}, STATUS_HEARTBEAT_MS);
		heartbeat.unref?.();

		let watchdogPoll: ReturnType<typeof setInterval> | undefined;
		if (opts.silenceMs) {
			// Poll proportionally to the threshold (never slower than every quarter of it)
			// so tests can use sub-second thresholds without sleeping on a 10 s tick.
			watchdogPoll = setInterval(() => {
				if (settled || watchdogFired || pgid === undefined) return;
				const silentFor = Date.now() - lastActivityAt;
				if (silentFor <= opts.silenceMs!) return;
				watchdogFired = true;
				const mins = Math.max(1, Math.round(silentFor / 60_000));
				res.exitCode = 124;
				res.errorMessage = `WATCHDOG: no child output for ${mins}m (last activity: ${activity}); process tree killed (SIGTERM, SIGKILL after ${Math.round(killGrace / 1000)}s if needed)`;
				killGroup(pgid, "SIGTERM");
				// Safety net: if the close event never delivers a settle, force one.
				setTimeout(() => {
					killGroup(pgid, "SIGKILL");
					settle();
				}, killGrace + 3_000);
			}, Math.min(10_000, Math.ceil(opts.silenceMs / 4)));
			watchdogPoll.unref?.();
		}

		const settle = (extra?: Partial<ChildResult>): void => {
			if (settled) return;
			settled = true;
			clearInterval(heartbeat);
			if (watchdogPoll) clearInterval(watchdogPoll);
			resolve({ ...res, ...extra });
		};

		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let ev: {
				type?: string;
				message?: {
					role?: string;
					toolName?: string;
					content?: { type: string; text?: string; name?: string; arguments?: { command?: string; path?: string; file_path?: string; [k: string]: unknown } }[];
					model?: string;
					stopReason?: string;
					errorMessage?: string;
					usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number }; totalTokens?: number };
				};
			};
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}
			const msg = ev.message;
			if (!msg) return;
			if (ev.type === "message_end" && msg.role === "assistant") {
				for (const part of msg.content ?? []) {
					if (part.type === "text" && typeof part.text === "string") res.finalText = part.text;
					if (part.type === "toolCall" && part.name) {
						res.toolCalls.push(part.name);
						const a = part.arguments;
						const hint = (a?.command ?? a?.path ?? a?.file_path ?? "") as string;
						activity = hint ? `${part.name}: ${hint.slice(0, 72)}` : part.name;
					}
				}
				turns++;
				const u = msg.usage;
				if (u) {
					res.usage.input += u.input ?? 0;
					res.usage.output += u.output ?? 0;
					res.usage.cacheRead += u.cacheRead ?? 0;
					res.usage.cacheWrite += u.cacheWrite ?? 0;
					res.usage.cost += u.cost?.total ?? 0;
					if (typeof u.totalTokens === "number") res.usage.totalTokens = u.totalTokens;
				}
				if (msg.model) res.model = msg.model;
				if (msg.stopReason) res.stopReason = msg.stopReason;
				if (msg.errorMessage) res.errorMessage = msg.errorMessage;
				emitStatus(true); // a completed turn is meaningful progress — always visible
			} else if (ev.type === "tool_result_end") {
				if (typeof msg.toolName === "string") {
					res.toolCalls.push(msg.toolName);
					// Keep the richer toolCall hint when one was seen; name the tool otherwise.
					if (activity === "starting") activity = msg.toolName;
				}
				emitStatus();
			}
		};
		proc.stdout?.on("data", (d: Buffer) => {
			lastActivityAt = Date.now(); // any output at all is progress (NDJSON or not)
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		proc.stderr?.on("data", (d: Buffer) => {
			lastActivityAt = Date.now();
			res.stderr += d.toString();
		});
		opts.onSpawn?.(proc.pid);

		const onAbort = () => {
			if (killed || pgid === undefined) return;
			killed = true;
			res.aborted = true;
			killGroup(pgid, "SIGTERM");
			setTimeout(() => {
				killGroup(pgid, "SIGKILL");
			}, 5_000);
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		// Settle on EXIT, not CLOSE: a leaked grandchild (an abandoned browser) inherits
		// the child's stdio and holds the write ends open, so 'close' never fires while
		// 'exit' always does. 'close' remains the fast path; if it lags past a short
		// drain (buffered tail data), the fallback settles anyway.
		let exitCodeSeen: number | null = null;
		let fallback: ReturnType<typeof setTimeout> | undefined;
		let sweepStarted = false;
		const sweepAndSettle = (code: number | null): void => {
			if (settled) return;
			if (buf.trim()) handleLine(buf);
			const finish = (): void => {
				settle({ exitCode: spawnFailed ? 1 : code ?? (watchdogFired ? 124 : res.aborted ? 130 : 0) });
			};
			if (pgid === undefined || sweepStarted || !groupAlive(pgid)) {
				finish();
				return;
			}
			// Members of the child's process tree survived the child (a leaked
			// grandchild). Sweep: SIGTERM the group, escalate to SIGKILL, then settle.
			sweepStarted = true;
			const orphans = groupMemberCount(pgid);
			res.stderr += `\n[loop] child exited but its process tree is still alive — reaping ${orphans > 0 ? orphans : "leaked"} orphaned subprocess(es)`;
			killGroup(pgid, "SIGTERM");
			setTimeout(() => {
				killGroup(pgid, "SIGKILL");
				finish();
			}, SWEEP_ESCALATION_MS);
		};
		proc.on("exit", (code) => {
			if (pgid) liveTrees.delete(pgid);
			exitCodeSeen = code;
			// Give in-flight pipe data a moment to arrive; if the pipe stays open
			// (held by a survivor), settle on the schedule instead of waiting forever.
			fallback = setTimeout(() => sweepAndSettle(exitCodeSeen), 150);
		});
		proc.on("close", () => {
			if (pgid) liveTrees.delete(pgid);
			if (fallback) clearTimeout(fallback);
			sweepAndSettle(exitCodeSeen);
		});
		proc.on("error", (e) => {
			if (pgid) liveTrees.delete(pgid);
			res.stderr += String(e);
			spawnFailed = true;
			res.exitCode = 1;
			setTimeout(() => settle(), 50);
		});
	});
}
