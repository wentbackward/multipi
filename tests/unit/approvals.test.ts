// P6 ask machinery (permission-policy spec 2026-11-09 §6/§9): HMAC approval tokens —
// mint, verify, TTL with a controllable clock (seam, no sleeps), scope binding,
// singleshot atomic consumption, and forge-resistant denial with audit hygiene.
import assert from "node:assert/strict";
import test from "node:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import {
	ensureKeyring,
	type ApprovalAudit,
	appendAudit,
	attemptConsume,
	canonicalPayload,
	KEYRING_FILENAME,
	mintToken,
	resolveSigningSecret,
	scopesMatch,
	SECRET_ENV_VAR,
	tokenDirFor,
	tokenFileName,
	consumeTokenFile,
	verifyToken,
	writeTokenFile,
} from "../../extension/src/approvals.ts";
import { evaluate, loadPolicy } from "../../extension/src/policy.ts";

const SECRET = "unit-test-signing-secret-not-a-real-credential";
const OTHER_SECRET = "a-different-signing-secret";
const RULE = "Bash(*gh pr merge*)";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const APPROVALS_MODULE = path.join(REPO_ROOT, "extension", "src", "approvals.ts");
/** A fixed "now" (ms epoch) so the TTL tests steer the clock instead of sleeping. */
const T0 = 1_750_000_000_000;
const MIN = 60_000;

interface Fx { dir: string; tokenDir: string; log: string; }

/** Hermetic fixture: a state dir with its token dir and an audit log path; cleaned in t.after. */
function fx(t: { after: (fn: () => void) => void }): Fx {
	const dir = mkdtempSync(path.join(os.tmpdir(), "multipi-approvals-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const tokenDir = tokenDirFor(path.join(dir, "state"));
	mkdirSync(tokenDir, { recursive: true });
	return { dir, tokenDir, log: path.join(dir, "state", "logs", "policy-audit.jsonl") };
}

/** Mint a token straight into the fixture token dir (what the CLI's node half does). */
function mintTo(f: Fx, ruleId: string, over: Record<string, unknown> = {}): string {
	const token = mintToken({ ruleId, ttlMinutes: 10, secret: SECRET, now: T0, ...over });
	return writeTokenFile(f.tokenDir, token);
}

test("the token dir nests dev-loop-tokens under the state dir (spec §6 layout)", () => {
	assert.equal(tokenDirFor("/home/op/.multipi/proj"), "/home/op/.multipi/proj/dev-loop-tokens");
});

test("minting produces a token that verifies round-trip with the same secret", () => {
	const t = mintToken({ ruleId: RULE, ttlMinutes: 10, targetScope: "main", secret: SECRET, now: T0 });
	assert.equal(t.issuedAt, T0);
	assert.equal(t.expiresAt, T0 + 10 * MIN);
	assert.equal(t.targetScope, "main");
	assert.deepEqual(verifyToken(t, SECRET, T0 + 5 * MIN), { ok: true, token: t });
});

test("a token signed with a different secret is rejected as bad-hmac (the forge)", () => {
	const t = mintToken({ ruleId: RULE, ttlMinutes: 10, secret: SECRET, now: T0 });
	const bad = verifyToken(t, OTHER_SECRET, T0);
	assert.equal(bad.ok, false);
	if (!bad.ok) assert.equal(bad.reason, "bad-hmac");
});

test("tampering with a field after signing (bumping expiresAt) is rejected as bad-hmac", () => {
	const t = mintToken({ ruleId: RULE, ttlMinutes: 10, secret: SECRET, now: T0 });
	const bumped = { ...t, expiresAt: t.expiresAt + 24 * 60 * MIN };
	const bad = verifyToken(bumped, SECRET, T0 + 11 * MIN);
	assert.equal(bad.ok, false);
	if (!bad.ok) assert.equal(bad.reason, "bad-hmac");
});

test("TTL is honoured with a controllable clock: alive before the deadline, expired AT it", () => {
	const t = mintToken({ ruleId: RULE, ttlMinutes: 1, secret: SECRET, now: T0 });
	assert.equal(verifyToken(t, SECRET, T0 + MIN - 1).ok, true, "1 ms before the deadline is still live");
	const edge = verifyToken(t, SECRET, T0 + MIN);
	assert.equal(edge.ok, false, "the deadline itself is already expired");
	if (!edge.ok) assert.equal(edge.reason, "expired");
});

test("garbage payloads are rejected as malformed, never guessed", () => {
	for (const raw of [
		null,
		"not json",
		[],
		{},
		{ ruleId: RULE, targetScope: "*", issuedAt: T0, expiresAt: T0 + MIN, hmac: "zz" },
		{ ruleId: RULE, targetScope: "*", issuedAt: "now", expiresAt: T0 + MIN, hmac: "ab".repeat(32) },
		{ ruleId: "", targetScope: "*", issuedAt: T0, expiresAt: T0 + MIN, hmac: "ab".repeat(32) },
	]) {
		const bad = verifyToken(raw, SECRET, T0);
		assert.equal(bad.ok, false, `expected malformed for ${JSON.stringify(raw)}`);
		if (!bad.ok) assert.equal(bad.reason, "malformed");
	}
});

test("a live, in-scope token passes and is consumed: the file is gone afterwards", (t) => {
	const f = fx(t);
	const p = mintTo(f, RULE, { targetScope: "*" });
	assert.ok(existsSync(p), "the minted token file exists pre-consumption");
	const out = attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + MIN });
	assert.equal(out.verdict, "pass");
	assert.equal(out.reason, undefined);
	assert.equal(out.audit.kind, "consumed");
	assert.equal(out.audit.ruleId, RULE);
	assert.ok(!existsSync(p), "consumption removed the token file");
	assert.deepEqual(listVisible(f.tokenDir), [], "no orphan residue in the token dir");
});

test("singleshot: a second use of a consumed token denies with no-token", (t) => {
	const f = fx(t);
	mintTo(f, RULE);
	assert.equal(attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + MIN }).verdict, "pass");
	const second = attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + 2 * MIN });
	assert.equal(second.verdict, "deny");
	assert.equal(second.reason, "no-token");
	assert.equal(second.audit.kind, "deny");
});

test("a forged token is denied bad-hmac and LEFT IN PLACE for the operator's inspection", (t) => {
	const f = fx(t);
	const p = mintTo(f, RULE);
	const tampered = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
	tampered.expiresAt = (tampered.expiresAt as number) + 60 * MIN;
	writeFileSync(p, JSON.stringify(tampered));
	const out = attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + MIN });
	assert.equal(out.verdict, "deny");
	assert.equal(out.reason, "bad-hmac");
	assert.equal(out.audit.kind, "deny");
	assert.ok(existsSync(p), "a forged token is not consumed — it is evidence");
});

test("an expired token is denied expired and left in place", (t) => {
	const f = fx(t);
	const p = mintTo(f, RULE, { ttlMinutes: 1 });
	const out = attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + MIN + 1 });
	assert.equal(out.verdict, "deny");
	assert.equal(out.reason, "expired");
	assert.ok(existsSync(p), "an expired token is not consumed — it is evidence");
});

test("a garbage token file is denied malformed and left in place", (t) => {
	const f = fx(t);
	const p = path.join(f.tokenDir, tokenFileName(RULE));
	writeFileSync(p, "definitely not a token");
	const out = attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + MIN });
	assert.equal(out.verdict, "deny");
	assert.equal(out.reason, "malformed");
	assert.ok(existsSync(p));
});

test("a token whose payload ruleId disagrees with the request is denied foreign-rule", (t) => {
	const f = fx(t);
	// The file is NAMED for rule B but was minted for rule A: a swapped/misdirected token.
	const token = mintToken({ ruleId: "Bash(git tag *)", ttlMinutes: 10, secret: SECRET, now: T0 });
	const renamed = path.join(f.tokenDir, tokenFileName(RULE));
	writeFileSync(renamed, JSON.stringify(token) + "\n");
	const out = attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + MIN });
	assert.equal(out.verdict, "deny");
	assert.equal(out.reason, "foreign-rule");
	assert.ok(existsSync(renamed), "a foreign token is not consumed — it is evidence");
});

test("scope: a '*' token covers any declared scope; a scoped token covers ONLY its scope", () => {
	assert.equal(scopesMatch("*", "main"), true);
	assert.equal(scopesMatch("*", undefined), true);
	assert.equal(scopesMatch("", "anything"), true, "an empty stored scope means '*'");
	assert.equal(scopesMatch("main", "main"), true);
	assert.equal(scopesMatch(" main ", "main"), true, "trim is cosmetic on both sides");
	assert.equal(scopesMatch("main", "other"), false);
	assert.equal(scopesMatch("main", undefined), false,
		"a scoped token never covers an action that declares no scope (fail closed)");
});

test("a scope mismatch denies and leaves the token; the matching scope passes", (t) => {
	const f = fx(t);
	const p = mintTo(f, RULE, { targetScope: "main" });
	const off = attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + MIN, actionScope: "staging" });
	assert.equal(off.verdict, "deny");
	assert.equal(off.reason, "scope-mismatch");
	assert.ok(existsSync(p), "a scope mismatch does not spend the token");
	const on = attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + MIN, actionScope: "main" });
	assert.equal(on.verdict, "pass");
	assert.ok(!existsSync(p));
});

// --- #54 should-fix 1: the rename race — consumption must decide, never throw ---------

test("consumeTokenFile: a token file that vanished before the rename (lost the race) is reported no-token", (t) => {
	const f = fx(t);
	assert.equal(consumeTokenFile(path.join(f.tokenDir, tokenFileName(RULE))), "no-token",
		"a missing token file IS the lost rename race — not an error");
});

test("consumeTokenFile: a rename it cannot perform (unwritable token dir) is reported io-error, file left in place", (t) => {
	const f = fx(t);
	const p = mintTo(f, RULE);
	chmodSync(f.tokenDir, 0o555); // stat- and readable, unwritable
	t.after(() => chmodSync(f.tokenDir, 0o755));
	assert.equal(consumeTokenFile(p), "io-error", "a foreign fs failure is io-error, not no-token");
	assert.ok(existsSync(p), "an io-error consume leaves the token in place for inspection");
});

test("attemptConsume maps a failed consume rename to a deny (io-error) with an audit line — never an uncaught throw", (t) => {
	const f = fx(t);
	const p = mintTo(f, RULE);
	chmodSync(f.tokenDir, 0o555);
	t.after(() => chmodSync(f.tokenDir, 0o755));
	const out = attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + MIN });
	assert.equal(out.verdict, "deny");
	assert.equal(out.reason, "io-error");
	assert.equal(out.audit.kind, "deny");
	assert.ok(existsSync(p), "the token is left in place for inspection");
});

test("two CONCURRENT consumers of one token: exactly one passes, the loser denies no-token, neither throws", async (t) => {
	const f = fx(t);
	mintTo(f, RULE);
	const outcomes = await Promise.all([0, 1].map(() => runConsumeWorker(f.tokenDir)));
	assert.deepEqual(outcomes.map((o) => o.error).filter((e) => e !== undefined), [],
		`no consumer may throw: ${outcomes.map((o) => o.error).filter((e) => e !== undefined).join(" | ")}`);
	const passes = outcomes.filter((o) => o.verdict === "pass");
	const denies = outcomes.filter((o) => o.verdict === "deny");
	assert.equal(passes.length, 1, "exactly one consumer spends the token");
	assert.equal(denies.length, 1, "the other consumer gets a verdict, not an exception");
	assert.equal(denies[0].reason, "no-token", "the loser of the rename race denies no-token");
});

/** One REAL concurrent consumer: a fresh worker thread running the shipped attemptConsume.
 * Its result is invariant under scheduling: either it finds no file, or it loses the
 * atomic rename to the other worker — both are the `no-token` deny, never a throw. */
function runConsumeWorker(tokenDir: string): Promise<{ verdict?: string; reason?: string; error?: string }> {
	const code =
		`const { parentPort } = require("node:worker_threads");\n` +
		`(async () => {\n` +
		`  try {\n` +
		`    const mod = await import(${JSON.stringify(APPROVALS_MODULE)});\n` +
		`    const out = mod.attemptConsume({ tokenDir: ${JSON.stringify(tokenDir)}, ruleId: ${JSON.stringify(RULE)}, secret: ${JSON.stringify(SECRET)}, now: ${T0 + MIN} });\n` +
		`    parentPort.postMessage({ verdict: out.verdict, ...(out.reason !== undefined ? { reason: out.reason } : {}) });\n` +
		`  } catch (e) { parentPort.postMessage({ error: String(e) }); }\n` +
		`})();`;
	return new Promise((resolve) => {
		const w = new Worker(code, { eval: true });
		w.on("message", (m: { verdict?: string; reason?: string; error?: string }) => { w.terminate(); resolve(m); });
		w.on("error", (e: Error) => { w.terminate(); resolve({ error: String(e) }); });
	});
}

test("tokenFileName is filesystem-safe, stable, and distinct per rule", () => {
	assert.equal(tokenFileName(RULE), "Bash__gh_pr_merge__.tok");
	assert.match(tokenFileName(RULE), /^[A-Za-z0-9._-]+\.tok$/, "no metacharacters survive");
	assert.notEqual(tokenFileName("Bash(git tag *)"), tokenFileName(RULE));
	assert.equal(tokenFileName("oneshot:install-secondary"), "oneshot_install-secondary.tok");
	assert.equal(tokenFileName(RULE), tokenFileName(RULE), "stable across calls");
});

test("audit entries never carry the secret or the token's hmac (log hygiene)", (t) => {
	const f = fx(t);
	mintTo(f, RULE);
	const audits: ApprovalAudit[] = [];
	// The forge: re-sign the file's body under a DIFFERENT field value → bad-hmac.
	const p = path.join(f.tokenDir, tokenFileName(RULE));
	const forged = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
	forged.targetScope = "rogue";
	writeFileSync(p, JSON.stringify(forged));
	audits.push(attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + MIN }).audit);
	// The clean consumption, re-minted first.
	mintTo(f, RULE);
	audits.push(attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + MIN }).audit);
	for (const audit of audits) {
		const line = JSON.stringify(audit);
		assert.ok(line.includes(RULE), "the audit names the rule");
		assert.ok(!line.includes(SECRET), "the audit never carries the secret");
		assert.ok(!line.includes(OTHER_SECRET), "the audit never carries a forger's secret");
	}
});

test("appendAudit appends one JSONL line per event and creates the log dir", (t) => {
	const f = fx(t);
	assert.ok(!existsSync(f.log));
	const a: ApprovalAudit = { ts: T0, kind: "consumed", ruleId: RULE, layer: "hook", session: "s1" };
	const b: ApprovalAudit = { ts: T0 + 1, kind: "deny", ruleId: RULE, reason: "bad-hmac" };
	appendAudit(f.log, a);
	appendAudit(f.log, b);
	const lines = readFileSync(f.log, "utf8").trimEnd().split("\n");
	assert.equal(lines.length, 2);
	assert.deepEqual(JSON.parse(lines[0]), a);
	assert.deepEqual(JSON.parse(lines[1]), b);
});

test("an orphan .consuming residue from a crashed consume is swept on the next attempt", (t) => {
	const f = fx(t);
	mintTo(f, RULE);
	writeFileSync(path.join(f.tokenDir, `stray.tok.consuming-4242-${"ab".repeat(4)}`), "half-consumed");
	const out = attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + MIN });
	assert.equal(out.verdict, "pass");
	assert.deepEqual(listVisible(f.tokenDir), [], "the orphan is swept");
});

// #54 should-fix 3: writeTokenFile's hidden .<name>.mint-<hex> temp must be swept too
test("an orphan .mint-* temp from an interrupted mint is swept on the next attempt; other hidden files are never touched", (t) => {
	const f = fx(t);
	mintTo(f, RULE);
	const name = tokenFileName(RULE);
	const strayMint = `.${name}.mint-${"ab".repeat(4)}`;
	const wrongShape = `.${name}.mint-not-hex-hex`;
	const unrelated = ".unrelated-hidden";
	writeFileSync(path.join(f.tokenDir, strayMint), "half-minted");
	writeFileSync(path.join(f.tokenDir, wrongShape), "not a mint-temp shape");
	writeFileSync(path.join(f.tokenDir, unrelated), "hidden, unrelated");
	const out = attemptConsume({ tokenDir: f.tokenDir, ruleId: RULE, secret: SECRET, now: T0 + MIN });
	assert.equal(out.verdict, "pass");
	assert.ok(!existsSync(path.join(f.tokenDir, strayMint)), "the interrupted-mint temp is swept");
	assert.ok(existsSync(path.join(f.tokenDir, wrongShape)), "a name outside the mint-temp shape is left alone");
	assert.ok(existsSync(path.join(f.tokenDir, unrelated)), "hidden files in general are never touched");
});

test("writeTokenFile creates the dir 0700 and the file 0600, replacing any stale token", (t) => {
	const f = fx(t);
	const t1 = mintToken({ ruleId: RULE, ttlMinutes: 10, secret: SECRET, now: T0 });
	const p = writeTokenFile(f.tokenDir, t1);
	assert.equal(statSync(f.tokenDir).mode & 0o777, 0o700, "the token dir is 0700");
	assert.equal(statSync(p).mode & 0o777, 0o600, "the token file is 0600");
	const t2 = mintToken({ ruleId: RULE, ttlMinutes: 10, secret: SECRET, now: T0 + MIN });
	writeTokenFile(f.tokenDir, t2);
	assert.equal(JSON.parse(readFileSync(p, "utf8")).issuedAt, t2.issuedAt, "re-mint replaces the stale token");
});

test("resolveSigningSecret: the env var wins; a 0600 keyring is the fallback; neither ⇒ null", (t) => {
	const f = fx(t);
	const state = path.join(f.dir, "state");
	assert.deepEqual(resolveSigningSecret(state, { [SECRET_ENV_VAR]: "from-env" }), { secret: "from-env", source: "env" });
	assert.equal(resolveSigningSecret(state, {}), null, "no env, no keyring ⇒ null (nothing is invented)");
	const k = ensureKeyring(state, {});
	assert.equal(k.created, true);
	assert.equal(k.path, path.join(state, KEYRING_FILENAME));
	assert.match(k.secret, /^[0-9a-f]{64}$/, "the keyring is 32 random bytes, hex");
	assert.equal(statSync(k.path).mode & 0o777, 0o600, "the keyring file is 0600");
	assert.deepEqual(resolveSigningSecret(state, {}), { secret: k.secret, source: "keyring" });
	assert.equal(ensureKeyring(state, {}).created, false, "an existing keyring is reused, never rotated");
	assert.deepEqual(resolveSigningSecret(state, { [SECRET_ENV_VAR]: "env-wins" }), { secret: "env-wins", source: "env" });
});

test("mintToken rejects a blank rule id and a non-positive TTL", () => {
	assert.throws(() => mintToken({ ruleId: "", ttlMinutes: 10, secret: SECRET, now: T0 }), /ruleId/);
	assert.throws(() => mintToken({ ruleId: RULE, ttlMinutes: 0, secret: SECRET, now: T0 }), /ttlMinutes/);
	assert.throws(() => mintToken({ ruleId: RULE, ttlMinutes: NaN, secret: SECRET, now: T0 }), /ttlMinutes/);
});

test("the canonical payload is compact JSON with sorted keys and no hmac", () => {
	assert.equal(
		canonicalPayload({ ruleId: "R", targetScope: "s", issuedAt: 1, expiresAt: 2 }),
		'{"expiresAt":2,"issuedAt":1,"ruleId":"R","targetScope":"s"}',
	);
});

// --- the seeded permission policy wires the token protections (spec §6) --------

test("seeded permissions.json: the POLICY'D SESSION can never mint; the keyring is Read/Edit-denied", () => {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const p = loadPolicy(repoRoot);
	assert.equal(p.ok, true, `repo permissions.json must load: ${p.error ?? ""}`);
	const ORCH = { actor: "orchestrator" };
	const bash = (c: string) => evaluate(p, { ...ORCH, tool: "bash", command: c });
	assert.equal(bash("./scripts/multipi-approve Bash(git tag *)").verdict, "deny",
		"the mint CLI is reachable from the policy'd session ⇒ it must be denied");
	assert.equal(bash("multipi-approve 'Bash(git tag *)'").verdict, "deny",
		"the PATH spelling of the mint CLI is denied too");
	assert.equal(evaluate(p, { ...ORCH, tool: "read", paths: ["~/.multipi/proj/policy-secret"] }).verdict, "deny",
		"the keyring file is Read-denied");
	assert.equal(evaluate(p, { ...ORCH, tool: "edit", paths: ["~/.multipi/proj/policy-secret"] }).verdict, "deny",
		"the keyring file is Edit-denied");
	// #54 should-fix 2: the /run/user keyring spelling gets the same shield as the token dir
	assert.equal(evaluate(p, { ...ORCH, tool: "read", paths: ["/run/user/1000/policy-secret"] }).verdict, "deny",
		"the /run/user keyring spelling is Read-denied (symmetric with the token-dir shields)");
	assert.equal(evaluate(p, { ...ORCH, tool: "edit", paths: ["/run/user/1000/policy-secret"] }).verdict, "deny",
		"the /run/user keyring spelling is Edit-denied");
});

/** Non-hidden files in a dir (orphans like .consuming-… excluded by design). */
function listVisible(d: string): string[] {
	try {
		return readdirSync(d).filter((n) => !n.startsWith("."));
	} catch {
		return [];
	}
}
