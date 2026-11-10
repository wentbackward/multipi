// Pure permission-policy evaluator (permission-policy spec 2026-11-09-multipi-permission-policy.md
// §3, §4-L1, §5, §7). Dependency rule: node builtins only — no @earendil-works/* imports — so the
// hook (P2), the shims (P3), doctor and policy.sh all share ONE evaluator.
//
// Rule dialect (the operator's, verbatim): `Bash(<pattern>)`, `Read(<glob>)`, `Edit(<glob>)`.
// Glob semantics, PINNED by tests (tests/unit/policy.test.ts):
//   Bash — `prefix:*` is prefix shorthand; any other `*` spans ANY run of characters (spaces,
//          slashes); the match is anchored and case-sensitive.
//   Read/Edit — `*` is one path component, `**` is any depth; a leading `./` is normalized away
//          from both pattern and path; `~` is a LITERAL first segment (callers expand the home
//          dir before calling — the evaluator is env-free).
//
// Honesty limits (spec §9, the tripwire contract): this is string-layer matching. Quoting,
// wrapping (`sh -c`, heredocs), substitution and scripts the caller writes around it bypass it;
// only TOP-LEVEL command tokens are inspected (no env-assignment prefixes, no cwd — a relative
// install target resolves against the repo ROOT, and if that is not certain the answer is deny,
// never guess). `gitTargets` must be RESOLVED main-repo roots (the P3 shim computes them from
// rev-parse ground truth); the `trusted` flag must be backed by the shim's PPID/env-marker proof
// of script ancestry — a bare claim here is not verified, and mentioning a script path in a
// command never confers trust.
//
// Verdict order (fixed): unusable policy ⇒ deny (fail closed) → structural git-target rules
// (worst target wins; unresolvable/foreign ⇒ deny, secondary ⇒ ask) → install.sh structural
// rule (foreign target ⇒ deny, secondary ⇒ ask) → trusted exemption (string rules ONLY,
// spec §5 — the exemption can NEVER lift a structural rule; the 2026-11-09 oneshot failure
// class is the one no exemption reopens) → string rules (deny > ask > allow) → posture default.
// `gitTargets` entries must be main-repo ROOTS (the parent of the rev-parse git-dir); the P3
// shim converts --git-common-dir output to the root before calling.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_POLICY, loadConfig, type PolicyConfig } from "./config.ts";

/** One compiled rule. `id` is the raw rule string (audit-friendly); `re`/`cls` are internal. */
export interface PolicyRule {
	/** Normalized tool family: "bash" | "read" | "edit" | anything else is inert (bookkeeping). */
	tool: string;
	/** Which array the rule came from — its verdict class. */
	cls: "deny" | "ask" | "allow";
	pattern: string;
	id: string;
	re: RegExp;
}

/** Loaded policy. `ok:false` (UNUSABLE) is distinct from zero rules (ABSENT): unusable denies
 * everything, absent defers to the posture. */
export interface Policy {
	ok: boolean;
	/** Why the policy is unusable (bad .devloop.json, bad permissions.json, bad rule). */
	error?: string;
	/** The repo root the policy files were loaded FROM (a checkout may be a linked
	 * worktree): permissions.json and scripts-identity resolve here. */
	root: string;
	/** The MAIN worktree root this checkout belongs to — the "self" of every
	 * repo-scope decision (worktree paths normalize here; see mainRootOf). */
	scopeRoot: string;
	config: PolicyConfig;
	rules: PolicyRule[];
	/** Whether a permissions.json existed next to the config. */
	hasPermissionsFile: boolean;
}

/** Structural rule ids (spec §5/§7) — the delta no string pattern can express. */
export const RULE_POLICY_UNUSABLE = "policy:unusable";
export const RULE_ONESHOT_FOREIGN = "oneshot:foreign-repo";
export const RULE_ONESHOT_SECONDARY = "oneshot:secondary-repo";
export const RULE_ONESHOT_UNRESOLVABLE = "oneshot:unresolvable-target";
export const RULE_ONESHOT_INSTALL_FOREIGN = "oneshot:install-foreign";
export const RULE_ONESHOT_INSTALL_SECONDARY = "oneshot:install-secondary";
export const RULE_TRUSTED_EXEMPT = "trusted:exemption";

/** What one call declares to be doing (hook/shim extract this from the tool arguments). */
export interface PolicyContext {
	/** Who is acting (e.g. "orchestrator"); carried for the audit log, rules do not scope on it (v1). */
	actor: string;
	/** Tool name ("bash", "read", "edit", "write", …). */
	tool: string;
	/** The command line, for bash. */
	command?: string;
	/** File targets, for read/edit/write (canonical or as-given; see normalization above). */
	paths?: string[];
	/** RESOLVED main-repo roots of every git target the call acts on; `null` = an expected
	 * target could not be resolved with certainty ⇒ fail closed (spec §7.2). Absent = no git target. */
	gitTargets?: (string | null)[];
	/** Set ONLY on the shim's PPID/env-marker proof that the call comes from an installed
	 * script's own process tree (spec §5). Lifts string rules; NEVER the structural rules. */
	trusted?: boolean;
}

export type PolicyVerdict = "allow" | "ask" | "deny";

export interface PolicyDecision {
	verdict: PolicyVerdict;
	/** The deciding rule (raw rule string for string rules, structural id otherwise). */
	ruleId?: string;
	/** One-line reason — for string-layer denials/asks this text is the tripwire (spec §4). */
	reason?: string;
}

const RULE_RE = /^([A-Z][A-Za-z0-9_]*)\(([^()]*)\)$/;
const TOOL_FAMILY: Record<string, string> = { bash: "bash", read: "read", edit: "edit", write: "edit" };

function escapeRe(s: string): string {
	return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Bash pattern → anchored regex: `prefix:*` is prefix shorthand (stem anchored to a token
 * start; a `*` INSIDE the stem is an escaped literal — `a*b:*` ≙ literal prefix `a*b`);
 * otherwise `*` → `.*` (spans anything). */
function bashRe(pattern: string): RegExp {
	// `prefix:*` prefix shorthand anchored to a TOKEN START: the stem must end at whitespace
	// or end-of-line, so `Bash(sudo:*)` does not admit `sudoku`, and an ALLOW prefix cannot
	// over-admit (`Bash(git log:*)` does not admit `git logspam`).
	if (pattern.endsWith(":*")) {
		const stem = escapeRe(pattern.slice(0, -2));
		return new RegExp(`^${stem}(?=\\s|$).*`, "s");
	}
	return new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`, "s");
}

/** Path glob → anchored regex: `**` → `.*` (any depth), `*` → `[^/]*` (one component). */
function globRe(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*" && pattern[i + 1] === "*") { out += ".*"; i++; }
		else if (c === "*") out += "[^/]*";
		else out += escapeRe(c);
	}
	return new RegExp(`^${out}$`);
}

/** A leading `./` is noise: `./.env` and `.env` are the same file in the session cwd. */
function stripDotSlash(p: string): string {
	let s = p;
	while (s.startsWith("./")) s = s.slice(2);
	// `.//.env` → `/​.env` would be a silent RELATIVE→ABSOLUTE reclassification; when the
	// original was dot-relative, keep the result relative (`.//.env` ⇒ `.env`).
	if (s.startsWith("/") && p.startsWith(".")) s = "." + s;
	return s;
}

function compileRule(raw: string, cls: "deny" | "ask" | "allow"): PolicyRule {
	const m = RULE_RE.exec(raw);
	if (!m) throw new Error(`rule ${JSON.stringify(raw)} is not Tool(pattern)`);
	const [, tool, pattern] = m;
	if (!pattern) throw new Error(`rule ${JSON.stringify(raw)} has an empty pattern`);
	const t = tool.toLowerCase(); // bash/read/edit bind to tools; any other family is inert bookkeeping
	const pat = stripDotSlash(pattern); // normalized once, for BOTH the stored field and the matcher
	return { tool: t, cls, pattern: pat, id: raw, re: t === "bash" ? bashRe(pat) : globRe(pat) };
}

/**
 * Normalize any repo path (main or linked worktree) to the MAIN worktree root by reading the
 * `.git` entry: a directory ⇒ already the common root; a file ⇒ the worktree's `gitdir:`
 * pointer, whose third ancestor is the main root. Unresolvable input is returned as-is
 * (the caller's semantics, documented — never a silent re-scope to the wrong repo).
 */
function mainRootOf(p: string): string {
	try {
		const ge = path.join(p, ".git");
		const st = statSync(ge);
		if (st.isDirectory()) return p;
		if (st.isFile()) {
			const line = readFileSync(ge, "utf8").split("\n").find((l) => l.startsWith("gitdir:"));
			const gd = line ? line.slice(line.indexOf(":") + 1).trim() : null;
			// gd = <main>/.git/worktrees/<name>
			return gd ? path.dirname(path.dirname(path.dirname(gd))) : p;
		}
	} catch {
		return p;
	}
	return p;
}

/**
 * Load the policy from a repo root — MAIN or LINKED WORKTREE (both accepted):
 * - the `.devloop.json` policy block follows loadConfig's own main-root resolution
 *   (unchanged dark-factory behaviour); the sibling `permissions.json` (operator's
 *   wrapped shape {"permissions":{"deny","allow","ask"}} or bare {deny,allow,ask}) loads
 *   from the GIVEN checkout, and scripts-identity resolves against it (the train under
 *   gate carries its own seed);
 * - the SELF of repo-scope decisions is the COMMON repository: `scopeRoot` is
 *   normalized from the worktree's `.git` gitdir pointer (see mainRootOf), so a policy
 *   loaded inside any worktree never re-scopes "self" to that one worktree.
 * Any JSON/shape/rule error makes the policy UNUSABLE (ok:false) — fail closed; a
 * MISSING file is not an error.
 */
export function loadPolicy(root: string, env: NodeJS.ProcessEnv = process.env): Policy {
	const scopeRoot = mainRootOf(root);
	const cfg = loadConfig(root, env);
	const base: Policy = { ok: false, root, scopeRoot, config: DEFAULT_POLICY, rules: [], hasPermissionsFile: false };
	if (!cfg) return { ...base, error: ".devloop.json missing or unparseable" };
	const permPath = path.join(root, "permissions.json");
	if (!existsSync(permPath)) return { ok: true, root, scopeRoot, config: cfg.policy, rules: [], hasPermissionsFile: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(permPath, "utf8"));
	} catch (e) {
		return { ...base, config: cfg.policy, hasPermissionsFile: true, error: `permissions.json is not valid JSON: ${(e as Error).message}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ...base, config: cfg.policy, hasPermissionsFile: true, error: "permissions.json must be a JSON object" };
	}
	const o = parsed as Record<string, unknown>;
	const wrapped = typeof o.permissions === "object" && o.permissions !== null && !Array.isArray(o.permissions);
	if ("permissions" in o && !wrapped) {
		return { ...base, config: cfg.policy, hasPermissionsFile: true, error: "permissions.json permissions key must be an object with deny/allow/ask arrays" };
	}
	const src = wrapped ? (o.permissions as Record<string, unknown>) : o;
	const rules: PolicyRule[] = [];
	for (const key of ["deny", "ask", "allow"] as const) {
		const arr = src[key];
		if (arr === undefined) continue;
		if (!Array.isArray(arr) || !arr.every((r) => typeof r === "string")) {
			return { ...base, config: cfg.policy, hasPermissionsFile: true, error: `permissions.json ${key} must be an array of rule strings` };
		}
		for (const raw of arr as string[]) {
			try {
				rules.push(compileRule(raw, key));
			} catch (e) {
				return { ...base, config: cfg.policy, hasPermissionsFile: true, error: (e as Error).message };
			}
		}
	}
	return { ok: true, root, scopeRoot, config: cfg.policy, rules, hasPermissionsFile: true };
}

type TargetClass = "self" | "allowed" | "secondary" | "foreign";

/** Repo-scope decision for one resolved target: self or an explicit repos entry pass;
 * a whitelisted secondary asks; anything else is foreign (spec §7.1/§7.3). */
/** Classify a RESOLVED target against self/allowlist/secondaries. Both sides are compared
 * by realpath when the paths exist (a symlinked root or target must not turn SELF into
 * foreign — a false deny would break the loop's own operations); lexical when missing. */
function classifyTarget(policy: Policy, target: string): TargetClass {
	const canon = (p: string) => realOrNull(p) ?? p;
	const t = canon(path.resolve(target));
	const r = canon(path.resolve(policy.scopeRoot));
	if (t === r || t.startsWith(r + path.sep)) return "self";
	const repos = policy.config.repos.filter((x) => x !== "self").map((x) => canon(path.resolve(x)));
	if (repos.includes(t)) return "allowed";
	const secs = policy.config.secondaries.map((x) => canon(path.resolve(x)));
	if (secs.includes(t)) return "secondary";
	return "foreign";
}

function realOrNull(p: string): string | null {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
}

/** Resolve `token` (from the repo root) to a REAL file inside the installed scripts/ dir,
 * or null. Single source of the identity rule (spec §5): realpath, no symlink escape. */
function realInstalledScript(token: string, root: string): string | null {
	const scripts = realOrNull(path.join(root, "scripts"));
	if (!scripts) return null;
	const real = realOrNull(path.resolve(root, token));
	if (!real || (real !== scripts && !real.startsWith(scripts + path.sep))) return null;
	try {
		return statSync(real).isFile() ? real : null;
	} catch {
		return null;
	}
}

/** True when the program (resolved from the repo root) IS an installed scripts/*.sh file by
 * realpath (spec §5: identity, not name or a path string the model composed). */
export function isTrustedProgram(program: string, root: string): boolean {
	if (/\s/.test(program) || program === "~" || program.startsWith("~/")) return false; // unresolvable ⇒ not trusted
	return realInstalledScript(program, root)?.endsWith(".sh") ?? false;
}

/** Is this top-level token the installed install.sh (by realpath)? Both sides of the
 * comparison must be REAL: a missing scripts dir is "not the install script", never a
 * null===null match. */
function isInstalledInstallScript(token: string, root: string): boolean {
	const real = realInstalledScript(token, root);
	const want = realOrNull(path.join(root, "scripts", "install.sh"));
	return real !== null && want !== null && real === want;
}

const RANK: Record<PolicyVerdict, number> = { deny: 2, ask: 1, allow: 0 };

/** A structural (non-rule) finding, before it is turned into the final decision. */
interface Flag { verdict: PolicyVerdict; ruleId: string; reason: string }

/** The decision a matched string rule produces (its class IS the verdict). */
function ruleDecision(rule: PolicyRule): PolicyDecision {
	switch (rule.cls) {
		case "deny": return { verdict: "deny", ruleId: rule.id, reason: `denied by rule: ${rule.id}` };
		case "ask": return { verdict: "ask", ruleId: rule.id, reason: `approval required by rule: ${rule.id}` };
		case "allow": return { verdict: "allow", ruleId: rule.id, reason: `matched allow rule: ${rule.id}` };
	}
}

/** The policy decision for one declared action. Pure over the loaded policy (see module
 * header for the fixed verdict order and the honesty limits). */
export function evaluate(policy: Policy, ctx: PolicyContext): PolicyDecision {
	// 0. Unusable ⇒ fail closed. Nothing else may decide while the policy is broken.
	if (!policy.ok) return { verdict: "deny", ruleId: RULE_POLICY_UNUSABLE, reason: `policy unusable (${policy.error}) — failing closed` };

	// 1. Structural git-target rules (spec §7): identity/data based, immune to string tricks,
	//    and they outrank the trusted exemption.
	if (ctx.gitTargets) {
		const flagged: Flag[] = [];
		for (const t of ctx.gitTargets) {
			if (t === null) {
				flagged.push({ verdict: "deny", ruleId: RULE_ONESHOT_UNRESOLVABLE, reason: "git target unresolvable — failing closed (spec §7.2)" });
				continue;
			}
			switch (classifyTarget(policy, t)) {
				case "secondary":
					flagged.push({ verdict: "ask", ruleId: RULE_ONESHOT_SECONDARY, reason: `git target is a whitelisted secondary — operator consent required (spec §7.1)` });
					break;
				case "foreign":
					flagged.push({ verdict: "deny", ruleId: RULE_ONESHOT_FOREIGN, reason: `git target outside the repo allowlist {self${policy.config.repos.filter((x) => x !== "self").map((x) => `, ${x}`).join("")}} — the 2026-11-09 oneshot rule (spec §7.1)` });
					break;
				default:
					break; // self / allowed: the rules layer still sees this call
			}
		}
		// Worst target wins the call (deny > ask).
		let worst: Flag | null = null;
		for (const f of flagged) if (!worst || RANK[f.verdict] > RANK[worst.verdict]) worst = f;
		if (worst) return { verdict: worst.verdict, ruleId: worst.ruleId, reason: worst.reason };
	}

	const tool = ctx.tool.toLowerCase(); // pi names tools lowercase; both rule layers key off the same value

	// 2. Oneshot install rule: install.sh acting on a target. Runs BEFORE the trusted
	//    exemption: an installed install.sh is trusted for STRING rules, but a foreign
	//    INSTALL TARGET is the exact 2026-11-09 failure class no exemption may reopen
	//    (spec §7.1). The target is the first non-flag argument; relative/~ targets
	//    cannot be resolved with certainty from this context ⇒ unresolvable ⇒ deny
	//    (spec §7.2), never a guess.
	if (tool === "bash" && typeof ctx.command === "string") {
		const d = evaluateInstall(policy, ctx.command);
		if (d) return d;
	}

	// 3. Trusted-program exemption (spec §5): the REVIEWED SCRIPT CODE is the authorized
	//    actor, so string rules do not apply — all structural rules above already ran and
	//    ALWAYS do (the exemption lifts nothing structural).
	if (ctx.trusted) {
		return { verdict: "allow", ruleId: RULE_TRUSTED_EXEMPT, reason: "trusted-program exemption: string rules not applied (spec §5); structural rules already decided above" };
	}

	if (tool === "bash" && typeof ctx.command === "string") {
		// 4. String rules (the tripwire layer); deny > ask > allow, first rule per class wins.
		const hits = matchRules(policy, "bash", ctx.command);
		const winner = hits.deny ?? hits.ask ?? hits.allow;
		if (winner) return ruleDecision(winner);
	}

	// 5. Path rules bind read→Read, edit/write→Edit; the worst verdict across paths wins.
	const family = TOOL_FAMILY[tool];
	if ((family === "read" || family === "edit") && ctx.paths) {
		let best: PolicyDecision | null = null;
		for (const p of ctx.paths) {
			const hits = matchRules(policy, family, stripDotSlash(p));
			const winner = hits.deny ?? hits.ask ?? hits.allow;
			if (!winner) continue;
			const d = ruleDecision(winner);
			if (!best || RANK[d.verdict] > RANK[best.verdict]) best = d;
		}
		if (best) return best;
	}

	// 6. Posture default (spec §3): unmatched ⇒ the configured default.
	if (policy.config.posture === "ask") return { verdict: "ask", reason: "no rule matched — default posture ask" };
	return { verdict: "allow", reason: "no rule matched — default posture allow" };
}

interface Hits { deny: PolicyRule | null; ask: PolicyRule | null; allow: PolicyRule | null; }

/** First matching rule per class, in rule order. */
function matchRules(policy: Policy, family: string, value: string): Hits {
	const hits: Hits = { deny: null, ask: null, allow: null };
	for (const rule of policy.rules) {
		if (rule.tool !== family || hits[rule.cls]) continue;
		if (rule.re.test(value)) hits[rule.cls] = rule;
	}
	return hits;
}

/** The install.sh structural rule, or null when the command is not an install invocation. */
function evaluateInstall(policy: Policy, command: string): PolicyDecision | null {
	const toks = command.trim().split(/\s+/).filter(Boolean);
	if (!toks.length) return null;
	if (!isInstalledInstallScript(toks[0], policy.root)) return null;
	const target = toks.slice(1).find((t) => !t.startsWith("-"));
	if (target === undefined) {
		// The real script's documented default installs into the CURRENT DIRECTORY — a target
		// this layer cannot resolve with certainty. Spec §7.2's fail direction is deny, not
		// "usage problem" (the one spelling of the oneshot failure that must not fall through).
		return { verdict: "deny", ruleId: RULE_ONESHOT_UNRESOLVABLE, reason: "install.sh with no declared target defaults to the current directory, which is unresolvable from this context — failing closed (spec §7.2)" };
	}
	if (target === "~" || target.startsWith("~/") || !target.startsWith("/")) {
		return { verdict: "deny", ruleId: RULE_ONESHOT_UNRESOLVABLE, reason: `install target ${target} is unresolvable from the declared context — failing closed (spec §7.2)` };
	}
	switch (classifyTarget(policy, target)) {
		case "secondary":
			return { verdict: "ask", ruleId: RULE_ONESHOT_INSTALL_SECONDARY, reason: `install.sh target is a whitelisted secondary — operator consent required (spec §7.1)` };
		case "foreign":
			return { verdict: "deny", ruleId: RULE_ONESHOT_INSTALL_FOREIGN, reason: `install.sh target outside the repo allowlist — the 2026-11-09 oneshot rule (spec §7.1)` };
		default:
			return null; // self / allowed: falls through to string rules and posture
	}
}
