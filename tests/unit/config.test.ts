import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { loadConfig, resolveState } from "../../extension/src/config.ts";
import { repoSlugFromRemote } from "../../extension/src/config.ts";
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

test("repoSlugFromRemote parses https and ssh remote urls", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "slug-"));
	execFileSync("git", ["init", "-q", "-b", "main", dir]);
	execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/widget.git"]);
	assert.equal(repoSlugFromRemote(dir, "origin"), "acme/widget");
	execFileSync("git", ["-C", dir, "remote", "set-url", "origin", "git@github.com:acme/widget"]);
	assert.equal(repoSlugFromRemote(dir, "origin"), "acme/widget");
	assert.equal(repoSlugFromRemote(dir, "nope"), "");
});
