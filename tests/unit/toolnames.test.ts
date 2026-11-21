// Provider tool-name grammar probe (ticket #107, generalizing #99): the PURE half
// shared by both operational surfaces — scripts/doctor.sh's one-shot and the
// orchestrator's session_start seat (extension/index.ts). One grammar, one
// provider notion, one report shape: the doctor, the seat and the #99
// registration pin must never drift apart on what a portable name is.
// Offline: no process, no network, no live API call.
import assert from "node:assert/strict";
import test from "node:test";
import {
	TOOL_NAME_GRAMMAR,
	TOOL_NAMES,
	REGISTERED_TOOL_NAMES,
	isStrictGrammarProvider,
	resolveProvider,
	toolNamesFromEnv,
	probeToolNameGrammar,
} from "../../extension/src/toolnames.ts";

// --- the grammar itself (the #99 pin, now the probe's ruler) --------------------

test("grammar: letters, underscores, digits and dashes after a leading letter pass", () => {
	for (const n of ["devloop_dispatch", "a", "abc-1_x", "DevLoop_Merge2", "x-y_z9"]) {
		assert.ok(TOOL_NAME_GRAMMAR.test(n), `${JSON.stringify(n)} must pass the strictest common provider grammar`);
	}
});

test("grammar: the #99 failure modes fail — dot, leading digit, leading underscore, leading dash, empty, non-ascii", () => {
	for (const n of ["devloop.dispatch", "9lives", "_hidden", "-dash", "", "café"]) {
		assert.ok(!TOOL_NAME_GRAMMAR.test(n), `${JSON.stringify(n)} must be REJECTED by the strictest common provider grammar`);
	}
});

// --- the name list is the extension's single source, not a second copy -----------

test("registered names: exactly the six control-plane tools, all inside the grammar", () => {
	assert.deepEqual(Object.values(TOOL_NAMES), [
		"devloop_dispatch",
		"devloop_cancel",
		"devloop_pause",
		"devloop_gate",
		"devloop_merge",
		"devloop_status",
	]);
	assert.equal(REGISTERED_TOOL_NAMES.length, 6, "one name per control-plane tool");
	for (const n of REGISTERED_TOOL_NAMES) {
		assert.ok(TOOL_NAME_GRAMMAR.test(n), `registered name ${JSON.stringify(n)} drifted out of the portable character set`);
	}
});

// --- provider resolution and the strict-grammar classification -------------------

test("strict classification: OpenAI-completions-shaped providers are strict, others and the unknown are not", () => {
	// The observed evidence (Kimi 400, ticket #99) plus the family that speaks the
	// same openai-completions API shape: anything OPENAI-NAMED is treated as strict
	// (a custom-named gateway is the operator's MULTIPI_PROVIDER spelling to give).
	for (const p of ["openai", "OpenAI", "openai-completions", "openai-compatible", "OpenAI-Gateway", "kimi", "KIMI", "moonshot"]) {
		assert.ok(isStrictGrammarProvider(p), `${JSON.stringify(p)} is a known strict-grammar provider`);
	}
	for (const p of ["anthropic", "claude", "grok", "gemini", "ollama-local", ""]) {
		assert.ok(!isStrictGrammarProvider(p), `${JSON.stringify(p)} is NOT classified strict (silence on the warning seat)`);
	}
	assert.ok(!isStrictGrammarProvider(undefined), "no provider at all is permissive, not strict");
});

test("resolveProvider: MULTIPI_PROVIDER wins, PI_PROVIDER is the fallback, empty means unset", () => {
	assert.equal(resolveProvider({ MULTIPI_PROVIDER: "kimi", PI_PROVIDER: "anthropic" }), "kimi");
	assert.equal(resolveProvider({ PI_PROVIDER: "anthropic" }), "anthropic");
	assert.equal(resolveProvider({ MULTIPI_PROVIDER: "kimi" }), "kimi");
	assert.equal(resolveProvider({ MULTIPI_PROVIDER: "", PI_PROVIDER: "anthropic" }), "anthropic");
	assert.equal(resolveProvider({ MULTIPI_PROVIDER: "" }), undefined);
	assert.equal(resolveProvider({}), undefined);
});

// --- the name list seam (what-if probes without shipping a rename) ---------------

test("toolNamesFromEnv: unset and EMPTY fall back to the registered list (empty = unset)", () => {
	assert.deepEqual(toolNamesFromEnv({}), [...REGISTERED_TOOL_NAMES]);
	assert.deepEqual(toolNamesFromEnv({ MULTIPI_PROBE_TOOL_NAMES: "" }), [...REGISTERED_TOOL_NAMES]);
});

test("toolNamesFromEnv: a colon-separated override replaces the list verbatim", () => {
	assert.deepEqual(toolNamesFromEnv({ MULTIPI_PROBE_TOOL_NAMES: "a.b:c_d" }), ["a.b", "c_d"]);
	assert.deepEqual(toolNamesFromEnv({ MULTIPI_PROBE_TOOL_NAMES: "solo" }), ["solo"]);
});

// --- the report ------------------------------------------------------------------

test("probe: healthy registered names report zero bad under a strict provider", () => {
	const r = probeToolNameGrammar(REGISTERED_TOOL_NAMES, "openai");
	assert.deepEqual(r, { provider: "openai", strict: true, count: 6, bad: [] });
});

test("probe: bad names are flagged IN INPUT ORDER and every instance of a duplicate counts", () => {
	const r = probeToolNameGrammar(["good_one", "devloop.bad", "9lead", "devloop.bad", "also_fine"], undefined);
	assert.deepEqual(r, { provider: "unknown", strict: false, count: 5, bad: ["devloop.bad", "9lead", "devloop.bad"] });
});

test("probe: an empty list is clean (nothing registered, nothing to reject)", () => {
	assert.deepEqual(probeToolNameGrammar([], "kimi"), { provider: "kimi", strict: true, count: 0, bad: [] });
});

test("probe: the bad-name finding is PROVIDER-INDEPENDENT — an unknown provider still flags a bad name (doctor reports it)", () => {
	const r = probeToolNameGrammar(["devloop.bad"], undefined);
	assert.deepEqual(r.bad, ["devloop.bad"]);
	assert.equal(r.strict, false, "unknown provider is not classified strict (the warning seat stays silent)");
});
