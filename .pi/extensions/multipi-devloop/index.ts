import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeTools, evaluateSettle, formatEditedFile } from "./src/tools.ts";

const DEVLOOP_INSTRUCTIONS = `Manage tickets as a pipeline driven by GitHub issue labels: open -> dl/in-progress (a child is working) -> dl/in-review (PR open) -> dl/approved (review VERDICT: APPROVE) -> dl/gated (batch gate green) -> dl/merged (squash-merged; then close the issue). dl/blocked marks tickets needing a human decision. Workflow: dispatch role agents with devloop.dispatch (one ticket per implementer; independent tickets in parallel, up to the slot cap); when reports land, review, then gate ALL dl/approved branches together with devloop.gate (in a deliberate merge order), and merge the green train with devloop.merge (same order). Check progress any time with devloop.status. Stop only when no open ticket is startable (unblocked with closed or in-flight dependencies) — the stop-gate enforces this for you.`;

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
}

/** Re-exported for tests that drive the hooks without a live pi process. */
export { evaluateSettle, formatEditedFile, makeTools };
export type { ExtensionContext };
