import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTools } from "../../extension/src/tools.ts";
import { REGISTERED_TOOL_NAMES } from "../../extension/src/toolnames.ts";
import { DEVLOOP_CONFIG_KEYS, LOOP_LABELS } from "../../extension/src/config.ts";

/**
 * Spec-freshness pins (ticket #110 — the durable part of the living spec): when a
 * CONTRACT SURFACE changes (a tool, a loop label, an exit code, a config key, a
 * dispatch parameter, a role's tool set), docs/SPEC.md must describe it in the same change.
 * Below, each test asserts SPEC.md against the CODE (makeTools, the label vocabulary, the pinned
 * exit tables, the parser's key list, the agent frontmatter), so drift is a red gate, not a silent decay.
 *
 * Deliberately conservative (the ticket's "grow over time"): it pins the surfaces
 * that ALREADY have pins. New surfaces join here as they gain their own ground truth.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC_PATH = path.join(ROOT, "docs", "SPEC.md");
const DESIGN_SPEC = path.join(ROOT, "docs", "superpowers", "specs", "2026-10-27-devloop-pi-design.md");
const SPEC = existsSync(SPEC_PATH) ? readFileSync(SPEC_PATH, "utf8") : "";

/** A top-level "## Title" section (to the next "## " or EOF). */
function section(text: string, title: string): string {
	const idx = text.search(new RegExp(`^## (?:\\d+\\. )?${title}[^\\n]*$`, "m"));
	assert.notEqual(idx, -1, `"docs/SPEC.md" must carry a "## ${title}" section`);
	const rest = text.slice(idx);
	const next = rest.indexOf("\n## ");
	return next === -1 ? rest : rest.slice(0, next);
}

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/** Every file under dir with given extensions, recursively, sorted (deterministic sweep). */
function walk(dir: string, exts: string[]): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir).sort()) {
		const p = path.join(dir, e);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...walk(p, exts));
		else if (exts.some((x) => e.endsWith(x))) out.push(p);
	}
	return out;
}

// --- SPEC.md exists and is the rebuild source ---------------------------------

test("docs/SPEC.md exists and names itself the rebuild source of truth", () => {
	assert.ok(existsSync(SPEC_PATH), "docs/SPEC.md is missing — it is the rebuild source of truth (#110)");
	assert.ok(SPEC.startsWith("# multipi"), "SPEC.md must be the multipi system spec");
	assert.ok(/rebuild/i.test(SPEC), "SPEC.md must state its rebuild-source role");
});

// --- tool names: SPEC.md ↔ makeTools()/REGISTERED_TOOL_NAMES -------------------

test("SPEC.md's tools section lists exactly the registered control-plane tools", () => {
	const sec = section(SPEC, "Control-plane tools");
	const named = [...new Set([...sec.matchAll(/`devloop_[a-z_]+`/g)].map((m) => m[0].slice(1, -1)))].sort();
	assert.deepEqual(
		named,
		[...REGISTERED_TOOL_NAMES].sort(),
		"a renamed/added control-plane tool must appear in SPEC.md in the same change",
	);
	assert.equal(named.length, 6, "ground truth: six control-plane tools");
});

// --- loop labels: SPEC.md ↔ code ----------------------------------------------

test("SPEC.md documents every label of the loop state machine", () => {
	const sec = section(SPEC, "Loop and label state machine");
	for (const l of LOOP_LABELS) assert.ok(sec.includes(l), `the loop label ${l} is missing from SPEC.md`);
});

test("no loop code uses a label outside the documented vocabulary (drift sweep)", () => {
	const files = [...walk(path.join(ROOT, "extension", "src"), [".ts"]), ...walk(path.join(ROOT, "scripts"), [".sh"])];
	const found = new Set<string>();
	for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/\bdl\/([a-z][a-z-]*)/g)) found.add(`dl/${m[1]}`);
	const unknown = [...found].filter((l) => !(LOOP_LABELS as readonly string[]).includes(l)).sort();
	assert.deepEqual(unknown, [], `code uses labels outside the documented vocabulary (document them in SPEC.md + LOOP_LABELS): ${unknown.join(", ")}`);
});

// --- exit-code contracts: SPEC.md ↔ the pinned tables --------------------------

/** The pinned per-script rc tables, mirroring each script's header (design spec §2.3). */
const EXIT_CONTRACTS: { script: string; codes: [number, string][] }[] = [
	{ script: "gate-train.sh", codes: [[0, "green"], [1, "red"], [2, "usage"], [3, "conflict"]] },
	{
		script: "merge-train.sh",
		codes: [[0, "merged"], [2, "usage"], [3, "conflict"], [4, "differs"], [5, "notes"], [6, "changed"], [7, "merged"], [8, "gated"]],
	},
	{ script: "scenario-stage.sh", codes: [[0, "green"], [1, "red"], [2, "usage"]] },
	{ script: "cleanup-worktrees.sh", codes: [[0, "done"], [2, "usage"]] },
	{ script: "multipi-status.sh", codes: [[0, "live"], [1, "idle"], [2, "stale"], [3, "dead"], [4, "usage"]] },
	{ script: "multipi-interrupt.sh", codes: [[0, "injected"], [4, "usage"], [5, "session"], [6, "tty"]] },
	{ script: "multipi-board.sh", codes: [[0, "human"], [1, "blocked"], [2, "red"], [4, "usage"]] },
];

test("SPEC.md's exit-code table carries every pinned per-script rc contract", () => {
	const sec = section(SPEC, "Exit-code contracts");
	for (const t of EXIT_CONTRACTS) {
		const line = sec.split("\n").find((l) => l.includes(t.script));
		assert.ok(line, `SPEC.md's exit-code table has no row for scripts/${t.script}`);
		for (const [code, word] of t.codes) {
			assert.ok(new RegExp(`\\b${code}\\b`).test(line!), `${t.script}: rc ${code} missing from the SPEC.md row`);
			assert.ok(line!.toLowerCase().includes(word), `${t.script}: rc ${code} meaning "${word}" missing from the SPEC.md row`);
		}
	}
});

// --- config keys: SPEC.md ↔ DEVLOOP_CONFIG_KEYS (the single source) ------------

/** SPEC.md's configuration table: the documented key set, plus the residual views the pins assert.
 * Returned together so the two-directional pin shares ONE extraction (a drift between two
 * separately parsed copies would mask the very drift the pin exists to catch). */
function keySurfaces(specText: string): { documented: Set<string>; undocumented: string[]; extra: string[] } {
	const sec = section(specText, "Configuration");
	const documented = new Set([...sec.matchAll(/^\|\s*`([a-z0-9_\[\].]+)`\s*\|/gm)].map((m) => m[1]));
	const undocumented = [...DEVLOOP_CONFIG_KEYS].filter((k) => !documented.has(k));
	const extra = [...documented].filter((k) => !(DEVLOOP_CONFIG_KEYS as readonly string[]).includes(k));
	return { documented, undocumented, extra };
}

test("every config key the loop accepts is documented in SPEC.md (and vice versa)", () => {
	const { undocumented, extra } = keySurfaces(SPEC);
	assert.deepEqual(undocumented, [], "parser-accepted keys undocumented in SPEC.md: " + undocumented.join(", "));
	assert.deepEqual(extra, [], `SPEC.md documents keys the loop does not accept (add them to DEVLOOP_CONFIG_KEYS or remove): ${extra.join(", ")}`);
});

test("the config-key pin is demonstrably red: dropping one key from the table is detected", () => {
	assert.equal(keySurfaces(SPEC).undocumented.length, 0, "precondition: the table is currently complete");
	const mutated = SPEC.split("\n").filter((l) => !l.startsWith("| `deploy` |")).join("\n");
	assert.deepEqual(keySurfaces(mutated).undocumented, ["deploy"], "removing a documented key must make the pin red");
});

// --- environment seams: SPEC.md §13 ↔ the seams the code reads ──────────────────

/** Every MULTIPI_* seam the loop's scripts and extension read, excluding the two
 * trailing-underscore artifacts (glob patterns in comments). */
function codeSeams(): string[] {
	const files = [
		...walk(path.join(ROOT, "scripts"), [".sh"]),
		...walk(path.join(ROOT, "extension"), [".ts"]),
	];
	const found = new Set<string>();
	for (const f of files)
		for (const m of readFileSync(f, "utf8").matchAll(/\b(MULTIPI_[A-Z_]+)\b/g)) {
			// A trailing-underscore match is a glob artifact in a comment
			// (e.g. "$MULTIPI_SCENARIO_*"), not a seam.
			if (!m[1].endsWith("_")) found.add(m[1]);
		}
	return [...found].sort();
}

// The smoke launcher's own seams (tests/smoke.sh), classified in the §13 closing note:
// not operator/loop contracts. MULTIPI_SLOT is heavy.sh's per-slot export, read back by
// the smoke; MULTIPI_TRUSTED is the trusted-programs forgery probe; MULTIPI_PLUGIN_DIR is
// the module-path override for the smoke's node one-shots.
const SMOKE_ONLY_SEAMS = new Set(["MULTIPI_TRUSTED", "MULTIPI_PLUGIN_DIR", "MULTIPI_SLOT"]);

test("SPEC.md's environment-seams table is the inventory of the seams the code reads", () => {
	const sec = section(SPEC, "Environment seams");
	const claimed = new Set([...sec.matchAll(/`(MULTIPI_[A-Z_]+)`/g)].map((m) => m[1]));
	// The closing note names the smoke-only seams — classified, not claimed as contracts.
	for (const s of SMOKE_ONLY_SEAMS) claimed.delete(s);
	const missing = codeSeams().filter((s) => !SMOKE_ONLY_SEAMS.has(s) && !claimed.has(s)).sort();
	assert.deepEqual(missing, [], `SPEC.md §13 is missing seams the code reads: ${missing.join(", ")}`);
	const extra = [...claimed].filter((s) => !codeSeams().includes(s)).sort();
	assert.deepEqual(extra, [], `SPEC.md §13 claims seams the code does not read: ${extra.join(", ")}`);
});

// --- dispatch parameters: SPEC.md + design spec §2.2 ↔ makeTools() -------------

/** The dispatch tool's parameter list, derived from its typebox schema (required first, `?` = optional). */
function dispatchParams(): string[] {
	const t = makeTools().find((x) => x.name === "devloop_dispatch");
	assert.ok(t, "makeTools() must register devloop_dispatch");
	const p = t.parameters as unknown as { properties: Record<string, unknown>; required?: string[] };
	return Object.keys(p.properties).map((k) => (p.required?.includes(k) ? k : `${k}?`));
}

/** The union of role names the dispatch cell lists ("a" | "b" …), in order. */
function dispatchRoles(row: string): string[] {
	const seg = row.slice(row.indexOf('role: "'));
	assert.notEqual(seg, "", "the dispatch row must carry a role union");
	const end = seg.indexOf('",');
	assert.notEqual(end, -1, "the role union must be followed by a `, `");
	return seg.slice(7, end).split("|").map((s) => s.replace(/^"|"$/g, "").trim());
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The roles the dispatch tool's schema description names (order preserved). */
function schemaDispatchRoles(): string[] {
	const t = makeTools().find((x) => x.name === "devloop_dispatch");
	const p = t!.parameters as unknown as { properties: { role: { description: string } } };
	return String(p.properties.role.description).split(" | ");
}

function assertDispatchRow(row: string, where: string): void {
	assert.ok(row.startsWith("| `devloop_dispatch` |"), `${where}: no dispatch row`);
	for (const p of dispatchParams()) {
		assert.ok(new RegExp(`(?<![\w-])${esc(p)}(?!\w)`).test(row), `${where}: the dispatch row is missing parameter ${p}`);
	}
	const optionals = new Set([...row.matchAll(/(?<![\w-])([a-z]+\?)(?!\w)/g)].map((m) => m[1]));
	const knownOptional = new Set(dispatchParams().filter((p) => p.endsWith("?")));
	const unknown = [...optionals].filter((p) => !knownOptional.has(p)).sort();
	assert.deepEqual(unknown, [], `${where}: the dispatch row names parameters the schema does not have: ${unknown.join(", ")}`);
	// The specific #110 regression: a nonexistent `notes?` parameter.
	assert.ok(!row.includes("notes?"), `${where}: the dispatch row still lists the nonexistent notes? parameter`);
	// The role union must match the roles the schema description names.
	assert.deepEqual(dispatchRoles(row), schemaDispatchRoles(), `${where}: the dispatch row's role union drifted from the schema`);
}

test("the SPEC.md dispatch row matches makeTools()' DispatchSchema (five roles, spec/focus, no notes?)", () => {
	const row = section(SPEC, "Control-plane tools").split("\n").find((l) => l.startsWith("| `devloop_dispatch` |")) ?? "";
	assertDispatchRow(row, "SPEC.md");
});

test("the design spec §2.2 dispatch row matches makeTools()' DispatchSchema (regenerated, not hand-copied)", () => {
	const text = read("docs/superpowers/specs/2026-10-27-devloop-pi-design.md");
	const row = text.split("\n").find((l) => l.startsWith("| `devloop_dispatch` |")) ?? "";
	assertDispatchRow(row, "design spec §2.2");
});

// --- role tools: SPEC.md §8 ↔ the agent frontmatter ----------------------------

/** The `tools:` list of each bundled agent's frontmatter (absent = pi defaults). */
function agentRoleTools(): Map<string, string> {
	const out = new Map<string, string>();
	for (const f of readdirSync(path.join(ROOT, "agents")).sort()) {
		if (!f.endsWith(".md")) continue;
		const lines = read(path.join("agents", f)).split("\n");
		if (lines[0]?.trim() !== "---") continue;
		const fm = lines.slice(1, lines.indexOf("---", 1));
		const name = fm.find((l) => l.startsWith("name: "))?.slice(6).trim();
		const tools = fm.find((l) => l.startsWith("tools: "))?.slice(7).trim();
		if (name) out.set(name, tools ?? "");
	}
	return out;
}

test("SPEC.md's roles table lists each role's frontmatter tool set (drift guard)", () => {
	const sec = section(SPEC, "Roles");
	for (const [name, tools] of [...agentRoleTools()].sort()) {
		const row = sec.split("\n").find((l) => l.startsWith(`| \`${name}\` |`));
		assert.ok(row, `SPEC.md's roles table has no row for the ${name} role`);
		if (tools)
			assert.ok(
				row!.includes(`\`${tools}\``),
				`SPEC.md's ${name} row must list its frontmatter tools verbatim (expected: \`${tools}\`)`,
			);
	}
});

// --- the discipline line + rebuild-source naming --------------------------------

test("the devloop skill and the implementer prompt carry the SPEC.md-update discipline", () => {
	for (const f of ["skills/devloop/SKILL.md", "agents/implementer.md"]) {
		const t = read(f);
		assert.ok(t.includes("docs/SPEC.md"), `${f} must name docs/SPEC.md (the living spec)`);
		assert.ok(/freshness check/i.test(t), `${f} must reference the freshness check`);
	}
});

test("AGENTS.md names docs/SPEC.md as the rebuild source of truth", () => {
	const t = read("AGENTS.md");
	assert.ok(t.includes("docs/SPEC.md"), "AGENTS.md must name docs/SPEC.md");
	assert.ok(/rebuild/i.test(t), "AGENTS.md must state the rebuild-source role");
});

// --- LEARNINGS.md: the institutional memory -------------------------------------

test("docs/LEARNINGS.md carries each round's lesson with symptom/cause/prevention/pin structure", () => {
	const t = read("docs/LEARNINGS.md");
	for (const topic of [
		"wedge", // the ~6h silent orchestrator
		"OOM", // "No result provided" child deaths
		"mutual-exec", // shim-on-shim double-wrap
		"resume bias", // re-dispatch re-reading its own report
		"should-fix cascade", // and its terminus (the polish tail)
		"kimi", // OpenAI-grammar tool-name portability
		"wait_for", // the flake class and the bounded-poll idiom
		"delete-then-push", // the PR-closed-without-merge nuance
	]) {
		assert.ok(t.toLowerCase().includes(topic.toLowerCase()), `LEARNINGS.md is missing the "${topic}" lesson`);
	}
	for (const field of ["symptom", "root cause", "now prevents", "pinned"]) {
		assert.ok(t.toLowerCase().includes(field), `every LEARNINGS.md entry must carry the "${field}" dimension`);
	}
});
