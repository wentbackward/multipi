import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { loadPolicy } from "../../extension/src/policy.ts";
import {
	ACTION_SUMMARY_MAX,
	createPolicyEnforcer,
	type PolicyEnforcer,
	policyHash,
} from "../../extension/src/policyhook.ts";
import { BASE_CONFIG, makeFixture, type Fixture } from "../fixtures.ts";

/**
 * P2 pins (permission-policy spec §4-L1/§6/§8, ticket #40): the hook layer that wires the
 * pure evaluator into a block-capable tool_call seat, the audit log, the session-start
 * policy hash, and the pinned absent/broken load behaviours.
 */

interface Case { fx: Fixture; env: NodeJS.ProcessEnv; perms: string; }

/** Fixture repo with a committed base config, an optional permissions.json, and a
 *  hermetic MULTIPI_HOME so the audit log lands in the scratch dir, never the real state. */
function seed(permsJson: string | null, devloopJson: string = BASE_CONFIG): Case {
	const fx = makeFixture(devloopJson);
	const env = { ...process.env, MULTIPI_HOME: path.join(fx.dir, "home") };
	if (permsJson !== null) writeFileSync(path.join(fx.repo, "permissions.json"), permsJson);
	return { fx, env, perms: path.join(fx.repo, "permissions.json") };
}

const PERMS = (o: { deny?: string[]; ask?: string[]; allow?: string[] }): string =>
	JSON.stringify({ permissions: { deny: o.deny ?? [], ask: o.ask ?? [], allow: o.allow ?? [] } });

function enforcer(c: Case, warnings: string[], extra: Record<string, unknown> = {}): PolicyEnforcer {
	return createPolicyEnforcer({
		root: c.fx.repo,
		env: c.env,
		warn: (m) => warnings.push(m),
		...extra,
	});
}

function readLines(p: string): Record<string, unknown>[] {
	return readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

const logOf = (c: Case): string => path.join(c.env.MULTIPI_HOME as string, "proj", "logs", "policy-audit.jsonl");

// --- the session-start policy hash ------------------------------------------

test("policyHash is stable across equal loads and changes when a rule OR a knob changes", () => {
	const c = seed(PERMS({ deny: ["Bash(sudo:*)"], allow: ["Bash(git status:*)"] }));
	try {
		const h1 = policyHash(loadPolicy(c.fx.repo, c.env));
		assert.equal(policyHash(loadPolicy(c.fx.repo, c.env)), h1, "equal loads hash equal");
		writeFileSync(c.perms, PERMS({ deny: ["Bash(sudo:*)"], ask: ["Bash(gh pr merge:*)"], allow: ["Bash(git status:*)"] }));
		assert.notEqual(policyHash(loadPolicy(c.fx.repo, c.env)), h1, "a new rule changes the hash");
		// The same raw rule MOVING to a different verdict class changes the hash (class is hashed).
		writeFileSync(c.perms, PERMS({ deny: ["Bash(gh pr merge:*)"], allow: ["Bash(git status:*)"] }));
		const hClass = policyHash(loadPolicy(c.fx.repo, c.env));
		assert.notEqual(hClass, h1, "a rule moving classes changes the hash");
		// A knob (posture) change changes the hash.
		const cfg = JSON.parse(BASE_CONFIG) as Record<string, unknown>;
		cfg.policy = { posture: "ask" };
		writeFileSync(c.fx.config, JSON.stringify(cfg));
		assert.notEqual(policyHash(loadPolicy(c.fx.repo, c.env)), hClass, "a knob change changes the hash");
	} finally { c.fx.cleanup(); }
});

// --- verdict → block shape (the tripwire text the model sees) ----------------

test("a seeded deny rule blocks with the exact 'DENIED <rule-id>: <reason>' shape", () => {
	const c = seed(PERMS({ deny: ["Bash(sudo:*)"] }));
	try {
		const f = enforcer(c, []);
		const res = f.onToolCall({ toolName: "bash", input: { command: "sudo reboot" }, sessionId: "sess-test" });
		assert.equal(res?.block, true, "deny blocks");
		assert.equal(res?.reason, "DENIED Bash(sudo:*): denied by rule: Bash(sudo:*)", "exact tripwire text");
	} finally { c.fx.cleanup(); }
});

test("an ask rule blocks with the §6 escalation directive shape (multipi-approve retry)", () => {
	const c = seed(PERMS({ ask: ["Bash(gh pr merge:*)"] }));
	try {
		const f = enforcer(c, []);
		const res = f.onToolCall({ toolName: "bash", input: { command: "gh pr merge 12" }, sessionId: "sess-test" });
		assert.equal(res?.block, true, "ask blocks");
		assert.equal(
			res?.reason,
			"ASK Bash(gh pr merge:*): bash: gh pr merge 12. Operator approval required: run 'multipi-approve Bash(gh pr merge:*)' in your own shell, then retry.",
			"exact §6 directive",
		);
	} finally { c.fx.cleanup(); }
});

test("allow and default verdicts pass through (no block)", () => {
	const c = seed(PERMS({ allow: ["Bash(git status:*)"] }));
	try {
		const f = enforcer(c, []);
		assert.equal(f.onToolCall({ toolName: "bash", input: { command: "git status" }, sessionId: null }), undefined, "matched allow passes");
		assert.equal(f.onToolCall({ toolName: "read", input: { path: "src/plain.txt" }, sessionId: null }), undefined, "default posture passes");
	} finally { c.fx.cleanup(); }
});

test("posture:ask makes every unmatched call ASK with the exact directive (ruleId posture:ask)", () => {
	const c = seed(PERMS({}), JSON.stringify({ policy: { posture: "ask" } }));
	try {
		const f = enforcer(c, []);
		const b = f.onToolCall({ toolName: "bash", input: { command: "curl example.com" }, sessionId: null });
		assert.ok(b?.block, "posture-ask blocks an unmatched call");
		assert.equal(b!.reason, "ASK posture:ask: bash: curl example.com. Operator approval required: run 'multipi-approve posture:ask' in your own shell, then retry.",
			"exact §6 directive with the posture rule id");
	} finally { c.fx.cleanup(); }
});

// --- the audit log (spec §8) --------------------------------------------------

test("each non-default verdict appends exactly one audit line with the seven fields; default passes log nothing", () => {
	const c = seed(PERMS({ deny: ["Bash(sudo:*)"], ask: ["Bash(gh pr merge:*)"] }));
	try {
		const f = enforcer(c, []);
		f.onToolCall({ toolName: "bash", input: { command: "git status" }, sessionId: "s" }); // default: no line
		f.onToolCall({ toolName: "bash", input: { command: "sudo x" }, sessionId: "s" }); // deny
		f.onToolCall({ toolName: "bash", input: { command: "gh pr merge 1" }, sessionId: "s" }); // ask
		const lines = readLines(logOf(c));
		assert.equal(lines.length, 2, "one line per non-default verdict, none for the default");
		for (const l of lines) {
			for (const k of ["ts", "session", "actor", "ruleId", "verdict", "actionSummary", "layer"]) {
				assert.ok(k in l, `field ${k} present`);
			}
			assert.equal(l.layer, "hook");
			assert.equal(l.actor, "orchestrator");
			assert.equal(l.session, "s");
			assert.ok(new Date(l.ts as string).getTime() > 0, "ts parses");
		}
		assert.deepEqual(
			lines.map((l) => [l.verdict, l.ruleId]),
			[["deny", "Bash(sudo:*)"], ["ask", "Bash(gh pr merge:*)"]],
			"lines in call order",
		);
		assert.equal(lines[0].actionSummary, "bash: sudo x", "bounded action summary");
	} finally { c.fx.cleanup(); }
});

test("an allow BY CURATED RULE is logged (the audit baseline / near-miss record); posture allows are not", () => {
	const c = seed(PERMS({ allow: ["Bash(git status:*)"] }));
	try {
		const f = enforcer(c, []);
		f.onToolCall({ toolName: "bash", input: { command: "git status" }, sessionId: "s" });
		f.onToolCall({ toolName: "bash", input: { command: "echo hi" }, sessionId: "s" });
		const lines = readLines(logOf(c));
		assert.deepEqual(lines.map((l) => [l.verdict, l.ruleId]), [["allow", "Bash(git status:*)"]], "only the rule-backed allow lands");
	} finally { c.fx.cleanup(); }
});

test("the session-start note records the effective policy hash into the audit log", () => {
	const c = seed(PERMS({ deny: ["Bash(sudo:*)"] }));
	try {
		const f = enforcer(c, []);
		f.noteSession("sess-test");
		const lines = readLines(logOf(c));
		assert.equal(lines.length, 1);
		assert.equal(lines[0].event, "policy_session_start");
		assert.equal(lines[0].session, "sess-test");
		assert.equal(lines[0].actor, "orchestrator");
		assert.equal(lines[0].layer, "hook");
		assert.equal(lines[0].policyHash, policyHash(loadPolicy(c.fx.repo, c.env)), "hash of rules + knobs");
		assert.equal(lines[0].policyHash, f.hash);
	} finally { c.fx.cleanup(); }
});

// --- drift (spec §8: visible noise, not a silent change) ---------------------

test("rewriting permissions.json after load: the next non-default verdict carries a POLICY DRIFT warning (reason + audit fields)", () => {
	const c = seed(PERMS({ deny: ["Bash(sudo:*)"] }));
	try {
		const f = enforcer(c, []);
		const before = f.onToolCall({ toolName: "bash", input: { command: "sudo a" }, sessionId: "s" });
		assert.ok(before?.reason?.startsWith("DENIED "), "no drift before the rewrite");
		writeFileSync(c.perms, PERMS({ deny: ["Bash(sudo:*)", "Bash(rm -rf /:*)"] }));
		const after = f.onToolCall({ toolName: "bash", input: { command: "sudo b" }, sessionId: "s" });
		assert.ok(after?.reason?.startsWith("POLICY DRIFT:"), `drift warning leads the reason (got: ${after?.reason})`);
		assert.ok(after?.reason?.includes("enforcing the session-loaded policy"), "the reason says which policy stays in force");
		const lines = readLines(logOf(c));
		assert.equal(lines.length, 2);
		assert.equal(lines[0].policyDrift, undefined, "first verdict: no drift fields");
		assert.equal(lines[1].policyDrift, true);
		assert.notEqual(lines[1].diskPolicyHash, lines[1].sessionPolicyHash, "hashes recorded on both sides");
		assert.equal(lines[1].sessionPolicyHash, f.hash, "session side is the load-time hash");
	} finally { c.fx.cleanup(); }
});

// --- the pinned absent / broken load behaviours (ticket #40) ------------------

test("MISSING policy files ⇒ policy INACTIVE: everything passes, one loud warning, an inactive session line", () => {
	const c = seed(null); // base config, no permissions.json
	try {
		const warnings: string[] = [];
		const f = enforcer(c, warnings);
		assert.equal(f.active, false, "inactive");
		assert.equal(f.onToolCall({ toolName: "bash", input: { command: "sudo anything" }, sessionId: "s" }), undefined, "even a seeded-class call passes");
		assert.equal(warnings.length, 1, "one warning at load");
		assert.match(warnings[0], /INACTIVE/i, "the warning says INACTIVE");
		f.noteSession("s");
		const lines = readLines(logOf(c));
		assert.equal(lines.length, 1);
		assert.equal(lines[0].event, "policy_session_start");
		assert.equal(lines[0].verdict, "inactive");
		assert.equal(lines[0].policyHash, null, "no effective policy to hash");
		assert.equal(lines[1], undefined, "no verdict lines were written");
	} finally { c.fx.cleanup(); }
});

test("BROKEN-but-present permissions.json ⇒ hook ACTIVE, denying every call with policy:unusable (fail closed)", () => {
	const c = seed("{ this is not json");
	try {
		const warnings: string[] = [];
		const f = enforcer(c, warnings);
		assert.equal(f.active, true, "broken ⇒ active (briding is the safety, not an accident)");
		f.noteSession("s"); // real lifecycle: the session line precedes the first verdict
		const calls: [string, Record<string, unknown>][] = [
			["bash", { command: "git status" }],
			["read", { path: "src/plain.txt" }],
			["write", { path: "src/plain.txt", content: "x" }],
		];
		for (const [tool, input] of calls) {
			const res = f.onToolCall({ toolName: tool, input, sessionId: "s" });
			assert.equal(res?.block, true, `broken policy blocks ${tool}`);
			assert.ok(res?.reason?.startsWith("DENIED policy:unusable:"), `exact unusable id for ${tool}`);
		}
		const lines = readLines(logOf(c));
		assert.equal(lines[0].event, "policy_session_start");
		assert.equal(lines[0].verdict, "broken");
		assert.equal(lines.length, 4, "session line + one line per denied call");
	} finally { c.fx.cleanup(); }
});

test("no .devloop.json at all ⇒ policy INACTIVE, not bridle (a non-loop directory is not a threat surface)", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "multipi-noloop-"));
	try {
		const warnings: string[] = [];
		const f = createPolicyEnforcer({ root: dir, env: { ...process.env, MULTIPI_HOME: path.join(dir, "home") }, warn: (m) => warnings.push(m) });
		assert.equal(f.active, false);
		assert.equal(f.onToolCall({ toolName: "bash", input: { command: "sudo x" }, sessionId: null }), undefined);
		assert.equal(warnings.length, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- read/edit paths: the LITERAL-`~` convention (ticket #40 addendum, spec §9)

test("a LITERAL-`~` token-dir read is denied by the seeded rule, and the audit summary redacts it", () => {
	const c = seed(PERMS({ deny: ["Read(~/.multipi/*/dev-loop-tokens/**)"] }));
	try {
		const f = enforcer(c, []);
		const res = f.onToolCall({ toolName: "read", input: { path: "~/.multipi/proj/dev-loop-tokens/a.tok" }, sessionId: "s" });
		assert.equal(res?.block, true, "literal-~ form trips the seeded deny");
		assert.equal(res?.reason, "DENIED Read(~/.multipi/*/dev-loop-tokens/**): denied by rule: Read(~/.multipi/*/dev-loop-tokens/**)");
		const lines = readLines(logOf(c));
		assert.equal(lines[0].actionSummary, "read: <token-dir>", "store path redacted from the summary");
		assert.ok(!String(lines[0].actionSummary).includes("dev-loop-tokens"), "no store path in the audit line");
	} finally { c.fx.cleanup(); }
});

test("an EXPANDED-absolute token-dir path passes — the documented tripwire-only limit is pinned, not accidental (spec §9)", () => {
	const c = seed(PERMS({ deny: ["Read(~/.multipi/*/dev-loop-tokens/**)"] }));
	try {
		const f = enforcer(c, []);
		// The hook passes paths to the evaluator in the literal form the model wrote; it never
		// pre-expands `~`, so this is what an expanded spelling does today — and must stay
		// documented if that ever changes (a silent skip of the seeded denies).
		const expanded = path.join(homedir(), ".multipi", "proj", "dev-loop-tokens", "a.tok");
		assert.equal(f.onToolCall({ toolName: "read", input: { path: expanded }, sessionId: null }), undefined, "expanded path: passes (limit)");
	} finally { c.fx.cleanup(); }
});

test("write paths are matched against the Edit rules (write binds to the Edit family)", () => {
	const c = seed(PERMS({ deny: ["Edit(./.env)"] }));
	try {
		const f = enforcer(c, []);
		const res = f.onToolCall({ toolName: "write", input: { path: ".env", content: "x" }, sessionId: null });
		assert.equal(res?.block, true, "writing .env trips the Edit rule via ./ normalization");
	} finally { c.fx.cleanup(); }
});

// --- summary hygiene + failure containment ------------------------------------

test("the audit actionSummary is bounded regardless of command length", () => {
	const c = seed(PERMS({ deny: ["Bash(sudo:*)"] }));
	try {
		const f = enforcer(c, []);
		f.onToolCall({ toolName: "bash", input: { command: "sudo " + "x".repeat(500) }, sessionId: null });
		const lines = readLines(logOf(c));
		assert.ok(String(lines[0].actionSummary).length <= ACTION_SUMMARY_MAX + 1, "bounded");
		assert.ok(String(lines[0].actionSummary).endsWith("…"), "truncation marked");
	} finally { c.fx.cleanup(); }
});

test("a failing audit append never breaks a verdict (blocks still block, passes still pass)", () => {
	const c = seed(PERMS({ deny: ["Bash(sudo:*)"] }));
	try {
		const warnings: string[] = [];
		const f = createPolicyEnforcer({
			root: c.fx.repo,
			env: c.env,
			warn: (m) => warnings.push(m),
			append: () => { throw new Error("disk full"); },
		});
		assert.equal(f.onToolCall({ toolName: "bash", input: { command: "sudo x" }, sessionId: null })?.block, true, "deny still blocks");
		assert.equal(f.onToolCall({ toolName: "bash", input: { command: "git status" }, sessionId: null }), undefined, "pass still passes");
		assert.ok(warnings.length >= 1, "the write failure is reported once");
		assert.equal(f.onToolCall({ toolName: "bash", input: { command: "sudo y" }, sessionId: null })?.block, true, "and it keeps working");
	} finally { c.fx.cleanup(); }
});
