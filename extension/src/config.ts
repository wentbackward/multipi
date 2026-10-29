import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface CheckSpec { name: string; command: string; heavy: boolean; summary?: string; }
export interface HeavyConfig {
	slots: number;
	memoryMax?: string;
	portEnv?: string;
	portBase: number;
	portStep: number;
	cleanTemp: string[];
	cleanTempMinutes: number;
	pollSeconds: number;
}
export interface StopGateConfig { requireCleanTree: boolean; maxBlocks: number; }
export interface MergeConfig { method: string; deleteBranch: boolean; }

export interface DevloopConfig {
	/** Main worktree root (where .devloop.json lives). */
	root: string;
	baseBranch: string;
	remote: string;
	fastCheck?: string;
	format?: string;
	formatExtensions?: string[];
	checks: CheckSpec[];
	gateSetup?: string;
	gateWorktree?: string;
	notesDir?: string;
	logsDir?: string;
	heavy: HeavyConfig;
	stopGate: StopGateConfig;
	merge: MergeConfig;
	deploy?: string;
}

export interface Paths {
	stateDir: string;
	notesDir: string;
	logsDir: string;
	gateDir: string;
}

function str(v: unknown, d = ""): string {
	return typeof v === "string" && v.length > 0 ? v : d;
}
function num(v: unknown, d: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function bool(v: unknown, d: boolean): boolean {
	return typeof v === "boolean" ? v : d;
}

/** Root of the main worktree containing cwd (mirrors scripts/lib/common.sh dl_main_root). */
export function mainRoot(cwd: string): string | null {
	try {
		const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, stdio: "pipe" }).toString().trim();
		if (path.basename(common) === ".git") return path.dirname(common);
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe" }).toString().trim();
	} catch {
		return null;
	}
}

/** Locate and parse .devloop.json for the repo containing cwd. Null when not in a repo, no config, or invalid JSON. */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): DevloopConfig | null {
	const root = mainRoot(cwd);
	if (!root) return null;
	const cfgPath = env.MULTIPI_CONFIG ?? path.join(root, ".devloop.json");
	if (!existsSync(cfgPath)) return null;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(cfgPath, "utf8"));
	} catch {
		return null;
	}
	const h = (raw.heavy ?? {}) as Record<string, unknown>;
	const sg = (raw.stop_gate ?? {}) as Record<string, unknown>;
	const mg = (raw.merge ?? {}) as Record<string, unknown>;
	const checksRaw = Array.isArray(raw.checks) ? raw.checks : [];
	const checks: CheckSpec[] = checksRaw.map((c, i) => {
		if (typeof c === "string") return { name: `check-${i + 1}`, command: c, heavy: true };
		const o = (c ?? {}) as Record<string, unknown>;
		return {
			name: str(o.name, `check-${i + 1}`),
			command: str(o.command),
			heavy: bool(o.heavy, true),
			summary: str(o.summary) || undefined,
		};
	});
	return {
		root,
		baseBranch: str(raw.base_branch, "main"),
		remote: str(raw.remote, "origin"),
		fastCheck: str(raw.fast_check) || undefined,
		format: str(raw.format) || undefined,
		formatExtensions: Array.isArray(raw.format_extensions) ? (raw.format_extensions as string[]) : undefined,
		checks,
		gateSetup: str(raw.gate_setup) || undefined,
		gateWorktree: str(raw.gate_worktree) || undefined,
		notesDir: str(raw.notes_dir) || undefined,
		logsDir: str(raw.logs_dir) || undefined,
		heavy: {
			slots: num(h.slots, 2),
			memoryMax: str(h.memory_max) || undefined,
			portEnv: str(h.port_env) || undefined,
			portBase: num(h.port_base, 8600),
			portStep: num(h.port_step, 10),
			cleanTemp: Array.isArray(h.clean_temp) ? (h.clean_temp as string[]) : [],
			cleanTempMinutes: num(h.clean_temp_minutes, 120),
			pollSeconds: num(h.poll_seconds, 10),
		},
		stopGate: { requireCleanTree: bool(sg.require_clean_tree, true), maxBlocks: num(sg.max_blocks, 5) },
		merge: { method: str(mg.method, "squash"), deleteBranch: bool(mg.delete_branch, true) },
		deploy: str(raw.deploy) || undefined,
	};
}

/** State directory, mirroring scripts/lib/common.sh: $MULTIPI_HOME/<repo> (default ~/.multipi). */
export function resolveState(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const root = mainRoot(cwd) ?? cwd;
	const home = env.MULTIPI_HOME ?? path.join(os.homedir(), ".multipi");
	return path.join(home, path.basename(root));
}

export function resolvePaths(cfg: DevloopConfig, env: NodeJS.ProcessEnv = process.env): Paths {
	const state = resolveState(cfg.root, env);
	const resolveOpt = (p?: string): string => {
		if (!p) return "";
		if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
		return p.startsWith("/") ? p : path.join(cfg.root, p);
	};
	return {
		stateDir: state,
		notesDir: path.resolve(resolveOpt(cfg.notesDir) || path.join(state, "notes")),
		logsDir: path.resolve(resolveOpt(cfg.logsDir) || path.join(state, "logs")),
		gateDir: path.resolve(resolveOpt(cfg.gateWorktree) || path.join(path.dirname(cfg.root), `${path.basename(cfg.root)}-gate`)),
	};
}

/** `owner/name` of the configured remote (https or ssh URL form), or "" when undecipherable.
 * gh defaults to the PARENT tracker inside a fork, so every gh call pins this slug. */
export function repoSlugFromRemote(root: string, remote: string): string {
	try {
		const url = spawnSync("git", ["remote", "get-url", remote], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
			.stdout.toString().trim();
		const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
		return m ? `${m[1]}/${m[2]}` : "";
	} catch {
		return "";
	}
}
