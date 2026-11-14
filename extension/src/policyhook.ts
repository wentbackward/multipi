// P2 hook layer (permission-policy spec 2026-11-09-multipi-permission-policy.md §4-L1, §6, §8, §11):
// wires the PURE evaluator (policy.ts) into a block-capable tool_call seat, the audit log, and the
// session-start policy hash. Dependency rule: node builtins + the pure modules only — no
// @earendil-works/* imports — so unit tests and (P4) doctor/policy.sh can drive it without pi.
//
// Pinned load behaviours (ticket #40, DECISIONS 2026-11-09):
// - `.devloop.json` missing/unparseable      ⇒ policy INACTIVE + loud one-time warning (the loop
//   itself is non-functional there; bridling every call would protect nothing);
// - `permissions.json` absent                ⇒ policy INACTIVE + loud one-time warning (a fresh
//   install without policy must not bridle every command);
// - `permissions.json` present-but-broken    ⇒ hook ACTIVE, denying everything (fail closed).
//
// Session-start: the effective policy (rules + knobs) is hashed and recorded in the audit log on
// `session_start` (§8 governance). At every NON-DEFAULT verdict the on-disk policy is re-hashed;
// a difference is surfaced as a POLICY DRIFT warning in the block reason AND in the audit line
// (self-loosening becomes audit noise, not a silent change). The hook keeps enforcing the
// SESSION-LOADED policy (no hot reload, §8).
//
// Audit log: <logsDir>/policy-audit.jsonl (logsDir = the devloop-resolved logs dir, default the
// state dir's `logs/` — the same resolution every other devloop log uses). One line per
// non-default verdict (deny/ask) + one per allow BY CURATED RULE (the §3 "allow list is the
// audit baseline" record, including dangerous-class near-misses) + one session-start line per
// session. `actionSummary` is bounded and redacted (token-dir paths and the scenario store path
// never land in the log — spec §8 log hygiene). A failing append never breaks a verdict.
//
// PATH CONVENTION (ticket #40 addendum, spec §9): read/edit/write paths are passed to the
// evaluator in the LITERAL form the model wrote in the tool call — `~` is NOT pre-expanded.
// The seeded token-dir denies are written in the literal-`~` glob convention
// (`Read(~/.multipi/*/dev-loop-tokens/**)`); an expanded path would silently skip them. That
// skip is the documented tripwire-only limit (the secret-minting design does not rely on the
// Read denies, §9) and is test-pinned in both directions.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig, resolvePaths, scenariosOn, DEFAULT_POLICY } from "./config.ts";
import { evaluate, loadPolicy, type Policy, type PolicyContext, type PolicyDecision } from "./policy.ts";

export const AUDIT_LOG_NAME = "policy-audit.jsonl";
/** Bounded action summaries (spec §8): long enough to diagnose, short enough to stay noise-free. */
export const ACTION_SUMMARY_MAX = 160;
/** The rule id an ask-by-POSTURE (no matched rule) escalates under — structural-id family. */
export const RULE_POSTURE_ASK = "posture:ask";
/** `~` is LITERAL in the seeded Read/Edit denies: the evaluator matches it as a first segment. */
const TOKEN_DIR_RE = /(~|\$HOME|\$\{HOME\}|\/)[^\s"'`|;&<>]*dev-loop-tokens[^\s"'`|;&<>]*/g;

/**
 * The session-start hash of the EFFECTIVE policy (spec §8): sha256 over the canonical
 * (posture, repos, secondaries, tokenTtlMinutes) knobs plus every rule as [raw id, class].
 * Rule class is part of the digest — moving a raw rule between deny/ask/allow is a change.
 */
export function policyHash(policy: Policy): string {
	const payload = {
		posture: policy.config.posture,
		repos: policy.config.repos,
		secondaries: policy.config.secondaries,
		tokenTtlMinutes: policy.config.tokenTtlMinutes,
		rules: policy.rules.map((r) => [r.id, r.cls]),
	};
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * The declared action as a PolicyContext (the Layer-1 extraction of §4): command for bash; the
 * SINGLE path target for read/edit/write, in the LITERAL form the model wrote (no `~`
 * expansion, no cwd resolution — the evaluator owns `./` normalization, the hook owns honesty).
 * `gitTargets`/`trusted` are deliberately ABSENT at the hook layer: they need the P3 shim's
 * rev-parse ground truth and PPID-ancestry proof respectively — never derived here.
 */
export function buildPolicyContext(toolName: string, input: Record<string, unknown>, actor: string): PolicyContext {
	const tool = toolName.toLowerCase(); // pi names tools lowercase; the evaluator keys off the same value
	const ctx: PolicyContext = { actor, tool };
	if (tool === "bash") {
		if (typeof input.command === "string") ctx.command = input.command;
		return ctx;
	}
	const p = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : null;
	if (p !== null) ctx.paths = [p];
	return ctx;
}

/** `bash: <command>`, `<tool>: <path[, path]>`, or the bare tool name. */
export function summarizeCall(toolName: string, input: Record<string, unknown>): string {
	const tool = toolName.toLowerCase();
	if (tool === "bash" && typeof input.command === "string") return `bash: ${input.command}`;
	const p = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : null;
	return p !== null ? `${tool}: ${p}` : tool;
}

/**
 * Log hygiene (spec §8): bound the summary and scrub what must not survive — every
 * token-dir path (any home spelling) becomes `<token-dir>`; the scenario store dir becomes
 * `<store>`. Everything else travels verbatim (the summary is a tripwire aid, not a vault).
 */
export function redactSummary(summary: string, storeDir: string | null): string {
	let out = summary.replace(TOKEN_DIR_RE, "<token-dir>");
	if (storeDir && out.includes(storeDir)) out = out.split(storeDir).join("<store>");
	if (out.length > ACTION_SUMMARY_MAX) out = `${out.slice(0, ACTION_SUMMARY_MAX)}…`;
	return out;
}

/** The deny block text (the tripwire: rule id + one-line reason is what makes the model reconsider). */
export function formatDeny(d: PolicyDecision): string {
	return `DENIED ${d.ruleId ?? "policy:unusable"}: ${d.reason ?? ""}`;
}

/** The ask block text — the §6 escalation directive, verbatim shape. */
export function formatAsk(d: PolicyDecision, actionSummary: string): string {
	const ruleId = d.ruleId ?? RULE_POSTURE_ASK;
	return `ASK ${ruleId}: ${actionSummary}. Operator approval required: run 'multipi-approve ${ruleId}' in your own shell, then retry.`;
}

export interface PolicyEnforcer {
	/** false ⇒ every call passes (absent policy; the loud warning already went out at load). */
	active: boolean;
	/** The session-loaded policy (ok:false = broken ⇒ the evaluator denies everything). */
	policy: Policy;
	/** The session-start hash, or null when there is no effective policy to hash. */
	hash: string | null;
	/** The audit log path, or null when no state dir can be resolved. */
	logPath: string | null;
	/** Decide one tool call. Returns the block decision, or undefined (pass). */
	onToolCall(args: { toolName: string; input: Record<string, unknown>; sessionId: string | null }): { block: boolean; reason: string } | undefined;
	/** Write the session-start line (hash of the effective policy) to the audit log. */
	noteSession(sessionId: string | null): void;
}

export interface EnforcerOpts {
	/** The session's working dir at extension load (main root or a linked worktree). */
	root: string;
	env?: NodeJS.ProcessEnv;
	/** Who is acting (carried into every audit line); rules do not scope on it (v1). */
	actor?: string;
	/** Warning sink (default console.warn) — one loud line per load, never per call. */
	warn?: (msg: string) => void;
	/** Line sink (seam for tests); defaults to appending into the state-dir logs. */
	append?: (logPath: string, line: string) => void;
	/** Clock (seam for tests). */
	now?: () => string;
}

export function createPolicyEnforcer(opts: EnforcerOpts): PolicyEnforcer {
	const env = opts.env ?? process.env;
	const warn = opts.warn ?? ((m: string) => console.warn(m));
	const now = opts.now ?? (() => new Date().toISOString());
	const actor = opts.actor ?? "orchestrator";
	const cfg = loadConfig(opts.root, env);
	const storeDir = cfg && scenariosOn(cfg) ? resolvePaths(cfg, env).scenariosDir : null;
	let logPath: string | null = null;
	if (cfg) {
		try {
			logPath = path.join(resolvePaths(cfg, env).logsDir, AUDIT_LOG_NAME);
		} catch {
			logPath = null; // unresolvable logs dir ⇒ audit is degraded, verdicts are not
		}
	}
	const warnedAppend = { once: false };
	const append = (line: object): void => {
		if (!logPath) return;
		try {
			(opts.append ?? ((p, l) => { mkdirSync(path.dirname(p), { recursive: true }); appendFileSync(p, `${l}\n`); }))(logPath, JSON.stringify(line));
		} catch (e) {
			if (!warnedAppend.once) {
				warnedAppend.once = true;
				warn(`multipi policy: audit log write failed (${(e as Error).message}) — verdicts unaffected, audit DEGRADED until it works`);
			}
		}
	};

	// --- load once (spec §8: no hot reload — governance rides the ordinary pipeline) ---
	if (!cfg) {
		// loadConfig returns null for MISSING and for PRESENT-BUT-CORRUPT .devloop.json alike.
		// Missing ⇒ the loop is non-functional here ⇒ INACTIVE. Corrupt ⇒ the config is
		// agent-writable self-disarm of the policy layer: ACTIVE and denying, exactly like a
		// broken permissions.json (P3 review round 2; version-controlled ⇒ existsSync at the
		// acting root is the distinction).
		let corrupt = false;
		try { corrupt = existsSync(path.join(opts.root, ".devloop.json")); } catch { corrupt = false; }
		if (corrupt) {
			warn("multipi policy: .devloop.json is present but unparseable — hook ACTIVE and denying every tool call until it is repaired (a corrupt config must not self-disarm the policy layer)");
			const deadBroken: Policy = { ok: false, error: ".devloop.json present but unparseable", root: opts.root, scopeRoot: opts.root, config: DEFAULT_POLICY, rules: [], hasPermissionsFile: false };
			const state: PolicyEnforcer = {
				active: true, policy: deadBroken, hash: null, logPath,
				onToolCall: (args) => denyEvery(args, ".devloop.json present but unparseable — failing closed; repair the file or the call is denied"),
				noteSession: (sid) => append(sessionLine(sid, "broken", null)),
			};
			return state;
		}
		warn("multipi policy: no usable .devloop.json in this session's working dir — policy hook INACTIVE (every tool call passes); the devloop itself is non-functional here");
		const dead: Policy = { ok: false, error: "no usable .devloop.json", root: opts.root, scopeRoot: opts.root, config: DEFAULT_POLICY, rules: [], hasPermissionsFile: false };
		return {
			active: false, policy: dead, hash: null, logPath,
			onToolCall: () => undefined,
			noteSession: (sid) => append(sessionLine(sid, "inactive", null)),
		};
	}
	const policy = loadPolicy(opts.root, env);
	if (!policy.ok) {
		// BROKEN-present: the hook is ACTIVE and denies everything non-trusted — the loudness is
		// the refusal itself; the load-time warning tells the operator WHY.
		warn(`multipi policy: ${policy.error} — hook ACTIVE and denying every tool call until the policy is repaired`);
		const state: PolicyEnforcer = {
			active: true, policy, hash: null, logPath,
			onToolCall: (args) => denyEvery(args, "policy unusable — failing closed; repair the policy file or the call is denied"),
			noteSession: (sid) => append(sessionLine(sid, "broken", null)),
		};
		return state;
	}
	if (!policy.hasPermissionsFile) {
		warn("multipi policy: no permissions.json next to .devloop.json — policy hook INACTIVE (every tool call passes); seed permissions.json to arm the tripwire");
		return {
			active: false, policy, hash: null, logPath,
			onToolCall: () => undefined,
			noteSession: (sid) => append(sessionLine(sid, "inactive", null)),
		};
	}

	const hash = policyHash(policy);

	function sessionLine(sid: string | null, verdict: string, policyHash: string | null): object {
		return { ts: now(), event: "policy_session_start", session: sid ?? "-", actor, ruleId: "", verdict, actionSummary: "", layer: "hook", policyHash };
	}

	function denyEvery(args: { toolName: string; input: Record<string, unknown>; sessionId: string | null }, reason: string): { block: boolean; reason: string } {
		const decision: PolicyDecision = { verdict: "deny", ruleId: "policy:unusable", reason };
		const summary = redactSummary(summarizeCall(args.toolName, args.input), storeDir);
		append(verdictLine(args, decision, summary, null, null));
		return { block: true, reason: formatDeny(decision) };
	}

	// The on-disk policy re-hashed at each non-default verdict (drift, §8). Cheap and rare:
	// non-default verdicts are exactly the interesting moments.
	function diskHash(): string {
		try {
			const fresh = loadPolicy(opts.root, env);
			return fresh.ok ? policyHash(fresh) : "unusable";
		} catch {
			return "unreadable";
		}
	}

	function verdictLine(
		args: { toolName: string; input: Record<string, unknown>; sessionId: string | null },
		d: PolicyDecision,
		actionSummary: string,
		drift: boolean | null,
		dh: string | null,
	): object {
		const line: Record<string, unknown> = {
			ts: now(),
			event: "verdict",
			session: args.sessionId ?? "-",
			actor,
			ruleId: d.ruleId ?? "",
			verdict: d.verdict,
			actionSummary,
			layer: "hook",
		};
		if (drift) {
			line.policyDrift = true;
			line.diskPolicyHash = dh;
			line.sessionPolicyHash = hash;
		}
		return line;
	}

	const state: PolicyEnforcer = {
		active: true, policy, hash, logPath,
		onToolCall: (args) => {
			const ctx = buildPolicyContext(args.toolName, args.input, actor);
			const d = evaluate(policy, ctx);
			const summary = redactSummary(summarizeCall(args.toolName, args.input), storeDir);
			if (d.verdict === "allow") {
				// Curated-allow match (ruleId set) = the audit baseline / near-miss record; a
				// posture default (no ruleId) is the steady state and stays out of the log.
				if (d.ruleId) append(verdictLine(args, d, summary, null, null));
				return undefined;
			}
			// Non-default verdict: drift check FIRST (§8 warns at every non-default verdict).
			const dh = diskHash();
			// "unreadable" = a transient disk failure on the RE-READ, not a policy change: it must
			// not masquerade as drift (spurious warnings are noise the operator stops trusting).
			const drifted = dh !== "unreadable" && dh !== hash;
			const reason = d.verdict === "deny"
				? formatDeny(d)
				: formatAsk(d, summary);
			const text = drifted
				? `POLICY DRIFT: on-disk policy hash ${dh} != session-loaded hash ${hash} — enforcing the session-loaded policy (no hot reload). ${reason}`
				: reason;
			append(verdictLine(args, d, summary, drifted ? true : null, drifted ? dh : null));
			return { block: true, reason: text };
		},
		noteSession: (sid) => append(sessionLine(sid, "loaded", hash)),
	};
	return state;
}
