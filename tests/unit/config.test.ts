import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { loadConfig, resolveState, scenariosOn, resolvePaths, repoSlugFromRemote } from "../../extension/src/config.ts";
import { makeFixture, BASE_CONFIG } from "../fixtures.ts";

test("loadConfig reads the repo config with defaults filled", () => {
	const fx = makeFixture(BASE_CONFIG);
	try {
		const cfg = loadConfig(fx.repo);
		assert.ok(cfg);
		assert.equal(cfg.baseBranch, "main");
		assert.equal(cfg.remote, "origin");
		assert.equal(cfg.fastCheck, "test -f README.md");
		assert.equal(cfg.checks.length, 1);
		assert.equal(cfg.heavy.slots, 2);
		assert.equal(cfg.stopGate.maxBlocks, 5);
		assert.equal(cfg.merge.method, "squash");
	} finally { fx.cleanup(); }
});

test("loadConfig returns null outside a git repo", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "np-"));
	assert.equal(loadConfig(dir), null);
});

test("loadConfig returns null for invalid JSON", () => {
	const fx = makeFixture("{nope");
	try {
		assert.equal(loadConfig(fx.repo), null);
	} finally { fx.cleanup(); }
});

test("loadConfig applies defaults for an empty config", () => {
	const fx = makeFixture("{}");
	try {
		const cfg = loadConfig(fx.repo);
		assert.ok(cfg);
		assert.equal(cfg.baseBranch, "main");
		assert.equal(cfg.remote, "origin");
		assert.equal(cfg.heavy.slots, 2);
		assert.equal(cfg.heavy.portBase, 8600);
		assert.equal(cfg.heavy.portStep, 10);
		assert.equal(cfg.stopGate.maxBlocks, 5);
		assert.equal(cfg.checks.length, 0);
		assert.equal(cfg.childSilenceMinutes, 30, "watchdog default");
	} finally { fx.cleanup(); }
});

test("loadConfig parses child_silence_minutes (watchdog)", () => {
	const fx = makeFixture('{"child_silence_minutes": 45}');
	try {
		const cfg = loadConfig(fx.repo);
		assert.equal(cfg?.childSilenceMinutes, 45);
	} finally { fx.cleanup(); }
});

test("resolveState is $MULTIPI_HOME/<repo>", () => {
	const fx = makeFixture(BASE_CONFIG);
	try {
		const home = path.join(fx.dir, "home");
		const st = resolveState(fx.repo, { MULTIPI_HOME: home });
		assert.equal(st, path.join(home, "proj"));
	} finally { fx.cleanup(); }
});

test("loadConfig parses object and plain-string checks uniformly", () => {
	const fx = makeFixture(JSON.stringify({ checks: ["false", { name: "e", command: "true", heavy: false }] }));
	try {
		const cfg = loadConfig(fx.repo);
		assert.ok(cfg);
		assert.deepEqual(cfg.checks.map((c) => c.command), ["false", "true"]);
		assert.equal(cfg.checks[0].heavy, true);
		assert.equal(cfg.checks[0].name, "check-1");
		assert.equal(cfg.checks[1].name, "e");
	} finally { fx.cleanup(); }
});

test("loadConfig defaults factory to collaborative and scenarios to absent", () => {
	const fx = makeFixture(BASE_CONFIG);
	try {
		const cfg = loadConfig(fx.repo);
		assert.ok(cfg);
		assert.equal(cfg.factory, "collaborative");
		assert.equal(cfg.scenarios, undefined);
	} finally { fx.cleanup(); }
});

test("loadConfig parses factory: dark", () => {
	const fx = makeFixture('{"factory": "dark"}');
	try {
		assert.equal(loadConfig(fx.repo)?.factory, "dark");
	} finally { fx.cleanup(); }
});

test("loadConfig treats an unknown factory value as collaborative", () => {
	const fx = makeFixture('{"factory": "night-shift"}');
	try {
		assert.equal(loadConfig(fx.repo)?.factory, "collaborative");
	} finally { fx.cleanup(); }
});

test("loadConfig parses a scenarios block with spec defaults for unset keys", () => {
	const fx = makeFixture('{"scenarios": {"dir": "/srv/store"}}');
	try {
		const sc = loadConfig(fx.repo)?.scenarios;
		assert.ok(sc, "block must parse to an object");
		assert.equal(sc!.dir, "/srv/store");
		assert.equal(sc!.run, undefined);
		assert.equal(sc!.runSeconds, 120);
		assert.equal(sc!.judge, undefined);
		assert.equal(sc!.judgeSeconds, 600);
		assert.equal(sc!.pass, 0.8);
		assert.equal(sc!.minSatisfaction, 0.9);
		assert.equal(sc!.sealed, 0.2);
	} finally { fx.cleanup(); }
});

test("loadConfig parses a fully specified scenarios block", () => {
	const fx = makeFixture('{"scenarios": {"dir": "d", "run": "r", "run_seconds": 5, "judge": "j", "judge_seconds": 7, "pass": 0.5, "min_satisfaction": 0.7, "sealed": 0.1}}');
	try {
		const sc = loadConfig(fx.repo)?.scenarios;
		assert.ok(sc);
		assert.equal(sc!.dir, "d");
		assert.equal(sc!.run, "r");
		assert.equal(sc!.runSeconds, 5);
		assert.equal(sc!.judge, "j");
		assert.equal(sc!.judgeSeconds, 7);
		assert.equal(sc!.pass, 0.5);
		assert.equal(sc!.minSatisfaction, 0.7);
		assert.equal(sc!.sealed, 0.1);
	} finally { fx.cleanup(); }
});

test("loadConfig parses an explicit scenarios: false", () => {
	const fx = makeFixture('{"factory": "dark", "scenarios": false}');
	try {
		const cfg = loadConfig(fx.repo);
		assert.ok(cfg);
		assert.equal(cfg.scenarios, false);
	} finally { fx.cleanup(); }
});

test("scenariosOn: block present on in any mode; explicit false off even in dark; absent on only in dark", () => {
	const table: [json: string, on: boolean, why: string][] = [
		['{"scenarios": {}}', true, "an empty block counts as present: on in collaborative"],
		['{"scenarios": {"dir": "/srv/store"}}', true, "block present: on in collaborative"],
		['{"factory": "dark", "scenarios": {"dir": "/srv/store"}}', true, "block present: on in dark"],
		['{"factory": "dark", "scenarios": false}', false, "explicit false wins even in dark"],
		["{}", false, "absent is off in collaborative"],
		['{"factory": "dark"}', true, "absent is on by the dark preset"],
	];
	for (const [json, on, why] of table) {
		const fx = makeFixture(json);
		try {
			const cfg = loadConfig(fx.repo);
			assert.ok(cfg, why);
			assert.equal(scenariosOn(cfg), on, why);
		} finally { fx.cleanup(); }
	}
});

test("resolvePaths: scenariosDir defaults to <stateDir>/scenarios, sibling of the worktrees dir", () => {
	const fx = makeFixture(BASE_CONFIG);
	try {
		const home = path.join(fx.dir, "home");
		const p = resolvePaths(loadConfig(fx.repo)!, { MULTIPI_HOME: home });
		assert.equal(p.stateDir, path.join(home, "proj"));
		assert.equal(p.worktreeDir, path.join(home, "proj", "worktrees", "proj"));
		assert.equal(p.scenariosDir, path.join(home, "proj", "scenarios"));
	} finally { fx.cleanup(); }
});

test("resolvePaths: scenarios.dir ~/ expands against $HOME", () => {
	const fx = makeFixture('{"scenarios": {"dir": "~/store"}}');
	try {
		const home = path.join(fx.dir, "home");
		const p = resolvePaths(loadConfig(fx.repo)!, { MULTIPI_HOME: home, HOME: home });
		assert.equal(p.scenariosDir, path.join(home, "store"));
	} finally { fx.cleanup(); }
});

test("resolvePaths: scenarios.dir relative resolves against the repo PARENT (worktree_dir rule)", () => {
	const fx = makeFixture('{"scenarios": {"dir": "store"}}');
	try {
		const p = resolvePaths(loadConfig(fx.repo)!, { MULTIPI_HOME: path.join(fx.dir, "home") });
		assert.equal(p.scenariosDir, path.join(path.dirname(fx.repo), "store"));
	} finally { fx.cleanup(); }
});

test("resolvePaths: scenarios.dir absolute passes through", () => {
	const fx = makeFixture('{"scenarios": {"dir": "/abs/store"}}');
	try {
		const p = resolvePaths(loadConfig(fx.repo)!, { MULTIPI_HOME: path.join(fx.dir, "home") });
		assert.equal(p.scenariosDir, "/abs/store");
	} finally { fx.cleanup(); }
});

test("setup templates ship no factory and no scenarios keys (fresh = collaborative, scenarios off)", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	for (const rel of ["templates/devloop.json", ".pi/templates/devloop.json"]) {
		const raw = JSON.parse(readFileSync(path.join(here, "..", "..", rel), "utf8")) as Record<string, unknown>;
		assert.equal("factory" in raw, false, `${rel} must not set factory`);
		assert.equal("scenarios" in raw, false, `${rel} must not set scenarios`);
	}
});

test("repoSlugFromRemote parses https and ssh remote urls", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "slug-"));
	execFileSync("git", ["init", "-q", "-b", "main", dir]);
	execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/widget.git"]);
	assert.equal(repoSlugFromRemote(dir, "origin"), "acme/widget");
	execFileSync("git", ["-C", dir, "remote", "set-url", "origin", "git@github.com:acme/widget"]);
	assert.equal(repoSlugFromRemote(dir, "origin"), "acme/widget");
	assert.equal(repoSlugFromRemote(dir, "nope"), "");
});

// --- policy block (permission-policy spec §11-P1: the policy knobs schema) ---

test("loadConfig: no policy block gives the confirmed defaults (allow, self-only, no secondaries, 10 min TTL)", () => {
	const fx = makeFixture(BASE_CONFIG);
	try {
		const cfg = loadConfig(fx.repo);
		assert.deepEqual(cfg?.policy, { posture: "allow", repos: ["self"], secondaries: [], tokenTtlMinutes: 10 });
	} finally { fx.cleanup(); }
});

test("loadConfig: an explicit policy block parses all four knobs", () => {
	const fx = makeFixture('{"policy": {"posture": "ask", "repos": ["self", "/srv/other"], "secondaries": ["/srv/other"], "token_ttl_minutes": 30}}');
	try {
		const cfg = loadConfig(fx.repo);
		assert.deepEqual(cfg?.policy, { posture: "ask", repos: ["self", "/srv/other"], secondaries: ["/srv/other"], tokenTtlMinutes: 30 });
	} finally { fx.cleanup(); }
});

test("loadConfig: a partial policy block fills defaults per key", () => {
	const fx = makeFixture('{"policy": {"token_ttl_minutes": 5}}');
	try {
		const cfg = loadConfig(fx.repo);
		assert.deepEqual(cfg?.policy, { posture: "allow", repos: ["self"], secondaries: [], tokenTtlMinutes: 5 });
	} finally { fx.cleanup(); }
});

test("loadConfig: garbage posture coerces to the allow default (config-layer coercion discipline)", () => {
	const fx = makeFixture('{"policy": {"posture": "nope"}}');
	try {
		assert.equal(loadConfig(fx.repo)?.policy?.posture, "allow");
	} finally { fx.cleanup(); }
});

test("loadConfig: a repos list with one untrusted entry fails closed to self-only", () => {
	for (const bad of ['{"policy": {"repos": ["self", "./relative"]}}', '{"policy": {"repos": ["self", 42]}}', '{"policy": {"repos": "self"}}']) {
		const fx = makeFixture(bad);
		try {
			assert.deepEqual(loadConfig(fx.repo)?.policy?.repos, ["self"], bad);
		} finally { fx.cleanup(); }
	}
});

test("loadConfig: repos dedupes while keeping order; secondaries keep only absolute paths", () => {
	const fx = makeFixture('{"policy": {"repos": ["self", "/a", "/a", "/b"], "secondaries": ["/ok", "relative", 7, "/dup", "/ok"]}}');
	try {
		const p = loadConfig(fx.repo)?.policy;
		assert.deepEqual(p?.repos, ["self", "/a", "/b"]);
		assert.deepEqual(p?.secondaries, ["/ok", "/dup"]);
	} finally { fx.cleanup(); }
});

test("loadConfig: token_ttl_minutes falls back to 10 when missing, non-numeric or non-positive", () => {
	for (const bad of ['{"policy": {}}', '{"policy": {"token_ttl_minutes": "ten"}}', '{"policy": {"token_ttl_minutes": 0}}']) {
		const fx = makeFixture(bad);
		try {
			assert.equal(loadConfig(fx.repo)?.policy?.tokenTtlMinutes, 10, bad);
		} finally { fx.cleanup(); }
	}
});
