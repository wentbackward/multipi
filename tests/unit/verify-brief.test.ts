import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Ticket #108 pins: standard post-merge independent verification is a TEMPLATE
// (never re-improvised per train), a SKILL-DOCUMENTED automatic trigger with a
// pinned threshold, and a pinned rc contract. This file is the doc-pin half; the
// behavioural half is the "verify-brief.sh" section of tests/smoke.sh.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p: string[]): string => readFileSync(path.join(ROOT, ...p), "utf8");

const TEMPLATE = read("templates", "verify-brief.md");
const SKILL = read("skills", "devloop", "SKILL.md");
const SCRIPT = read("scripts", "verify-brief.sh");
const INSTALL = read("scripts", "install.sh");
const DECISIONS = read("docs", "DECISIONS.md");

/** Extract the skill's "## 7. …" section. */
function skillSection7(): string {
	const rest = SKILL.split("## 7.");
	assert.ok(rest.length >= 2, "the devloop skill must carry a '## 7.' section");
	const body = rest.slice(1).join("## 7.");
	const nl = body.indexOf("\n## ");
	return nl === -1 ? body : body.slice(0, nl);
}

test("the standard brief template holds the fixed steps of the clean-environment proof", () => {
	for (const [needle, what] of [
		["mktemp -d", "a fresh clone in a temp dir"],
		["{{REPO_URL}}", "of THIS repo, rendered per train"],
		["NEVER", "never the session repo or the gate worktree"],
		["Scrub PATH", "unjudged by the loop's policy shims"],
		["make check", "the full check set, each rc recorded"],
		["scripts/doctor.sh", "doctor on the clone"],
		["scripts/install.sh", "install into a throwaway repo"],
		["BYTE-IDENTICAL", "installed copies are byte-identical mirrors"],
		["VERIFICATION: PASS", "the verdict line the report header keys off"],
		["Clean up", "temp dirs removed at the end"],
	] as const) {
		assert.ok(TEMPLATE.includes(needle), `the brief template must carry: ${what} (${needle})`);
	}
});

test("the brief template carries exactly the four per-train render placeholders", () => {
	const found = [...TEMPLATE.matchAll(/\{\{[A-Z_]+\}\}/g)].map((m) => m[0]).sort();
	assert.deepEqual(found, ["{{EXERCISE}}", "{{RANGE}}", "{{REPO_URL}}", "{{TOUCHED}}"]);
});

test("skill §7 documents the automatic trigger, the threshold and the report attachment", () => {
	const sec = skillSection7();
	for (const needle of [
		"verify-brief.sh", // the deterministic half the orchestrator runs after the merge
		"VERIFY DISPATCH",
		"VERIFY SKIP",
		"extension/",
		"scripts/",
		"agents/",
		"skills/",
		".devloop.json",
		"templates/verify-brief.md", // the brief template is its own threshold category
		"docs/superpowers/specs/",
		"report", // the report subcommand attaches the proof to the issues
	]) {
		assert.ok(sec.includes(needle), `skill §7 must name: ${needle}`);
	}
	assert.ok(/default.?ON/i.test(sec), "skill §7 must state the default-ON direction");
});

test("the script's pinned rc contract is in its header (0 dispatch · 2 usage · 3 internal · 10 skip)", () => {
	for (const needle of ["0 contract touched", "2 usage", "3 internal", "10 docs/test-only"]) {
		assert.ok(SCRIPT.includes(needle), `the header must pin: ${needle}`);
	}
});

test("install.sh ships the brief template beside the scripts (installed targets have no templates/ dir)", () => {
	assert.ok(
		INSTALL.includes("verify-brief.template.md"),
		"install.sh must copy the template into the target's scripts/",
	);
});

test("DECISIONS.md records the default-on choice and the dispatch threshold (#108)", () => {
	const line = DECISIONS.split("\n").find((l) => l.includes("#108") && l.includes("verify-brief"));
	assert.ok(line, "DECISIONS.md must carry a #108 entry naming the default-on choice");
	assert.ok(/default-?ON|default on/i.test(line ?? ""), "the entry must record the default direction");
});

test("the dogfood skill mirror tracks the source §7 byte-for-byte", () => {
	assert.equal(
		read(".pi", "skills", "devloop", "SKILL.md"),
		SKILL,
		".pi/skills/devloop/SKILL.md diverges from skills/devloop/SKILL.md",
	);
});
