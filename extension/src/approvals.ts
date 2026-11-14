// P6 ask machinery (permission-policy spec 2026-11-09 §6/§9): HMAC approval tokens.
//
// One pure-node module is the single source for the WHOLE ask cycle — the operator's
// `scripts/multipi-approve` CLI mints here, the P2 hook / P3 shims consume here. Same
// dependency rule as policy.ts: node builtins only (plus ./config.ts's constants), no
// pi imports, so every consumer shares one HMAC, one clock seam, one consumption rule.
//
// Threat model (spec §1/§6, honest): same-OS-user forgery is OUT of scope by design —
// the operator's secret is reachable to the same user through env or files, and the
// escape hatch is the dedicated user/container. What this module buys:
//   - a forger without the secret cannot produce a token that verifies (HMAC-SHA256);
//   - a captured token is bounded (TTL) and spent once (singleshot rename-then-unlink);
//   - every consume or deny is a structured audit entry that NEVER carries the secret
//     or the token's hmac (log hygiene: forge attempts are audited events, not silent
//     passes, and self-approved-looking events stay reviewable).
//
// Fixed verdict order in attemptConsume (pinned by tests/unit/approvals.test.ts):
// no-token → malformed → bad-hmac → expired → foreign-rule → scope-mismatch → pass.
// Only PASS consumes; every deny LEAVES THE FILE IN PLACE (it is evidence for the
// operator's inspection). Orphan `<name>.consuming-*` residue from a crash between
// rename and unlink is swept best-effort at the start of every attempt.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

/** The per-project token dir name under the state dir (spec §6:
 * `~/.multipi/<project>/dev-loop-tokens/`). */
export const TOKEN_DIRNAME = "dev-loop-tokens";
/** Operator-environment secret seam (spec §6: never in the repo, never in
 * .devloop.json, never on the loop's PATH). Takes precedence over the keyring file. */
export const SECRET_ENV_VAR = "POLICY_SIGNING_SECRET";
/** Keyring fallback: a 0600 file under the project's STATE dir (outside the repo).
 * Created ONCE by the mint CLI when the env var is absent; never rotated automatically. */
export const KEYRING_FILENAME = "policy-secret";

/** A stored approval token (the token file's JSON body). */
export interface ApprovalToken {
	/** The rule this token authorizes (raw rule string, e.g. `Bash(*gh pr merge*)`). */
	ruleId: string;
	/** Scope the token covers: `"*"` = any; else the action must declare exactly this. */
	targetScope: string;
	/** Issue time, ms epoch. */
	issuedAt: number;
	/** Deadline, ms epoch. `now >= expiresAt` ⇒ expired (the deadline itself is spent). */
	expiresAt: number;
	/** Hex HMAC-SHA256 over canonicalPayload of the other four fields. */
	hmac: string;
}

export interface MintFields {
	ruleId: string;
	/** Positive minutes; validated (throws TypeError when blank/zero/non-finite). */
	ttlMinutes: number;
	/** Defaults to `"*"` (any scope). */
	targetScope?: string;
	secret: string;
	/** ms epoch clock seam (defaults to Date.now()) — tests steer time without sleeping. */
	now?: number;
}

/** The `<stateDir>/dev-loop-tokens` token dir (spec §6 layout). */
export function tokenDirFor(stateDir: string): string {
	return path.join(stateDir, TOKEN_DIRNAME);
}

/** Filesystem-safe, stable name for a rule's token file. Rule strings are full rule
 * dialect (`Bash(*gh pr merge*)`): every character outside [A-Za-z0-9._-] becomes `_`.
 * Names can collide across rules that sanitize identically — the PAYLOAD ruleId must
 * still match the request (the foreign-rule deny), so a collision degrades to a deny,
 * never a cross-rule pass. */
export function tokenFileName(ruleId: string): string {
	return ruleId.replace(/[^A-Za-z0-9._-]/g, "_") + ".tok";
}

/** Canonical signing payload: compact JSON, keys sorted alphabetically, hmac excluded.
 * Any field change after signing (even reordering by a re-serializer) breaks the HMAC. */
export function canonicalPayload(t: { ruleId: string; targetScope: string; issuedAt: number; expiresAt: number }): string {
	return JSON.stringify({ expiresAt: t.expiresAt, issuedAt: t.issuedAt, ruleId: t.ruleId, targetScope: t.targetScope });
}

export function hmacOf(payload: string, secret: string): string {
	return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** Mint (sign) one token. Throws TypeError on a blank ruleId or non-positive TTL —
 * the CLI validates user input first; this is the module's own contract. */
export function mintToken(f: MintFields): ApprovalToken {
	if (typeof f.ruleId !== "string" || f.ruleId.trim() === "") throw new TypeError("mintToken: ruleId must be a non-blank string");
	if (typeof f.ttlMinutes !== "number" || !Number.isFinite(f.ttlMinutes) || f.ttlMinutes <= 0) {
		throw new TypeError("mintToken: ttlMinutes must be a positive finite number");
	}
	const now = f.now ?? Date.now();
	const base = {
		expiresAt: now + Math.round(f.ttlMinutes * 60_000),
		issuedAt: now,
		ruleId: f.ruleId,
		targetScope: f.targetScope ?? "*",
	};
	return { ...base, hmac: hmacOf(canonicalPayload(base), f.secret) };
}

export type VerifyFailure = "malformed" | "bad-hmac" | "expired";
export type VerifyResult = { ok: true; token: ApprovalToken } | { ok: false; reason: VerifyFailure };

const HEX64 = /^[0-9a-f]{64}$/;

/** Verify shape, then HMAC, then TTL — against the caller's clock (`now`, ms epoch).
 * Never throws on bad input: garbage is `malformed`, a wrong signature is `bad-hmac`
 * (THE forge signal), past the deadline is `expired`. */
export function verifyToken(raw: unknown, secret: string, now: number): VerifyResult {
	const malformed = { ok: false as const, reason: "malformed" as const };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return malformed;
	const o = raw as Record<string, unknown>;
	const { ruleId, targetScope, issuedAt, expiresAt, hmac } = o;
	if (
		typeof ruleId !== "string" || ruleId.trim() === "" ||
		typeof targetScope !== "string" ||
		typeof issuedAt !== "number" || !Number.isFinite(issuedAt) ||
		typeof expiresAt !== "number" || !Number.isFinite(expiresAt) ||
		typeof hmac !== "string" || !HEX64.test(hmac)
	) return malformed;
	const token: ApprovalToken = { ruleId, targetScope, issuedAt, expiresAt, hmac };
	const expect = hmacOf(canonicalPayload(token), secret);
	const a = Buffer.from(expect, "utf8");
	const b = Buffer.from(hmac, "utf8");
	if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad-hmac" };
	if (now >= token.expiresAt) return { ok: false, reason: "expired" };
	return { ok: true, token };
}

/** Scope binding (pinned): `""`/`"*"` stored scope covers anything; a stored concrete
 * scope requires the action to declare EXACTLY that scope — a scope-less action never
 * satisfies a scoped token (fail closed). Trim is cosmetic on both sides. */
export function scopesMatch(storedScope: string, actionScope?: string): boolean {
	const s = storedScope.trim();
	if (s === "" || s === "*") return true;
	const a = (actionScope ?? "").trim();
	if (a === "") return false;
	return s === a;
}

export type ConsumeDenyReason = "no-token" | "malformed" | "bad-hmac" | "expired" | "foreign-rule" | "scope-mismatch";

/** One audit line per consume outcome (spec §8: JSONL, bounded, no secrets/store paths).
 * The caller persists it (appendAudit / the P2 audit writer); the module returns it. */
export interface ApprovalAudit {
	ts: number;
	kind: "consumed" | "deny";
	ruleId: string;
	/** Denials only: WHY (the forge's reason is exactly why a forge is an audited event). */
	reason?: ConsumeDenyReason;
	/** Consumer layer ("hook" | "shim" | …), when the caller knows it. */
	layer?: string;
	session?: string;
	/** Bounded action summary — the caller's obligation: never the secret, token bytes,
	 * or scenario-store paths (log hygiene). */
	actionSummary?: string;
}

export interface ConsumeOptions {
	tokenDir: string;
	/** The ask's rule id; the token file is named from it AND its payload must agree. */
	ruleId: string;
	secret: string;
	/** ms epoch clock seam (defaults to Date.now()). */
	now?: number;
	/** The action's declared scope (the shim/hook extracts it; absent ⇒ no scope). */
	actionScope?: string;
	layer?: string;
	session?: string;
	actionSummary?: string;
}

export interface ConsumeOutcome {
	verdict: "pass" | "deny";
	ruleId: string;
	/** Denials only. */
	reason?: ConsumeDenyReason;
	/** The audit entry to persist (exactly one per attempt, pass or deny). */
	audit: ApprovalAudit;
}

/** Sweep crash-residue: `<anything>.consuming-<digits>-<hex>` names from a consume that
 * died between rename and unlink. Best-effort: a failed unlink is not an error here —
 * the NEXT attempt sweeps again. Hidden files are never touched. */
function sweepConsumingResidue(tokenDir: string): void {
	let names: string[];
	try {
		names = readdirSync(tokenDir);
	} catch {
		return;
	}
	for (const n of names) {
		if (/\.consuming-\d+-[0-9a-f]+$/.test(n)) {
			try {
				unlinkSync(path.join(tokenDir, n));
			} catch {
				// leave it for the next sweep
			}
		}
	}
}

/** THE consume entry (P2 hook / P3 shims / smokes all call this): verify a live token
 * for the rule, atomically consume it, and return the verdict + audit entry.
 * See the module header for the fixed verdict order and the left-in-place evidence rule. */
export function attemptConsume(o: ConsumeOptions): ConsumeOutcome {
	const now = o.now ?? Date.now();
	sweepConsumingResidue(o.tokenDir);
	const audit = (kind: "consumed" | "deny", reason?: ConsumeDenyReason): ApprovalAudit => ({
		ts: now,
		kind,
		ruleId: o.ruleId,
		...(reason !== undefined ? { reason } : {}),
		...(o.layer !== undefined ? { layer: o.layer } : {}),
		...(o.session !== undefined ? { session: o.session } : {}),
		...(o.actionSummary !== undefined ? { actionSummary: o.actionSummary } : {}),
	});
	const deny = (reason: ConsumeDenyReason): ConsumeOutcome => ({ verdict: "deny", ruleId: o.ruleId, reason, audit: audit("deny", reason) });
	const file = path.join(o.tokenDir, tokenFileName(o.ruleId));
	if (!existsSync(file)) return deny("no-token");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return deny("malformed");
	}
	const v = verifyToken(raw, o.secret, now);
	if (!v.ok) return deny(v.reason);
	if (v.token.ruleId !== o.ruleId) return deny("foreign-rule");
	if (!scopesMatch(v.token.targetScope, o.actionScope)) return deny("scope-mismatch");
	// SINGESHOT consumption, atomic by rename-then-unlink (rename within one directory is
	// atomic; a crash in the gap orphans a .consuming-* name that the next sweep removes).
	const residue = `${file}.consuming-${process.pid}-${randomBytes(4).toString("hex")}`;
	renameSync(file, residue);
	try {
		unlinkSync(residue);
	} catch {
		// the next attempt's sweep finishes the job
	}
	return { verdict: "pass", ruleId: o.ruleId, audit: audit("consumed") };
}

/** Atomically write a minted token: dir 0700, file 0600, temp-then-rename (a re-mint
 * supersedes the outstanding token for the rule — the operator's fresh intent wins).
 * Returns the final path. */
export function writeTokenFile(tokenDir: string, token: ApprovalToken): string {
	mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(tokenDir, 0o700); // tighten a pre-existing looser dir (belt and suspenders)
	} catch {
		// not fatal: the dir exists (mkdir succeeded)
	}
	const final = path.join(tokenDir, tokenFileName(token.ruleId));
	const tmp = path.join(tokenDir, `.${tokenFileName(token.ruleId)}.mint-${randomBytes(4).toString("hex")}`);
	writeFileSync(tmp, JSON.stringify(token, null, 2) + "\n", { mode: 0o600 });
	renameSync(tmp, final);
	return final;
}

/** Append one audit entry as a JSONL line, creating the log's dir if needed. */
export function appendAudit(logPath: string, entry: ApprovalAudit): void {
	mkdirSync(path.dirname(logPath), { recursive: true });
	appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

export interface SecretSource { secret: string; source: "env" | "keyring"; }

/** Resolve the per-project signing secret WITHOUT creating anything (spec §6): the
 * operator's `POLICY_SIGNING_SECRET` env var wins; else a readable keyring file in the
 * STATE dir; else null (the mint CLI then offers to create the keyring). */
export function resolveSigningSecret(stateDir: string, env: NodeJS.ProcessEnv = process.env): SecretSource | null {
	const fromEnv = env[SECRET_ENV_VAR];
	if (typeof fromEnv === "string" && fromEnv.length > 0) return { secret: fromEnv, source: "env" };
	try {
		const s = readFileSync(path.join(stateDir, KEYRING_FILENAME), "utf8").trim();
		if (s.length > 0) return { secret: s, source: "keyring" };
	} catch {
		// no keyring
	}
	return null;
}

/** Create-once keyring: returns the EXISTING keyring when there is one (rotation is an
 * explicit operator act: delete/replace the file — outstanding tokens invalidate, by
 * design). Creates the state dir 0700 and the keyring 0600 with 32 random hex bytes. */
export function ensureKeyring(stateDir: string, env: NodeJS.ProcessEnv = process.env): { secret: string; path: string; created: boolean } {
	const keyringPath = path.join(stateDir, KEYRING_FILENAME);
	const existing = resolveSigningSecret(stateDir, env);
	if (existing !== null && existing.source === "keyring") {
		return { secret: existing.secret, path: keyringPath, created: false };
	}
	if (existing !== null) {
		// env var set: use it and leave the keyring alone (nothing to create).
		return { secret: existing.secret, path: keyringPath, created: false };
	}
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const secret = randomBytes(32).toString("hex");
	writeFileSync(keyringPath, secret + "\n", { mode: 0o600 });
	return { secret, path: keyringPath, created: true };
}
