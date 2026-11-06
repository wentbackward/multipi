import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { discoverRoles, findRole } from "../../extension/src/roles.ts";

function agentFile(dir: string, name: string, extra = ""): string {
	const p = path.join(dir, `${name}.md`);
	writeFileSync(p, `---\nname: ${name}\ndescription: test role\n${extra}---\nBody of ${name}.\n`);
	return p;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("discoverRoles parses frontmatter and body", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "roles-"));
	agentFile(dir, "implementer", "tools: read, bash\nmodel: fake/model\n");
	const roles = discoverRoles(dir);
	assert.equal(roles.length, 1);
	assert.equal(roles[0].name, "implementer");
	assert.deepEqual(roles[0].tools, ["read", "bash"]);
	assert.equal(roles[0].model, "fake/model");
	assert.match(roles[0].systemPrompt, /Body of implementer/);
});

test("project dir overrides the bundled role of the same name", () => {
	const bundled = mkdtempSync(path.join(tmpdir(), "roles-b-"));
	const project = mkdtempSync(path.join(tmpdir(), "roles-p-"));
	agentFile(bundled, "reviewer");
	agentFile(project, "reviewer");
	writeFileSync(path.join(project, "reviewer.md"), "---\nname: reviewer\ndescription: tuned\n---\nPROJECT OVERRIDE.\n");
	const roles = discoverRoles(bundled, project);
	const reviewer = roles.find((r) => r.name === "reviewer");
	assert.ok(reviewer);
	assert.match(reviewer!.systemPrompt, /PROJECT OVERRIDE/);
});

test("malformed files are skipped without breaking discovery of good ones", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "roles-"));
	writeFileSync(path.join(dir, "broken.md"), "no frontmatter here\n");
	agentFile(dir, "verifier");
	const roles = discoverRoles(dir);
	assert.deepEqual(roles.map((r) => r.name), ["verifier"]);
});

test("missing bundled dir yields the project roles only", () => {
	const project = mkdtempSync(path.join(tmpdir(), "roles-p2-"));
	agentFile(project, "implementer");
	const roles = discoverRoles(path.join(project, "does-not-exist"), project);
	assert.deepEqual(roles.map((r) => r.name), ["implementer"]);
});

test("the repo's scenario-writer role is discovered (frontmatter name, body mandates, mirrored copy)", () => {
	const root = path.resolve(HERE, "..", "..");
	const bundled = path.join(root, "agents");
	const project = path.join(root, ".pi", "agents");
	const found = findRole(bundled, "scenario-writer", project);
	assert.ok(found, "discoverRoles finds scenario-writer in agents/");
	assert.match(found!.systemPrompt, /t<ticket>-<slug>/, "mandates the id convention");
	assert.match(found!.systemPrompt, /required: true/, "mandates required: true for core behaviour");
	assert.match(found!.systemPrompt, /never read the code/i, "mandates never reading the code");
	assert.match(found!.systemPrompt, /only inside the store/i, "mandates writing only inside the store");
	assert.match(found!.systemPrompt, /store lies inside the repository/i, "BLOCKED condition when the store is inside the repo");
	assert.match(found!.systemPrompt, /^STATUS: DONE/m, "report contract: STATUS: DONE");
	assert.match(found!.systemPrompt, /^STATUS: BLOCKED/m, "report contract: STATUS: BLOCKED");
	assert.match(found!.systemPrompt, /required\|scored, new\|changed/, "report contract: one line per scenario (id, title, required|scored, new|changed)");
	// the installed project-layer copy is a byte-identical mirror (install invariant)
	assert.deepEqual(readFileSync(path.join(project, "scenario-writer.md")), readFileSync(path.join(bundled, "scenario-writer.md")), ".pi/agents copy mirrors agents/");
});
