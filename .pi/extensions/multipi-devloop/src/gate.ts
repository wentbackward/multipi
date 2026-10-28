import { execFile } from "node:child_process";
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

export function runScript(script: string, opts: TrainRunOptions): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			"bash",
			[path.join(opts.scriptsDir, script), ...opts.branches],
			{ cwd: opts.repoRoot, env: { ...process.env, ...opts.env }, maxBuffer: 20 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
					? (error as { code: number }).code
					: 1)
					: 0;
				resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
			},
		);
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
