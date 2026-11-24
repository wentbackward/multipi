import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeFixture } from "../fixtures.ts";
import { parseGhOutput, setLifecycleLabel, issueLabels, addLabel, removeLabel } from "../../extension/src/issues.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

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

// ---------------------------------------------------------------------------
// setLifecycleLabel (ticket #143): lifecycle transitions REPLACE, never
// accumulate. The tracker is fake-gh: the lines of labels/<n> are the labels
// the issue carries (the real CLI's dedupe/no-op-remove semantics are pinned
// in the fake itself).
// ---------------------------------------------------------------------------

function lcFixture(): ReturnType<typeof makeFixture> {
	const fx = makeFixture('{"base_branch":"main"}');
	const bin = path.join(fx.dir, "bin");
	mkdirSync(bin, { recursive: true });
	execFileSync("ln", ["-sf", path.join(ROOT, "tests", "fake-gh"), path.join(bin, "gh")]);
	process.env.FAKE_GH_DIR = path.join(fx.dir, "gh");
	process.env.PATH = `${bin}:${process.env.PATH}`;
	return fx;
}

const ghRun = (fx: ReturnType<typeof makeFixture>, args: string[]) =>
	execFileSync("gh", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();

function newIssue(fx: ReturnType<typeof makeFixture>, title: string): number {
	return Number(ghRun(fx, ["issue", "create", title, "body"]).trim().split("/").pop());
}

test("setLifecycleLabel replaces the prior lifecycle label (in-progress -> in-review)", () => {
	const fx = lcFixture();
	try {
		const n = newIssue(fx, "Replace on green report");
		addLabel("", n, "dl/in-progress");
		setLifecycleLabel("", n, "dl/in-review");
		assert.deepEqual(issueLabels("", n), ["dl/in-review"], "the DONE transition retires dl/in-progress");
	} finally { fx.cleanup(); }
});

test("setLifecycleLabel retires EVERY other lifecycle label at once (a pile-up lands exactly one)", () => {
	const fx = lcFixture();
	try {
		const n = newIssue(fx, "Repair the pile-up");
		for (const l of ["dl/in-progress", "dl/in-review", "dl/approved", "dl/gated"]) addLabel("", n, l);
		setLifecycleLabel("", n, "dl/merged");
		assert.deepEqual(issueLabels("", n), ["dl/merged"], "a closed ticket ends with dl/merged, nothing else");
	} finally { fx.cleanup(); }
});

test("setLifecycleLabel keeps dl/blocked and dl/area/* — they are not lifecycle labels", () => {
	const fx = lcFixture();
	try {
		const n = newIssue(fx, "Blocked and classified");
		for (const l of ["dl/in-progress", "dl/blocked", "dl/area/extension"]) addLabel("", n, l);
		setLifecycleLabel("", n, "dl/in-review");
		assert.deepEqual(issueLabels("", n).sort(), ["dl/area/extension", "dl/blocked", "dl/in-review"]);
	} finally { fx.cleanup(); }
});

test("dl/blocked REPLACES the state it pauses; the unblock re-dispatch re-sets in-progress", () => {
	const fx = lcFixture();
	try {
		const n = newIssue(fx, "Pause then resume");
		addLabel("", n, "dl/in-progress");
		addLabel("", n, "dl/area/scripts");
		setLifecycleLabel("", n, "dl/blocked");
		assert.deepEqual(issueLabels("", n).sort(), ["dl/area/scripts", "dl/blocked"], "blocked retires the in-flight state");
		// The unblock drops dl/blocked (skill §1.2); the re-dispatch re-sets in-progress.
		removeLabel("", n, "dl/blocked");
		setLifecycleLabel("", n, "dl/in-progress");
		assert.deepEqual(issueLabels("", n).sort(), ["dl/area/scripts", "dl/in-progress"]);
	} finally { fx.cleanup(); }
});

test("setLifecycleLabel is idempotent: re-setting the carried label removes nothing and duplicates nothing", () => {
	const fx = lcFixture();
	try {
		const n = newIssue(fx, "Idempotent transition");
		addLabel("", n, "dl/in-review");
		setLifecycleLabel("", n, "dl/in-review");
		setLifecycleLabel("", n, "dl/in-review");
		assert.deepEqual(issueLabels("", n), ["dl/in-review"], "exactly one entry, no duplicate, no removed lifecycle label");
		const log = readFileSync(`${process.env.FAKE_GH_DIR}/calls.log`, "utf8");
		assert.ok(!log.includes("--remove-label"), "no lifecycle label to retire, so no remove calls are issued");
	} finally { fx.cleanup(); }
});

test("setLifecycleLabel is tolerant of absent labels: a fresh, unlabelled issue takes the label without error", () => {
	const fx = lcFixture();
	try {
		const n = newIssue(fx, "Fresh ticket");
		assert.doesNotThrow(() => setLifecycleLabel("", n, "dl/in-progress"), "no lifecycle label present is the normal first dispatch, not an error");
		assert.deepEqual(issueLabels("", n), ["dl/in-progress"]);
	} finally { fx.cleanup(); }
});
