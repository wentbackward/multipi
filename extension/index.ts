import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import * as childreg from "./src/childreg.ts";
import { makeTools, evaluateSettle, formatEditedFile } from "./src/tools.ts";

const DEVLOOP_INSTRUCTIONS = `Manage tickets as a pipeline driven by GitHub issue labels: open -> dl/in-progress (a child is working) -> dl/in-review (PR open) -> dl/approved (review VERDICT: APPROVE) -> dl/gated (batch gate green) -> dl/merged (squash-merged; then close the issue). dl/blocked marks tickets needing a human decision. Workflow: dispatch role agents with devloop.dispatch (one ticket per implementer; independent tickets in parallel, up to the slot cap); when reports land, review, then gate ALL dl/approved branches together with devloop.gate (in a deliberate merge order), and merge the green train with devloop.merge (same order). Check progress any time with devloop.status. When the operator asks to pause or stop the loop, call devloop.pause (it interrupts all children, writes HANDOFF.md, and comments the tickets), then settle. On a fresh session, step 0 of the devloop skill reads a HANDOFF.md if present and re-dispatches the interrupted children. Stop only when no open ticket is startable (unblocked with closed or in-flight dependencies) — the stop-gate enforces this for you.`;

/**
 * multipi dev-loop extension.
 *
 * Registers the devloop.* control-plane tools and two hooks:
 *  - agent_before_settle: the three-way stop gate (red fast check / dirty tree / startable tickets).
 *  - tool_result: format-on-edit after successful write/edit calls.
 * The factory body stays allocation-light: no timers, no processes, no reads at load time —
 * everything is resolved lazily per invocation from the context's cwd.
 */
export default function devloopExtension(pi: ExtensionAPI): void {
	// A one-shot role child (spawnPi sets MULTIPI_CHILD) must not load the loop: registering the
	// tools would let a child drive the loop itself, and the stop-gate hook would keep a child
	// that delivered its report from ever settling (it is not the orchestrator).
	if (process.env.MULTIPI_CHILD) return;
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
