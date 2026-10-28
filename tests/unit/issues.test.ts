import assert from "node:assert/strict";
import test from "node:test";
import { parseGhOutput } from "../../extension/src/issues.ts";

test("parses a single compact JSON array (observed gh output for one row)", () => {
	const rows = parseGhOutput('[{"number":1,"title":"t","labels":[],"body":"b"}]\n');
	assert.equal(rows.length, 1);
	assert.equal((rows[0] as { number: number }).number, 1);
});

test("parses a multi-row JSON array", () => {
	const rows = parseGhOutput('[{"number":1},{"number":2},{"number":3}]');
	assert.deepEqual(rows.map((r) => (r as { number: number }).number), [1, 2, 3]);
});

test("parses NDJSON (one object per line)", () => {
	const rows = parseGhOutput('{"number":7,"title":"a"}\n{"number":8,"title":"b"}\n');
	assert.deepEqual(rows.map((r) => (r as { number: number }).number), [7, 8]);
});

test("parses a single object (gh view output)", () => {
	const rows = parseGhOutput('{"title":"hello"}');
	assert.equal(rows.length, 1);
	assert.equal((rows[0] as { title: string }).title, "hello");
});

test("empty output yields no rows", () => {
	assert.deepEqual(parseGhOutput(""), []);
	assert.deepEqual(parseGhOutput("   \n  "), []);
});
