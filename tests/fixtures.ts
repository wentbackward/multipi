import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Fixture {
	dir: string;       // scratch root
	repo: string;      // main worktree
	origin: string;    // bare origin
	config: string;    // path of .devloop.json
	cleanup: () => void;
}

const sh = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

export function makeFixture(configJson: string): Fixture {
	const dir = mkdtempSync(path.join(tmpdir(), "multipi-unit-"));
	const origin = path.join(dir, "origin.git");
	const repo = path.join(dir, "proj");
	execFileSync("git", ["init", "-q", "--bare", origin]);
	execFileSync("git", ["clone", "-q", origin, repo], { stdio: "pipe" });
	sh(repo, "config", "user.email", "t@example.com");
	sh(repo, "config", "user.name", "Test");
	sh(repo, "config", "commit.gpgsign", "false");
	writeFileSync(path.join(repo, "README.md"), "x\n");
	sh(repo, "add", "-A");
	sh(repo, "commit", "-qm", "init");
	sh(repo, "push", "-q", "-u", "origin", "HEAD:main");
	const cfgPath = path.join(repo, ".devloop.json");
	writeFileSync(cfgPath, configJson);
	return {
		dir,
		repo,
		origin,
		config: cfgPath,
		cleanup: () => { try { execFileSync("rm", ["-rf", dir], { stdio: "ignore" }); } catch { /* */ } },
	};
}

export const BASE_CONFIG = JSON.stringify({
	base_branch: "main",
	remote: "origin",
	fast_check: "test -f README.md",
	format: "echo formatted {file} >> fmt.log",
	format_extensions: [".txt"],
	checks: [{ name: "unit", command: "true", heavy: false }],
	heavy: { slots: 2, poll_seconds: 1, port_env: "E2E_PORT", port_base: 9100, port_step: 10 },
	stop_gate: { require_clean_tree: true, max_blocks: 5 },
	merge: { method: "squash", delete_branch: true },
});
