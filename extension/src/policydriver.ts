// The P3 shim's policy brain (permission-policy spec 2026-11-09-multipi-permission-policy.md
// §4-L2, §5, §8): the git/gh shims (scripts/policy-shims/) gather GROUND TRUTH — the acting
// repository from rev-parse, refspec/force/tag facts from the real argv, the ancestor
// script list from /proc — and hand it here as argv. This driver loads the SAME policy and
// runs the SAME pure evaluator (policy.ts) the P2 hook uses, appends the audit line
// (layer=shim, the hook's seven fields plus the layer key — eight total), and prints the verdict:
//
//   ALLOW                      → the shim execs the real binary with argv untouched
//   BLOCK<TAB>LINE             → the shim prints LINE verbatim to stderr and exits 126
//   INACTIVE\n<why>            → no effective policy here: the shim passes through silently
//
// Any internal failure exits non-zero and prints nothing usable on stdout — the shims fail
// CLOSED (deny policy:shim-error) on that. Dependency rule: node builtins + the pure
// modules only — no @earendil-works/* imports, so plain `node policydriver.ts` runs it
// (Node 24 type stripping; no build step).
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig, resolvePaths } from "./config.ts";
import {
	evaluate, loadPolicy, hasTrustedAncestor,
	formatPolicyDeny, formatPolicyAsk, redactActionSummary,
	type PolicyContext,
} from "./policy.ts";

const USAGE =
	"policydriver --root <checkout> --command <line> [--target <root>]... [--unresolvable-target] " +
	"[--push-force] [--push-base] [--push-tags] [--tag-mutation] [--gh-action repo-delete|pr-merge] " +
	"[--candidate <script>]... [--session <id>]";

function fail(msg: string): never {
	process.stderr.write(`policydriver: ${msg}\n`);
	process.exit(1);
}

function parseArgs(argv: string[]): {
	root: string; command: string; targets: (string | null)[];
	pushForce: boolean; pushBase: boolean; pushTags: boolean;
	tagMutation: boolean; ghAction: "repo-delete" | "pr-merge" | undefined;
	candidates: string[]; session: string;
} {
	let root = "", command = "", ghAction: "repo-delete" | "pr-merge" | undefined;
	let pushForce = false, pushBase = false, pushTags = false, tagMutation = false;
	const targets: (string | null)[] = [];
	const candidates: string[] = [];
	let session = "-";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = (): string => {
			i++;
			return i < argv.length ? argv[i] : fail(`${a} needs a value`);
		};
		switch (a) {
			case "--root": root = next(); break;
			case "--command": command = next(); break;
			case "--target": targets.push(next()); break;
			case "--unresolvable-target": targets.push(null); break;
			case "--push-force": pushForce = true; break;
			case "--push-base": pushBase = true; break;
			case "--push-tags": pushTags = true; break;
			case "--tag-mutation": tagMutation = true; break;
			case "--gh-action": {
				const v = next();
				if (v !== "repo-delete" && v !== "pr-merge") fail("--gh-action must be repo-delete|pr-merge");
				ghAction = v;
				break;
			}
			case "--candidate": candidates.push(next()); break;
			case "--session": session = next(); break;
			default: fail(`unknown argument ${a}\n${USAGE}`);
		}
	}
	if (!root) fail(`missing --root\n${USAGE}`);
	return { root, command, targets, pushForce, pushBase, pushTags, tagMutation, ghAction, candidates, session };
}

/** The audit log path (the devloop logs dir; the hook writes to the same file). */
function auditPath(root: string): string | null {
	try {
		const cfg = loadConfig(root);
		if (cfg) return path.join(resolvePaths(cfg).logsDir, "policy-audit.jsonl");
	} catch {
		/* fall through */
	}
	return null;
}

function main(): void {
	const a = parseArgs(process.argv.slice(2));
	let warnedAudit = false;
	const append = (line: object): void => {
		const p = auditPath(a.root);
		if (!p) return;
		try {
			mkdirSync(path.dirname(p), { recursive: true });
			appendFileSync(p, `${JSON.stringify(line)}\n`);
		} catch (e) {
			if (!warnedAudit) {
				warnedAudit = true;
				process.stderr.write(`policydriver: audit log write failed (${(e as Error).message}) — verdicts unaffected, audit DEGRADED\n`);
			}
		}
	};

	// Load semantics mirror the P2 hook: no .devloop.json ⇒ the loop itself is non-functional
	// here ⇒ INACTIVE (pass through); a missing permissions.json ⇒ not armed ⇒ INACTIVE.
	// A PRESENT-BUT-BROKEN policy file is NOT inactive: it falls through to the unusable-deny
	// (a corrupted config is agent-writable self-disarm of Layer-2 and must not pass everything
	// through — P3 review round 2; loadConfig returns null for missing AND unparseable, so the
	// distinction is an existsSync on the version-controlled config at the acting root).
	const policy = loadPolicy(a.root);
	if (!policy.ok && policy.error?.startsWith(".devloop.json")) {
		let present = false;
		try { present = existsSync(path.join(a.root, ".devloop.json")); } catch { present = false; }
		if (!present) {
			console.log(`INACTIVE\n${policy.error}`);
			return;
		}
		// present-but-unparseable: fall through to the unusable deny below.
	}
	if (policy.ok && !policy.hasPermissionsFile) {
		console.log("INACTIVE\nno permissions.json next to .devloop.json — policy not armed");
		return;
	}

	const trusted = hasTrustedAncestor(a.candidates, a.root);
	const ctx: PolicyContext = { actor: "shim", tool: "bash", command: a.command };
	if (a.targets.length > 0) ctx.gitTargets = a.targets;
	if (a.pushForce || a.pushBase || a.pushTags) ctx.gitPush = { force: a.pushForce, baseRef: a.pushBase, tags: a.pushTags };
	if (a.tagMutation) ctx.gitTagMutation = true;
	if (a.ghAction) ctx.ghAction = a.ghAction;
	if (trusted) ctx.trusted = true;

	const d = evaluate(policy, ctx);
	// Audit exactly like the hook: every non-default verdict + every allow BY CURATED RULE
	// (the baseline / near-miss record; the posture default stays out of the log).
	if (d.verdict !== "allow" || d.ruleId) {
		append({
			ts: new Date().toISOString(),
			event: "verdict",
			session: a.session,
			actor: "shim",
			ruleId: d.ruleId ?? "",
			verdict: d.verdict,
			actionSummary: redactActionSummary(a.command),
			layer: "shim",
		});
	}
	if (d.verdict === "allow") {
		console.log("ALLOW");
		return;
	}
	const line = d.verdict === "deny"
		? formatPolicyDeny(d)
		: formatPolicyAsk(d, redactActionSummary(a.command));
	console.log(`BLOCK\t${line}`);
}

try {
	main();
} catch (e) {
	fail((e as Error).message);
}
