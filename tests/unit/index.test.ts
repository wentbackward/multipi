import assert from "node:assert/strict";
import test from "node:test";
import devloopExtension from "../../extension/index.ts";

function fakePi() {
	const tools: string[] = [];
	const hooks: string[] = [];
	const commands: string[] = [];
	// Minimal ExtensionAPI surface as used by the factory.
	const pi = {
		registerTool: (t: { name?: string }) => {
			if (t?.name) tools.push(t.name);
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		on: (name: string) => {
			hooks.push(name);
		},
	};
	return { pi: pi as unknown as Parameters<typeof devloopExtension>[0], tools, hooks, commands };
}

test("extension registers 6 tools, 4 hooks and the /devloop-agents command for an orchestrator session", () => {
	const saved = process.env.MULTIPI_CHILD;
	delete process.env.MULTIPI_CHILD; // hermetic: a loop child's env carries MULTIPI_CHILD=1
	try {
		const { pi, tools, hooks, commands } = fakePi();
		devloopExtension(pi);
		assert.equal(tools.length, 6);
		assert.ok(tools.includes("devloop.pause"));
		assert.ok(tools.includes("devloop.dispatch"));
		assert.deepEqual(hooks.sort(), ["agent_before_settle", "session_start", "session_tree", "tool_result"]);
		assert.deepEqual(commands, ["devloop-agents"]);
	} finally {
		if (saved === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = saved;
	}
});

test("a child process (MULTIPI_CHILD) registers NOTHING — no tools, hooks, or commands", () => {
	const { pi, tools, hooks, commands } = fakePi();
	const saved = process.env.MULTIPI_CHILD;
	process.env.MULTIPI_CHILD = "1";
	try {
		devloopExtension(pi);
	} finally {
		if (saved === undefined) delete process.env.MULTIPI_CHILD;
		else process.env.MULTIPI_CHILD = saved;
	}
	assert.equal(tools.length, 0, "no tools in a child");
	assert.equal(hooks.length, 0, "no hooks in a child");
	assert.equal(commands.length, 0, "no commands in a child");
});
