import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timeoutText } from "../../extension/src/liveness.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = path.join(HERE, "..", "..", "docs", "superpowers", "specs", "2026-11-15-orchestrator-liveness.md");
const SPEC_TEXT = readFileSync(SPEC, "utf8");

/** The `**Trigger (reported, verbatim):**` paragraph, split into the quoted operator span
 * (between the opening `*"` and the closing `"*`) and the editorial note that follows it. */
function triggerParts(): { quote: string; note: string } {
	const lines = SPEC_TEXT.split("\n");
	const start = lines.findIndex((l) => l.startsWith("**Trigger (reported, verbatim):**"));
	assert.notEqual(start, -1, "the spec must carry the verbatim operator trigger paragraph");
	let end = start;
	while (end < lines.length && lines[end] !== "") end++;
	const paragraph = lines.slice(start, end).join("\n");
	const open = paragraph.indexOf('*"');
	const close = paragraph.indexOf('"*', open + 2);
	assert.notEqual(open, -1, "the trigger paragraph must open a quoted span");
	assert.notEqual(close, -1, "the trigger paragraph must close the quoted span");
	return { quote: paragraph.slice(open + 2, close), note: paragraph.slice(close + 2) };
}

/** The backticked timeout template of spec §2, with its markdown line-wraps collapsed to one line. */
function timeoutTemplate(): string {
	const sec2 = SPEC_TEXT.split("## 2.")[1]?.split("## 3.")[0];
	assert.ok(sec2, "the spec must carry a §2 (bounded tool calls) section");
	const seg = sec2.slice(sec2.indexOf("On expiry the tool"));
	assert.notEqual(seg, "", "§2 must describe the on-expiry reconciliation result");
	const open = seg.indexOf("`");
	const close = seg.indexOf("`", open + 1);
	assert.notEqual(open, -1, "§2 must carry the backticked timeout template");
	assert.notEqual(close, -1, "the timeout template must be closed");
	return seg.slice(open + 1, close).replace(/\s+/g, " ").trim();
}

// --- trigger quote (item 1) ---------------------------------------------------

test("the verbatim trigger quote reproduces the operator's original dotted spelling (devloop.gate)", () => {
	const { quote } = triggerParts();
	assert.ok(quote.includes("the devloop.gate"), "the verbatim span must keep the reported dotted spelling");
	assert.ok(!quote.includes("devloop_gate"), "the verbatim span must not carry the post-#99 underscored name");
});

test("the trigger paragraph carries an inline note mapping the pre/post-#99 tool names", () => {
	const { note } = triggerParts();
	assert.ok(note.trim() !== "", "an editor's note must follow the verbatim quote");
	assert.match(note, /devloop\.gate/, "the note must name the original dotted spelling");
	assert.match(note, /devloop_gate/, "the note must name the current underscored spelling");
	assert.match(note, /post-#99/, "the note must attribute the rename to #99");
});

// --- timeout template (item 2) ------------------------------------------------

test("the §2 timeout template leads with the underscored placeholder (no dotted devloop.<tool>)", () => {
	assert.ok(!SPEC_TEXT.includes("devloop.<tool>"), "the stale dotted placeholder must be gone");
	assert.ok(timeoutTemplate().startsWith("devloop_<tool> timed out after <N>m"), "the template must lead with devloop_<tool> timed out after <N>m");
});

test("the §2 template, instantiated, equals the format timeoutText actually emits", () => {
	const concrete = timeoutTemplate()
		.replaceAll("devloop_<tool>", "devloop_gate")
		.replaceAll("<N>m", "45m");
	assert.equal(concrete, timeoutText("devloop_gate", 45 * 60_000), "whatever the code emits is what the spec describes");
});
