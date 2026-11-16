/**
 * Worker body of the "writeState is atomic" test (tests/unit/liveness.test.ts).
 * Lives in its OWN file on purpose: a Worker spawned on the test file re-executes every
 * top-level test() of it (and re-spawns workers — a fork bomb observed under `node --test`).
 * This file imports no test runner and runs exactly the write-then-validate loop.
 */
import { writeFileSync } from "node:fs";
import { workerData } from "node:worker_threads";
import path from "node:path";
import { loadState, writeState, type LivenessState } from "../../extension/src/liveness.ts";

if (workerData) {
	const { d, which } = workerData as { d: string; which: string };
	const mine: LivenessState = {
		schema: 1, sessionId: which, pid: 1, state: "active", tool: null,
		lastEventAt: 1_000_000, lastTickAt: 1, lastWakeSeq: -1,
	};
	const other: LivenessState = { ...mine, sessionId: which === "A" ? "B" : "A", lastTickAt: 2 };
	for (let i = 0; i < 40; i++) {
		writeState(d, i % 2 === 0 ? mine : other);
		// After EVERY write the writer re-reads and validates the shape. A torn (mid-write)
		// document is only possible if the publish is an in-place truncate; a rename publishes
		// complete documents.
		const seen = loadState(d);
		if (!seen || seen.schema !== 1 || (seen.sessionId !== "A" && seen.sessionId !== "B") || typeof seen.pid !== "number") {
			throw new Error(`torn or missing document observed: ${JSON.stringify(seen)}`);
		}
	}
	writeFileSync(path.join(d, `.reader-${which}-ok`), "ok");
}
