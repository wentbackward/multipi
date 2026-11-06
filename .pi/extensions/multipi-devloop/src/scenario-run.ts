// Scenario-stage process-group primitives (dark-factory spec §5.1/§5.2).
//
// The bash stage (scripts/scenario-stage.sh) cannot import spawnPi: that helper is bound to
// pi's NDJSON event stream and lives in the orchestrator's process. The stage therefore runs
// node one-shots into THIS module, reusing child.ts's spawn contract verbatim — `detached`
// (own process group, pgid == child pid) plus whole-group TERM -> KILL (2 s grace) — for two
// jobs: the system-under-test run (must survive the stage) and the one-shot judges (must not).
//
// Runs are spawned with stdio straight onto a LOG FILE descriptor (not pipes): the stage's
// node runner exits while the server keeps running, and a proxy that disappears mid-stream
// would SIGPIPE the very system under test.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { groupAlive, killGroup } from "./child.ts";

/** Spec §5.1/§5.2: SIGKILL arrives this long after the SIGTERM to a still-live group. */
export const STOP_GRACE_MS = 2000;
/** Log/first-line poll cadence while waiting on a run. */
const POLL_MS = 50;
/** How long stopGroup keeps confirming the group is actually reaped after the final SIGKILL. */
const REAP_WAIT_MS = 500;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** kill -0 on the group — exported for tests and diagnostics (true = still live). */
export function groupAliveOf(pgid: number): boolean {
	return pgid > 0 && groupAlive(pgid);
}

/**
 * Stop an entire process group: SIGTERM, then SIGKILL after graceMs (default 2 s) if anyone
 * survives — the stage's pinned teardown. No-op (never throws) when the group is already gone
 * or unknown, so it is safe from exit traps and repeated calls.
 */
export async function stopGroup(pgid: number, graceMs: number = STOP_GRACE_MS): Promise<void> {
	if (pgid <= 0) return;
	if (!groupAlive(pgid)) return;
	killGroup(pgid, "SIGTERM");
	const deadline = Date.now() + Math.max(0, graceMs);
	while (Date.now() < deadline && groupAlive(pgid)) await sleep(POLL_MS);
	if (groupAlive(pgid)) killGroup(pgid, "SIGKILL");
	// A zombie child still answers kill 0 until libuv reaps it; confirm actual departure.
	const reapDeadline = Date.now() + REAP_WAIT_MS;
	while (Date.now() < reapDeadline && groupAlive(pgid)) await sleep(POLL_MS);
}

export type SystemRunResult =
	| { ok: true; /** The run's own process group id (== its pid). */ pgid: number; /** First non-empty printed line. */ target: string }
	| { ok: false; reason: string };

/**
 * Start the system under test in its OWN process group with stdout+stderr appended to
 * logFile. Resolves as soon as the first NON-EMPTY line (stdout or stderr) is visible —
 * that line is the target handed to the judges — while the run keeps living, fully detached
 * from this process. Resolves with a failure (after stopping the group) when the run exits
 * before printing anything or stays silent past runSeconds.
 */
export async function spawnSystemRun(opts: {
	/** Shell snippet, executed as `bash -c`. */
	command: string;
	/** How long to wait for the first line (seconds). */
	runSeconds: number;
	/** Append target for the run's full output. */
	logFile: string;
}): Promise<SystemRunResult> {
	let logFd: number;
	try {
		logFd = openSync(opts.logFile, "a");
	} catch (e) {
		return { ok: false, reason: `run log is not writable: ${String(e)}` };
	}
	let proc: ChildProcess;
	try {
		// detached: the child leads its own process group (pgid == pid) — the spawn contract
		// shared with spawnPi, so one signal reaches the whole tree (server, workers, shells).
		proc = spawn("bash", ["-c", opts.command], {
			detached: true,
			stdio: ["ignore", logFd, logFd],
		});
	} catch (e) {
		closeSync(logFd);
		return { ok: false, reason: `run failed to start: ${String(e)}` };
	}
	// The child holds its own copy of the fd; the runner closes its copy and may exit now.
	closeSync(logFd);
	const pgid = proc.pid ?? -1;
	const fd = openSync(opts.logFile, "r");
	let cursor = 0;
	let pending = "";

	const nextTargetLine = (): string | null => {
		const buf = Buffer.alloc(65536);
		// Append PER READ: `buf` is overwritten on every readSync call, so combining several
		// reads into one `subarray(0, total)` both drops the earlier bytes and exposes stale
		// buffer garbage beyond the last partial fill as if it were output.
		while (true) {
			const n = readSync(fd, buf, 0, buf.length, cursor); // number; 0 at EOF
			if (n === 0) break;
			cursor += n;
			pending += buf.subarray(0, n).toString("utf8");
		}
		const line = scan(pending);
		if (line === null) {
			// Memo (review of #13): only complete lines were empty, so drop them and keep the
			// trailing unfinished line — pending (and every poll's split) stays bounded by the
			// longest unfinished line instead of the whole banner. O(n) total, was O(n²).
			const nl = pending.lastIndexOf("\n");
			pending = nl === -1 ? pending : pending.slice(nl + 1);
		}
		return line;
		// Only COMPLETE lines count: the segment after the last \n may be mid-write and is
		// re-scanned on the next poll once its newline (or more) has arrived.
		function scan(text: string): string | null {
			const segs = text.split(/\r?\n/);
			const upto = /\r?\n$/.test(text) ? segs.length : segs.length - 1;
			for (let i = 0; i < upto; i++) {
				const l = segs[i].trim();
				if (l !== "") return l;
			}
			return null;
		}
	};

	const deadline = Date.now() + Math.max(0, opts.runSeconds) * 1000;
	while (Date.now() < deadline) {
		let line: string | null = null;
		try {
			line = nextTargetLine();
		} catch {
			/* the run may have exited mid-read; the liveness check below decides */
		}
		if (line !== null) {
			// Hand the group back to the stage (it stops it at stage end): without unref the
			// still-running server would pin this runner's event loop for its whole lifetime.
			proc.unref?.();
			return { ok: true, pgid, target: line };
		}
		if (!groupAlive(pgid)) return { ok: false, reason: "run exited before printing a target" };
		await sleep(POLL_MS);
	}
	await stopGroup(pgid);
	return { ok: false, reason: `run silent for ${opts.runSeconds}s past its first-line wait` };
}

export type JudgeResult =
	| { ok: true; /** The judge's exit code (1 when it died to a signal we did not send). */ exitCode: number }
	| { ok: false; reason: string };

/**
 * Run ONE judge command in its own process group, bounded by judgeSeconds. The judge's full
 * output lands in outFile; the three MULTIPI_SCENARIO_* seams (plus whatever the caller adds)
 * ride in env. Settles on the child's `exit` — child.ts's lesson: `close` can outlive a dead
 * child. A cap overrun stops the group (TERM -> KILL) and is a FAILED run: upstream the
 * scenario scores 0 with the reason recorded; an unreliable judge never green-lights.
 */
export async function spawnJudge(opts: {
	/** Shell snippet, executed as `bash -c` (the configured template or the default pi command). */
	command: string;
	/** Per-judge cap in seconds. */
	judgeSeconds: number;
	/** Judge transcript target (fresh file). */
	outFile: string;
	/** Extra env (the documented scenario seams). */
	env?: Record<string, string>;
	/** Working directory for the judge (defaults to the stage's cwd). */
	cwd?: string;
}): Promise<JudgeResult> {
	let outFd: number;
	try {
		outFd = openSync(opts.outFile, "w");
	} catch (e) {
		return { ok: false, reason: `judge transcript is not writable: ${String(e)}` };
	}
	let proc: ChildProcess;
	try {
		proc = spawn("bash", ["-c", opts.command], {
			detached: true,
			cwd: opts.cwd,
			stdio: ["ignore", outFd, outFd],
			env: { ...process.env, ...(opts.env ?? {}) },
		});
	} catch (e) {
		closeSync(outFd);
		return { ok: false, reason: `judge failed to start: ${String(e)}` };
	}
	closeSync(outFd);
	const pgid = proc.pid ?? -1;

	return await new Promise<JudgeResult>((resolve) => {
		let settled = false;
		const finish = (r: JudgeResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (r.ok) {
				resolve(r);
			} else {
				// The cap (or a spawn death) means: tear the whole judge tree down, THEN report.
				void stopGroup(pgid).then(() => resolve(r));
			}
		};
		proc.on("error", (e) => finish({ ok: false, reason: `judge failed to start: ${String(e)}` }));
		// `exit`, not `close`: the child's stdio points at a file fd a leaked grandchild could
		// inherit and hold open long after the child is dead.
		proc.on("exit", (code) => finish({ ok: true, exitCode: code ?? 1 }));
		const timer = setTimeout(
			() => finish({ ok: false, reason: `judge_seconds cap (${opts.judgeSeconds}s) exceeded` }),
			Math.max(0, opts.judgeSeconds) * 1000,
		);
	});
}
