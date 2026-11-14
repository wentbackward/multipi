import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
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
