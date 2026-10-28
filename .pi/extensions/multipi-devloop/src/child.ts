import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

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
	/** Called once the process has started, with its (possibly undefined) pid. */
	onSpawn?: (pid: number | undefined) => void;
	onUpdate?: (partial: { finalText: string; toolCalls: string[] }) => void;
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
 * and resolve with the aggregated result. Never throws for child failures; `signal` aborts
 * kill the child (SIGTERM, SIGKILL after 5s) and set `aborted`.
 */
export function spawnPi(opts: SpawnOpts): Promise<ChildResult> {
	const args = ["-p", "--no-session", "--mode", "json"];
	if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
	if (opts.tools?.length) args.push("--tools", opts.tools.join(","));
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinking) args.push("--thinking", opts.thinking);
	args.push(opts.task);
	const { command, args: fullArgs } = resolvePiInvocation(args, opts.env ?? process.env);

	return new Promise((resolve) => {
		const res: ChildResult = {
			exitCode: 0,
			finalText: "",
			stderr: "",
			aborted: false,
			toolCalls: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 },
		};
		let proc;
		let spawnFailed = false;
		try {
			proc = spawn(command, fullArgs, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...opts.env },
			});
		} catch (e) {
			res.exitCode = 1;
			res.stderr = String(e);
			resolve(res);
			return;
		}
		let buf = "";
		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let ev: {
				type?: string;
				message?: {
					role?: string;
					toolName?: string;
					content?: { type: string; text?: string; name?: string }[];
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
					if (part.type === "toolCall" && part.name) res.toolCalls.push(part.name);
				}
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
				opts.onUpdate?.({ finalText: res.finalText, toolCalls: res.toolCalls });
			} else if (ev.type === "tool_result_end") {
				if (typeof msg.toolName === "string") res.toolCalls.push(msg.toolName);
				opts.onUpdate?.({ finalText: res.finalText, toolCalls: res.toolCalls });
			}
		};
		proc.stdout.on("data", (d: Buffer) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		proc.stderr.on("data", (d: Buffer) => {
			res.stderr += d.toString();
		});
		opts.onSpawn?.(proc.pid);
		let killed = false;
		const onAbort = () => {
			if (killed) return;
			killed = true;
			res.aborted = true;
			try {
				proc.kill("SIGTERM");
			} catch { /* already gone */ }
			setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch { /* already gone */ }
			}, 5000);
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		proc.on("close", (code) => {
			if (buf.trim()) handleLine(buf);
			resolve({ ...res, exitCode: spawnFailed ? 1 : code ?? (res.aborted ? 130 : 0) });
		});
		proc.on("error", (e) => {
			res.stderr += String(e);
			spawnFailed = true;
			res.exitCode = 1;
			setTimeout(() => resolve({ ...res }), 50);
		});
	});
}
