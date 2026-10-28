import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { formatTarget, applyFormat, shellQuote } from "../../extension/src/formatter.ts";

test("no format configured -> null", () => {
	assert.equal(formatTarget({ format: null, formatExtensions: null }, "a.md"), null);
});

test("format applies to listed extensions (plain suffix matching, as pinned in config schema)", () => {
	const cfg = { format: "prettier {file}", formatExtensions: [".ts", ".md"] };
	assert.equal(formatTarget(cfg, "src/a.ts"), "prettier 'src/a.ts'");
	// Suffix matching is exact: ".ts" does NOT cover ".tsx" — list it explicitly.
	assert.equal(formatTarget(cfg, "src/a.tsx"), null);
	assert.equal(formatTarget(cfg, "src/a.py"), null);
	const cfg2 = { format: "prettier {file}", formatExtensions: [".ts", ".tsx", ".md"] };
	assert.equal(formatTarget(cfg2, "src/a.tsx"), "prettier 'src/a.tsx'");
});

test("no extension filter -> applies to everything", () => {
	const cfg = { format: "go fmt {file}", formatExtensions: null };
	assert.equal(formatTarget(cfg, "x.go"), "go fmt 'x.go'");
});

test("shellQuote escapes single quotes for the {file} placeholder", () => {
	assert.equal(shellQuote("a'b"), "'a'\"'\"'b'");
	// Round-trip: the quoted form must evaluate back to the original value in bash.
	assert.equal(execFileSync("bash", ["-c", `printf %s ${shellQuote("a'b z")}`]).toString(), "a'b z");
	assert.equal(shellQuote("plain.txt"), "'plain.txt'");
});

test("applyFormat actually reformats a file (real shell execution)", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "fmt-"));
	const f = path.join(dir, "out.txt");
	writeFileSync(f, "junk\n");
	const cmd = formatTarget({ format: `printf 'fmt:\\n' > ${f.replace(/'/g, "'\"'\"'")}`, formatExtensions: null }!, f)!;
	const res = await applyFormat(cmd, dir);
	assert.equal(res.ok, true, res.stderr);
	assert.equal(readFileSync(f, "utf8"), "fmt:\n");
});

test("applyFormat reports a failing command with stderr, not an exception", async () => {
	const res = await applyFormat("false", process.cwd());
	assert.equal(res.ok, false);
});
