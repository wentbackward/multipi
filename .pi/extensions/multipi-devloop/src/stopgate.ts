import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { collectStream } from "./streamcap.ts";

export interface IssueInfo {
	number: number;
	blocked: boolean;
	/** Issue numbers the ticket depends on (`Depends on #n` in the body). */
	deps: number[];
	/** The ticket's phase labels (dl/in-progress, dl/in-review, dl/approved, dl/gated, …). */
	labels?: string[];
	/** Status of the ticket's implementer entry in the loop state; absent = no entry. */
	implementer?: "running" | "done" | "crashed" | "interrupted" | "blocked";
	/** True when the ticket's code-reviewer entry (review-<n>) is currently running. */
	reviewRunning?: boolean;
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
	/** The fingerprint (driveFingerprint) of the drive state the gate last BLOCKED on, if any —
	 * the repeat breaker's comparison key (ticket #147). Computed/persisted by the caller. */
	lastDriveFingerprint?: string;
	/** Blocks already emitted against that fingerprint (0 = first). */
	driveBlocks?: number;
}

/** One open ticket's drive class (the loop-drive classification, ticket #147). */
export interface DriveClasses {
	/** Dispatchable: no pipeline phase in flight, no live/delivered implementer entry, deps satisfied, scenario-covered when the store is on. */
	dispatchable: number[];
	/** Delivered (implementer `done`) with no RUNNING review — owned by the review clause. */
	pending: number[];
	/** dl/approved not yet dl/gated — owned by the gate clause. */
	approved: number[];
	/** dl/gated — owned by the merge clause. */
	gated: number[];
}

/** Store state for the startability rule (spec §4); omitted store means off. */
export interface StoreCoverage {
	on: boolean;
	/** Ticket numbers with at least one valid `t<n>-` scenario in the store. */
	covered: number[];
}

export type StopGateDecision =
	| { action: "pass"; gaveUp?: boolean; /** Audit line for the K-repeat release (console, not the counter file). */ audit?: string }
	| { action: "block"; message: string; bumpCounter: boolean; /** Present on drive blocks: the fingerprint to persist for the repeat breaker. */ fingerprint?: string };

/**
 * Classify every open, non-blocked ticket into exactly one drive clause (ticket #147).
 *
 * The 2026-11-25 livelock: `countStartable` conflated *dispatchable now* with *open and
 * unblocked*, so the drive clause counted in-pipeline tickets (#110 under review) and named
 * nothing — an identical impossible instruction re-injected on every settle. The phases:
 *   dl/gated                                  → merge clause
 *   dl/approved (not dl/gated)                → gate clause
 *   implementer entry running                 → none (child in flight)
 *   running review                            → none (review in flight — the incident shape)
 *   implementer entry done                    → review clause (any/absent label — a label
 *                                               anomaly must not re-dispatch the implementer)
 *   otherwise (no entry, or terminal entry)   → dispatch clause (re-dispatch/resume),
 *                                               deps + scenario coverage gating stays HERE ONLY
 */
export function classifyDrive(
	issues: IssueInfo[],
	closed: number[],
	inFlight: number[],
	store: StoreCoverage = { on: false, covered: [] },
): DriveClasses {
	const done = new Set([...closed, ...inFlight]);
	const covered = new Set(store.covered);
	const cls: DriveClasses = { dispatchable: [], pending: [], approved: [], gated: [] };
	for (const i of issues) {
		if (i.blocked) continue;
		const labels = i.labels ?? [];
		if (labels.includes("dl/gated")) {
			cls.gated.push(i.number);
		} else if (labels.includes("dl/approved")) {
			cls.approved.push(i.number);
		} else if (i.implementer === "running") {
			// The child in flight IS the work — nothing to drive.
		} else if (i.reviewRunning) {
			// The review in flight IS the work — nothing to drive (the incident shape).
		} else if (i.implementer === "done") {
			cls.pending.push(i.number);
		} else if (i.deps.every((d) => done.has(d)) && (!store.on || covered.has(i.number))) {
			cls.dispatchable.push(i.number);
		}
	}
	return cls;
}

/** Backwards-compatible count of the dispatch class (spec §4 wording; the gate uses classifyDrive). */
export function countStartable(
	issues: IssueInfo[],
	closed: number[],
	inFlight: number[] = [],
	store: StoreCoverage = { on: false, covered: [] },
): number {
	return classifyDrive(issues, closed, inFlight, store).dispatchable.length;
}

/**
 * K for the drive repeat breaker: consecutive settles against an UNCHANGED drive state block
 * at most K times, then the gate passes with an audit line. K=3: three identical messages are
 * enough for the instruction to be unmistakably understood, and they bound the context pollution
 * to three injections instead of unbounded; K=1–2 would release before the model had a full
 * turn to act on a merely confusing (not impossible) instruction, and any larger K buys nothing
 * — after three identical blocks the state has demonstrably been acted on and cannot be.
 */
export const DRIVE_REPEAT_LIMIT = 3;

/** Stable fingerprint over the drive clause inputs (ticket #147): a change in any of them is a
 * new drive state and resets the repeat count. */
export function driveFingerprint(i: StopGateInputs, cls: DriveClasses): string {
	const nums = (xs: number[]): string => xs.slice().sort((a, b) => a - b).map(String).join("/");
	return [
		nums(cls.dispatchable),
		nums(cls.pending),
		nums(cls.approved),
		nums(cls.gated),
		i.running,
		i.cap,
		i.fastCheckPassed ? "green" : "red",
		i.dirty ? "dirty" : "clean",
	].join("|");
}

/**
 * Pure evaluation of the stop gate.
 * Priority: (1) red fast check, (2) dirty tree, (3) phased loop drive (ticket #147):
 * dispatchable / delivered-awaiting-review / approved-awaiting-gate / gated-awaiting-merge.
 * (1) and (2) are bounded by maxBlocks (bump the counter); the drive is unbounded (harness
 * invariant) and never bumps the bounded counter, EXCEPT the K-repeat release: an unchanged
 * drive state blocked K times consecutively passes with an audit line (console, not the
 * bounded-counter file) — an identical repeated message must not livelock the session.
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
	const cls = classifyDrive(i.issues, i.closed, i.inFlight, {
		on: i.scenariosOn === true,
		covered: i.covered ?? [],
	});
	// The loop drive: work that is dispatchable, delivered-but-unreviewed, approved-but-
	// ungated, or gated-but-unmerged. Every clause is unbounded (the harness invariant) and
	// names the tickets it counts — an unnamed count is the 2026-11-25 livelock shape.
	const name = (xs: number[]): string => xs.map((n) => `#${n}`).join(", ");
	const drive: string[] = [];
	if (cls.dispatchable.length > 0 && i.running < i.cap) {
		drive.push(
			`${cls.dispatchable.length} ticket(s) are startable (unblocked, dependencies closed) and a dispatch slot is free (running ${i.running}/${i.cap}): ${name(cls.dispatchable)}. Keep going: dispatch them with devloop_dispatch, gate and merge what is dl/gated.`,
		);
	}
	if (cls.pending.length > 0) {
		drive.push(
			`${cls.pending.length} delivered branch(es) await the reviewer (the implementer child finished, but no review has been dispatched): ${name(cls.pending)}. Keep going: dispatch the code-reviewer for each (devloop_dispatch), then gate and merge what is dl/gated.`,
		);
	}
	if (cls.approved.length > 0) {
		drive.push(
			`${cls.approved.length} ticket(s) are dl/approved and await the gate: ${name(cls.approved)}. Keep going: run the batch gate for them (devloop_gate), then merge what is dl/gated.`,
		);
	}
	if (cls.gated.length > 0) {
		drive.push(
			`${cls.gated.length} ticket(s) are dl/gated and await the merge: ${name(cls.gated)}. Keep going: merge them in gate order (devloop_merge).`,
		);
	}
	if (drive.length > 0) {
		const fp = driveFingerprint(i, cls);
		if (i.lastDriveFingerprint === fp && (i.driveBlocks ?? 0) >= DRIVE_REPEAT_LIMIT) {
			return {
				action: "pass",
				audit: `devloop stop-gate AUDIT: the drive state has been identical for ${DRIVE_REPEAT_LIMIT + 1} consecutive settles (startable ${name(cls.dispatchable) || "—"}; awaiting review ${name(cls.pending) || "—"}; awaiting gate ${name(cls.approved) || "—"}; awaiting merge ${name(cls.gated) || "—"}; running ${i.running}/${i.cap}) — releasing after ${DRIVE_REPEAT_LIMIT} identical blocks. Any change to the drive state re-blocks.`,
			};
		}
		return { action: "block", bumpCounter: false, message: drive.join("\n"), fingerprint: fp };
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

/** Per-repo drive-repeat state, stored next to the counter (never committed): line 1 = the
 * fingerprint of the last BLOCKED drive state, line 2 = blocks emitted against it. */
export function driveStatePath(repoRoot: string): string {
	const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot, stdio: "pipe" })
		.toString()
		.trim();
	return path.isAbsolute(common) ? path.join(common, "devloop-stop-drive") : path.join(repoRoot, common, "devloop-stop-drive");
}

export interface DriveRepeat {
	fp: string;
	n: number;
}

export function readDriveState(p: string): DriveRepeat | null {
	try {
		const lines = readFileSync(p, "utf8").trim().split("\n");
		const n = Number.parseInt(lines[1] ?? "", 10);
		if ((lines[0] ?? "").length > 0 && Number.isFinite(n) && n > 0) return { fp: lines[0], n };
		return null;
	} catch {
		return null;
	}
}

export function writeDriveState(p: string, fp: string, n: number): void {
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(p, `${fp}\n${n}\n`);
}

/** Clears the drive-repeat state (best effort; no-op when the file is absent). The gate calls
 * it on EVERY pass (the K-cycle release or a settle where no clause drives): a drive state
 * that vanishes and later RETURNS under the same fingerprint must restart the K-cycle from
 * block 1 — the stale (fingerprint, K) must not ride a passed settle (ticket #147 review
 * follow-up). A zero count has no file representation (readDriveState requires n > 0), so the
 * clear is an unlink, not a write. */
export function resetDriveState(p: string): void {
	try {
		unlinkSync(p);
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
		// the parent holds open for the entire run — that hung devloop_gate (see #48/#41).
		const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		// As in execFile: maxBuffer is enforced per stream; the tail combines stdout then stderr.
		const out = collectStream(child.stdout!, FAST_CHECK_MAX_BUFFER, () => child.kill("SIGTERM"));
		const err = collectStream(child.stderr!, FAST_CHECK_MAX_BUFFER, () => child.kill("SIGTERM"));
		let spawnErr = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), FAST_CHECK_TIMEOUT_MS);
		child.on("error", (e: Error) => {
			// spawn failure: "close" still follows and maps to RED — keep the message for the tail.
			spawnErr = e.message;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const combined =
				Buffer.concat(out).toString() +
				Buffer.concat(err).toString() +
				(spawnErr ? `\nspawn error: ${spawnErr}\n` : "");
			// code===0 alone is the fail-safe: signal kills (code=null) and spawn failures
			// (negative errno) are not 0, so they land RED just like non-zero exits.
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
