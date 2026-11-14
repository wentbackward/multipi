import { spawn } from "node:child_process";
import path from "node:path";

export interface GateOutcome {
	status: "green" | "red" | "conflict" | "error";
	/** Set for status "conflict": the branch that failed to rebase. */
	branch?: string;
	/** Last non-empty lines of the script output (for the model/user). */
	tail: string;
	exitCode: number;
}

export interface TrainRunOptions {
	/** Directory containing gate-train.sh / merge-train.sh (this repo's scripts/). */
	scriptsDir: string;
	repoRoot: string;
	branches: string[];
	env?: NodeJS.ProcessEnv;
	onTail?: (lines: string[]) => void;
}

function tailLines(out: string, n = 30): string[] {
	return out.split("\n").filter((l) => l.trim()).slice(-n);
}

const SCRIPT_MAX_BUFFER = 20 * 1024 * 1024;

/**
 * Normalize a spawn "close" code to execFile-era semantics: a signal-killed child arrives as
 * code=null, and a failed spawn as code=-errno (e.g. -2) — execFile's callback delivered both
 * as `err`, which this file's parsers read as 1. Anything but a real exit code maps to 1 so
 * the pinned gate classification (red=1 vs error) never flips.
 */
export function normalizeCloseCode(code: number | null): number {
	return code !== null && code >= 0 ? code : 1;
}

export function runScript(script: string, opts: TrainRunOptions): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		// Spawning (rather than execFile, whose options ignore `stdio` in Node 24) with stdin
		// "ignore": a check that reads stdin (REPL, `read`) must see immediate EOF, never a pipe
		// the parent holds open for the entire run — that hung devloop.gate (see #48/#41).
		const child = spawn("bash", [path.join(opts.scriptsDir, script), ...opts.branches], {
			cwd: opts.repoRoot,
			env: { ...process.env, ...opts.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let outBytes = 0;
		let errBytes = 0;
		child.stdout!.on("data", (chunk: Buffer) => {
			outBytes += chunk.length;
			if (outBytes <= SCRIPT_MAX_BUFFER) out.push(chunk);
			else child.kill("SIGTERM"); // same as execFile's maxBuffer: kill and fail
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			errBytes += chunk.length;
			if (errBytes <= SCRIPT_MAX_BUFFER) err.push(chunk);
			else child.kill("SIGTERM");
		});
		child.on("error", () => {
			// spawn failure (e.g. missing interpreter): "close" still follows and maps to code 1,
			// like execFile's error path.
		});
		child.on("close", (code) => {
			resolve({
				code: normalizeCloseCode(code),
				stdout: Buffer.concat(out).toString(),
				stderr: Buffer.concat(err).toString(),
			});
		});
	});
}

/**
 * Run gate-train.sh and classify per its pinned exit-code contract:
 * 0 green, 1 red (incl. gate_setup failure), 2 usage/config error, 3 rebase conflict (branch named).
 */
export async function runGateTrain(opts: TrainRunOptions): Promise<GateOutcome> {
	const { code, stdout, stderr } = await runScript("gate-train.sh", opts);
	const text = stdout + (stdout.endsWith("\n") ? "" : "\n") + stderr;
	const lines = tailLines(text);
	opts.onTail?.(lines);
	const tail = lines.join("\n");
	if (code === 0) return { status: "green", tail, exitCode: code };
	if (code === 1) return { status: "red", tail, exitCode: code };
	if (code === 3) {
		const m = text.match(/TRAIN rebase conflict at (\S+)/);
		return { status: "conflict", branch: m?.[1], tail, exitCode: code };
	}
	return { status: "error", tail, exitCode: code };
}
