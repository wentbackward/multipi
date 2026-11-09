// Unit tests for the pure scenario-store module (extension/src/scenarios.ts).
// Runs under plain node (type stripping) — no @earendil-works/* imports, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanStore, storeCounts, isSealed, parseVerdict, foldJudgeRun, coveredTicketNumbers, type ScenarioFile } from "../../extension/src/scenarios.ts";

const VALID = `---
id: t12-close-position-clears-alert
title: Closing a position clears its price alert
spec: [positions, alerts]
tags: [smoke, alerts]
required: true
---
## User and goal
As a trader I want alerts to reflect reality.

## Preconditions and fixtures
An open position and an active price alert.

## Steps
Close the position.

## Satisfied when
The alert is cleared automatically.
`;

/** Scratch store dir; write files (relative path -> content) and scan. */
function withStore(files: Record<string, string>, fn: (storeDir: string, files: ScenarioFile[]) => void): void {
	const storeDir = mkdtempSync(path.join(tmpdir(), "np-scenarios-"));
	try {
		for (const [rel, content] of Object.entries(files)) {
			const p = path.join(storeDir, rel);
			mkdirSync(path.dirname(p), { recursive: true });
			writeFileSync(p, content);
		}
		fn(storeDir, scanStore(storeDir));
	} finally {
		rmSync(storeDir, { recursive: true, force: true });
	}
}

test("scanStore finds *.md at any depth and ignores non-md files", () => {
	withStore({
		"a.md": VALID,
		"nested/deep/b.md": VALID.replace("t12-", "t13-"),
		"notes.txt": VALID,
		"noext": VALID,
	}, (_dir, files) => {
		assert.deepEqual(
			files.map((f) => f.file).sort(),
			["a.md", "nested/deep/b.md"],
		);
	});
});

test("scanStore skips nothing under .git at any depth", () => {
	withStore({
		"good.md": VALID,
		".git/x.md": VALID.replace("t12-", "t99-"),
		".git/hooks/pre-commit.md": VALID.replace("t12-", "t98-"),
		"outer/.git/inner/deep.md": VALID.replace("t12-", "t97-"),
	}, (_dir, files) => {
		assert.deepEqual(
			files.map((f) => f.file),
			["good.md"],
		);
	});
});

test("scanStore returns [] for a missing store dir", () => {
	const missing = path.join(mkdtempSync(path.join(tmpdir(), "np-scenarios-")), "not-there");
	assert.deepEqual(scanStore(missing), []);
});

test("rejects a scenario missing id", () => {
	withStore({ "no-id.md": VALID.replace(/^id: .*$\n/m, "") }, (_dir, files) => {
		assert.equal(files[0].valid, false);
		assert.match(files[0].reason ?? "", /id/i);
		assert.equal(files[0].id, undefined);
	});
});

test("rejects path-traversal ids (id: ../../xwalk/outside/evil) with a named reason", () => {
	withStore(
		{ "evil.md": VALID.replace("t12-close-position-clears-alert", "../../xwalk/outside/evil") },
		(_dir, files) => {
			assert.equal(files[0].valid, false, "the traversal vector must not be a valid scenario");
			assert.match(files[0].reason ?? "", /invalid id/, "named reason identifies the bad id");
			// counts as invalid so the stage's store gate sees it
			assert.equal(storeCounts(files).invalid, 1);
		},
	);
	// other shapes outside the pinned charset are rejected the same way
	for (const bad of ["a/b", "a b", "a\tb", "a:b", "../up"]) {
		withStore({ "bad.md": VALID.replace("t12-close-position-clears-alert", bad) }, (_dir, files) => {
			assert.equal(files[0].valid, false, `id ${JSON.stringify(bad)} must be invalid`);
			assert.match(files[0].reason ?? "", /invalid id/);
		});
	}
	// and every id inside the pinned charset still validates
	for (const good of ["a.b_c-9", "holdout-1", "x".repeat(100)]) {
		withStore({ "ok.md": VALID.replace("t12-close-position-clears-alert", good) }, (_dir, files) => {
			assert.equal(files[0].valid, true, `id ${JSON.stringify(good)} must stay valid: ${files[0].reason ?? ""}`);
		});
	}
});

test("rejects a scenario missing title", () => {
	withStore({ "no-title.md": VALID.replace(/^title: .*$\n/m, "") }, (_dir, files) => {
		assert.equal(files[0].valid, false);
		assert.match(files[0].reason ?? "", /title/i);
		assert.equal(files[0].id, "t12-close-position-clears-alert");
	});
});

test("rejects duplicate id across files (first in path order wins)", () => {
	withStore(
		{ "1.md": VALID, "2.md": VALID }, // same id in two files
		(_dir, files) => {
			assert.equal(files.length, 2);
			assert.equal(files.every((f) => f.valid), false);
			assert.ok(files.filter((f) => /duplicate id/i.test(f.reason ?? "")).length === 1, "exactly one duplicate flagged");
		},
	);
});

test("rejects missing required — must NOT default to false", () => {
	withStore({ "no-req.md": VALID.replace(/^required: .*$\n/m, "") }, (_dir, files) => {
		assert.equal(files[0].valid, false, "missing required line is invalid");
		assert.match(files[0].reason ?? "", /required/i);
		assert.equal(files[0].required, undefined);
	});
});

test("rejects required: maybe", () => {
	withStore({ "maybe.md": VALID.replace("required: true", "required: maybe") }, (_dir, files) => {
		assert.equal(files[0].valid, false);
		assert.match(files[0].reason ?? "", /required/i);
	});
});

test("rejects spec present but not in [a, b] form", () => {
	withStore({ "bad-spec.md": VALID.replace("spec: [positions, alerts]", "spec: positions, alerts") }, (_dir, files) => {
		assert.equal(files[0].valid, false);
		assert.match(files[0].reason ?? "", /spec/i);
	});
});

test("rejects tags present but not in [a, b] form", () => {
	withStore({ "bad-tags.md": VALID.replace("tags: [smoke, alerts]", "tags: [smoke, alerts") }, (_dir, files) => {
		assert.equal(files[0].valid, false);
		assert.match(files[0].reason ?? "", /tags/i);
	});
});

test("rejects an empty body", () => {
	const closeIdx = VALID.indexOf("---", VALID.indexOf("---") + 3) + 3;
	withStore({ "empty-body.md": VALID.slice(0, closeIdx) + "\n\n" }, (_dir, files) => {
		assert.equal(files[0].valid, false);
		assert.match(files[0].reason ?? "", /body/i);
	});
});

test("rejects a file with no frontmatter", () => {
	withStore({ "raw.md": "Just prose, no frontmatter.\n" }, (_dir, files) => {
		assert.equal(files[0].valid, false);
	});
});

test("accepts a fully valid file with parsed lists", () => {
	withStore({ "ok.md": VALID }, (_dir, files) => {
		assert.equal(files.length, 1);
		const f = files[0];
		assert.equal(f.valid, true);
		assert.equal(f.reason, undefined);
		assert.equal(f.id, "t12-close-position-clears-alert");
		assert.equal(f.title, "Closing a position clears its price alert");
		assert.equal(f.required, true);
		assert.deepEqual(f.spec, ["positions", "alerts"]);
		assert.deepEqual(f.tags, ["smoke", "alerts"]);
	});
});

test("storeCounts returns total, required and invalid COUNTS (no names)", () => {
	withStore(
		{
			"ok.md": VALID,
			"ok-scored.md": VALID.replace("t12-", "t13-").replace("required: true", "required: false"),
			"bad.md": VALID.replace("t12-", "t14-").replace(/^required: .*$\n/m, ""),
		},
		(_dir, files) => {
			const c = storeCounts(files);
			assert.equal(c.total, 3);
			assert.equal(c.required, 1);
			assert.equal(c.invalid, 1);
		},
	);
});

// --- coveredTicketNumbers: startability rule data (spec §4) ---

test("coveredTicketNumbers maps valid t<ticket>- ids to ticket numbers, deduplicated and sorted", () => {
	withStore(
		{
			"a.md": VALID.replace("t12-close-position-clears-alert", "t12-first"),
			"b.md": VALID.replace("t12-close-position-clears-alert", "t12-second"), // same ticket twice
			"c.md": VALID.replace("t12-close-position-clears-alert", "t3-third"),
			"deep/nested.md": VALID.replace("t12-close-position-clears-alert", "t27-nested"),
		},
		(_dir, files) => {
			assert.deepEqual(coveredTicketNumbers(files), [3, 12, 27]);
		},
	);
});

test("coveredTicketNumbers: invalid files never cover their ticket (duplicate loser included)", () => {
	withStore(
		{
			"missing-required.md": VALID.replace("t12-close-position-clears-alert", "t41-broken").replace(/^required: .*$\n/m, ""),
			"duplicate.md": VALID.replace("t12-close-position-clears-alert", "t42-dup-a"), // valid winner covers 42
			"duplicate2.md": VALID.replace("t12-close-position-clears-alert", "t42-dup-a"), // invalid loser adds nothing
		},
		(_dir, files) => {
			assert.deepEqual(coveredTicketNumbers(files), [42], "the broken t41- file covers nothing; the duplicate loser neither twice nor at all");
		},
	);
});

test("coveredTicketNumbers: t<ticket>- is an exact prefix — t123- never covers 12, bare t12 never covers 12 either", () => {
	withStore(
		{
			"long.md": VALID.replace("t12-close-position-clears-alert", "t123-longer"),
			"bare.md": VALID.replace("t12-close-position-clears-alert", "t12"),
			"nonum.md": VALID.replace("t12-close-position-clears-alert", "tt12-not-a-ticket"),
		},
		(_dir, files) => {
			assert.deepEqual(coveredTicketNumbers(files), [123]);
		},
	);
});

test("coveredTicketNumbers: empty store covers nothing", () => {
	withStore({}, (_dir, files) => {
		assert.deepEqual(coveredTicketNumbers(files), []);
	});
});

// --- isSealed: pinned digest contract (spec §5.5) ---
// Buckets computed from sha256: first 10 hex chars, base 16, mod 1000.
// t3-alerts-smoke          -> a7943c86c9 -> 65
// t12-close-position-clears-alert -> 58d8f33fb1 -> 257
test("isSealed pins vector: bucket 65 sealed at share 0.1, unsealed at 0.05", () => {
	assert.equal(isSealed("t3-alerts-smoke", 0.1), true);
	assert.equal(isSealed("t3-alerts-smoke", 0.05), false);
});

test("isSealed pins vector: bucket 257 unsealed at share 0.2, sealed at 0.3", () => {
	assert.equal(isSealed("t12-close-position-clears-alert", 0.2), false);
	assert.equal(isSealed("t12-close-position-clears-alert", 0.3), true);
});

test("isSealed: share 0 never seals, share 1 always seals", () => {
	const ids = ["t1", "t2-longer-slug", "T9-upper", "ünïcödé-id"];
	for (const id of ids) {
		assert.equal(isSealed(id, 0), false, `share 0 never seals ${id}`);
		assert.equal(isSealed(id, 1), true, `share 1 always seals ${id}`);
	}
});

// --- parseVerdict (spec §5.2: the judge's last line starting with '{') ---
const verdict = (over: Record<string, unknown> = {}) => ({
	id: "t12-close-position-clears-alert",
	satisfied: 0.95,
	required: true,
	evidence: "alert removed after close (log line 42)",
	missing: "",
	...over,
});

test("parseVerdict accepts a valid last-line verdict", () => {
	const out = "some chatter\nanother line\n" + JSON.stringify(verdict()) + "\n";
	const r = parseVerdict(out, "t12-close-position-clears-alert");
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.verdict.satisfied, 0.95);
		assert.equal(r.verdict.required, true);
		assert.equal(r.verdict.missing, "");
	}
});

test("parseVerdict accepts boundary scores 0 and 1", () => {
	assert.equal(parseVerdict(JSON.stringify(verdict({ satisfied: 0 })), "t12-close-position-clears-alert").ok, true);
	assert.equal(parseVerdict(JSON.stringify(verdict({ satisfied: 1 })), "t12-close-position-clears-alert").ok, true);
});

test("parseVerdict rejects a non-JSON last line", () => {
	const r = parseVerdict("chat\n{not json", "t12-close-position-clears-alert");
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.reason, /[Jj][Ss][Oo][Nn]/);
});

test("parseVerdict rejects JSON not on the last line", () => {
	const out = "note\n" + JSON.stringify(verdict()) + "\nfinal commentary";
	const r = parseVerdict(out, "t12-close-position-clears-alert");
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.reason, /last line/i);
});

test("parseVerdict rejects an id mismatch", () => {
	const r = parseVerdict(JSON.stringify(verdict({ id: "other-id" })), "t12-close-position-clears-alert");
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.reason, /id/i);
});

test("parseVerdict rejects out-of-range scores (> 1, < 0, non-numeric)", () => {
	for (const satisfied of [1.2, -0.5, "0.9"]) {
		const r = parseVerdict(JSON.stringify(verdict({ satisfied })), "t12-close-position-clears-alert");
		assert.equal(r.ok, false, `satisfied=${JSON.stringify(satisfied)} must be rejected`);
		if (!r.ok) assert.match(r.reason, /satisfied/i);
	}
});

test("parseVerdict rejects malformed JSON, arrays, and missing fields", () => {
	const id = "t12-close-position-clears-alert";
	assert.equal(parseVerdict("{broken json", id).ok, false);
	assert.equal(parseVerdict("[1, 2, 3]", id).ok, false);
	assert.equal(parseVerdict(JSON.stringify(verdict({ required: undefined })), id).ok, false);
	assert.equal(parseVerdict(JSON.stringify(verdict({ evidence: undefined })), id).ok, false);
	assert.equal(parseVerdict(JSON.stringify(verdict({ missing: undefined })), id).ok, false);
	assert.equal(parseVerdict("", id).ok, false);
});

// --- foldJudgeRun (spec §5.2: the whole verdict policy in one place) ---
test("foldJudgeRun: exit 0 delegates to parseVerdict (valid stays valid, invalid stays invalid)", () => {
	const id = "t12-close-position-clears-alert";
	const good = foldJudgeRun("chatter\n" + JSON.stringify(verdict()) + "\n", id, 0);
	assert.equal(good.ok, true);
	if (good.ok) assert.equal(good.verdict.satisfied, 0.95);
	const bad = foldJudgeRun("no json here", id, 0);
	assert.equal(bad.ok, false);
	if (!bad.ok) assert.match(bad.reason, /[Jj][Ss][Oo][Nn]/);
});

test("foldJudgeRun: a non-zero judge exit discards even a WELL-FORMED verdict (never green-lights)", () => {
	const id = "t12-close-position-clears-alert";
	const r = foldJudgeRun(JSON.stringify(verdict()), id, 3);
	assert.equal(r.ok, false, "a healthy-looking verdict from an unhealthy judge must score 0");
	if (!r.ok) {
		assert.match(r.reason, /judge exited 3/);
		assert.match(r.reason, /discarded/);
	}
});

test("foldJudgeRun: a non-zero judge exit wraps the parse reason on a bad transcript", () => {
	const id = "t12-close-position-clears-alert";
	const r = foldJudgeRun("about to die", id, 3);
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.reason, /^judge exited 3; /);
	if (!r.ok) assert.match(r.reason, /not a JSON verdict/);
});
