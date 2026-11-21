import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
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
	/** Epoch ms of the transition into the terminal status (finishEntry, the reap, cancel/pause).
	 * Undefined only for legacy entries written before the field existed. */
	endedAt?: number;
}
export type DispatchState = Record<string, DispatchEntry>;

const FILE = "dispatch.json";
/** The late-report ack ledger (ticket #121): a key → terminal-time map, kept OUT of the
 * dispatch state (the state file is the audit history; the ledger is the operator's cursor). */
const SEEN = "reconcile-seen.json";
/**
 * Spawn grace (ticket #121): a freshly-persisted entry sits at pid 0 until onSpawn delivers
 * the child's real pid (persistEntry → spawnPi → onSpawn is milliseconds, never minutes).
 * Within the grace a pid-less entry reads as "spawning", never dead — reaping it would free
 * the slot mid-spawn and a concurrent dispatch would start a SECOND child for the same
 * ticket. Past the grace, a pid-less entry is exactly the #104 shape (the pid never arrived)
 * and is reclaimed like a dead pid.
 */
const RECONCILE_GRACE_MS = 60_000;

function isAlive(pid: number): boolean {
	if (pid <= 0) return false;
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

/** Atomic write (unique-per-process tmp + rename); creates the state dir if needed. */
export function writeState(stateDir: string, state: DispatchState): void {
	mkdirSync(stateDir, { recursive: true });
	const tmp = path.join(stateDir, `${FILE}.tmp.${process.pid}.${Date.now()}`);
	writeFileSync(tmp, JSON.stringify(state, null, 2));
	renameSync(tmp, path.join(stateDir, FILE));
}

/**
 * Exclusive lock around a read-modify-write on a shared JSON file in the state dir.
 * Concurrent pi sessions (parallel orchestrator runs, test drivers) share the files; the O_EXCL
 * lock file serialises cycles so no entry is lost to a lost update. Bounded retries with a
 * 10 s deadline — state updates are milliseconds, so contention never approaches the deadline.
 */
function lockedJson<O, R>(
	stateDir: string,
	file: string,
	readObj: () => O,
	writeObj: (o: O) => void,
	mutate: (o: O) => { result: R; write: boolean },
): R {
	mkdirSync(stateDir, { recursive: true });
	const lock = path.join(stateDir, `${file}.lock`);
	const deadline = Date.now() + 10_000;
	for (;;) {
		let held = false;
		try {
			try {
				const fd = openSync(lock, "wx");
				writeFileSync(fd, String(process.pid));
				closeSync(fd);
				held = true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException)?.code !== "EEXIST" || Date.now() > deadline) throw err;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
				continue;
			}
			const obj = readObj();
			const { result, write } = mutate(obj);
			if (write) writeObj(obj);
			return result;
		} finally {
			if (held) {
				try {
					unlinkSync(lock);
				} catch {
					/* already released */
				}
			}
		}
	}
}

/** Exclusive lock around a read-modify-write on the shared dispatch state. */
export function updateState<T>(stateDir: string, fn: (state: DispatchState) => T): T {
	return lockedJson(stateDir, FILE, () => readState(stateDir), (s) => writeState(stateDir, s), (s) => ({ result: fn(s), write: true }));
}

/**
 * Reclaim dead running entries (ticket #121): a child whose status says `running` but whose
 * pid is dead has crashed out from under the loop (or lost its pid entirely past the spawn
 * grace, the #104 shape). It is reclassified `crashed` with `endedAt` stamped — the slot
 * frees, a re-dispatch is allowed, and the history line stays for post-mortem. Mutates in
 * place; returns whether anything changed. Best-effort by construction: a recycled pid can
 * read as alive, which delays (never loses) the reclaim — the same kill -0 stance the
 * heavy-slot locks take (#68).
 */
export function reapDead(state: DispatchState, now: number = Date.now()): boolean {
	let changed = false;
	for (const e of Object.values(state)) {
		if (e.status !== "running") continue;
		const hasPid = e.pid > 0;
		const dead = hasPid ? !isAlive(e.pid) : now - e.startedAt >= RECONCILE_GRACE_MS;
		if (dead) {
			e.status = "crashed";
			e.endedAt ??= now;
			changed = true;
		}
	}
	return changed;
}

/**
 * Reclaim dead running entries and PERSIST the reclassification (write only when something
 * changed — the state file's mtime feeds the board's age fallbacks, so no spurious rewrites).
 * Runs under the state lock, so a concurrent dispatch (pid stamp, terminal write) can never
 * be clobbered by the reap. Returns the post-reap state plus whether anything was written.
 */
export function reconcileState(stateDir: string, now: number = Date.now()): { state: DispatchState; changed: boolean } {
	return lockedJson(stateDir, FILE, () => readState(stateDir), (s) => writeState(stateDir, s), (s) => {
		const changed = reapDead(s, now);
		return { result: { state: s, changed }, write: changed };
	});
}

/** Flip dead running entries to crashed; keep history (the status tool shows it). */
export function pruneDead(state: DispatchState, now: number = Date.now()): DispatchState {
	reapDead(state, now);
	return state;
}

export function runningCount(state: DispatchState): number {
	pruneDead(state);
	return Object.values(state).filter((e) => e.status === "running").length;
}

// ---------------------------------------------------------------------------
// Late-report surface (ticket #121): children that reached a terminal state since
// the orchestrator last saw them. The ack ledger is a separate file — the dispatch
// state is the audit history, the ledger is the operator's cursor into it.
// ---------------------------------------------------------------------------

/** Ledger shape: dispatch key → the terminal time of the generation last acked. */
export type ReconcileSeen = Record<string, number>;

export function readSeen(stateDir: string): ReconcileSeen {
	try {
		return JSON.parse(readFileSync(path.join(stateDir, SEEN), "utf8")) as ReconcileSeen;
	} catch {
		return {};
	}
}

/** The identity of a terminal generation: endedAt, or startedAt for legacy entries. */
export function terminalTime(e: DispatchEntry): number {
	return e.endedAt ?? e.startedAt;
}

/** Terminal (non-running) entries whose current generation is not in the seen ledger. */
export function unseenTerminals(state: DispatchState, seen: ReconcileSeen): Array<[string, DispatchEntry]> {
	return Object.entries(state).filter(([k, e]) => e.status !== "running" && seen[k] !== terminalTime(e));
}

/** Merge terminal generations into the seen ledger. Write-only-on-change: an all-known ack
 * rewrites nothing (no mtime churn on the cursor file), mirroring reconcileState's discipline. */
export function ackTerminals(stateDir: string, acks: ReconcileSeen): void {
	lockedJson(stateDir, SEEN, () => readSeen(stateDir), (s) => writeSeen(stateDir, s), (s) => {
		let changed = false;
		for (const [k, v] of Object.entries(acks)) {
			if (s[k] !== v) {
				s[k] = v;
				changed = true;
			}
		}
		return { result: s, write: changed };
	});
}

function writeSeen(stateDir: string, seen: ReconcileSeen): void {
	mkdirSync(stateDir, { recursive: true });
	const tmp = path.join(stateDir, `${SEEN}.tmp.${process.pid}.${Date.now()}`);
	writeFileSync(tmp, JSON.stringify(seen, null, 2));
	renameSync(tmp, path.join(stateDir, SEEN));
}
