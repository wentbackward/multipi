import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import { existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as childreg from "./src/childreg.ts";
import { registerChildProcessGuards } from "./src/child.ts";
import { GUARDED_ROLES, GUARD_REFUSAL, initGuard, callTouchesStore } from "./src/guard.ts";
import { createPolicyEnforcer } from "./src/policyhook.ts";
import { loadConfig, mainRoot, resolveState } from "./src/config.ts";
import * as liveness from "./src/liveness.ts";
import { makeTools, evaluateSettle, formatEditedFile } from "./src/tools.ts";
import { probeToolNameGrammar, resolveProvider, toolNamesFromEnv } from "./src/toolnames.ts";

const DEVLOOP_INSTRUCTIONS = `Manage tickets as a pipeline driven by GitHub issue labels: open -> dl/in-progress (a child is working) -> dl/in-review (PR open) -> dl/approved (review VERDICT: APPROVE) -> dl/gated (batch gate green) -> dl/merged (squash-merged; then close the issue). dl/blocked marks tickets needing a human decision. Workflow: dispatch role agents with devloop_dispatch (one ticket per implementer; independent tickets in parallel, up to the slot cap); when reports land, review, then gate ALL dl/approved branches together with devloop_gate (in a deliberate merge order), and merge the green train with devloop_merge (same order). Check progress any time with devloop_status. When the operator asks to pause or stop the loop, call devloop_pause (it interrupts all children, writes HANDOFF.md, and comments the tickets), then settle. On a fresh session, step 0 of the devloop skill reads a HANDOFF.md if present and re-dispatches the interrupted children. Stop only when no open ticket is startable (unblocked with closed or in-flight dependencies) — the stop-gate enforces this for you.`;

/**
 * multipi dev-loop extension.
 *
 * Orchestrator sessions register the devloop_* control-plane tools and hooks:
 *  - agent_before_settle: the three-way stop gate (red fast check / dirty tree / startable tickets).
 *  - tool_result: format-on-edit after successful write/edit calls.
 *  - tool_call: the permission-policy tripwire (spec 2026-11-09-multipi-permission-policy.md
 *    §4-L1): the pure evaluator, loaded ONCE at extension load (no hot reload), blocks denies
 *    with the tripwire text, asks with the §6 escalation directive, and audits to the state dir
 *    (session-start policy hash, one line per non-default verdict; see src/policyhook.ts).
 *  - session_start: records the session's effective policy hash into the audit log, and
 *    prepends the installed scripts/policy-shims dir to the session PATH (Layer-2, §4-L2):
 *    the model's git/gh calls then run through the policy wrapper. Children never register
 *    either — spawnPi spreads the process env, so a child's bash tools inherit the shims
 *    (and the loop scripts' /proc ancestry carries the §5 identity exemption into theirs).
 *  - session_start (the grammar probe, #107): one non-blocking warning line when the
 *    ACTIVE provider is grammar-strict (OpenAI-completions shape) and a registered
 *    control-plane tool name would be rejected — the 400-coming-at-dispatch seen
 *    BEFORE dispatch (permissive/unknown providers stay silent; doctor carries the
 *    static, provider-agnostic half).
 * Child sessions (MULTIPI_CHILD) register NOTHING — except a child of a guarded role with the
 * scenario store on, which registers the guard-only mode: exactly ONE block-capable tool_call
 * hook refusing calls that touch the store (spec §3). No tools, no stop-gate, no policy hook
 * either way (P2 scope: the policy hook is the ORCHESTRATOR's; children meet the policy in the
 * P3 shims, where it is meaningful).
 * The factory body stays allocation-light: no timers, no processes, no reads at load time —
 * everything is resolved lazily per invocation from the context's cwd. Two load-time readers
 * are the documented exceptions: the guard (it must know the store path BEFORE the first tool
 * call) and the policy enforcer (§8: the effective policy is session-frozen and hashed).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Watchdog script resolution (pinned: index.test.ts "resolveWatchScript"): the repo's
 * VENDORED copy wins (an installed loop versions its scripts with the target); otherwise
 * the module-relative fallback serves the source tree (`extension/index.ts` →
 * `../scripts`). The repo PARENT is deliberately NOT probed: a bare `../../` from the
 * source tree resolves to the parent's tree, and a stray `scripts/multipi-watch.sh` out
 * there must never win over a missing vendored copy.
 */
export function resolveWatchScript(root: string): string | undefined {
	return [
		path.join(root, "scripts", "multipi-watch.sh"),
		path.join(HERE, "..", "scripts", "multipi-watch.sh"),
	].find((c) => existsSync(c));
}

export default function devloopExtension(pi: ExtensionAPI): void {
	// A one-shot role child (spawnPi sets MULTIPI_CHILD) must not load the loop: registering the
	// tools would let a child drive the loop itself, and the stop-gate hook would keep a child
	// that delivered its report from ever settling (it is not the orchestrator).
	if (process.env.MULTIPI_CHILD) {
		const role = process.env.MULTIPI_CHILD_ROLE;
		if (role && (GUARDED_ROLES as readonly string[]).includes(role)) registerStoreGuard(pi, process.cwd());
		return;
	}
	// When this orchestrator exits, no spawned child tree survives (best-effort; see child.ts).
	registerChildProcessGuards();
	registerPolicyShimPath(pi);
	for (const tool of makeTools(DEVLOOP_INSTRUCTIONS)) {
		try {
			pi.registerTool(tool);
		} catch (e) {
			console.error(`devloop: failed to register ${tool.name}: ${(e as Error).message}`);
		}
	}

	pi.on("agent_before_settle", async (_event, ctx: ExtensionContext) => {
		const decision = await evaluateSettle(ctx.cwd);
		return decision ?? undefined;
	});

	pi.on("tool_result", async (event, _ctx) => {
		const name = (event as { toolName?: string }).toolName ?? "";
		if (name !== "write" && name !== "edit") return;
		if (event.isError) return;
		const input = (event.input ?? {}) as Record<string, unknown>;
		const filePath = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : null;
		if (!filePath) return;
		try {
			const { cwd } = _ctx;
			await formatEditedFile(cwd, filePath);
		} catch (e) {
			// Formatting must never wedge the agent: report and move on.
			console.error(`devloop format-on-edit error: ${(e as Error).message}`);
		}
	});

	registerAgentVisibility(pi);
	registerPolicyEnforcer(pi);
	registerLiveness(pi);
	registerToolNameProbe(pi);
}

// ---------------------------------------------------------------------------
// Agent visibility: a live bar under the editor (one line per running child)
// and /devloop-agents to browse children + their event rings.
// Data comes from the in-process registry (childreg.ts) — children run in this
// process, so no polling of the state file is needed.
// ---------------------------------------------------------------------------

const WIDGET_KEY = "devloop-children";

let uiCtx: ExtensionContext | undefined;
let barTui: TUI | undefined;
let widgetLive = false;
let ticker: ReturnType<typeof setInterval> | undefined;

class ChildBar implements Component {
	render(width: number): string[] {
		return childreg.renderChildBar(childreg.liveChildren(), Date.now(), width);
	}
	invalidate(): void {}
}

class AgentsPanel implements Component {
	private sel = 0;
	/** events hidden below the window (0 = newest; larger = older) */
	private scroll = 0;
	private tui: TUI;
	private theme: Theme;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		const kids = childreg.liveChildren();
		if (kids.length === 0) return;
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.sel = (this.sel + kids.length - 1) % kids.length;
			this.scroll = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.sel = (this.sel + 1) % kids.length;
			this.scroll = 0;
			this.tui.requestRender();
			return;
		}
		const maxScroll = Math.max(0, (kids[this.sel]?.events.length ?? 0) - 1);
		if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
			this.scroll = Math.min(maxScroll, this.scroll + 8);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "space")) {
			this.scroll = Math.max(0, this.scroll - 8);
			this.tui.requestRender();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = childreg.renderAgentsPanel(childreg.liveChildren(), this.sel, this.scroll, width, Date.now());
		// Re-color the selection marker and status dots via the theme.
		return lines.map((l, i) => {
			if (l.startsWith("▶")) return this.theme.fg("accent", "▶") + l.slice(1);
			if (i > 0 && i <= childreg.liveChildren().length && (l.startsWith(" ● ") || l.startsWith(" ○ "))) {
				const running = l[2] === "●";
				const dot = this.theme.fg(running ? "success" : "dim", l.slice(0, 2)) + l.slice(2);
				return dot;
			}
			return l;
		});
	}
}

function syncWidget(): void {
	const ctx = uiCtx;
	if (!ctx?.hasUI) return;
	const running = childreg.runningChildren().length > 0;
	if (running && !widgetLive) {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui: TUI) => {
				barTui = tui;
				return new ChildBar();
			},
			{ placement: "belowEditor" },
		);
		widgetLive = true;
	} else if (!running && widgetLive) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		widgetLive = false;
	}
}

function ensureTicker(): void {
	if (ticker) return;
	ticker = setInterval(() => {
		syncWidget();
		if (childreg.runningChildren().length > 0) barTui?.requestRender();
	}, 1000);
	ticker.unref?.();
}

/**
 * The Layer-2 shim PATH (permission-policy spec §4-L2, ticket #41): ONE string operation at
 * session_start — prepend <main root>/scripts/policy-shims to this process's PATH so every
 * bash tool of the session resolves git/gh through the policy wrapper. Absent dir ⇒ the loop
 * is not installed here ⇒ nothing to arm (and the shims are inert without permissions.json
 * anyway — the installer, not this hook, decides where they live). Idempotent: a restarted
 * session never prepends twice — and the comparison is CANONICAL (round-13 should-fix):
 * a symlinked main worktree spells the same shims dir differently per session, so both
 * sides resolve through symlinks before the contains-check (exact string compare doubled
 * the prepend). Nonexistent PATH entries cannot resolve; they fall back to their
 * resolved/spelled form (safeCanon does not resolve) and simply never match.
 */
const safeCanon = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};

function registerPolicyShimPath(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		try {
			const shims = path.join(mainRoot(ctx.cwd) ?? ctx.cwd, "scripts", "policy-shims");
			if (!existsSync(shims)) return;
			const canon = safeCanon(shims);
			const cur = process.env.PATH ?? "";
			const alreadyArmed = cur.split(path.delimiter).some((entry) => entry && safeCanon(path.resolve(entry)) === canon);
			if (alreadyArmed) return;
			process.env.PATH = `${shims}${path.delimiter}${cur}`;
		} catch {
			// PATH bookkeeping must never block the session.
		}
	});
}

/**
 * Guard-only child mode (spec §3): exactly one block-capable tool_call hook that refuses calls
 * naming the scenario store. The store path comes from the child's own committed .devloop.json
 * (no env seam carries it); an unparseable config or unresolvable store path fails closed —
 * every guarded call gets the generic refusal.
 */
function registerStoreGuard(pi: ExtensionAPI, childCwd: string): void {
	const g = initGuard(childCwd);
	if (!g.enabled) return; // store off ⇒ register nothing, ever
	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		const name = (event as { toolName?: string }).toolName ?? "";
		const input = ((event as { input?: unknown }).input ?? {}) as Record<string, unknown>;
		// Fail closed: an unknowable store dir refuses EVERY guarded call.
		if (!g.storeDir || callTouchesStore(g.storeDir, ctx.cwd, name, input)) {
			return { block: true, reason: GUARD_REFUSAL };
		}
	});
}

/**
 * Provider tool-name grammar probe (ticket #107, the #99 pin as an operational
 * surface): ONE non-blocking line at session_start when the active provider is
 * grammar-strict (OpenAI-completions API shape) and a registered control-plane
 * tool name falls outside the strictest common grammar — the operator sees the
 * 400-coming-at-dispatch BEFORE dispatch, not with it. Permissive or UNKNOWN
 * providers stay silent (there the failure is hypothetical; scripts/doctor.sh
 * carries the static, provider-agnostic check for every provider). The name
 * list honours the documented MULTIPI_PROBE_TOOL_NAMES diagnostic seam (empty =
 * unset) so a candidate rename trips at startup on purpose, and the provider
 * comes from MULTIPI_PROVIDER, falling back to pi's PI_PROVIDER session env.
 * Offline: a static validation, never a live API call.
 */
function registerToolNameProbe(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		try {
			const report = probeToolNameGrammar(toolNamesFromEnv(process.env), resolveProvider(process.env));
			if (!report.strict || report.bad.length === 0) return;
			console.error(`devloop: provider ${report.provider} is grammar-strict and will reject tool name ${report.bad.map((n) => JSON.stringify(n)).join(", ")} at the first API call (grammar ^[A-Za-z][A-Za-z0-9_-]*$) — dispatch is unusable until the names comply`);
		} catch {
			// Advisory surface: the probe must never block a session start.
		}
	});
}

/**
 * P2 (permission-policy spec §4-L1/§8): the orchestrator's policy hook. The policy loads ONCE
 * at extension load from the session's working dir (session-frozen: governance edits ride the
 * ordinary pipeline and become visible on the NEXT session — self-loosening meanwhile shows up
 * as POLICY DRIFT noise on every non-default verdict). Absent policy ⇒ hook inactive (loud
 * one-time warning); broken policy ⇒ active, denying everything (fail closed). Children never
 * reach this seat (the MULTIPI_CHILD branch above returns first).
 */
function registerPolicyEnforcer(pi: ExtensionAPI): void {
	const enforcer = createPolicyEnforcer({ root: process.cwd(), actor: "orchestrator" });
	const sessionIdOf = (ctx: ExtensionContext): string | null => {
		try {
			return ctx.sessionManager?.getSessionId?.() ?? null;
		} catch {
			return null;
		}
	};
	pi.on("session_start", async (_e, ctx: ExtensionContext) => {
		enforcer.noteSession(sessionIdOf(ctx));
	});
	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		if (!enforcer.active) return; // absent policy: everything passes (the load-time warning said so)
		const name = (event as { toolName?: string }).toolName ?? "";
		const input = ((event as { input?: unknown }).input ?? {}) as Record<string, unknown>;
		return enforcer.onToolCall({ toolName: name, input, sessionId: sessionIdOf(ctx) }) ?? undefined;
	});
}

// ---------------------------------------------------------------------------
// Orchestrator liveness (spec 2026-11-15 §1): the sidecar at <state dir>/orchestrator-state.json, maintained from extension events. The pure half lives in
// src/liveness.ts (dependency rule); this seat is the ONLY pi-typed maintainer.
// Every persistence call is fail-soft: liveness bookkeeping must never break the session.
// ---------------------------------------------------------------------------

/** The heartbeat tick interval — proof the event loop lives even with zero LLM traffic (spec §1). */
const LIVENESS_TICK_MS = 15000;
/** High-frequency event writes are throttled to ≤1 per this window (spec §1). */
const LIVENESS_EVENT_WRITE_MS = 1000;

/**
 * Explicit test seams (index.test.ts, #65 round-4: one named object instead of loose
 * mutable module-level exports — production reads none of it):
 */
export const testSeams = {
	/** persist() ATTEMPTS — persist is the extension's only sidecar writer, so one attempt
	 * is at most one fs write. The write-throttle pin asserts on this count (and the
	 * resulting content), not on mtime: sub-second writes alias under filesystem mtime
	 * granularity, the count does not. */
	livenessWriteAttempts: 0,
	/** Watch-script targets attempted by spawnWatchDaemon — the TUI-only auto-start pin
	 * asserts the BRANCH (tui spawns, rpc never does) through this list. */
	watchSpawns: [] as string[],
};

function registerLiveness(pi: ExtensionAPI): void {
	let dir: string | undefined;
	let state: liveness.LivenessState | undefined;
	let seq = 0;
	let lastEventWrite = 0;
	let timer: ReturnType<typeof setInterval> | undefined;

	const persist = (): void => {
		if (!dir || !state) return;
		testSeams.livenessWriteAttempts += 1;
		try {
			// Watermark-safe publish (src/liveness.ts, review round-1 item 4): re-reads the
			// sidecar, adopts a HIGHER externally-raised lastWakeSeq (the watchdog's bump),
			// and retries ≤ 3 times on a stale read. On exhaustion it writes nothing —
			// the give-up is bounded: a lost bump costs one duplicate wake, capped by the
			// watchdog's 3600 s wall axis.
			if (!liveness.publishState(dir, state)) {
				console.error("devloop liveness: sidecar publish abandoned after 3 stale reads (bounded; the watchdog's 3600 s wall axis caps damage)");
			}
		} catch {
			// Liveness is a convenience surface; a write failure is never a session failure.
		}
	};

	const sessionIdOf = (ctx: ExtensionContext): string => {
		try {
			return ctx.sessionManager?.getSessionId?.() ?? "";
		} catch {
			return "";
		}
	};

	/**
	 * Detached, idempotent watchdog auto-start (spec §4): the pidfile lock inside the script
	 * makes repeats across sessions a no-op. TUI sessions only — the watchdog's injection
	 * target is the operator's terminal (headless sessions have no TTY to wake; part B's tool
	 * bound still covers them, and `multipi-watch.sh --daemon` can be started by hand).
	 */
	const spawnWatchDaemon = (cwd: string): void => {
		try {
			const root = mainRoot(cwd) ?? cwd;
			const target = resolveWatchScript(root);
			if (!target) return;
			testSeams.watchSpawns.push(target);
			const child = spawn("bash", [target, "--daemon"], { detached: true, stdio: "ignore" });
			child.unref();
		} catch {
			// Spawning the net must never block or break the session start.
		}
	};

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		try {
			const cwd = ctx.cwd;
			// The loop not installed here (no .devloop.json) ⇒ no sidecar, nothing armed.
			dir = loadConfig(cwd) ? resolveState(cwd) : undefined;
			if (!dir) return;
			const prev = liveness.loadState(dir);
			// Continue the sequence across a restart (lastWakeSeq is the watchdog's persistent watermark).
			seq = Math.max(prev?.tool?.seq ?? 0, prev?.lastWakeSeq ?? 0);
			const now = Date.now();
			state = {
				schema: 1,
				sessionId: sessionIdOf(ctx),
				pid: process.pid,
				state: "active",
				tool: null,
				lastEventAt: now,
				lastTickAt: now,
				lastWakeSeq: prev?.lastWakeSeq ?? -1,
			};
			lastEventWrite = now;
			persist();
			if (!timer) {
				timer = setInterval(() => {
					if (state) {
						state.lastTickAt = Date.now();
						persist();
					}
				}, LIVENESS_TICK_MS);
				timer.unref?.();
			}
			if (ctx.mode === "tui") spawnWatchDaemon(cwd);
		} catch {
			// See persist(): never block the session start.
		}
	});

	pi.on("tool_execution_start", (event: unknown) => {
		if (!state) return;
		const name = (event as { toolName?: unknown }).toolName;
		const now = Date.now();
		seq += 1;
		state.tool = { name: typeof name === "string" ? name : "unknown", startedAt: now, seq };
		state.state = "active";
		state.lastEventAt = now;
		lastEventWrite = now;
		persist();
	});

	pi.on("tool_execution_end", () => {
		if (!state || !state.tool) return;
		state.tool = null;
		state.state = "idle";
		state.lastEventAt = Date.now();
		lastEventWrite = Date.now();
		persist();
	});

	pi.on("message_update", () => {
		if (!state) return;
		const now = Date.now();
		state.lastEventAt = now; // in-memory always; the WRITE is throttled to ≤1/s
		if (now - lastEventWrite >= LIVENESS_EVENT_WRITE_MS) {
			lastEventWrite = now;
			persist();
		}
	});

	pi.on("session_shutdown", () => {
		try {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			if (state) {
				state.state = "ended";
				state.lastTickAt = Date.now();
				persist();
			}
			// TERMINAL: pi delivers a trailing tool_execution_end (and possibly more
			// events) AFTER session_shutdown — the exact shutdown-mid-tool incident of
			// this ticket. Nulling the in-memory doc makes every later event a no-op,
			// so the "ended" tombstone is never rewritten back to idle/active. The
			// next session_start re-seeds a fresh doc (a new session is a new doc).
			state = undefined;
		} catch {
			// Best-effort: the shutdown path must not throw.
		}
	});
}

function registerAgentVisibility(pi: ExtensionAPI): void {
	childreg.onChange(() => {
		syncWidget();
		ensureTicker();
		barTui?.requestRender();
	});
	const attach = (_e: unknown, ctx: ExtensionContext): void => {
		if (ctx.hasUI) {
			uiCtx = ctx;
			syncWidget();
		}
	};
	pi.on("session_start", attach);
	pi.on("session_tree", attach);
	pi.registerCommand("devloop-agents", {
		description: "Browse devloop children (running + recent) and their live output",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/devloop-agents requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new AgentsPanel(tui, theme, () => done()));
		},
	});
}

/** Re-exported for tests that drive the hooks without a live pi process. */
export { evaluateSettle, formatEditedFile, makeTools };
export type { ExtensionContext };
export { renderAgentsPanel, renderChildBar } from "./src/childreg.ts";
