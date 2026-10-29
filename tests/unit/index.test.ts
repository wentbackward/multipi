import assert from "node:assert/strict";
import test from "node:test";
import devloopExtension from "../../extension/index.ts";

function fakePi() {
	const tools: string[] = [];
	const hooks: string[] = [];
	// Minimal ExtensionAPI surface as used by the factory.
	const pi = {
		registerTool: (t: { name?: string }) => {
			if (t?.name) tools.push(t.name);
		},
		on: (name: string) => {
			hooks.push(name);
		},
	};
	return { pi: pi as unknown as Parameters<typeof devloopExtension>[0], tools, hooks };
}

test("extension registers 5 tools and both hooks for an orchestrator session", () => {
	const { pi, tools, hooks } = fakePi();
	devloopExtension(pi);
	assert.equal(tools.length, 5);
	assert.ok(tools.includes("devloop.dispatch"));
	assert.deepEqual(hooks.sort(), ["agent_before_settle", "tool_result"]);
});

test("a child process (MULTIPI_CHILD) registers NOTHING — no tools, no stop-gate", () => {
	const { pi, tools, hooks } = fakePi();
	process.env.MULTIPI_CHILD = "1";
	try {
		devloopExtension(pi);
	} finally {
		delete process.env.MULTIPI_CHILD;
	}
	assert.equal(tools.length, 0, "no tools in a child");
	assert.equal(hooks.length, 0, "no hooks in a child");
});
