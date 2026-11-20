import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactActionSummary, ACTION_SUMMARY_MAX } from "../../extension/src/policy.ts";

/**
 * #55 equivalence pin: the shell redactor (scripts/policy-shims/lib/policyshim.sh,
 * `_shim_redact_summary`) is the ONE path that bypasses the TS redactor
 * (`policy.ts`, `redactActionSummary`) — the shim's fallback audit line. A one-line
 * drift in the sed program or the bound would silently desynchronise redaction
 * between layers (log hygiene is security-relevant: token-dir paths must never
 * leak). This test feeds IDENTICAL adversarial strings through both engines and
 * asserts byte-identical output, plus literal expectations on representative
 * cases so the two engines cannot drift in TOGETHER.
 *
 * Offline: it spawns the local `bash` against the repo's own script — no network.
 * Corpus is ASCII except where a multi-byte case is marked (short of the bound, so
 * byte-wise vs code-point-wise matching is locale-insensitive there).
 *
 * KNOWN RESIDUALS — three accepted engine divergences outside the corpus. The
 * byte-identity above is total OVER THE CORPUS, not over the whole input space.
 * In every residual the token-dir SCRUB itself is identical (the literal core is
 * removed by both engines); where the divergence is asymmetric (residuals 2 and 3)
 * the shim removes at least as much as the TS engine — never less. None of these is
 * a leak. Each is pinned by an exact-literal test below: if an engine is ever
 * aligned, amend that test AND this note in the same change.
 *
 * 1. ASTRAL-PLANE COUNTING (pre-existing, DECISIONS.md 2026-11-14): astral-plane
 *    characters count 1 in a UTF-8 bash but 2 UTF-16 units in TS, so the two engines
 *    may cut a few characters apart on emoji-heavy strings crossing the bound.
 *    Direction is symmetric (either may cut slightly sooner); both outputs stay
 *    valid, bounded UTF-8.
 *
 * 2. UNICODE WHITESPACE IN THE SPAN CLASS (the #55 review-tail residual, NBSP case
 *    pinned below): JS `\s` and POSIX `[:space:]` diverge — glibc does not put U+00A0
 *    in `[:space:]` even under C.utf8, so `~/.m/dev-loop-tokens\u00A0tail` yields
 *    `x <token-dir>\u00A0tail` in TS but `x <token-dir>` in the shim; U+2028 adds a
 *    C-locale-scoped divergence (glibc's C `[:space:]` is ASCII-only). Direction is
 *    asymmetric: the shim OVER-scrubs (it eats the whitespace-separated tail that TS
 *    keeps) — more removed, never less.
 *
 * 3. TRAILING NEWLINE (the #55 review-tail residual, pinned below): the shim's
 *    `s=$(…)` substitutions (scripts/policy-shims/lib/policyshim.sh — a pre-existing
 *    pattern, the sed line predates the consolidation branch) strip a trailing
 *    newline from the summary while the TS redactor preserves it. Direction is
 *    asymmetric: the shim DROPS the line terminator; the scrub itself is identical,
 *    so the shim never prints material the TS engine would not have. Low-value input
 *    for a fallback audit line — kept as an accepted documented difference, not
 *    aligned.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Run `_shim_redact_summary` over `s` via the repo's own shell lib (input via env — no
 * quoting layer between the corpus and the function). `extraEnv` overrides the environment
 * (the C-locale pin drives LC_ALL/LANG). Output is decoded FATAL: a mid-UTF-8-sequence cut
 * (a lone 0xB6 tail — the reviewed repro) throws instead of masking itself as U+FFFD.
 * Valid UTF-8 is thus asserted on EVERY call. */
function shimRedact(s: string, extraEnv: NodeJS.ProcessEnv = {}): string {
	const out = execFileSync(
		"bash",
		["-c", ". ./scripts/policy-shims/lib/policyshim.sh; printf '%s' \"$(_shim_redact_summary \"$RS_EQUIV_IN\")\""],
		{ cwd: ROOT, encoding: "buffer", env: { ...process.env, RS_EQUIV_IN: s, ...extraEnv } },
	);
	return new TextDecoder("utf-8", { fatal: true }).decode(out);
}

/** The adversarial corpus: every home spelling, boundaries, negatives, duplicates,
 * metacharacter adjacency, the truncation boundary (160/161), truncation-after-replace
 * order, and a short multi-byte case. */
const CORPUS: { name: string; input: string }[] = [
	{ name: "empty input", input: "" },
	{ name: "ordinary command travels verbatim", input: "bash: git status" },
	{ name: "tilde spelling, quoted", input: 'bash: git push "~/.multipi/x/dev-loop-tokens/a.tok"' },
	{ name: "$HOME spelling", input: "cat $HOME/.multipi/proj/dev-loop-tokens/gh.pr-merge.tok" },
	{ name: "${HOME} spelling", input: "echo ${HOME}/.multipi/y/dev-loop-tokens" },
	{ name: "absolute home spelling, deep path", input: "rm -rf /home/role/.multipi/z/dev-loop-tokens/dir/deep/x.y" },
	{ name: "two occurrences in one string", input: "cp ~/.m/dev-loop-tokens/t1 ~/.m2/dev-loop-tokens/t2" },
	{ name: "token suffix keeps spanning (dev-loop-tokensX/)", input: "ls ~/dev-loop-tokensx/" },
	{ name: "negative: bare name without a prefix", input: "dev-loop-tokens" },
	{ name: "negative: underscore variant", input: "ls x/dev_loop_tokens" },
	{ name: "metachars stop the match at |", input: "grep '~/.m/dev-loop-tokens|' f" },
	{ name: "token at the very start", input: "~/.multipi/a/dev-loop-tokens/t rest" },
	{ name: "boundary: exactly 160 chars — no truncation", input: "a".repeat(ACTION_SUMMARY_MAX) },
	{ name: "boundary: 161 chars — cut at the bound, ellipsis marks it", input: "a".repeat(ACTION_SUMMARY_MAX + 1) },
	{ name: "long: 500 chars", input: "sudo " + "x".repeat(500) },
	{
		name: "order: replace THEN bound (token inside the window)",
		input: "p".repeat(150) + " ~/.m/dev-loop-tokens/abcdef",
	},
	{
		name: "order: token beyond the bound is never shown",
		input: "q".repeat(180) + " ~/.m/dev-loop-tokens/secret",
	},
	{ name: "multi-byte, short of the bound", input: "caf\u00e9 \u00d7 \u2192 \u65e5\u672c\u8a9b ~/.m/dev-loop-tokens/t ok" },
	{ name: "quotes inside", input: "echo 'a\"b' | tr '&' '<token-dir>'" },
	// #55 review SF1 — the bound must count CHARACTERS under a pinned UTF-8 locale, never
	// bytes: under a C-locale caller the pre-fix ${#s}/${s:0:160} cut mid-sequence.
	{
		name: "over the bound in BYTES only (83 chars / 219 bytes) — a byte cut would split a sequence",
		input: "\u2192".repeat(53) + "\u00e9".repeat(30),
	},
	{
		name: "over the bound in CHARS (175) — cut at the bound by characters, never bytes",
		input: "\u00e9".repeat(ACTION_SUMMARY_MAX + 10) + " tail",
	},
];

test("the shell redactor outputs byte-identical text to the TS redactor (one contract, #55)", () => {
	for (const { name, input } of CORPUS) {
		const ts = redactActionSummary(input, null);
		const sh = shimRedact(input);
		assert.equal(sh, ts, `${name}: shell ${JSON.stringify(sh)} !== TS ${JSON.stringify(ts)}`);
	}
});

test("representative outputs are the LITERAL contract (the engines cannot drift together)", () => {
	// Token-dir scrubbing — every home spelling collapses to the placeholder.
	assert.equal(shimRedact(CORPUS[2].input), 'bash: git push "<token-dir>"');
	assert.equal(shimRedact(CORPUS[3].input), "cat <token-dir>");
	assert.equal(shimRedact(CORPUS[5].input), "rm -rf <token-dir>");
	// Negatives are NOT over-scrubbed.
	assert.equal(shimRedact(CORPUS[8].input), "dev-loop-tokens");
	assert.equal(shimRedact(CORPUS[9].input), "ls x/dev_loop_tokens");
	// Metacharacter boundary: the span stops at the excluded class.
	assert.equal(shimRedact(CORPUS[10].input), "grep '<token-dir>|' f");
	// Truncation boundary: 160 passes, 161 cuts at 160 and marks with the ellipsis.
	assert.equal(shimRedact(CORPUS[12].input).length, ACTION_SUMMARY_MAX);
	const cut = shimRedact(CORPUS[13].input);
	assert.equal(cut.length, ACTION_SUMMARY_MAX + 1, "161-char input cuts to bound + ellipsis");
	assert.ok(cut.endsWith("\u2026"), "the ellipsis marks the truncation");
	// Order: the replace shrinks the string BEFORE the bound is applied — a token spanning
	// the bound leaves a PARTIAL placeholder (proving replace ran first: a bound-first
	// implementation would erase it entirely).
	const reordered = shimRedact(CORPUS[15].input);
	assert.equal(reordered, "p".repeat(150) + " <token-di\u2026", "token replaced, then cut at the bound");
	assert.ok(!reordered.includes("dev-loop-tokens"), "no raw token path survives");
	assert.equal(reordered.length, ACTION_SUMMARY_MAX + 1, "bounded");
	// Multi-byte over the bound: the cut counts CHARACTERS, never bytes.
	assert.equal(shimRedact(CORPUS[19].input), CORPUS[19].input, "byte-long but char-short: untouched");
	assert.equal(shimRedact(CORPUS[20].input), "\u00e9".repeat(ACTION_SUMMARY_MAX) + "\u2026", "175 chars cut to 160 + ellipsis");
});

test("residual 2 (NBSP): stops the TS span (JS \\s) but not the shim span (POSIX [:space:]) — the shim OVER-scrubs (#55 review-tail)", () => {
	// glibc puts U+00A0 in NO [:space:] (not even under C.utf8) while JS \\s matches it:
	// the TS span halts AT the NBSP, the shim span swallows it and the tail with it.
	// Pinned under the default locale AND a C-locale caller — the direction is the same
	// everywhere: the shim removes MORE, never less (no raw token-dir core in either).
	// NB: the ambient-locale leg asserts the shim's DEFAULT output, so it leans on that "NBSP in no glibc [:space:]" premise (mirroring the U+2028 pin's scoping); the C-locale leg pins the direction regardless.
	for (const extraEnv of [{}, { LC_ALL: "C", LANG: "C" }] as NodeJS.ProcessEnv[]) {
		const input = "x ~/.m/dev-loop-tokens\u00A0tail";
		assert.equal(redactActionSummary(input, null), "x <token-dir>\u00A0tail", "TS: \\s stops the span at NBSP");
		assert.equal(shimRedact(input, extraEnv), "x <token-dir>", "shim: [:space:] lacks NBSP — the span eats the tail");
	}
});

test("residual 2 (scope: U+2028): diverges ONLY for a C-locale caller, same over-scrub direction (#55 review-tail)", () => {
	const input = "x ~/.m/dev-loop-tokens\u2028tail";
	assert.equal(redactActionSummary(input, null), "x <token-dir>\u2028tail", "TS: \\s matches U+2028");
	assert.equal(
		shimRedact(input, { LC_ALL: "C", LANG: "C" }),
		"x <token-dir>",
		"C-locale caller: [:space:] is ASCII-only, the span eats the tail",
	);
	// NB: under a UTF-8 ambient locale glibc DOES put U+2028 in [:space:], so the engines
	// agree there — the residual is C-locale-scoped by construction, which is why this
	// test drives LC_ALL=C explicitly and makes no default-locale assertion.
});

test("residual 3 (trailing newline): stripped by the shim's $(…) substitutions but preserved by TS (#55 review-tail)", () => {
	const input = "ls ~/.m/dev-loop-tokens/t\n";
	const ts = redactActionSummary(input, null);
	const sh = shimRedact(input);
	assert.equal(ts, "ls <token-dir>\n", "TS preserves the trailing newline");
	assert.equal(sh, "ls <token-dir>", "shim: the s=$(…) substitution eats it");
	// Safe direction: the SCRUB is identical in both; only the line terminator differs,
	// so the shim never prints material the TS engine would not have printed.
	assert.ok(!ts.includes("dev-loop-tokens") && !sh.includes("dev-loop-tokens"), "raw token-dir core scrubbed by both");
});

test("a C-locale caller gets the same output, always valid UTF-8 (locale-pinned bound, #55 review SF1)", () => {
	// The caller's locale must not decide the bound: under LC_ALL=C, bash's ${#s}/
	// ${s:0:160} count BYTES and cut mid-sequence (a lone 0xB6 tail — undecodable audit
	// line). The function pins its OWN UTF-8 locale for the length/substring decision,
	// so a C-locale caller sees the same decision the TS engine makes for the whole
	// corpus (valid UTF-8 is asserted on every call by shimRedact's fatal decode).
	for (const { name, input } of CORPUS) {
		const ts = redactActionSummary(input, null);
		const sh = shimRedact(input, { LC_ALL: "C", LANG: "C" });
		assert.equal(sh, ts, `${name}: C-locale shell ${JSON.stringify(sh)} !== TS ${JSON.stringify(ts)}`);
	}
});

/**
 * #55 review round-2 SF1: the UTF-8 locale probe (`_shim_pick_utf8_locale`) forks 1-2
 * child bashes. It is only CONSUMED by the truncation branch of `_shim_redact_summary`
 * (the driver-broken fallback path), but every git/gh shim invocation SOURCES the lib —
 * so probing at source time paid the fork on the hot path for a feature the happy path
 * never reaches. These pins instrument `bash` on PATH with a recording wrapper: every
 * child bash invoked with the é probe ARGUMENT appends one marker to PROBE_LOG, and the
 * test counts probe forks. Offline: the wrapper execs the system bash; the only side
 * effect is temp files under os.tmpdir (removed on exit).
 */
function findRealBash(): string {
	for (const p of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"]) {
		if (fs.existsSync(p)) return p;
	}
	assert.fail("no system bash for probe instrumentation");
}

function probeContext(): { env: NodeJS.ProcessEnv; count: () => number; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-probe-"));
	const log = path.join(dir, "probes");
	// POSIX sh so the wrapper itself needs no bash. The marker fires only for the probe
	// argument — the single character é, delivered via PROBE_CHAR so this file carries
	// no shell octal/quote escaping. The bound-decision child (argument = the summary
	// being cut) never matches.
	const wrapper = [
		"#!/bin/sh",
		'if [ -n "${PROBE_LOG:-}" ] && [ -n "${PROBE_CHAR:-}" ] && [ -n "${BASH_REAL:-}" ]; then',
		'  for a in "$@"; do',
		'    [ "$a" = "$PROBE_CHAR" ] && printf x >> "$PROBE_LOG"',
		"  done",
		"fi",
		'exec "${BASH_REAL}" "$@"',
		"",
	].join("\n");
	fs.writeFileSync(path.join(dir, "bash"), wrapper, { mode: 0o755 });
	return {
		env: {
			...process.env,
			PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
			PROBE_LOG: log,
			PROBE_CHAR: "\u00e9",
			BASH_REAL: findRealBash(),
		},
		count: () => (fs.existsSync(log) ? (fs.readFileSync(log, "utf8").match(/x/g) ?? []).length : 0),
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

function runShim(ctx: { env: NodeJS.ProcessEnv }, script: string): void {
	execFileSync("bash", ["-c", script], { cwd: ROOT, encoding: "buffer", env: ctx.env });
}

test("the locale probe is NOT forked at source time (lazy eval, #55 review round-2 SF1)", () => {
	const ctx = probeContext();
	try {
		runShim(ctx, ". ./scripts/policy-shims/lib/policyshim.sh; :");
		assert.equal(ctx.count(), 0, "sourcing the shim lib must not fork the locale probe");
	} finally {
		ctx.cleanup();
	}
});

test("the locale probe is lazy AND cached: sub-bound summaries never probe; once the bound is needed, one probe per process despite repeat calls and re-sources", () => {
	const ctx = probeContext();
	const src = ". ./scripts/policy-shims/lib/policyshim.sh;";
	try {
		// Fresh process, under the bound: the probe is never needed, never paid.
		runShim(ctx, `${src} _shim_redact_summary "short summary"; _shim_redact_summary "another"; :`);
		assert.equal(ctx.count(), 0, "sub-bound summaries must not fork the probe");
		// Fresh process, THREE over-bound calls plus a mid-flight RE-SOURCE of the lib:
		// a correct implementation probes ONCE here (1-2 candidate attempts), never
		// three times (no per-call re-probe) and never on the re-source (no source-time
		// probe). A count >= 3 would expose either regression.
		runShim(ctx, `${src} long=$(printf 'a%.0s' {1..161}); _shim_redact_summary "$long"; ${src} _shim_redact_summary "$long"; _shim_redact_summary "$long"; :`);
		assert.ok(
			ctx.count() >= 1 && ctx.count() <= 2,
			`expected one probe (1-2 candidate attempts) for three over-bound calls + a re-source in one process, got ${ctx.count()}`,
		);
	} finally {
		ctx.cleanup();
	}
});

// #93 (the #91 review-tail polish): the KNOWN RESIDUALS note numbers the accepted
// divergences 1 = astral-plane, 2 = span-class whitespace, 3 = trailing newline — a test
// title's "residual N" prefix must cite the note's item N, not the pin's own sequence.
// Pre-#93 the third pin was titled "residual 2" (the note's whitespace item) and the
// NBSP pin "residual 1" (the note's astral item), so one grep hit two different facts.
test("the residual-pin titles number themselves by the KNOWN RESIDUALS note's items, never their own sequence (#93)", () => {
	// Re-derived from THIS file's own source: every test title cited as a pin must number
	// itself after the note's item for the divergence it pins. The scanner is line-anchored
	// and the corpus is small — if a test title ever spans lines, extend the pattern.
	const src = fs.readFileSync(new URL(import.meta.url), "utf8");
	const titles = [...src.matchAll(/^test\("(.*)", \(\)/gm)].map((m) => m[1]);
	const residualTitles = titles.filter((t) => /^residual \d/.test(t));
	for (const [topic, item] of [["NBSP", 2], ["U+2028", 2], ["trailing newline", 3]] as const) {
		const pin = residualTitles.find((t) => t.toLowerCase().includes(topic.toLowerCase()));
		assert.ok(pin, `a pin titled for ${topic} exists`);
		assert.ok(
			pin.startsWith(`residual ${item}`),
			`${topic} is note item ${item}: the pin must be titled "residual ${item} …" (got ${JSON.stringify(pin)})`,
		);
	}
	assert.equal(
		residualTitles.length,
		3,
		`exactly the three noted divergences carry "residual N" titles, got: ${residualTitles.map((t) => JSON.stringify(t)).join(", ")}`,
	);
});

// #95 (the #93 review tail): the strict scanner above parses only single-line titles in
// the exact opening form — a future residual pin whose title is split over lines, or
// written as a backtick expression, would drop out of the scan and the count-of-three
// assertion would pass SILENTLY on a form it cannot read. The companion below re-opens
// every pin with a line-break-tolerant pattern and asserts the two scans agree on the
// number of residual-title openings: a form the strict scanner cannot parse goes RED
// here instead of disappearing from the pin. Best effort like the scanner itself — it
// reads source text, not an AST.
test("every residual-pin opening is parseable by the title scanner — an unparseable form goes red, not silent (#95)", () => {
	const src = fs.readFileSync(new URL(import.meta.url), "utf8");
	const strictTitles = [...src.matchAll(/^test\("(.*)", \(\)/gm)].map((m) => m[1]);
	const strictResiduals = strictTitles.filter((t) => /^residual \d/.test(t));
	// Tolerant opener: `test`, ANY whitespace (incl. newlines) on EITHER side of the opening
	// paren, then a quote- or backtick-delimited title starting with `residual <digit>`. #97
	// closed the paren-side hole: `test ( "…"` is legal JS, and the pre-fix pattern only
	// tolerated whitespace AFTER the paren, so that form stayed silent to both scans. The
	// strict scanner's own regex literal in this file does not match it (the paren is spelled
	// escaped in the literal), so this count is not self-inflated.
	const lenientCount = [...src.matchAll(/test\s*\(\s*["`]residual \d/g)].length;
	assert.equal(
		lenientCount,
		strictResiduals.length,
		`${lenientCount} residual-title openings tolerated vs ${strictResiduals.length} the strict scanner parsed: a residual pin is written in a form the title scanner cannot parse — rewrite it (or extend the scanner AND this companion in the same change)`,
	);
});
