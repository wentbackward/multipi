import { globSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, resolvePaths, scenariosOn } from "./config.ts";

/** Roles whose children must never see the scenario store (dark-factory spec §3). */
export const GUARDED_ROLES = ["implementer", "code-reviewer", "verifier"] as const;

/** Generic refusal: names the guard, not the store. The child sees THAT it is blocked, never WHY. */
export const GUARD_REFUSAL = "Blocked by the multipi role guard.";

/** Guarded file tools that take a path (spec §3); `bash` takes a command. Others name no paths. */
const PATH_TOOLS = ["read", "grep", "find", "ls", "edit", "write"] as const;

/** Guard state decided once at extension load (spec §3).
 * `enabled: true` with `storeDir: null` is FAIL CLOSED: the hook is present and every
 * guarded call is refused, so a broken config bricks the loop loudly rather than running
 * a guarded child loose. `enabled: false` means the store is off — register nothing, ever. */
export interface GuardInit {
	enabled: boolean;
	storeDir: string | null;
}

/** Decide the guard state from the .devloop.json in the CHILD'S working dir.
 * No env seam carries the store path — env is child-readable; the hook denies access, not knowledge. */
export function initGuard(cwd: string, env: NodeJS.ProcessEnv = process.env): GuardInit {
	const cfg = loadConfig(cwd, env);
	if (!cfg) return { enabled: true, storeDir: null }; // missing or unparseable ⇒ fail closed
	if (!scenariosOn(cfg)) return { enabled: false, storeDir: null }; // store off ⇒ the guard never registers
	try {
		const dir = resolvePaths(cfg, env).scenariosDir;
		return dir ? { enabled: true, storeDir: dir } : { enabled: true, storeDir: null };
	} catch {
		return { enabled: true, storeDir: null }; // unresolvable store path ⇒ fail closed
	}
}

/**
 * Best-effort command-line matching (spec §3: it reads the command line, not what runs):
 * refuse any `read`/`grep`/`find`/`ls`/`edit`/`write`/`bash` call whose arguments name a
 * path inside the store — absolute, `~/`- or `$HOME`-prefixed, cwd-relative (including
 * after a `cd` in the same command), a symlink into the store, or a glob whose expansion
 * intersects it. Honesty limits (documented): a script the child writes, a path assembled
 * at run time, or a recursive search of an ancestor directory are not caught.
 */
export function callTouchesStore(
	storeDir: string,
	cwd: string,
	toolName: string,
	input: Record<string, unknown>,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const store = path.resolve(storeDir);
	if (toolName === "bash") {
		return typeof input.command === "string" && commandTouchesStore(store, cwd, input.command, env);
	}
	if ((PATH_TOOLS as readonly string[]).includes(toolName)) {
		for (const key of ["path", "file_path"]) {
			const v = input[key];
			if (typeof v === "string" && pathTouchesStore(store, cwd, v, env)) return true;
		}
	}
	return false;
}

function homeOf(env: NodeJS.ProcessEnv): string {
	return env.HOME || os.homedir();
}

/** Expand a leading `~/`, `$HOME` or `${HOME}` against the env the child itself sees. */
function expandHome(p: string, env: NodeJS.ProcessEnv): string {
	const home = homeOf(env);
	if (p === "~" || p === "$HOME" || p === "${HOME}") return home;
	if (p.startsWith("~/")) return path.join(home, p.slice(2));
	const m = p.match(/^\$\{?HOME\}?\/(.*)$/s);
	return m ? path.join(home, m[1]) : p;
}

/** realpath with fallback to the lexical path (a not-yet-existing file is checked lexically). */
function realSafe(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		return p;
	}
}

function inside(p: string, root: string): boolean {
	return p === root || p.startsWith(root + path.sep);
}

function hasGlob(p: string): boolean {
	return /[?*[]/.test(p);
}

/** True when a path (after ~/$HOME expansion, glob expansion and symlink resolution) is in the store. */
function pathTouchesStore(store: string, cwd: string, p: string, env: NodeJS.ProcessEnv): boolean {
	const abs = path.resolve(cwd, expandHome(p, env));
	if (hasGlob(abs)) return globTouchesStore(abs, store);
	const realAbs = realSafe(abs);
	const realStore = realSafe(store);
	return inside(abs, store) || inside(realAbs, store) || inside(realAbs, realStore);
}

function globTouchesStore(pattern: string, store: string): boolean {
	let matches: string[];
	try {
		matches = globSync(pattern);
	} catch {
		return false; // not a usable glob pattern — best effort, skip
	}
	const realStore = realSafe(store);
	return matches.some((m) => inside(m, store) || inside(m, realStore) || inside(realSafe(m), realStore));
}

/** Strip surrounding quotes and one run of trailing punctuation (`, ) ;`). */
function cleanTok(raw: string): string {
	const unquoted = raw.replace(/^(['"])(.*)\1$/s, "$2");
	return unquoted.replace(/[),;]+$/g, "");
}

function isPathLike(tok: string): boolean {
	return tok.includes("/") || /^(~|\$HOME|\$\{HOME\})(\/|$)/.test(tok);
}

function commandTouchesStore(store: string, cwd: string, command: string, env: NodeJS.ProcessEnv): boolean {
	// Top-level segments; naive split on && || ; | and newlines (quoting is honoured
	// per-token, not per-segment — documented best effort, spec §3).
	const segments = command.replace(/\|\|/g, "\x01").replace(/&&/g, "\x01").split(/\x01|[;\n|]+/);
	let effCwd = cwd;
	for (const seg of segments) {
		const toks = seg.split(/\s+/).filter(Boolean).map(cleanTok);
		// A subshell paren does not hide the commands inside it from the reader of this line:
		// strip a leading `(` token (or an attached one, `(cd`), then the rest of the segment
		// is read exactly like the unparenthesised form.
		while (toks.length > 0 && toks[0] === "(") toks.shift();
		if (toks.length > 0 && toks[0].startsWith("(")) toks[0] = toks[0].slice(1);
		if (toks.length === 0) continue;
		// A cd moves the base dir for the rest of the command; landing inside the store is a touch.
		// -X-style flags before the target (cd -P, cd --) are options, not the target — skipping
		// them matters for RELATIVE targets, which the token loop below cannot see.
		if (toks[0] === "cd") {
			let i = 1;
			while (i < toks.length && toks[i].startsWith("-")) i++; // `cd -` has no resolvable target
			if (i < toks.length) {
				const target = expandHome(toks[i], env);
				if (pathTouchesStore(store, effCwd, target, env)) return true;
				effCwd = path.resolve(effCwd, target);
			}
		}
		for (const tok of toks) {
			if (isPathLike(tok) && pathTouchesStore(store, effCwd, tok, env)) return true;
		}
	}
	return false;
}
