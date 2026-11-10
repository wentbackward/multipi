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

/** Permission-policy posture (permission-policy spec §3): what an UNMATCHED call does. */
export type PolicyPosture = "allow" | "ask";

/** Permission-policy knobs (permission-policy spec §6/§7.3/§11-P1). The `policy` block of .devloop.json.
 * Rule arrays live in the sibling permissions.json (loaded by extension/src/policy.ts). */
export interface PolicyConfig {
	/** Default-allow with curated deny/ask classes (operator-confirmed); "ask" is the strict flip (future). */
	posture: PolicyPosture;
	/** Repo allowlist: "self" or absolute main-repo paths. Self-only is the default. */
	repos: string[];
	/** Foreign absolute paths where a mutation ASKS instead of denying (spec §7.1). */
	secondaries: string[];
	/** Ask-token TTL in minutes (spec §6; consumed by the phase-2 mint). */
	tokenTtlMinutes: number;
}

/** Confirmed defaults (operator 2026-11-09): default-allow, self-only, no secondaries, 10 min TTL. */
export const DEFAULT_POLICY: PolicyConfig = { posture: "allow", repos: ["self"], secondaries: [], tokenTtlMinutes: 10 };

/** Operating mode preset (dark-factory spec §1); see scenariosOn for the defaults it sets. */
export type FactoryMode = "collaborative" | "dark";

/** Scenario store settings (dark-factory spec §2). The block's mere presence turns the store on. */
export interface ScenariosConfig {
	dir?: string;
	run?: string;
	runSeconds: number;
	judge?: string;
	judgeSeconds: number;
	pass: number;
	minSatisfaction: number;
	sealed: number;
}

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
	/** Single dir holding all issue worktrees (default: <stateDir>/worktrees/<repo>; relative resolves against the repo PARENT). */
	worktreeDir?: string;
	/** Operating mode preset: "dark" turns scenarios on unless explicitly off; anything else is "collaborative". */
	factory: FactoryMode;
	/** Scenario store: an object (block present ⇒ store on in any mode); false (explicit off, wins even in dark); absent ⇒ on only in dark. */
	scenarios?: ScenariosConfig | false;
	/** Watchdog: kill a child that emits no output for this many minutes (default 30). */
	childSilenceMinutes: number;
	notesDir?: string;
	logsDir?: string;
	heavy: HeavyConfig;
	stopGate: StopGateConfig;
	merge: MergeConfig;
	/** Ask-token TTL / repo allowlist / posture (spec §11-P1); always present, defaults when the block is absent. */
	policy: PolicyConfig;
	deploy?: string;
}

export interface Paths {
	stateDir: string;
	notesDir: string;
	logsDir: string;
	gateDir: string;
	worktreeDir: string;
	/** Scenario store dir (spec §2): default <stateDir>/scenarios, a sibling of the worktrees dir. */
	scenariosDir: string;
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

/** Parse the `policy` block (permission-policy spec §11-P1). Absent ⇒ confirmed defaults.
 * Garbage posture coerces to the default (config-layer discipline, cf. factory); a repos list
 * with ANY untrusted entry (not "self", not an absolute path) invalidates the whole list to
 * ["self"] — widening the allowlist is a fail-closed direction, not a per-entry filter.
 * secondaries keep only absolute paths (dropping an entry can only tighten). */
export function parsePolicyBlock(raw: unknown): PolicyConfig {
	const o = (typeof raw === "object" && raw !== null && !Array.isArray(raw)) ? (raw as Record<string, unknown>) : {};
	const reposRaw = Array.isArray(o.repos) ? o.repos : null;
	let repos: string[];
	if (reposRaw === null || reposRaw.length === 0) {
		repos = ["self"];
	} else if (reposRaw.every((r) => r === "self" || (typeof r === "string" && r.startsWith("/")))) {
		repos = [...new Set(reposRaw as string[])];
	} else {
		repos = ["self"]; // one untrusted entry ⇒ the list is untrusted ⇒ self-only (fail closed)
	}
	const secondaries = Array.isArray(o.secondaries)
		? [...new Set(o.secondaries.filter((s): s is string => typeof s === "string" && s.startsWith("/")))]
		: [];
	const ttl = typeof o.token_ttl_minutes === "number" && Number.isFinite(o.token_ttl_minutes) && o.token_ttl_minutes > 0 ? o.token_ttl_minutes : 10;
	return { posture: o.posture === "ask" ? "ask" : "allow", repos, secondaries, tokenTtlMinutes: ttl };
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
	let scenarios: ScenariosConfig | false | undefined;
	if (raw.scenarios === false) {
		scenarios = false; // explicit off — wins even in a dark factory (spec §9)
	} else if (typeof raw.scenarios === "object" && raw.scenarios !== null && !Array.isArray(raw.scenarios)) {
		const so = raw.scenarios as Record<string, unknown>;
		scenarios = {
			dir: str(so.dir) || undefined,
			run: str(so.run) || undefined,
			runSeconds: num(so.run_seconds, 120),
			judge: str(so.judge) || undefined,
			judgeSeconds: num(so.judge_seconds, 600),
			pass: num(so.pass, 0.8),
			minSatisfaction: num(so.min_satisfaction, 0.9),
			sealed: num(so.sealed, 0.2),
		};
	}
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
		worktreeDir: str(raw.worktree_dir) || undefined,
		factory: raw.factory === "dark" ? "dark" : "collaborative",
		scenarios,
		childSilenceMinutes: num(raw.child_silence_minutes, 30),
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
		policy: parsePolicyBlock(raw.policy),
		deploy: str(raw.deploy) || undefined,
	};
}

/** The scenario-store switch (spec §1/§9): an explicit false is off even in dark; a present
 * block is on in any mode; absent, the dark preset turns it on and collaborative leaves it off. */
export function scenariosOn(cfg: DevloopConfig): boolean {
	if (cfg.scenarios === false) return false;
	if (cfg.scenarios) return true;
	return cfg.factory === "dark";
}

/** State directory, mirroring scripts/lib/common.sh: $MULTIPI_HOME/<repo> (default ~/.multipi). */
export function resolveState(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const root = mainRoot(cwd) ?? cwd;
	const home = env.MULTIPI_HOME ?? path.join(os.homedir(), ".multipi");
	return path.join(home, path.basename(root));
}

export function resolvePaths(cfg: DevloopConfig, env: NodeJS.ProcessEnv = process.env): Paths {
	const state = resolveState(cfg.root, env);
	// Like scripts/lib/common.sh ($HOME), `~/` expands against the HOME the caller gave us,
	// falling back to the OS home so process.env callers behave exactly as before.
	const home = env.HOME || os.homedir();
	const resolveOpt = (p?: string): string => {
		if (!p) return "";
		if (p.startsWith("~/")) return path.join(home, p.slice(2));
		return p.startsWith("/") ? p : path.join(cfg.root, p);
	};
	// All issue worktrees live in ONE dir per project (plus the gate worktree inside it),
	// so the repo's parent directory holds a single entry instead of one folder per ticket.
	const resolveWt = (p: string): string => (p.startsWith("~/") ? path.join(home, p.slice(2)) : p.startsWith("/") ? p : path.join(path.dirname(cfg.root), p));
	const wt = path.resolve(cfg.worktreeDir ? resolveWt(cfg.worktreeDir) : path.join(state, "worktrees", path.basename(cfg.root)));
	// Scenario store (spec §2): scenarios.dir resolves like worktree_dir (absolute, ~/, or
	// relative to the repo's PARENT — the store can never live inside the repo or its
	// worktrees); default <stateDir>/scenarios, a sibling of the worktrees dir.
	const sc = cfg.scenarios && typeof cfg.scenarios === "object" ? cfg.scenarios : undefined;
	const scDir = path.resolve(sc?.dir ? resolveWt(sc.dir) : path.join(state, "scenarios"));
	return {
		stateDir: state,
		notesDir: path.resolve(resolveOpt(cfg.notesDir) || path.join(state, "notes")),
		logsDir: path.resolve(resolveOpt(cfg.logsDir) || path.join(state, "logs")),
		gateDir: path.resolve(resolveOpt(cfg.gateWorktree) || path.join(wt, "gate")),
		worktreeDir: wt,
		scenariosDir: scDir,
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
