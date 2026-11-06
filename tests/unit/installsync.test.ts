import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo invariant from scripts/install.sh: the installed `.pi` copies are byte-identical mirrors
 * of their sources. A stale copy silently ships disabled behaviour into THIS repo's own
 * dogfood instance (review of #9: a missing src/guard.ts in .pi/extensions/multipi-devloop/
 * meant the role guard was inert for real guarded children).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const rel = (...p: string[]): string => path.join(ROOT, ...p);
const read = (p: string): Buffer => readFileSync(p);

/** Sorted file names with the given extension in a directory. */
function names(dir: string, ext: string): string[] {
	return readdirSync(dir).filter((f) => f.endsWith(ext)).sort();
}

/** Every <ext> file in srcDir has a byte-identical twin in dstDir — and nothing stale there. */
function assertMirrors(srcDir: string, dstDir: string, ext: string, label: string): void {
	const src = names(srcDir, ext);
	const dst = names(dstDir, ext);
	assert.deepEqual(dst, src, `${label}: ${path.relative(ROOT, dstDir)} must mirror ${path.relative(ROOT, srcDir)} exactly (got ${dst.join(", ")}, want ${src.join(", ")})`);
	for (const f of src) {
		assert.deepEqual(read(rel(dstDir, f)), read(rel(srcDir, f)), `${label}: ${path.join(dstDir, f)} diverges from ${path.join(srcDir, f)}`);
	}
}

const DST_EXT = ".pi/extensions/multipi-devloop";

test("the installed .pi extension copy tracks extension/ byte-for-byte (index.ts and src/*.ts)", () => {
	assert.deepEqual(read(rel(DST_EXT, "index.ts")), read(rel("extension", "index.ts")), "index.ts diverges from extension/index.ts");
	assertMirrors("extension/src", `${DST_EXT}/src`, ".ts", "extension src");
});

test("the installed agents mirror agents/ (project layer and bundled fallback)", () => {
	assertMirrors("agents", ".pi/agents", ".md", "project-layer agents");
	assertMirrors("agents", `${DST_EXT}/agents`, ".md", "bundled-fallback agents");
});

test("the installed skills mirror skills/*/SKILL.md", () => {
	const srcSkills = readdirSync(rel("skills")).filter((d) => statSync(rel("skills", d)).isDirectory()).sort();
	const dstSkills = readdirSync(rel(".pi/skills")).filter((d) => statSync(rel(".pi/skills", d)).isDirectory()).sort();
	assert.deepEqual(dstSkills, srcSkills, "skill directory sets differ");
	for (const s of srcSkills) {
		assert.deepEqual(read(rel(".pi/skills", s, "SKILL.md")), read(rel("skills", s, "SKILL.md")), `skills/${s}/SKILL.md diverges`);
	}
});

test("the installed template tracks templates/devloop.json", () => {
	assert.deepEqual(read(rel(".pi/templates", "devloop.json")), read(rel("templates", "devloop.json")), ".pi/templates/devloop.json diverges");
});
