// Unit tests for the scenario-stage process-group primitives (extension/src/scenario-run.ts,
// dark-factory spec §5.1/§5.2). Real spawns of fake `sleep`/`echo` commands — offline, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	spawnSystemRun,
	spawnJudge,
	stopGroup,
	groupAliveOf,
} from "../../extension/src/scenario-run.ts";

/** True when kill -0 <pid> (or the group) succeeds — i.e. the process still exists. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function scratch(): string {
	return mkdtempSync(path.join(tmpdir(), "multipi-scenario-run-test."));
}

test("spawnSystemRun exports the first non-empty printed line as the target", async () => {
	const dir = scratch();
	try {
		const log = path.join(dir, "run.log");
		const pidFile = path.join(dir, "leader.pid");
		const r = await spawnSystemRun({
			command: `printf '\\n   \\n'; echo "http://127.0.0.1:8621/api"; echo $$ > "${pidFile}"; sleep 30`,
			runSeconds: 5,
			logFile: log,
		});
		assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
		if (!r.ok) return;
		assert.equal(r.target, "http://127.0.0.1:8621/api", "first NON-EMPTY line is the target");
		// detached spawn: the child leads its own process group, pgid == child pid.
		const leader = Number(readFileSync(pidFile, "utf8").trim());
		assert.equal(r.pgid, leader, "reported pgid is the run's own pid (own process group)");
		assert.ok(groupAliveOf(r.pgid), "the run keeps living after the stage returns");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a verbose blank banner with a mid-write line still yields the right first-line target", async () => {
	// Review vector for the scan memo: a server that spews thousands of EMPTY lines before
	// speaking. The scan must (a) keep resuming an unterminated line across polls ("par" +
	// "tial\n" = "partial") and (b) keep its working buffer bounded — it must not accumulate
	// the whole banner and re-split it on every poll (O(n²) in banner size).
	const dir = scratch();
	try {
		const r = await spawnSystemRun({
			command:
				`head -c 200000 /dev/zero | tr '\\0' '\\n'; printf 'par'; sleep 0.3; printf 'tial\\n'; ` +
				`echo "http://127.0.0.1:8622/target"; sleep 30`,
			runSeconds: 15,
			logFile: path.join(dir, "run.log"),
		});
		assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
		if (!r.ok) return;
		assert.equal(r.target, "partial", "first non-empty COMPLETE line wins; the mid-write is joined");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a run that exits before printing is a red reason, not a hang", async () => {
	const dir = scratch();
	try {
		const r = await spawnSystemRun({
			command: "exit 7",
			runSeconds: 5,
			logFile: path.join(dir, "run.log"),
		});
		assert.equal(r.ok, false, `expected failure, got ${JSON.stringify(r)}`);
		if (r.ok) return;
		assert.match(r.reason, /exited before printing/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a >64KB first poll keeps every byte: no dropped middle, no stale-buffer line", async () => {
	// Deterministic form of the banner race: pre-populate the run log (spawnSystemRun appends
	// and scans from the start) with 200KB of empty lines ending in an UNTERMINATED "par".
	// The first poll therefore reads >64KB in several readSync iterations. A reader that
	// combines those reads wrong either drops the tail or exposes stale buffer bytes as a
	// phantom newline — both were reachable pre-fix (observed target "par" from a log whose
	// line 200001 was "partial").
	const dir = scratch();
	try {
		const log = path.join(dir, "run.log");
		writeFileSync(log, "\n".repeat(200000) + "par");
		const r = await spawnSystemRun({
			command: "sleep 0.2; printf 'tial\\n'; echo target-line; sleep 30",
			runSeconds: 10,
			logFile: log,
		});
		assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
		if (!r.ok) return;
		assert.equal(r.target, "partial", "the mid-write joins across the 64KB boundary");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a CRLF target whose \\r and \\n arrive in separate writes is not lost", async () => {
	// The scan-memo trims pending to the trailing unfinished line whenever nothing complete
	// was found; it must therefore keep a trailing "\r" that belongs to an unfinished line,
	// or the CRLF target vanishes when the "\n" lands in a later poll.
	const dir = scratch();
	try {
		const r = await spawnSystemRun({
			command: `echo -n "http://127.0.0.1:8623/crlf"; printf '\\r'; sleep 0.3; printf '\\n'; sleep 30`,
			runSeconds: 10,
			logFile: path.join(dir, "run.log"),
		});
		assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
		if (!r.ok) return;
		assert.equal(r.target, "http://127.0.0.1:8623/crlf");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("silence past run_seconds is red and kills the whole group (TERM-resistant members get KILL)", async () => {
	const dir = scratch();
	try {
		const pidFile = path.join(dir, "leader.pid");
		const start = Date.now();
		const r = await spawnSystemRun({
			command: `echo $$ > "${pidFile}"; trap '' TERM; exec sleep 30`,
			runSeconds: 0.3,
			logFile: path.join(dir, "run.log"),
		});
		assert.ok(Date.now() - start < 5000, "the wait honoured runSeconds, did not hang");
		assert.equal(r.ok, false, `expected silence failure, got ${JSON.stringify(r)}`);
		if (r.ok) return;
		assert.match(r.reason, /silent/);
		// trap '' TERM survives the SIGTERM: only the SIGKILL escalation can clear it,
		// so a live process here would prove the escalation never fired.
		const leader = Number(readFileSync(pidFile, "utf8").trim());
		assert.equal(pidAlive(leader), false, "no sleeper survives (kill -0 fails)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the run's full stdout and stderr land in the log file", async () => {
	const dir = scratch();
	try {
		const log = path.join(dir, "run.log");
		const r = await spawnSystemRun({
			command: "echo out-line; echo err-line >&2; sleep 0.3",
			runSeconds: 5,
			logFile: log,
		});
		assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
		// the log keeps growing after resolve; poll briefly for the tail.
		let content = "";
		for (let i = 0; i < 40; i++) {
			content = existsSync(log) ? readFileSync(log, "utf8") : "";
			if (content.includes("err-line")) break;
			await new Promise((res) => setTimeout(res, 50));
		}
		assert.ok(content.includes("out-line"), "stdout in log");
		assert.ok(content.includes("err-line"), "stderr in log");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stopGroup SIGTERMs a cooperative group without needing the KILL escalation", async () => {
	const dir = scratch();
	try {
		const r = await spawnSystemRun({
			command: "echo target; sleep 30",
			runSeconds: 5,
			logFile: path.join(dir, "run.log"),
		});
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.ok(groupAliveOf(r.pgid), "alive before stopGroup");
		const start = Date.now();
		await stopGroup(r.pgid);
		assert.ok(Date.now() - start < 1500, "cooperative TERM resolved well under the 2 s grace");
		assert.equal(groupAliveOf(r.pgid), false, "group gone (kill -0 fails)");
		// a second stopGroup on the dead group is a no-op, never a throw.
		await stopGroup(r.pgid);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawnJudge resolves with the command's exit code and captures its output", async () => {
	const dir = scratch();
	try {
		const out = path.join(dir, "j0.log");
		const r = await spawnJudge({ command: "echo judge-output-line; exit 0", judgeSeconds: 5, outFile: out });
		assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
		if (r.ok) assert.equal(r.exitCode, 0);

		const out3 = path.join(dir, "j3.log");
		const r3 = await spawnJudge({ command: "echo dying >&2; exit 3", judgeSeconds: 5, outFile: out3 });
		assert.equal(r3.ok, true, `expected ok, got ${JSON.stringify(r3)}`);
		if (r3.ok) {
			assert.equal(r3.exitCode, 3, "non-zero judge exit is reported, not swallowed");
			assert.ok(readFileSync(out3, "utf8").includes("dying"), "judge stderr captured in the transcript");
		}
		assert.ok(readFileSync(out, "utf8").includes("judge-output-line"), "judge stdout captured");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawnJudge passes the documented scenario env seams to the judge", async () => {
	const dir = scratch();
	try {
		const marker = path.join(dir, "env.marker");
		const out = path.join(dir, "jenv.log");
		const r = await spawnJudge({
			command: `printf '%s|%s|%s' "$MULTIPI_SCENARIO_ID" "$MULTIPI_SCENARIO_TARGET" "$MULTIPI_SCENARIO_FILE" > "${marker}"`,
			judgeSeconds: 5,
			outFile: out,
			env: {
				MULTIPI_SCENARIO_ID: "t13-env",
				MULTIPI_SCENARIO_TARGET: "http://127.0.0.1:8621/",
				MULTIPI_SCENARIO_FILE: "/somewhere/t13-env.md",
			},
		});
		assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
		assert.equal(
			readFileSync(marker, "utf8"),
			"t13-env|http://127.0.0.1:8621/|/somewhere/t13-env.md",
			"the three MULTIPI_SCENARIO_* seams reach the judge process",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a judge that overruns judge_seconds is killed TERM->KILL and reported as a cap overrun", async () => {
	const dir = scratch();
	try {
		const pidFile = path.join(dir, "judge.pid");
		const r = await spawnJudge({
			command: `echo $$ > "${pidFile}"; trap '' TERM; exec sleep 30`,
			judgeSeconds: 0.3,
			outFile: path.join(dir, "jcap.log"),
		});
		assert.equal(r.ok, false, `expected cap overrun, got ${JSON.stringify(r)}`);
		if (r.ok) return;
		assert.match(r.reason, /cap/);
		const judgePid = Number(readFileSync(pidFile, "utf8").trim());
		assert.equal(pidAlive(judgePid), false, "no TERM-resistant judge survives the cap (kill -0 fails)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
