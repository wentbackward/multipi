import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Ticket #68 unit pins for the shared resolution rule (scripts/policy-shims/lib/policyshim.sh):
// `shim_find_real` must never return a git that is an INTERPRETED SCRIPT — the pre-fix rule
// returned the first executable outside the shim dir, so under a double-wrapped PATH it was
// the OTHER wrapper, and two wrappers mutual-exec'd in one PID forever (12 h, a wedged slot).
// And `_shim_exec_real` (the recursion guard both shims exec through) must hard-refuse
// above depth 3.
//
// The snippets run bash with a FULLY CRAFTED PATH (only the fixture layers) — the rule is
// wrapper-agnostic and judged by magic bytes, so no inheritance can leak in. The ARMED
// environment (the dogfood shim dir on PATH, the loop's own arming) is pinned on the smoke
// side, where the loop's PATH is exactly the input the ticket names.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, "..", "..", "scripts", "policy-shims", "lib", "policyshim.sh");
const BASH = ["/usr/bin/bash", "/bin/bash"].find((p) => existsSync(p)) ?? "/bin/bash";
assert.ok(BASH, "bash for the snippets");

/** dir with an executable bash `git` (first bytes = `#!` script magic). */
function scriptGit(dir: string, body: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "git"), body, { mode: 0o755 });
}

/** dir with an executable bash `name` (first bytes = `#!` script magic). */
function scriptBin(dir: string, name: string, body: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, name), body, { mode: 0o755 });
}

/** dir with a fake COMPILED `name` (ELF magic bytes; never exec'd — only inspected). */
function compiledBin(dir: string, name: string): string {
	mkdirSync(dir, { recursive: true });
	const p = path.join(dir, name);
	writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
	chmodSync(p, 0o755);
	return p;
}

/** dir with a fake COMPILED `git` (ELF magic bytes; never exec'd — only inspected). */
function compiledGit(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const p = path.join(dir, "git");
	writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
	chmodSync(p, 0o755);
	return p;
}

/** Run a bash snippet that sources the library (after `set -u`); returns the triad. */
function runShim(snippet: string, extraEnv: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
	const r = spawnSync(BASH, ["-c", `set -u\n. "${LIB}"\n${snippet}`], {
		env: { PATH: "/usr/bin:/bin", ...extraEnv },
		encoding: "utf8",
	});
	return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// --- shim_find_real: the compiled-artifact rule --------------------------------

test("shim_find_real resolves the real git past two mutually-exec'd bash wrappers (the #68 incident geometry)", () => {
	const root = mkdtempSync(path.join(tmpdir(), "policyshim-test."));
	const a = `${root}/wrap-a`;
	const b = `${root}/wrap-b`;
	// Each wrapper execs the OTHER — the pre-fix resolution made this pair spin:
	scriptGit(a, `#!/usr/bin/env bash\nexec "${b}/git" "$@"\n`);
	scriptGit(b, `#!/usr/bin/env bash\nexec "${a}/git" "$@"\n`);
	const realGit = compiledGit(`${root}/real`);
	const got = runShim(`SIM_SHIM_DIR="${root}/no-such-shim-dir"\nshim_find_real git`, { PATH: `${a}:${b}:${root}/real` });
	assert.equal(got.status, 0, `stderr: ${got.stderr}`);
	assert.equal(got.stdout.trim(), realGit, "REAL_GIT is the compiled git, not either wrapper");
});

test("shim_find_real skips a `git` that is a SYMLINK to an interpreted script", () => {
	const root = mkdtempSync(path.join(tmpdir(), "policyshim-test."));
	const target = `${root}/script-target`;
	const linkdir = `${root}/links`;
	scriptGit(target, "#!/usr/bin/env bash\necho fake\n");
	mkdirSync(linkdir);
	symlinkSync(`${target}/git`, `${linkdir}/git`);
	const realGit = compiledGit(`${root}/real`);
	const got = runShim(`SIM_SHIM_DIR="${root}/no-such-shim-dir"\nshim_find_real git`, { PATH: `${linkdir}:${root}/real` });
	assert.equal(got.status, 0, `stderr: ${got.stderr}`);
	assert.equal(got.stdout.trim(), realGit, "a symlink to a script wrapper must be skipped");
});

test("shim_find_real skips the shim's OWN dir and fails (rc 1, no output) when only scripts remain", () => {
	const root = mkdtempSync(path.join(tmpdir(), "policyshim-test."));
	const shimdir = `${root}/shimdir`;
	const other = `${root}/other`;
	const real = `${root}/real`;
	scriptGit(shimdir, "#!/usr/bin/env bash\necho me\n");
	scriptGit(other, "#!/usr/bin/env bash\necho me2\n");
	const compiled = compiledGit(real);
	// own dir (excluded by dir) + foreign script (excluded by the rule) + compiled (kept):
	let got = runShim(`SIM_SHIM_DIR="${shimdir}"\nshim_find_real git`, { PATH: `${shimdir}:${other}:${real}` });
	assert.equal(got.status, 0, `stderr: ${got.stderr}`);
	assert.equal(got.stdout.trim(), compiled);
	// scripts only: rc 1, silent — the caller exits 127 (broken install).
	got = runShim(`SIM_SHIM_DIR="${shimdir}"\nshim_find_real git`, { PATH: `${shimdir}:${other}` });
	assert.equal(got.status, 1, "no compiled binary on PATH ⇒ rc 1");
	assert.equal(got.stdout, "");
});

// --- shim_is_compiled: the fail direction ---------------------------------------

/** dir with an executable `git` whose first two bytes are exactly `bytes`. */
function weirdGit(dir: string, bytes: Buffer): string {
	mkdirSync(dir, { recursive: true });
	const p = path.join(dir, "git");
	writeFileSync(p, bytes);
	chmodSync(p, 0o755);
	return p;
}

test("shim_is_compiled REJECTS an empty file (read failure is not acceptance)", () => {
	const dir = `${mkdtempSync(path.join(tmpdir(), "policyshim-test."))}/empty`;
	const p = weirdGit(dir, Buffer.alloc(0));
	const got = runShim(`shim_is_compiled "${p}" && echo compiled || echo script`);
	assert.equal(got.status, 0, `stderr: ${got.stderr}`);
	assert.equal(got.stdout.trim(), "script", "an empty candidate must fail, not pass, the compiled check");
});

test("shim_is_compiled REJECTS an UNREADABLE file (read failure is not acceptance)", () => {
	const root = mkdtempSync(path.join(tmpdir(), "policyshim-test."));
	const p = weirdGit(`${root}/noperm`, Buffer.from("ELF-fake-bytes"));
	chmodSync(p, 0o000);
	try {
		const got = runShim(`shim_is_compiled "${p}" && echo compiled || echo script`);
		assert.equal(got.status, 0, `stderr: ${got.stderr}`);
		// The snippets run as the current user; the check must still be decisive, never accept.
		if (process.getuid?.() === 0) {
			console.warn("SKIP-ASSERT: running as root, unreadable files are still readable");
		} else {
			assert.equal(got.stdout.trim(), "script", "an unreadable candidate must fail, not pass");
		}
	} finally {
		chmodSync(p, 0o755);
	}
});

test("shim_is_compiled accepts a compiled candidate (2-byte ELF magic) and rejects the #! magic", () => {
	const root = mkdtempSync(path.join(tmpdir(), "policyshim-test."));
	const good = weirdGit(`${root}/good`, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
	const bad = weirdGit(`${root}/bad`, Buffer.from("#!/bin/sh\n"));
	const got = runShim(`shim_is_compiled "${good}" || echo fail-good
shim_is_compiled "${bad}" && echo fail-bad || true`);
	assert.equal(got.status, 0, `stderr: ${got.stderr}`);
	assert.equal(got.stdout.trim(), "", "ELF magic accepted, script magic rejected");
});

// --- _shim_exec_real: the recursion depth guard (continued: the seam's own forwarders) ----

// The REAL gh shim artifact: the forwarder-bound pin runs it, not a copy — the guard must
// hold on the product, and a self-referencing seam is the seam analogue of the #68 spin.
const GH_SHIM = path.resolve(HERE, "..", "..", "scripts", "policy-shims", "gh");

test("a MULTIPI_SHIM_REAL_GH seam pointing at the SHIM ITSELF dies at the depth guard (126, nothing runs)", () => {
	// Each hop: the shim resolves the seam (= itself) and execs through _shim_exec_real —
	// the counter climbs one per hop and the 4th hop must refuse. Pre-guard, this geometry
	// would mutual-spin exactly like the #68 incident (whose resolution was PATH-derived);
	// the seam must not reopen that class with an operator/operator-fixure authority.
	const r = spawnSync(BASH, [GH_SHIM, "--version"], {
		env: { PATH: "/usr/bin:/bin", MULTIPI_SHIM_REAL_GH: GH_SHIM },
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(r.status, 126, `the refusal must land, got ${r.status}; stderr: ${r.stderr}`);
	assert.match(r.stderr, /recursion/i, `the stderr line names the guard: ${r.stderr}`);
});

// --- the MULTIPI_SHIM_REAL_* seams (ticket #72): authority order and fail direction --------
// The seam is the FIRST authority for the shim's real-binary resolution: a process that
// sets it owns the resolution for its own tree, and a seam target is NOT required to be a
// compiled artifact (that is how an offline script stand-in serves a test env — and its
// calls.log then proves the real binary was never reached). A BROKEN seam target fails
// closed (rc 1) and NEVER falls back to the PATH scan: a typo'd seam leaking onto the
// first compiled binary is the exact leak the seam exists to prevent.

test("shim_find_real consults MULTIPI_SHIM_REAL_GH first: a script stand-in beats an EARLIER compiled gh", () => {
	const root = mkdtempSync(path.join(tmpdir(), "policyshim-test."));
	const standin = `${root}/standin`;
	const real = `${root}/real`;
	scriptBin(standin, "gh", "#!/usr/bin/env bash\necho standin\n");
	compiledBin(real, "gh"); // compiled and AHEAD on PATH: the #68 scan would pick it
	const got = runShim(`SIM_SHIM_DIR="${root}/no-such-shim-dir"\nshim_find_real gh`, {
		PATH: `${real}:${root}`,
		MULTIPI_SHIM_REAL_GH: `${standin}/gh`,
	});
	assert.equal(got.status, 0, `stderr: ${got.stderr}`);
	assert.equal(got.stdout.trim(), `${standin}/gh`, "the valid seam wins over the compiled-on-PATH scan");
});

test("shim_find_real consults MULTIPI_SHIM_REAL_GIT first (symmetric seam for the git shim)", () => {
	const root = mkdtempSync(path.join(tmpdir(), "policyshim-test."));
	const standin = `${root}/standin`;
	const real = `${root}/real`;
	scriptBin(standin, "git", "#!/usr/bin/env bash\necho standin\n");
	compiledBin(real, "git");
	const got = runShim(`SIM_SHIM_DIR="${root}/no-such-shim-dir"\nshim_find_real git`, {
		PATH: `${real}:${root}`,
		MULTIPI_SHIM_REAL_GIT: `${standin}/git`,
	});
	assert.equal(got.status, 0, `stderr: ${got.stderr}`);
	assert.equal(got.stdout.trim(), `${standin}/git`, "the git seam is per-binary, like the gh seam");
});

test("shim_find_real resolves a seam target with NO compiled binary anywhere on PATH (the gh-less host)", () => {
	const root = mkdtempSync(path.join(tmpdir(), "policyshim-test."));
	const standin = `${root}/standin`;
	const shimdir = `${root}/shimdir`;
	scriptBin(standin, "gh", "#!/usr/bin/env bash\necho standin\n");
	scriptBin(shimdir, "gh", "#!/usr/bin/env bash\necho me\n");
	// The scan alone finds only scripts (rc 1, the pre-#72 fail-closed 127); the seam lifts
	// the stand-in without consulting PATH at all.
	const got = runShim(`SIM_SHIM_DIR="${shimdir}"\nshim_find_real gh`, {
		PATH: `${shimdir}:${root}`,
		MULTIPI_SHIM_REAL_GH: `${standin}/gh`,
	});
	assert.equal(got.status, 0, `stderr: ${got.stderr}`);
	assert.equal(got.stdout.trim(), `${standin}/gh`);
});

test("shim_find_real: the GIT seam does NOT authorize the GH shim (seams are per-binary)", () => {
	const root = mkdtempSync(path.join(tmpdir(), "policyshim-test."));
	const standin = `${root}/standin`;
	const real = `${root}/real`;
	scriptBin(standin, "git", "#!/usr/bin/env bash\necho standin\n");
	const compiledGh = compiledBin(real, "gh");
	// Only the GIT seam is set; a `shim_find_real gh` must fall through to the scan.
	const got = runShim(`SIM_SHIM_DIR="${root}/no-such-shim-dir"\nshim_find_real gh`, {
		PATH: `${real}:${root}`,
		MULTIPI_SHIM_REAL_GIT: `${standin}/git`,
	});
	assert.equal(got.status, 0, `stderr: ${got.stderr}`);
	assert.equal(got.stdout.trim(), compiledGh, "a foreign binary's seam must not resolve this shim");
});

test("shim_find_real FAILS CLOSED on a MISSING seam target — rc 1, and NO fallback to the compiled scan", () => {
	const root = mkdtempSync(path.join(tmpdir(), "policyshim-test."));
	const real = `${root}/real`;
	compiledBin(real, "gh"); // scannable and healthy: the tempting wrong answer
	const got = runShim(`SIM_SHIM_DIR="${root}/no-such-shim-dir"\nshim_find_real gh`, {
		PATH: `${real}:${root}`,
		MULTIPI_SHIM_REAL_GH: `${root}/nowhere/gh`,
	});
	assert.equal(got.status, 1, "an unusable seam target fails closed");
	assert.equal(got.stdout, "", "no path printed — the caller exits 127, nothing exec'd");
});

test("shim_find_real FAILS CLOSED on a NOT-EXECUTABLE seam target — rc 1, and NO fallback to the compiled scan", () => {
	const root = mkdtempSync(path.join(tmpdir(), "policyshim-test."));
	const broken = `${root}/broken`;
	const real = `${root}/real`;
	mkdirSync(broken, { recursive: true });
	writeFileSync(path.join(broken, "gh"), "#!/usr/bin/env bash\necho standin\n"); // readable, mode 644
	compiledBin(real, "gh");
	const got = runShim(`SIM_SHIM_DIR="${root}/no-such-shim-dir"\nshim_find_real gh`, {
		PATH: `${real}:${root}`,
		MULTIPI_SHIM_REAL_GH: `${broken}/gh`,
	});
	assert.equal(got.status, 1, "a non-executable seam target fails closed");
	assert.equal(got.stdout, "", "no path printed — the caller exits 127, nothing exec'd");
});

test("shim_find_real: an EMPTY seam value is unset (the compiled-on-PATH scan applies)", () => {
	const root = mkdtempSync(path.join(tmpdir(), "policyshim-test."));
	const real = `${root}/real`;
	const compiled = compiledBin(real, "gh");
	const got = runShim(`SIM_SHIM_DIR="${root}/no-such-shim-dir"\nshim_find_real gh`, {
		PATH: `${real}:${root}`,
		MULTIPI_SHIM_REAL_GH: "",
	});
	assert.equal(got.status, 0, `stderr: ${got.stderr}`);
	assert.equal(got.stdout.trim(), compiled, "empty means unset — the #68 rule is unchanged");
});

// --- _shim_exec_real: the recursion depth guard ---------------------------------

test("_shim_exec_real execs at depth 0 with the counter bumped to 1", () => {
	const got = runShim(`_shim_exec_real ${BASH} -c 'printf "%s" "$_POLICYSHIM_DEPTH"'`);
	assert.equal(got.status, 0, `stderr: ${got.stderr}`);
	assert.equal(got.stdout, "1");
});

test("_shim_exec_real passes the bumped counter down (2 → 3) and execs", () => {
	const got = runShim(`_POLICYSHIM_DEPTH=2\n_shim_exec_real ${BASH} -c 'printf "%s" "$_POLICYSHIM_DEPTH"'`);
	assert.equal(got.status, 0, `stderr: ${got.stderr}`);
	assert.equal(got.stdout, "3");
});

test("_shim_exec_real hard-refuses above depth 3: exit 126, a stderr line, nothing exec'd", () => {
	// depth 3: the NEXT hop would land at 4 > 3 → refuse.
	const got = runShim(`_POLICYSHIM_DEPTH=3\n_shim_exec_real ${BASH} -c 'echo SHOULD-NOT-RUN'`);
	assert.equal(got.status, 126, `expected 126, got ${got.status}; stderr: ${got.stderr}`);
	assert.equal(got.stdout, "", "the command must not run");
	assert.match(got.stderr, /recursion/i, `the stderr line names the guard: ${got.stderr}`);
});

test("a mutual-exec chain dies at the guard on hop 4 (the pre-fix infinite loop, bounded)", () => {
	// Each hop = one nested bash running _shim_exec_real the way a shim does; the chain
	// carries only the counter (as the exec-chain env does). Hops 1–3 bump to 3, hop 4
	// refuses — the exact bound where the incident's A→B→A→B spin used to run forever.
	// (The real two-layer PATH is exercised end to end on the smoke side.)
	const nested = runShim(`
	  # The innermost script rides an ENV VAR, not the argv chain: quoting three bash levels
	  # through argument lists is exactly the footgun this test must not have.
	  PAYLOAD='echo $_POLICYSHIM_DEPTH'
	  d=0
	  for hop in 1 2 3 4; do
	    out=$(env _POLICYSHIM_DEPTH=$d PAYLOAD="$PAYLOAD" ${BASH} -c '. "${LIB}" && _shim_exec_real "${BASH}" -c "$PAYLOAD"' 2>&1)
	    rc=$?
	    if [ $rc -ne 0 ]; then echo "hop\${hop}=126"; break; fi
	    d=$out
	  done
	  echo "depth=$d"`);
	assert.match(nested.stdout, /hop4=126/, `hop 4 must be the refusal: ${nested.stdout}`);
	assert.match(nested.stdout, /depth=3/, `hops 1–3 must reach depth 3: ${nested.stdout}`);
});
