import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import path from "node:path";
import { BASE_CONFIG, makeFixture, type Fixture } from "../fixtures.ts";

/**
 * #55 (folded-in adjacent park): `policydriver.ts` used to re-derive the audit log path
 * from a FRESH config load on EVERY audit append, and a null path was dropped silently.
 * Contract now: the path is resolved once per invocation from the loaded config, and the
 * unresolvable case routes through the audit-degraded warning (exactly once) instead of
 * vanishing — while the verdict itself always still prints (audit failures never break a
 * verdict, the hook's rule).
 *
 * Offline: the driver is spawned as a plain `node` process against a hermetic fixture
 * (its documented CLI; the shims drive it the same way).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRIVER = path.join(ROOT, "extension", "src", "policydriver.ts");

const DENY_PERMS = JSON.stringify({ permissions: { deny: ["Bash(badcmd:*)"], ask: [], allow: [] } });

function seedPerms(fx: Fixture): void {
	writeFileSync(path.join(fx.repo, "permissions.json"), DENY_PERMS);
}

function runDriver(fx: Fixture, command: string): { stdout: string; stderr: string; status: number } {
	const env = { ...process.env, MULTIPI_HOME: path.join(fx.dir, "home") };
	const r = spawnSync(process.execPath, [DRIVER, "--root", fx.repo, "--command", command], {
		encoding: "utf8", env, cwd: fx.repo,
	});
	return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? -1 };
}

const auditLog = (fx: Fixture): string => path.join(fx.dir, "home", "proj", "logs", "policy-audit.jsonl");

test("policydriver: a resolved audit path receives the verdict line and warns nothing", () => {
	const fx = makeFixture(BASE_CONFIG);
	try {
		seedPerms(fx);
		const r = runDriver(fx, "badcmd x");
		assert.equal(r.status, 0, "the driver exits 0 when it decides");
		assert.ok(r.stdout.startsWith("BLOCK\tDENIED Bash(badcmd:*):"), `the deny line prints (${JSON.stringify(r.stdout)})`);
		assert.equal(r.stderr, "", "a resolvable audit path does not warn");
		const lines = readFileSync(auditLog(fx), "utf8").trim().split("\n").map((l) => JSON.parse(l as string));
		assert.equal(lines.length, 1, "exactly one verdict line");
		assert.equal(lines[0].layer, "shim");
		assert.equal(lines[0].verdict, "deny");
	} finally { fx.cleanup(); }
});

test("policydriver: an unresolvable audit path warns DEGRADED once and the verdict still prints", () => {
	const fx = makeFixture(BASE_CONFIG);
	try {
		seedPerms(fx);
		// A PRESENT-BUT-CORRUPT .devloop.json: loadConfig returns null, so no logs dir can be
		// resolved — the exact case the silent-skip used to swallow.
		writeFileSync(fx.config, "{broken");
		const r = runDriver(fx, "badcmd x");
		assert.equal(r.status, 0, "the driver exits 0 when it decides");
		assert.ok(r.stdout.startsWith("BLOCK\tDENIED policy:unusable:"), `the fail-closed deny prints (${JSON.stringify(r.stdout)})`);
		const auditWarns = r.stderr.split("\n").filter((l) => l.includes("audit"));
		assert.equal(auditWarns.length, 1, `exactly one audit-degraded warning (${JSON.stringify(r.stderr)})`);
		assert.ok(auditWarns[0].includes("DEGRADED"), "the warning names the degraded audit");
		assert.ok(!existsSync(auditLog(fx)), "nowhere to write: no audit file appears");
	} finally { fx.cleanup(); }
});
