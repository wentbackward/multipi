import { runScript, type TrainRunOptions } from "./gate.ts";

export interface MergeOutcome {
	status:
		| "merged"
		| "replay-conflict"
		| "tree-differs"
		| "notes-missing"
		| "branch-changed"
		| "pr-not-merged"
		| "refused"
		| "error";
	/** Branches actually merged, in order (status "merged" only). */
	merged: string[];
	/** Last non-empty lines of the script output. */
	tail: string;
	exitCode: number;
}

const STATUS_BY_CODE: Record<number, Exclude<MergeOutcome["status"], "merged" | "error">> = {
	3: "replay-conflict",
	4: "tree-differs",
	5: "notes-missing",
	6: "branch-changed",
	7: "pr-not-merged",
	8: "refused",
};

/**
 * Run merge-train.sh and classify per its pinned exit-code contract:
 * 0 all merged, 3 replay conflict, 4 tree differs (re-gate), 5 notes missing,
 * 6 branch changed since the gate, 7 PR not merged, 8 refused (not gated green / wrong pending set).
 */
export async function runMergeTrain(opts: TrainRunOptions): Promise<MergeOutcome> {
	const probe = await runScript("merge-train.sh", opts);
	const text = probe.stdout + (probe.stdout.endsWith("\n") ? "" : "\n") + probe.stderr;
	const lines = text.split("\n").filter((l) => l.trim()).slice(-30);
	opts.onTail?.(lines);
	const tail = lines.join("\n");
	const code = probe.code;
	if (code === 0) {
		const merged = [...text.matchAll(/^merged (\S+) -> /gm)].map((m) => m[1]);
		return { status: "merged", merged, tail, exitCode: code };
	}
	return { status: STATUS_BY_CODE[code] ?? "error", merged: [], tail, exitCode: code };
}
