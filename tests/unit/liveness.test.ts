import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { tmpdir } from "node:os";
import {
	heartbeatOf,
	loadState,
	publishState,
	renderStatus,
	resolveToolTimeoutMs,
	sidecarPath,
	timeoutText,
	withTimeout,
	writeState,
	type LivenessState,
} from "../../extension/src/liveness.ts";

const base = (over: Partial<LivenessState> = {}): LivenessState => ({
	schema: 1,
	sessionId: "sess-1",
	pid: 4242,
	state: "active",
	tool: null,
	lastEventAt: 1_000_000,
	lastTickAt: 1_000_000,
	lastWakeSeq: -1,
	...over,
});

// --- sidecar store (spec §1) --------------------------------------------------

test("sidecarPath: the sidecar lives in the state dir as orchestrator-state.json", () => {
	assert.equal(sidecarPath("/home/op/.multipi/demo"), path.join("/home/op/.multipi/demo", "orchestrator-state.json"));
});

test("writeState/loadState round-trip the full spec §1 shape", () => {
	const d = mkdtemp();
	try {
		const s = base({ tool: { name: "devloop.gate", startedAt: 176, seq: 7 }, state: "idle", lastWakeSeq: 3 });
		writeState(d, s);
		assert.deepEqual(loadState(d), s, "every field survives the round trip");
	} finally { rmSync(d, { recursive: true, force: true }); }
});

test("loadState: a missing sidecar reads as null (not an exception)", () => {
	const d = mkdtemp();
	try { assert.equal(loadState(d), null); } finally { rmSync(d, { recursive: true, force: true }); }
});

test("loadState: a corrupt sidecar reads as null (fail soft, never a torn read)", () => {
	const d = mkdtemp();
	try {
		writeFileSync(sidecarPath(d), '{"schema":1, "sess');
		assert.equal(loadState(d), null);
	} finally { rmSync(d, { recursive: true, force: true }); }
});

// --- watermark-safe publish (review round-1 item 4: the two-writer lost-update window) ---

test("publishState: publishes the full document over nothing (missing sidecar ⇒ fresh doc)", () => {
	const d = mkdtemp();
	try {
		const s = base({ lastTickAt: 5_000_000 });
		assert.equal(publishState(d, s), true, "a publish without an existing file succeeds");
		assert.deepEqual(loadState(d), s);
	} finally { rmSync(d, { recursive: true, force: true }); }
});


test("publishState: an externally raised watermark is adopted, never regressed, and the new document still lands", () => {
	const d = mkdtemp();
	try {
		// The watchdog raised the watermark on the sidecar since our last write.
		writeState(d, base({ lastWakeSeq: 5, lastTickAt: 1_500_000 }));
		const ours = base({ lastWakeSeq: -1, lastTickAt: 2_000_000 });
		assert.equal(publishState(d, ours), true);
		assert.equal(loadState(d)!.lastWakeSeq, 5, "the higher external watermark survived the publish");
		assert.equal(loadState(d)!.lastTickAt, 2_000_000, "our new document still landed");

		// A lower-watermark publish over a higher file never downgrades either.
		assert.equal(publishState(d, base({ lastWakeSeq: 1, lastTickAt: 3_000_000 })), true);
		assert.equal(loadState(d)!.lastWakeSeq, 5, "no regression to our (lower) watermark");
		assert.equal(loadState(d)!.lastTickAt, 3_000_000);

		// Symmetric: our watermark higher than the file's is kept (max, not min).
		assert.equal(publishState(d, base({ lastWakeSeq: 9, lastTickAt: 4_000_000 })), true);
		assert.equal(loadState(d)!.lastWakeSeq, 9);
	} finally { rmSync(d, { recursive: true, force: true }); }
});

test("writeState is atomic: concurrent writers never publish a torn document", async () => {
	const d = mkdtemp();
	try {
		writeState(d, base({ sessionId: "seed" }));
		// Two worker threads hammer the sidecar with distinct payloads; after every write
		// the WRITER re-reads and validates the shape. A torn (mid-write) document is only
		// possible if the publish is an in-place truncate; a rename publishes complete docs.
		// The worker body lives in liveness-worker.ts — a Worker on the TEST file re-runs every
		// top-level test() (and re-spawns workers: fork bomb).
		const here = new URL("./liveness-worker.ts", import.meta.url);
		const spawn = (which: string) =>
			new Worker(here, { workerData: { d, which }, execArgv: ["--experimental-strip-types"] } as ConstructorParameters<typeof Worker>[1]);
		await Promise.all([waitWorker(spawn("A")), waitWorker(spawn("B"))]);
		assert.equal(existsSync(path.join(d, ".reader-A-ok")), true, "writer A validated every read");
		assert.equal(existsSync(path.join(d, ".reader-B-ok")), true, "writer B validated every read");
		// No abandoned tmp files: the writer cleans up after rename.
		const leftovers = readdirSync(d).filter((f) => f.includes(".tmp."));
		assert.deepEqual(leftovers, [], "no tmp residue after the writes settled");
	} finally { rmSync(d, { recursive: true, force: true }); }
});

test("heartbeatOf: the heartbeat is the newer of event activity and the tick", () => {
	assert.equal(heartbeatOf(base({ lastEventAt: 5, lastTickAt: 9 })), 9);
	assert.equal(heartbeatOf(base({ lastEventAt: 9, lastTickAt: 5 })), 9);
	assert.equal(heartbeatOf(base({ lastEventAt: 7, lastTickAt: 7 })), 7);
});

// --- renderStatus: the PINNED rc table of spec §1a ----------------------------

const render = (o: { state: LivenessState | null; now: number; staleMs: number; pidAlive: boolean }) =>
	renderStatus({ state: o.state, now: o.now, staleMs: o.staleMs, processAlive: o.pidAlive });

test("renderStatus rc 0: live — tool in flight, fresh heartbeat, process alive", () => {
	const v = render({ state: base({ tool: { name: "devloop.gate", startedAt: 999_000, seq: 2 } }), now: 1_000_000, staleMs: 120_000, pidAlive: true });
	assert.equal(v.rc, 0);
	assert.match(v.line, /LIVE/);
	assert.match(v.line, /devloop\.gate/);
});

test("renderStatus rc 1: alive but idle (no in-flight tool, fresh heartbeat)", () => {
	const v = render({ state: base({ state: "idle" }), now: 1_000_000, staleMs: 120_000, pidAlive: true });
	assert.equal(v.rc, 1);
	assert.match(v.line, /IDLE/);
});

test("renderStatus rc 2: heartbeat older than the stale bound ⇒ STALE / suspected WEDGE (state not ended)", () => {
	for (const state of ["active", "idle"] as const) {
		const v = render({ state: base({ state, lastEventAt: 0, lastTickAt: 0 }), now: 1_000_000, staleMs: 120_000, pidAlive: true });
		assert.equal(v.rc, 2, `state=${state}`);
		assert.match(v.line, /STALE/);
		assert.match(v.line, /wedge/i);
	}
});

test("renderStatus rc 2 boundary: heartbeat age exactly equal to the bound is still live (older = strictly greater)", () => {
	const v = render({ state: base({ lastEventAt: 880_000, lastTickAt: 880_000 }), now: 1_000_000, staleMs: 120_000, pidAlive: true });
	assert.equal(v.rc, 1, "age == bound is not yet stale");
});

test("renderStatus rc 3: state ended is dead even with a fresh heartbeat", () => {
	const v = render({ state: base({ state: "ended" }), now: 1_000_000, staleMs: 120_000, pidAlive: true });
	assert.equal(v.rc, 3);
	assert.match(v.line, /ENDED/i);
});

test("renderStatus rc 3: the sidecar process is gone ⇒ dead, even when state is active and the heartbeat looks fresh", () => {
	const v = render({ state: base({ tool: { name: "devloop.gate", startedAt: 999_000, seq: 1 } }), now: 1_000_000, staleMs: 120_000, pidAlive: false });
	assert.equal(v.rc, 3);
	assert.match(v.line, /DEAD/i);
});

test("renderStatus rc 3: no sidecar and no matching process", () => {
	const v = render({ state: null, now: 1_000_000, staleMs: 120_000, pidAlive: false });
	assert.equal(v.rc, 3);
});

test("renderStatus rc 1: no sidecar but a matching process runs (alive, no liveness claim possible)", () => {
	const v = render({ state: null, now: 1_000_000, staleMs: 120_000, pidAlive: true });
	assert.equal(v.rc, 1);
	assert.match(v.line, /no liveness sidecar/i);
});

// Addendum 2026-11-15 21:20 — OOM root cause surfaced on the line -----------------------------

test("renderStatus: meminfo figures (from /proc/meminfo via MULTIPI_STATUS_MEMINFO) ride on the line, human-readable", () => {
	const v = renderStatus({ state: base({ tool: { name: "devloop.gate", startedAt: 999_000, seq: 2 } }), now: 1_000_000, staleMs: 120_000, processAlive: true, mem: { ramKib: 1_048_576, swapFreeKib: 524_288 } });
	assert.match(v.line, /ram=1\.0G swapfree=512M/, "GiB renders with one decimal, MiB integral");
	const idle = renderStatus({ state: base({ state: "idle" }), now: 1_000_000, staleMs: 120_000, processAlive: true, mem: { ramKib: 153_600, swapFreeKib: 0 } });
	assert.match(idle.line, /ram=150M swapfree=0M/, "sub-GiB and zero swap stay in MiB");
	const noMem = render({ state: base({ state: "idle" }), now: 1_000_000, staleMs: 120_000, pidAlive: true });
	assert.doesNotMatch(noMem.line, /ram=/, "an unreadable meminfo degrades to no figures, never a failure");
});

test("renderStatus rc 3: a vanished pid's dead text names the oom-kill journal check (confirmed root cause)", () => {
	const v = render({ state: base({ tool: { name: "devloop.gate", startedAt: 999_000, seq: 1 } }), now: 1_000_000, staleMs: 120_000, pidAlive: false });
	assert.equal(v.rc, 3);
	assert.match(v.line, /journalctl --since <start> \| grep oom-kill/, "the likely cause is named with the exact check");
});

// --- withTimeout + the tool-timeout seams (spec §2) ---------------------------

test("resolveToolTimeoutMs: absent env ⇒ the config minutes (default 45 ⇒ 2700000 ms)", () => {
	assert.equal(resolveToolTimeoutMs(45, {}), 2_700_000);
	assert.equal(resolveToolTimeoutMs(10, {}), 600_000);
});

test("resolveToolTimeoutMs: MULTIPI_TOOL_TIMEOUT_MS integer ms overrides; 0 disables", () => {
	assert.equal(resolveToolTimeoutMs(45, { MULTIPI_TOOL_TIMEOUT_MS: "5" }), 5);
	assert.equal(resolveToolTimeoutMs(45, { MULTIPI_TOOL_TIMEOUT_MS: "0" }), null);
	assert.equal(resolveToolTimeoutMs(10, { MULTIPI_TOOL_TIMEOUT_MS: "12345" }), 12_345);
});

test("resolveToolTimeoutMs: a malformed env value falls back to the config (never a bogus bound)", () => {
	assert.equal(resolveToolTimeoutMs(45, { MULTIPI_TOOL_TIMEOUT_MS: "soon" }), 2_700_000);
	assert.equal(resolveToolTimeoutMs(45, { MULTIPI_TOOL_TIMEOUT_MS: "-5" }), 2_700_000);
	assert.equal(resolveToolTimeoutMs(45, { MULTIPI_TOOL_TIMEOUT_MS: "" }), 2_700_000);
	assert.equal(resolveToolTimeoutMs(45, {}), 2_700_000);
});

test("withTimeout: impl finishing before the bound resolves with the impl's value", async () => {
	const r = await withTimeout(() => new Promise<string>((res) => setTimeout(() => res("done"), 5)), 500);
	assert.deepEqual(r, { status: "ok", value: "done" });
});

test("withTimeout: on expiry it RESOLVES WITH A TIMEOUT OUTCOME — never rejects, never hangs (5 ms drive via the seam)", async () => {
	const ms = resolveToolTimeoutMs(45, { MULTIPI_TOOL_TIMEOUT_MS: "5" })!;
	const start = Date.now();
	const never = new Promise<string>(() => { /* abandoned on purpose */ });
	const r = await withTimeout(() => never, ms);
	assert.equal(r.status, "timeout");
	assert.equal((r as { ms?: number }).ms, 5);
	assert.ok(Date.now() - start < 2_000, "returned promptly at the bound, not forever");
});

test("withTimeout: disabled (null ms) always awaits the impl, however long it takes", async () => {
	const r = await withTimeout(() => new Promise<string>((res) => setTimeout(() => res("late"), 20)), resolveToolTimeoutMs(45, { MULTIPI_TOOL_TIMEOUT_MS: "0" }));
	assert.deepEqual(r, { status: "ok", value: "late" });
});

test("withTimeout: an impl rejection still propagates (the timeout only bounds expiry)", async () => {
	await assert.rejects(
		withTimeout(async () => { throw new Error("boom"); }, 500),
		/boom/,
	);
});

test("timeoutText: the exact reconciliation text the spec pins", () => {
	assert.equal(
		timeoutText("devloop.gate", 2_700_000),
		"devloop.gate timed out after 45m — external state (branch, worktree, child) is UNTOUCHED; check scripts/multipi-status.sh and devloop.status, then retry or devloop.cancel <ticket>.",
	);
});

// --- shared helpers -----------------------------------------------------------

function mkdtemp(): string {
	return mkdtempSync(path.join(tmpdir(), `multipi-liveness-${process.pid}-${Math.random().toString(36).slice(2)}`));
}

function waitWorker(w: Worker): Promise<void> {
	return new Promise((res, rej) => { w.on("exit", (c) => (c === 0 ? res() : rej(new Error(`worker exit ${c}`)))); w.on("error", rej); });
}
