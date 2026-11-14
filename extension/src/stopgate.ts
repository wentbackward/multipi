import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface IssueInfo {
	number: number;
	blocked: boolean;
	/** Issue numbers the ticket depends on (`Depends on #n` in the body). */
	deps: number[];
}

export interface StopGateInputs {
	/** false when the fast check failed (or timed out / errored). */
	fastCheckPassed: boolean;
	/** Tail of the fast-check output for the continuation message. */
	fastCheckTail: string;
	/** Working tree of the main branch (git status --porcelain). */
	dirty: boolean;
	requireCleanTree: boolean;
	maxBlocks: number;
	/** Consecutive forced continuations already given THIS session. */
	currentBlocks: number;
	/** Open issues (closed ones excluded by the caller). */
	issues: IssueInfo[];
	/** Numbers of closed issues (dependency satisfaction). */
	closed: number[];
	/** Numbers of issues with a child running (also satisfy dependencies, for loop drive). */
	inFlight: number[];
	/** Children currently running. */
	running: number;
	cap: number;
	/** Scenario store on? (dark-factory spec §4: startability requires a covering scenario). */
	scenariosOn?: boolean;
	/** Ticket numbers covered by at least one valid `t<n>-` scenario (only effective when scenariosOn). */
	covered?: number[];
}

/** Store state for the startability rule (spec §4); omitted store means off. */
export interface StoreCoverage {
	on: boolean;
	/** Ticket numbers with at least one valid `t<n>-` scenario in the store. */
	covered: number[];
}

export type StopGateDecision =
	| { action: "pass"; gaveUp?: boolean }
	| { action: "block"; message: string; bumpCounter: boolean };

export function countStartable(
	issues: IssueInfo[],
	closed: number[],
	inFlight: number[] = [],
	store: StoreCoverage = { on: false, covered: [] },
): number {
	const done = new Set([...closed, ...inFlight]);
	const covered = new Set(store.covered);
	// Startability rule (spec §4): with the store on, a ticket is startable only if a valid
	// t<ticket>- scenario covers it; with the store off the rule is inert (today's semantics).
	return issues.filter(
		(i) => !i.blocked && i.deps.every((d) => done.has(d)) && (!store.on || covered.has(i.number)),
	).length;
}

/**
 * Pure evaluation of the three-way stop gate.
 * Priority: (1) red fast check, (2) dirty tree, (3) loop drive.
 * (1) and (2) are bounded by maxBlocks (bump the counter); (3) is unbounded (harness invariant).
 */
export function evaluateStopGate(i: StopGateInputs): StopGateDecision {
	if (!i.fastCheckPassed) {
		if (i.currentBlocks >= i.maxBlocks) {
			return { action: "pass", gaveUp: true };
		}
		return {
			action: "block",
			bumpCounter: true,
			message: `The fast check is RED — finish the work, then re-run it. Output:\n${i.fastCheckTail}`,
		};
	}
	if (i.dirty && i.requireCleanTree) {
		if (i.currentBlocks >= i.maxBlocks) return { action: "pass", gaveUp: true };
		return {
			action: "block",
			bumpCounter: true,
			message:
				"The main-branch working tree has UNCOMMITTED CHANGES. Stage, commit (or discard), then settle.",
		};
	}
	const startable = countStartable(i.issues, i.closed, i.inFlight, {
		on: i.scenariosOn === true,
		covered: i.covered ?? [],
	});
	if (startable > 0 && i.running < i.cap) {
		return {
			action: "block",
			bumpCounter: false,
			message: `${startable} ticket(s) are startable (unblocked, dependencies closed) and a dispatch slot is free (running ${i.running}/${i.cap}). Keep going: dispatch them with devloop.dispatch, gate and merge what is dl/gated.`,
		};
	}
	return { action: "pass" };
}

// --- IO helpers (thin, tested indirectly via the tools) ---

const FAST_CHECK_TIMEOUT_MS = 10 * 60_000;
const FAST_CHECK_MAX_BUFFER = 2 * 1024 * 1024;

/** Per-repo counter file, stored next to the repo's git dir (never committed). */
export function counterPath(repoRoot: string): string {
	const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot, stdio: "pipe" })
		.toString()
		.trim();
	return path.isAbsolute(common) ? path.join(common, "devloop-stop-count") : path.join(repoRoot, common, "devloop-stop-count");
}

export function readCounter(p: string): number {
	try {
		const n = Number.parseInt(readFileSync(p, "utf8").trim(), 10);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	}
}

export function writeCounter(p: string, n: number): void {
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(p, String(n));
}

export function resetCounter(p: string): void {
	try {
		writeFileSync(p, "0");
	} catch {
		/* best effort */
	}
}

/** Run the configured fast check; timeout/error count as RED (fail safe). */
export function runFastCheck(command: string | null, cwd: string): Promise<{ passed: boolean; tail: string }> {
	if (!command) return Promise.resolve({ passed: true, tail: "(fast check not configured)" });
	return new Promise((resolve) => {
		// Spawning (rather than execFile, whose options ignore `stdio` in Node 24) with stdin
		// "ignore": a check that reads stdin (REPL, `read`) must see immediate EOF, never a pipe
		// the parent holds open for the entire run — that hung devloop.gate (see #48/#41).
		const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		// As in execFile: maxBuffer is enforced per stream; the tail combines stdout then stderr.
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let outBytes = 0;
		let errBytes = 0;
		child.stdout!.on("data", (chunk: Buffer) => {
			outBytes += chunk.length;
			if (outBytes <= FAST_CHECK_MAX_BUFFER) out.push(chunk);
			else child.kill("SIGTERM");
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			errBytes += chunk.length;
			if (errBytes <= FAST_CHECK_MAX_BUFFER) err.push(chunk);
			else child.kill("SIGTERM");
		});
		const timer = setTimeout(() => child.kill("SIGTERM"), FAST_CHECK_TIMEOUT_MS);
		child.on("error", () => {
			// spawn failure: "close" still follows and maps to RED.
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const combined = Buffer.concat(out).toString() + Buffer.concat(err).toString();
			resolve({
				passed: code === 0,
				tail: combined.split("\n").filter((l) => l.trim()).slice(-30).join("\n"),
			});
		});
	});
}

/** True when the main-branch working tree has unstaged/untracked changes. */
export function isDirty(repoRoot: string): boolean {
	try {
		return execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
		}).toString().trim().length > 0;
	} catch {
		return false;
	}
}
