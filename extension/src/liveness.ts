/**
 * Orchestrator liveness (spec 2026-11-15 §1/§2). The pure-node half of the liveness surface:
 * the JSON sidecar at <state dir>/orchestrator-state.json, the status render decisions behind
 * scripts/multipi-status.sh, and the withTimeout bound behind every devloop.* tool call.
 *
 * Dependency rule (AGENTS.md): pure-node — NO pi imports. Only index.ts talks to pi events;
 * the operators' bash scripts talk to the sidecar via scripts/lib/liveness.sh. Both sides are
 * pinned by tests to the same rc table and sidecar shape, so neither can drift silently.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LIVENESS_FILE = "orchestrator-state.json";

/** In-flight tool call (spec §1): `seq` increments on every start — the watchdog's per-tool dedupe key. */
export interface LivenessTool {
	name: string;
	startedAt: number;
	seq: number;
}
export type LivenessPhase = "active" | "idle" | "ended";

/** The sidecar document (spec §1 shape; schema 1). */
export interface LivenessState {
	schema: 1;
	sessionId: string;
	pid: number;
	state: LivenessPhase;
	tool: LivenessTool | null;
	lastEventAt: number;
	lastTickAt: number;
	/** Last tool.seq for which the watchdog already sent a wake (−1 = none / wedge wake). */
	lastWakeSeq: number;
}

export function sidecarPath(stateDir: string): string {
	return path.join(stateDir, LIVENESS_FILE);
}

/** Missing or corrupt sidecar reads as null (fail soft — a reader never throws on liveness). */
export function loadState(stateDir: string): LivenessState | null {
	try {
		const s = JSON.parse(readFileSync(sidecarPath(stateDir), "utf8")) as LivenessState;
		return typeof s === "object" && s !== null ? s : null;
	} catch {
		return null;
	}
}

/** Atomic publish: unique-per-process tmp file + rename — a reader only ever sees a complete document. */
export function writeState(stateDir: string, state: LivenessState): void {
	mkdirSync(stateDir, { recursive: true });
	const final = sidecarPath(stateDir);
	const tmp = `${final}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(tmp, JSON.stringify(state, null, 2));
	renameSync(tmp, final);
}

/** The heartbeat: the newer of high-frequency event activity and the 15 s tick. */
export function heartbeatOf(state: LivenessState): number {
	return Math.max(state.lastEventAt, state.lastTickAt);
}

// ---------------------------------------------------------------------------
// Status render (the PINNED rc table of spec §1a — mirrored in scripts/multipi-status.sh)
// ---------------------------------------------------------------------------

export interface StatusVerdict {
	/** 0 live · 1 alive-idle · 2 STALE/suspected WEDGE · 3 dead (rc 4 is decided by the reader). */
	rc: 0 | 1 | 2 | 3;
	line: string;
}

/** Optional /proc/meminfo figures for the line (addendum 2026-11-15 21:20): omitted ⇒ no figures. */
export interface MemFigures {
	ramKib: number;
	swapFreeKib: number;
}

/** Human-readable kibibytes for the meminfo figures: GiB with one decimal, else integral MiB. */
export function humanMem(kib: number): string {
	return kib >= 1_048_576 ? `${(kib / 1_048_576).toFixed(1)}G` : `${Math.round(kib / 1024)}M`;
}

/**
 * Decide the operator's one-line status + rc. `processAlive` is the script's liveness probe:
 * the sidecar's pid running, or (no sidecar) a pi-like process resident in the repo. Judgement
 * order (a dead process is dead no matter what the document claims):
 *   ended ⇒ 3 · process gone ⇒ 3 · heartbeat strictly older than the bound ⇒ 2 · tool ⇒ 0 · else 1.
 * No sidecar: 3 when nothing matches, 1 (ALIVE, no liveness claim) when a process runs.
 * `mem` rides on EVERY line as ` ram=<..> swapfree=<..>` — a vanishing session is usually an
 * OOM story (the confirmed root cause, addendum 2026-11-15 21:20), and the vanished-pid dead
 * text names the oom-kill journal check. The bash twin (scripts/lib/liveness.sh) renders the
 * same line skeleton and the same rc table (it appends the resolved ` tty=` when the pid is
 * alive — a kernel fact a pure render cannot know); both are pinned by tests.
 */
export function renderStatus(opts: { state: LivenessState | null; now: number; staleMs: number; processAlive: boolean; mem?: MemFigures }): StatusVerdict {
	const { state, now, staleMs } = opts;
	const age = (ms: number): string => humanDur(Math.max(0, ms));
	const mem = opts.mem ? ` ram=${humanMem(opts.mem.ramKib)} swapfree=${humanMem(opts.mem.swapFreeKib)}` : "";
	if (state === null) {
		return opts.processAlive
			? { rc: 1, line: `ALIVE (no liveness sidecar; a matching process is running)${mem}` }
			: { rc: 3, line: `DEAD (no sidecar, no matching process)${mem}` };
	}
	if (state.state === "ended") return { rc: 3, line: `ENDED pid=${state.pid} (session ended)${mem}` };
	if (!opts.processAlive) {
		return { rc: 3, line: `DEAD pid=${state.pid} not running (state was ${state.state}) — likely OOM-killed; check: journalctl --since <start> | grep oom-kill${mem}` };
	}
	const hb = heartbeatOf(state);
	if (now - hb > staleMs) {
		const tool = state.tool ? ` tool=${state.tool.name} (${age(now - state.tool.startedAt)})` : "";
		return { rc: 2, line: `STALE (suspected WEDGE) pid=${state.pid} heartbeat ${age(now - hb)} ago${tool}${mem}` };
	}
	if (state.tool) {
		return { rc: 0, line: `LIVE pid=${state.pid} tool=${state.tool.name} (${age(now - state.tool.startedAt)}) heartbeat ${age(now - hb)} ago${mem}` };
	}
	return { rc: 1, line: `IDLE pid=${state.pid} heartbeat ${age(now - hb)} ago (no tool in flight)${mem}` };
}

function humanDur(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return h < 48 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d`;
}

// ---------------------------------------------------------------------------
// Bounded tool calls (spec §2) — the unwedge
// ---------------------------------------------------------------------------

export interface OkOutcome<T> { status: "ok"; value: T; }
export interface TimedOutOutcome { status: "timeout"; ms: number; }
export type TimeoutResult<T> = OkOutcome<T> | TimedOutOutcome;

/**
 * Race impl against a bound. On expiry RESOLVES (never rejects, never hangs) with
 * `{status:"timeout"}`; the underlying promise is deliberately ABANDONED — its side effects
 * (a spawned child, a pushed branch) continue, which is exactly what the timeout text tells
 * the operator to reconcile. `ms === null` = disabled: always await the impl. An impl that
 * REJECTS still propagates — the bound governs expiry only, not failures.
 */
export async function withTimeout<T>(impl: () => Promise<T>, ms: number | null): Promise<TimeoutResult<T>> {
	if (ms === null) return { status: "ok", value: await impl() };
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<TimeoutResult<T>>((resolve) => {
		timer = setTimeout(() => resolve({ status: "timeout", ms }), ms);
		timer.unref?.(); // the bound must not hold the event loop open on its own
	});
	try {
		return await Promise.race([
			impl().then((value) => ({ status: "ok" as const, value }) as TimeoutResult<T>),
			guard,
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Documented seam `MULTIPI_TOOL_TIMEOUT_MS` (integer ms; 0 = disabled).
 * Malformed or negative values fall back to the config minutes — never a bogus bound. */
export function resolveToolTimeoutMs(configMinutes: number, env: NodeJS.ProcessEnv = process.env): number | null {
	const raw = env.MULTIPI_TOOL_TIMEOUT_MS;
	if (raw !== undefined && raw !== "") {
		const n = Number(raw);
		if (Number.isInteger(n) && n >= 0) return n === 0 ? null : n;
	}
	return Math.round(configMinutes * 60000);
}

/** The exact reconciliation text a timed-out devloop.* tool resolves with (spec §2). Minute-scale
 * bounds render `<N>m` (the spec's pin); sub-minute seam bounds render `<N>s` so the line never
 * claims "0m". */
export function timeoutText(name: string, ms: number): string {
	const dur = ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`;
	return `${name} timed out after ${dur} — external state (branch, worktree, child) is UNTOUCHED; check scripts/multipi-status.sh and devloop.status, then retry or devloop.cancel <ticket>.`;
}
