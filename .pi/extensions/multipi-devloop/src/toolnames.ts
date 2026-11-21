// ---------------------------------------------------------------------------
// Provider tool-name grammar probe (ticket #107, generalizing #99).
//
// #99 renamed the control-plane tools off the dotted spellings because
// OpenAI-grammar providers reject a dot (observed: Kimi 400), and pinned the
// portability in a unit test. This module is the OPERATIONAL surface of that
// pin: one grammar, one provider notion and one report shape shared by
//
//   - scripts/doctor.sh (the offline one-shot: ok/PROBLEM lines, rc counting),
//   - extension/index.ts (the orchestrator's session_start seat: one non-
//     blocking warning line when the ACTIVE provider is grammar-strict),
//
// so doctor, the seat and the registration pin cannot drift apart on what a
// portable name is. Pure node (dependency rule): no pi imports, no processes,
// no network — the probe is a STATIC validation of names against the grammar,
// never a live API call.
// ---------------------------------------------------------------------------

/** The strictest common provider function-name grammar — the #99 pin's ruler: a
 * leading letter, then letters, digits, underscores and dashes. The dot (or any
 * other character outside the set) makes every grammar-validating provider
 * reject the WHOLE request. */
export const TOOL_NAME_GRAMMAR = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The registered control-plane tool names — the single source of truth (one
 * name per tool, no aliases). Underscored, not dotted: the OpenAI
 * function-name grammar (`^[A-Za-z][A-Za-z0-9_-]*$`) rejects a dot, so a dot
 * makes the whole request fail on every grammar-validating provider
 * (observed: Kimi 400). The `tests/unit/tools.test.ts` grammar pin keeps this
 * list portable; `extension/src/tools.ts` re-exports this const and uses it
 * verbatim in every `name:` field AND every `runBounded(...)` label (labels
 * are operator-visible log/reconciliation text and must agree with the
 * registered name). */
export const TOOL_NAMES = {
	dispatch: "devloop_dispatch",
	cancel: "devloop_cancel",
	pause: "devloop_pause",
	gate: "devloop_gate",
	merge: "devloop_merge",
	status: "devloop_status",
} as const;

/** The same list as a flat readonly array (what the probe iterates). */
export const REGISTERED_TOOL_NAMES: readonly string[] = Object.freeze(Object.values(TOOL_NAMES));

/** Provider ids known to validate tool names against the OpenAI-completions
 * grammar (aside from the openai-named family handled below): the observed
 * Kimi 400 and its sibling, Moonshot (Kimi is served by Moonshot AI). The list
 * is deliberately SHORT: an unlisted provider is "unknown" and permissive —
 * the warning seat stays silent there, while doctor's static check still
 * reports a bad name under ANY provider. A custom-named gateway speaking the
 * openai-completions shape: give it an openai-naming (or list its id here). */
const KNOWN_STRICT_PROVIDERS: readonly string[] = ["kimi", "moonshot"];

/** Whether a provider id is a known grammar-strict one (OpenAI-completions
 * API shape): anything OPENAI-NAMED (case-insensitive substring — the
 * family's wire format validates names) or a pinned known id. No id, or an
 * unlisted one, is NOT strict. */
export function isStrictGrammarProvider(provider: string | undefined): boolean {
	if (!provider) return false;
	const p = provider.toLowerCase();
	return p.includes("openai") || KNOWN_STRICT_PROVIDERS.includes(p);
}

/** The active provider id for the probe: `MULTIPI_PROVIDER` (the documented
 * operator seam — set when pi's own session env does not reach the surface)
 * wins over `PI_PROVIDER` (pi's shell-tool session env, "currently selected
 * model provider"). Empty means unset (the loop-wide convention). */
export function resolveProvider(env: NodeJS.ProcessEnv): string | undefined {
	return env.MULTIPI_PROVIDER || env.PI_PROVIDER || undefined;
}

/** The name list to probe: `MULTIPI_PROBE_TOOL_NAMES` (colon-separated) is
 * the diagnostic seam that WHAT-IF's a rename without shipping it — doctor
 * and the session_start seat both honour it, so a broken candidate trips at
 * startup on purpose. Unset or EMPTY means the registered list. */
export function toolNamesFromEnv(env: NodeJS.ProcessEnv): readonly string[] {
	const override = env.MULTIPI_PROBE_TOOL_NAMES;
	if (!override) return REGISTERED_TOOL_NAMES;
	return override.split(":");
}

export interface ToolNameProbeReport {
	/** The resolved provider id, or "unknown" when neither seam carried one. */
	provider: string;
	/** True when the provider is a known grammar-strict one (gates the warning
	 * seat; the doctor's static check runs regardless). */
	strict: boolean;
	/** The number of names probed. */
	count: number;
	/** The names OUTSIDE the grammar, in input order (duplicates kept — each
	 * registered slot is one potential 400). */
	bad: string[];
}

/** The probe: every name against the strictest common grammar. Provider-
 * agnostic on the FINDING (a bad name is a bad name under any provider),
 * provider-aware on the `strict` flag (the warning seat's gate). */
export function probeToolNameGrammar(names: readonly string[], provider: string | undefined): ToolNameProbeReport {
	return {
		provider: provider ?? "unknown",
		strict: isStrictGrammarProvider(provider),
		count: names.length,
		bad: names.filter((n) => !TOOL_NAME_GRAMMAR.test(n)),
	};
}
