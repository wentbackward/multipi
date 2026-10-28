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
	/** Transport-level stop reason of the child's final message (diagnostics for "crashed" entries). */
	stopReason?: string;
	/** The child's error message, when pi reported one (persisted for post-mortem). */
	error?: string;
}
export type DispatchState = Record<string, DispatchEntry>;

const FILE = "dispatch.json";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Read the dispatch state file; missing or corrupt files read as empty (fail soft: history is lossy, liveness is recomputed). */
export function readState(stateDir: string): DispatchState {
	try {
		return JSON.parse(readFileSync(path.join(stateDir, FILE), "utf8")) as DispatchState;
	} catch {
		return {};
	}
}

/** Atomic write (tmp + rename); creates the state dir if needed. */
export function writeState(stateDir: string, state: DispatchState): void {
	mkdirSync(stateDir, { recursive: true });
	const tmp = path.join(stateDir, `${FILE}.tmp`);
	writeFileSync(tmp, JSON.stringify(state, null, 2));
	renameSync(tmp, path.join(stateDir, FILE));
}

/** Flip dead running entries to crashed; keep history (the status tool shows it). */
export function pruneDead(state: DispatchState): DispatchState {
	for (const e of Object.values(state)) {
		if (e.status === "running" && !isAlive(e.pid)) e.status = "crashed";
	}
	return state;
}

export function runningCount(state: DispatchState): number {
	return Object.values(pruneDead(state)).filter((e) => e.status === "running").length;
}
