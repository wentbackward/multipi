// Unit tests for the permission-policy evaluator (extension/src/policy.ts) and the
// policy-block schema in config.ts (spec 2026-11-09-multipi-permission-policy.md §3, §5,
// §7, §11-P1). Runs under plain node (type stripping) — no pi imports, no network;
// everything is a temp git fixture or a plain string.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixture } from "../fixtures.ts";
import {
	loadPolicy, evaluate, isTrustedProgram,
	RULE_POLICY_UNUSABLE, RULE_ONESHOT_FOREIGN, RULE_ONESHOT_SECONDARY, RULE_ONESHOT_UNRESOLVABLE,
	RULE_ONESHOT_INSTALL_FOREIGN, RULE_ONESHOT_INSTALL_SECONDARY, RULE_TRUSTED_EXEMPT,
} from "../../extension/src/policy.ts";

/** Scratch git repo; `cfg`/`file` rewrite .devloop.json / add files on disk before loadPolicy. */
function policyFx(fn: (root: string, cfg: (json: string) => void, file: (rel: string, content: string) => void) => void): void {
	const fx = makeFixture("{}");
	try {
		fn(
			fx.repo,
			(json) => writeFileSync(path.join(fx.repo, ".devloop.json"), json),
			(rel, content) => { mkdirSync(path.dirname(path.join(fx.repo, rel)), { recursive: true }); writeFileSync(path.join(fx.repo, rel), content); },
		);
	} finally { fx.cleanup(); }
}

const perms = (deny: string[] = [], allow: string[] = [], ask: string[] = []) =>
	JSON.stringify({ permissions: { deny, allow, ask } });

const ORCH = { actor: "orchestrator", tool: "bash" };

// --- loader: present vs absent vs unusable -----------------------------------

test("loadPolicy: missing permissions.json is ABSENT policy — ok, zero rules, posture governs", () => {
	policyFx((root, cfg) => {
		cfg("{}");
		const p = loadPolicy(root);
		assert.equal(p.ok, true);
		assert.equal(p.hasPermissionsFile, false);
		assert.deepEqual(p.rules, []);
		assert.deepEqual(p.config, { posture: "allow", repos: ["self"], secondaries: [], tokenTtlMinutes: 10 });
		assert.equal(evaluate(p, { ...ORCH, command: "git push -u origin main" }).verdict, "allow");
	});
});

test("loadPolicy: corrupt permissions.json makes the policy UNUSABLE — every call denies", () => {
	policyFx((root, cfg, file) => {
		cfg('{"policy": {"posture": "ask"}}');
		file("permissions.json", "{not json");
		const p = loadPolicy(root);
		assert.equal(p.ok, false);
		assert.ok(p.error);
		const d = evaluate(p, { ...ORCH, command: "git status" });
		assert.equal(d.verdict, "deny");
		assert.equal(d.ruleId, RULE_POLICY_UNUSABLE);
		assert.ok(d.reason);
	});
});

test("unusable policy != absent policy: absent allows by posture, unusable denies everything (fail closed)", () => {
	let absentVerdict = "";
	policyFx((root, cfg) => {
		cfg('{"policy": {"posture": "ask"}}');
		const absent = loadPolicy(root);
		assert.equal(absent.ok, true);
		absentVerdict = evaluate(absent, ORCH).verdict; // posture ask, no rules
	});
	assert.equal(absentVerdict, "ask"); // absent ⇒ posture governs (would have asked, not denied)
	policyFx((root, cfg, file) => {
		cfg('{"policy": {"posture": "ask"}}');
		for (const bad of ['{"permissions": "nope"}', '{"permissions": {"deny": "Bash(x)"}}', '[]']) {
			file("permissions.json", bad);
			const broken = loadPolicy(root);
			assert.equal(broken.ok, false, `shape ${bad} must not load`);
		}
	});
});

test("loadPolicy: accepts the operator's wrapped shape AND bare {deny,allow,ask}", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", JSON.stringify({ permissions: { deny: ["Bash(sudo:*)"], allow: ["Bash(git status *)"], ask: [] } }));
		assert.equal(loadPolicy(root).rules.length, 2);
		file("permissions.json", JSON.stringify({ deny: ["Bash(sudo:*)"], allow: [], ask: [] }));
		assert.equal(loadPolicy(root).rules.length, 1);
	});
});

test("loadPolicy: a non-string rule entry makes the policy unusable", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", JSON.stringify({ permissions: { deny: ["Bash(x:*)", 42], allow: [], ask: [] } }));
		const p = loadPolicy(root);
		assert.equal(p.ok, false);
		assert.equal(evaluate(p, ORCH).ruleId, RULE_POLICY_UNUSABLE);
	});
});

test("loadPolicy: a malformed rule (no Tool(pattern) form, or empty pattern) makes the policy unusable", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		for (const bad of ["git status", "Bash()", "Bash(a)b)"]) {
			file("permissions.json", JSON.stringify({ permissions: { deny: [bad], allow: [], ask: [] } }));
			const p = loadPolicy(root);
			assert.equal(p.ok, false, `rule ${JSON.stringify(bad)} must be rejected`);
			assert.match(p.error ?? "", new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `error must name the bad rule`);
		}
	});
});

test("loadPolicy: missing or unparseable .devloop.json ⇒ unusable (the policy cannot be classified)", () => {
	const plain = mkdtempSync(path.join(tmpdir(), "np-pol-"));
	assert.equal(loadPolicy(plain).ok, false);
});

test("loadPolicy: policy knobs ride along from the .devloop.json policy block", () => {
	policyFx((root, cfg) => {
		cfg(JSON.stringify({ policy: { repos: ["self", "/srv/alt"], secondaries: ["/srv/sec"], token_ttl_minutes: 5 } }));
		const p = loadPolicy(root);
		assert.equal(p.ok, true);
		assert.deepEqual(p.config.repos, ["self", "/srv/alt"]);
		assert.deepEqual(p.config.secondaries, ["/srv/sec"]);
		assert.equal(p.config.tokenTtlMinutes, 5);
	});
});

// --- Bash rule semantics (pinned: leading-prefix + `*` wildcards) ------------

test("Bash rules: `prefix:*` is prefix shorthand (bare prefix and continuations match, longer stem does not)", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", perms(["Bash(git log:*)"]));
		const p = loadPolicy(root);
		const ev = (cmd: string) => evaluate(p, { ...ORCH, command: cmd }).verdict;
		assert.equal(ev("git log"), "deny");
		assert.equal(ev("git log -5 --stat"), "deny");
		assert.equal(ev("git lo"), "allow", "a shorter/different stem is not a continuation of the prefix");
		assert.equal(ev("git logspam"), "allow", "prefix is anchored at a token start — `git log:*` must not admit `git logspam`");
	});
});

test("Bash rules: `*` spans ANY run of characters (spaces, slashes); exact rules are anchored", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", perms(
			["Bash(*git*push*--force*)"],
			["Bash(git remote -v)"],
		));
		const p = loadPolicy(root);
		const ev = (cmd: string) => evaluate(p, { ...ORCH, command: cmd }).verdict;
		assert.equal(ev("git push --force origin main"), "deny");
		assert.equal(ev("cd /srv/x && git push --force"), "deny", "mid-command match across spaces/slashes");
		assert.equal(ev("git remote -v"), "allow");
		assert.equal(ev("git remote -vv"), "allow", "anchored: no partial match");
	});
});

test("Bash rules: `cmd *` requires content after the space; matching is case-sensitive", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", perms([], ["Bash(git status *)"], ["Bash(sudo:*)"]));
		const p = loadPolicy(root);
		const v = (cmd: string) => evaluate(p, { ...ORCH, command: cmd }).verdict;
		assert.equal(v("git status --short"), "allow");
		assert.equal(v("git status"), "allow", "posture default, not the rule (no ruleId below)");
		assert.equal(evaluate(p, { ...ORCH, command: "git status" }).ruleId, undefined);
		assert.equal(v("sudo rm -rf /tmp/x"), "ask");
		assert.equal(v("SUDO rm -rf /tmp/x"), "allow", "case-sensitive: uppercase does not trip the tripwire rule");
	});
});

// --- Read/Edit path glob semantics -------------------------------------------

test("Read/Edit rules: `*` is ONE path component, `**` is any depth, `~` is a literal segment", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", perms([
			"Read(~/.multipi/*/dev-loop-tokens/**)",
			"Edit(src/*.ts)",
		]));
		const p = loadPolicy(root);
		const ev = (tool: string, pth: string) => evaluate(p, { actor: "orchestrator", tool, paths: [pth] }).verdict;
		assert.equal(ev("read", "~/.multipi/proj/dev-loop-tokens/a.b.tok"), "deny");
		assert.equal(ev("read", "~/.multipi/a/b/proj/dev-loop-tokens/a.tok"), "allow", "`*` must not cross a component");
		assert.equal(ev("edit", "src/x.ts"), "deny");
		assert.equal(ev("edit", "src/deep/x.ts"), "allow", "`*` is one component for Edit globs");
	});
});

test("Bash rules keep `./` LITERAL (path normalization is a Read/Edit concept): a `./`-spelled deny trips the runnable spelling only", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", perms(
			["Bash(./evil-script.sh *)"],
			["Bash(./scripts/ok.sh *)"],
		));
		const p = loadPolicy(root);
		const ev = (cmd: string) => evaluate(p, { ...ORCH, command: cmd });
		assert.equal(ev("./evil-script.sh --now").verdict, "deny", "the runnable spelling is the one the deny rule exists to trip");
		assert.equal(ev("./evil-script.sh --now").ruleId, "Bash(./evil-script.sh *)");
		assert.equal(ev("evil-script.sh --now").verdict, "allow", "the non-`./` spelling is a different command prefix — not this rule");
		const ok = ev("./scripts/ok.sh --x");
		assert.equal(ok.verdict, "allow");
		assert.equal(ok.ruleId, "Bash(./scripts/ok.sh *)", "seeded ./scripts allow rules must match real invocations (carry a ruleId)");
	});
});

test("Read/Edit rules: leading `./` is normalized away (`.env` matches `Read(./.env)`; `.env.local` matches `./.env.*`; `.envrc` does not)", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", perms(["Read(./.env)", "Read(./.env.*)"]));
		const p = loadPolicy(root);
		const ev = (pth: string) => evaluate(p, { actor: "orchestrator", tool: "read", paths: [pth] }).verdict;
		assert.equal(ev(".env"), "deny");
		assert.equal(ev("./.env"), "deny");
		assert.equal(ev(".env.production"), "deny");
		assert.equal(ev(".envrc"), "allow", "the literal dot of `./.env.*` must not elide");
		assert.equal(ev(".//.env"), "deny", "dot-dot-slash spells the SAME file: it must not reclassify to absolute `/.env`");
	});
});

test("classifyTarget: a symlinked root/target is still SELF (realpath comparison, no false foreign deny)", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", perms());
		const p = loadPolicy(root);
		// A symlink to the repo root: the path differs lexically but is the same repository.
		const link = root + "-link";
		symlinkSync(root, link);
		const d = evaluate(p, { ...ORCH, command: "git commit", gitTargets: [link] });
		assert.notEqual(d.ruleId, RULE_ONESHOT_FOREIGN, "a symlinked view of self must not be foreign");
		assert.equal(d.verdict, "allow", "self-through-symlink passes to rules/posture");
	});
});

test("Edit rules bind to both edit and write tools; Read rules do not bind to edit", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", perms(["Read(./.env)"], [], ["Edit(./.env)"]));
		const p = loadPolicy(root);
		assert.equal(evaluate(p, { actor: "orchestrator", tool: "write", paths: [".env"] }).verdict, "ask");
		assert.equal(evaluate(p, { actor: "orchestrator", tool: "read", paths: [".env"] }).verdict, "deny");
		assert.equal(evaluate(p, { actor: "orchestrator", tool: "edit", paths: [".env"] }).verdict, "ask");
		assert.equal(evaluate(p, { actor: "orchestrator", tool: "bash", paths: [".env"] }).verdict, "allow", "path rules never bind to bash");
	});
});

test("path rules: one denied path wins the call even when the others are clean", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", perms(["Read(./.env)"]));
		const p = loadPolicy(root);
		const d = evaluate(p, { actor: "orchestrator", tool: "read", paths: ["src/ok.ts", ".env"] });
		assert.equal(d.verdict, "deny");
		assert.equal(d.ruleId, "Read(./.env)");
	});
});

// --- verdict classes, precedence, posture ------------------------------------

test("precedence: deny beats ask+allow on one command; ask beats allow", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", perms(["Bash(git log:*)"], ["Bash(git log:*)"], ["Bash(git log:*)"]));
		const p = loadPolicy(root);
		const d = evaluate(p, { ...ORCH, command: "git log -1" });
		assert.equal(d.verdict, "deny");
		assert.equal(d.ruleId, "Bash(git log:*)");

		file("permissions.json", perms([], ["Bash(git log:*)"], ["Bash(git log:*)"]));
		const d2 = evaluate(loadPolicy(root), { ...ORCH, command: "git log -1" });
		assert.equal(d2.verdict, "ask");

		file("permissions.json", perms([], ["Bash(git log:*)"], []));
		assert.equal(evaluate(loadPolicy(root), { ...ORCH, command: "git log -1" }).verdict, "allow");
	});
});

test("an unmatched call follows the posture default (allow), with no ruleId", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", perms(["Bash(other:*)"]));
		const d = evaluate(loadPolicy(root), { ...ORCH, command: "ls -la" });
		assert.equal(d.verdict, "allow");
		assert.equal(d.ruleId, undefined);
		assert.match(d.reason ?? "", /posture/);
	});
});

test("posture flip: posture ask makes every unmatched call ask", () => {
	policyFx((root, cfg) => {
		cfg('{"policy": {"posture": "ask"}}');
		const d = evaluate(loadPolicy(root), ORCH);
		assert.equal(d.verdict, "ask");
		assert.match(d.reason ?? "", /posture/);
	});
});

// --- the three oneshot-delta rules (spec §7) ----------------------------------

test("oneshot rule 1: a git target outside self/repos/secondaries ⇒ deny (foreign-repo mutation)", () => {
	policyFx((root, cfg) => {
		cfg("{}");
		const p = loadPolicy(root);
		const d = evaluate(p, { ...ORCH, command: "git push origin main", gitTargets: ["/somewhere/foreign"] });
		assert.equal(d.verdict, "deny");
		assert.equal(d.ruleId, RULE_ONESHOT_FOREIGN);
	});
});

test("oneshot rule 1: a git target in secondaries ⇒ ask (whitelisted secondary needs consent)", () => {
	policyFx((root, cfg) => {
		const sec = "/somewhere/secondary";
		cfg(JSON.stringify({ policy: { secondaries: [sec] } }));
		const p = loadPolicy(root);
		const d = evaluate(p, { ...ORCH, command: "git push origin main", gitTargets: [sec] });
		assert.equal(d.verdict, "ask");
		assert.equal(d.ruleId, RULE_ONESHOT_SECONDARY);
	});
});

test("oneshot rule 3: the repo allowlist is data — an explicit repos entry lifts the structural verdict", () => {
	policyFx((root, cfg) => {
		const alt = "/srv/allowed-alt";
		cfg(JSON.stringify({ policy: { repos: ["self", alt] } }));
		const p = loadPolicy(root);
		assert.equal(evaluate(p, { ...ORCH, gitTargets: [alt] }).verdict, "allow");
		assert.equal(evaluate(p, { ...ORCH, gitTargets: [root] }).verdict, "allow", "self is always in scope");
	});
});

test("oneshot rule 2: an unresolvable git target (null) ⇒ deny, fail closed", () => {
	policyFx((root, cfg) => {
		cfg("{}");
		const p = loadPolicy(root);
		const d = evaluate(p, { ...ORCH, command: "git push", gitTargets: [null] });
		assert.equal(d.verdict, "deny");
		assert.equal(d.ruleId, RULE_ONESHOT_UNRESOLVABLE);
		assert.match(d.reason ?? "", /unresolvable/i);
	});
});

test("multi-target calls take the WORST target: foreign+secondary ⇒ deny, self+secondary ⇒ ask", () => {
	policyFx((root, cfg) => {
		const sec = "/somewhere/secondary";
		cfg(JSON.stringify({ policy: { secondaries: [sec] } }));
		const p = loadPolicy(root);
		assert.equal(evaluate(p, { ...ORCH, gitTargets: [sec, "/foreign"] }).verdict, "deny");
		assert.equal(evaluate(p, { ...ORCH, gitTargets: [root, sec] }).verdict, "ask");
		assert.equal(evaluate(p, { ...ORCH, gitTargets: [null, root] }).verdict, "deny", "unresolvable beats self");
	});
});

test("oneshot install rule: install.sh <foreign> ⇒ deny; <secondary> ⇒ ask; relative/~ target ⇒ unresolvable deny; self ⇒ falls through", () => {
	policyFx((root, cfg, file) => {
		const sec = "/somewhere/secondary";
		cfg(JSON.stringify({ policy: { secondaries: [sec] } }));
		file("scripts/install.sh", "#!/usr/bin/env bash\ntrue\n");
		const p = loadPolicy(root);
		const ev = (command: string) => evaluate(p, { ...ORCH, command });
		const foreign = ev(`${root}/scripts/install.sh /somewhere/foreign`);
		assert.equal(foreign.verdict, "deny");
		assert.equal(foreign.ruleId, RULE_ONESHOT_INSTALL_FOREIGN);
		const secondary = ev(`scripts/install.sh ${sec}`);
		assert.equal(secondary.verdict, "ask");
		assert.equal(secondary.ruleId, RULE_ONESHOT_INSTALL_SECONDARY);
		const rel = ev(`scripts/install.sh ./relative-target`);
		assert.equal(rel.verdict, "deny");
		assert.equal(rel.ruleId, RULE_ONESHOT_UNRESOLVABLE);
		const tilde = ev(`scripts/install.sh ~/foreign`);
		assert.equal(tilde.verdict, "deny");
		assert.equal(tilde.ruleId, RULE_ONESHOT_UNRESOLVABLE);
		const self = ev(`scripts/install.sh ${root}`);
		assert.equal(self.verdict, "allow", "self install falls through to rules/posture");
		const flagged = ev(`scripts/install.sh --yes ${sec}`);
		assert.equal(flagged.verdict, "ask", "flags are skipped when finding the target");
		assert.equal(ev(`scripts/install.sh`).verdict, "deny", "no declared target defaults to cwd — unresolvable ⇒ deny (§7.2)");
		assert.equal(ev(`scripts/install.sh`).ruleId, RULE_ONESHOT_UNRESOLVABLE);
	});
});

// --- trusted-program identity and the §5 exemption ----------------------------

test("trusted-program identity: realpath inside the installed scripts dir only (.sh, no symlink escape)", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
		file("scripts/foo.sh", "#!/usr/bin/env bash\ntrue\n");
		file("scripts/lib/helper.sh", "#!/usr/bin/env bash\ntrue\n");
		file("scripts/notascript.txt", "x");
		const outside = mkdtempSync(path.join(tmpdir(), "np-outside-"));
		writeFileSync(path.join(outside, "evil.sh"), "#!/usr/bin/env bash\ntrue\n");
		symlinkSync(path.join(outside, "evil.sh"), path.join(root, "scripts", "link.sh"));
		assert.equal(isTrustedProgram("scripts/foo.sh", root), true, "relative path from repo root");
		assert.equal(isTrustedProgram(path.join(root, "scripts", "lib", "helper.sh"), root), true, "absolute + nested");
		assert.equal(isTrustedProgram("scripts/link.sh", root), false, "symlink escaping the scripts dir is NOT trusted");
		assert.equal(isTrustedProgram("scripts/ghost.sh", root), false, "missing file is not trusted");
		assert.equal(isTrustedProgram("scripts/notascript.txt", root), false, "non-.sh is not trusted");
		assert.equal(isTrustedProgram(path.join(outside, "evil.sh"), root), false, "outside the scripts dir");
		assert.equal(isTrustedProgram("git", root), false, "bare command names are not trusted (no install path)");
	});
});

test("trusted exemption: a proven trusted child skips STRING rules (the force-push deny does not fire)", () => {
	policyFx((root, cfg, file) => {
		cfg("{}");
		file("permissions.json", perms(["Bash(*git*push*--force*)"]));
		const p = loadPolicy(root);
		assert.equal(evaluate(p, { ...ORCH, command: "git push --force", trusted: true }).verdict, "allow");
		const d = evaluate(p, { ...ORCH, command: "git push --force", trusted: true });
		assert.equal(d.ruleId, RULE_TRUSTED_EXEMPT);
		assert.equal(evaluate(p, { ...ORCH, command: "git push --force" }).verdict, "deny", "without proof it still denies");
	});
});

test("trusted exemption never lifts the STRUCTURAL rules (foreign target, unresolvable target, unusable policy)", () => {
	policyFx((root, cfg, file) => {
		cfg(JSON.stringify({ policy: { secondaries: ["/somewhere/secondary"] } }));
		file("permissions.json", perms());
		const p = loadPolicy(root);
		assert.equal(evaluate(p, { ...ORCH, command: "git push", gitTargets: ["/foreign"], trusted: true }).ruleId, RULE_ONESHOT_FOREIGN);
		assert.equal(evaluate(p, { ...ORCH, command: "git push", gitTargets: ["/somewhere/secondary"], trusted: true }).ruleId, RULE_ONESHOT_SECONDARY);
		assert.equal(evaluate(p, { ...ORCH, command: "git push", gitTargets: [null], trusted: true }).ruleId, RULE_ONESHOT_UNRESOLVABLE);
		const broken = { ...p, ok: false, error: "planted" };
		assert.equal(evaluate(broken, { ...ORCH, trusted: true }).ruleId, RULE_POLICY_UNUSABLE);
	});
});

test("trusted + install.sh: the install structural rule outranks the exemption (the 2026-11-09 failure class no exemption reopens)", () => {
	policyFx((root, cfg, file) => {
		cfg(JSON.stringify({ policy: { secondaries: ["/somewhere/secondary"] } }));
		file("permissions.json", perms());
		file("scripts/install.sh", "#!/usr/bin/env bash\ntrue\n");
		const p = loadPolicy(root);
		const foreign = evaluate(p, { ...ORCH, command: `${root}/scripts/install.sh /somewhere/foreign`, trusted: true });
		assert.equal(foreign.verdict, "deny", "trusted install.sh with a FOREIGN target is still denied");
		assert.equal(foreign.ruleId, RULE_ONESHOT_INSTALL_FOREIGN);
		const secondary = evaluate(p, { ...ORCH, command: `scripts/install.sh /somewhere/secondary`, trusted: true });
		assert.equal(secondary.verdict, "ask", "trusted install.sh with a SECONDARY target still asks");
		assert.equal(secondary.ruleId, RULE_ONESHOT_INSTALL_SECONDARY);
	});
});

// --- the dogfood seed ----------------------------------------------------------

test("seeded permissions.json: parses, and encodes the operator's dialect + the oneshot-delta base-branch push ask", () => {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const p = loadPolicy(repoRoot);
	assert.equal(p.ok, true, `repo permissions.json must load: ${p.error ?? ""}`);
	assert.ok(p.rules.length >= 10, "the seed carries the adapted reference rules");
	const denyOf = (c: string) => evaluate(p, { ...ORCH, command: c });
	assert.equal(denyOf("git push --force origin main").ruleId, "Bash(*git*push*--force*)");
	assert.equal(denyOf("gh pr merge 42 --admin").ruleId, "Bash(*gh pr merge*--admin*)");
	assert.equal(denyOf("gh repo delete x/y").ruleId, "Bash(gh repo delete:*)");
	assert.equal(denyOf("sudo reboot").ruleId, "Bash(sudo:*)");
	const read = (pth: string) => evaluate(p, { actor: "orchestrator", tool: "read", paths: [pth] });
	assert.equal(read("~/.multipi/proj/dev-loop-tokens/x.tok").verdict, "deny", "token-dir denial rides in the seed");
	assert.equal(read(".env").verdict, "deny");
	const askOf = (c: string) => evaluate(p, { ...ORCH, command: c });
	assert.equal(askOf("scripts/cleanup-worktrees.sh --apply").verdict, "ask", "cleanup --apply asks");
	assert.equal(askOf("git push origin main").verdict, "ask", "base-branch push asks (defense in depth)");
	assert.equal(askOf("git push origin main --force").verdict, "deny", "force beats the base-branch ask (precedence)");
	assert.equal(askOf("git tag v1").verdict, "ask", "tag creation asks");
	assert.equal(askOf("gh pr merge 42").verdict, "ask", "freeform pr merge asks");
	assert.equal(askOf("git push -u origin HEAD").verdict, "allow", "feature-branch push stays clean");
});

test("loadPolicy from a LINKED WORKTREE: self normalizes to the common repo; files stay with the checkout", () => {
	policyFx((root, cfg, file) => {
		cfg(JSON.stringify({}));
		file("permissions.json", perms(["Bash(sudo:*)"]));
		// A second linked worktree of the SAME repo: scopeRoot must be the common root,
		// so "self" never re-scopes to one worktree — the inference hole the spec bars.
		const wt = path.join(path.dirname(root), "proj-wt");
		execFileSync("git", ["-C", root, "worktree", "add", "-q", "--detach", wt], { stdio: "pipe" });
		const fromMain = loadPolicy(root);
		const fromWt = loadPolicy(wt);
		assert.equal(fromMain.scopeRoot, root, "the main worktree's scopeRoot is itself");
		assert.equal(fromWt.scopeRoot, root, "a linked worktree normalizes to the common root");
		assert.notEqual(evaluate(fromWt, { ...ORCH, command: "git push", gitTargets: [root] }).ruleId, RULE_ONESHOT_FOREIGN,
			"the repo's own main root is never foreign, from either view");
		assert.equal(fromMain.rules.length, 1, "rules load from the checkout's own permissions.json");
		assert.equal(fromWt.rules.length, 0, "the worktree checkout has no sibling file of its own — absent, not borrowed");
		assert.equal(evaluate(fromMain, { ...ORCH, command: "sudo reboot" }).verdict, "deny");
	});
});
