// Ticket #105 — polish budget: review.max_followup_depth + accept-tail.
//
// Acceptance covered here:
//  (1) the depth counter increments per should-fix round and trips at the configured cap
//      (pure functions, no tracker);
//  (2) at the cap, a review's should-fixes land in a per-area backlog ticket (CREATED or
//      APPENDED) and the original ticket goes dl/approved — gate-ready (engine driven
//      offline against fake-gh);
//  (3) must-fix rounds never count against the cap (correctness is not budgeted);
//  (5) config validation: a negative/non-integer depth falls back to the default WITH a
//      warning and never crashes.
// Criterion (4) — the skill §4 / DECISIONS documentation — is pinned in the doc tests.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeFixture } from "../fixtures.ts";
import { loadConfig, parseReviewBlock, DEFAULT_MAX_FOLLOWUP_DEPTH } from "../../extension/src/config.ts";
import { createIssue } from "../../extension/src/issues.ts";
import {
	countShouldFixRounds,
	acceptTailDue,
	polishBacklogTitle,
	acceptTail,
	SHOULD_FIX_FOLLOWUP_MARKER,
} from "../../extension/src/polish.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

// ---------------------------------------------------------------------------
// (1) the depth counter and the cap — pure, no tracker
// ---------------------------------------------------------------------------

test("countShouldFixRounds: one round per marked comment, in any position in the history", () => {
	assert.equal(countShouldFixRounds([]), 0, "no comments is zero rounds");
	assert.equal(countShouldFixRounds(["plain review note"]), 0);
	assert.equal(
		countShouldFixRounds([
			"plain comment",
			`${SHOULD_FIX_FOLLOWUP_MARKER}: round one`,
			"another plain comment",
			`${SHOULD_FIX_FOLLOWUP_MARKER}: round two`,
			`${SHOULD_FIX_FOLLOWUP_MARKER}: round three`,
		]),
		3,
		"the count is the number of marked comments, out of order and mixed in",
	);
});

test("countShouldFixRounds: the marker must open the first non-empty line, never appear mid-comment", () => {
	assert.equal(countShouldFixRounds([`found it: ${SHOULD_FIX_FOLLOWUP_MARKER} mentioned inline`]), 0, "inline mention is not a round");
	assert.equal(countShouldFixRounds([`\n\n${SHOULD_FIX_FOLLOWUP_MARKER}: late round`]), 1, "leading blank lines do not hide a marked comment");
	assert.equal(countShouldFixRounds([`${SHOULD_FIX_FOLLOWUP_MARKER}: appears again in line two\n${SHOULD_FIX_FOLLOWUP_MARKER}: no`]), 1, "one marked comment counts once, not per occurrence");
});

test("countShouldFixRounds: the marker needs a boundary (colon or end-of-line) — prose that merely starts with it is not a round", () => {
	assert.equal(countShouldFixRounds([`${SHOULD_FIX_FOLLOWUP_MARKER}s are welcome`]), 0, "pluralised prose is a discussion, not a re-dispatch");
	assert.equal(countShouldFixRounds([`${SHOULD_FIX_FOLLOWUP_MARKER}: round one`]), 1, "marker + colon is a round");
	assert.equal(countShouldFixRounds([SHOULD_FIX_FOLLOWUP_MARKER]), 1, "the lone marker at end-of-line is a round");
	assert.equal(countShouldFixRounds([`${SHOULD_FIX_FOLLOWUP_MARKER}, see the notes`]), 0, "a comma is not a boundary");
});

test("countShouldFixRounds: must-fix and gate/review chatter never count (correctness is not budgeted)", () => {
	assert.equal(
		countShouldFixRounds([
			"must-fix: the parser double-counts (re-dispatch)",
			"must-fix: second correctness round (re-dispatch)",
			"gate red on the flaky test — re-gate",
			"VERDICT: APPROVE",
		]),
		0,
		"unmarked re-dispatches and verdicts are invisible to the counter",
	);
});

test("acceptTailDue: trips exactly AT the configured cap and never under", () => {
	assert.equal(acceptTailDue(0, 2), false);
	assert.equal(acceptTailDue(1, 2), false, "one round used, one left");
	assert.equal(acceptTailDue(2, 2), true, "the second round is the last; the next finding trips the cap");
	assert.equal(acceptTailDue(3, 2), true, "over the cap stays at the cap");
	assert.equal(acceptTailDue(0, 0), true, "a cap of 0 accepts the tail immediately (a valid, explicit choice)");
	assert.equal(acceptTailDue(1, 1), true);
});

test("polishBacklogTitle: one stable title per area", () => {
	assert.equal(polishBacklogTitle("cache"), "Polish backlog — cache");
	assert.notEqual(polishBacklogTitle("cache"), polishBacklogTitle("auth"));
});

// ---------------------------------------------------------------------------
// (5) config validation — review.max_followup_depth
// ---------------------------------------------------------------------------

test("parseReviewBlock: absent block or absent key ⇒ the default, silently", () => {
	assert.deepEqual(parseReviewBlock(undefined), { maxFollowupDepth: 2, warning: null });
	assert.deepEqual(parseReviewBlock({}), { maxFollowupDepth: 2, warning: null });
	assert.equal(DEFAULT_MAX_FOLLOWUP_DEPTH, 2, "the default itself is pinned");
});

test("parseReviewBlock: honours an explicit non-negative integer (including 0)", () => {
	assert.deepEqual(parseReviewBlock({ max_followup_depth: 0 }), { maxFollowupDepth: 0, warning: null });
	assert.deepEqual(parseReviewBlock({ max_followup_depth: 5 }), { maxFollowupDepth: 5, warning: null });
});

test("parseReviewBlock: negative / non-integer / non-numeric ⇒ the default WITH a warning", () => {
	for (const bad of [-1, -0.5, 2.5, "2", null, [2], true]) {
		const r = parseReviewBlock({ max_followup_depth: bad });
		assert.equal(r.maxFollowupDepth, 2, `fallback for ${JSON.stringify(bad)}`);
		assert.ok(r.warning && r.warning.includes("review.max_followup_depth"), `warns for ${JSON.stringify(bad)}`);
	}
});

test("parseReviewBlock: a malformed BLOCK (not an object) coerces to the default silently (policy-block discipline)", () => {
	assert.deepEqual(parseReviewBlock("weird"), { maxFollowupDepth: 2, warning: null });
	assert.deepEqual(parseReviewBlock([1]), { maxFollowupDepth: 2, warning: null });
});

test("loadConfig: carries review.maxFollowupDepth (default and explicit) without crashing", () => {
	const fx = makeFixture('{"base_branch":"main","review":{"max_followup_depth":3}}');
	try {
		const cfg = loadConfig(fx.repo);
		assert.ok(cfg);
		assert.equal(cfg.review.maxFollowupDepth, 3);
	} finally { fx.cleanup(); }
	const fx0 = makeFixture('{"base_branch":"main"}');
	try {
		assert.equal(loadConfig(fx0.repo)?.review.maxFollowupDepth, 2, "absent block ⇒ default 2");
	} finally { fx0.cleanup(); }
});

test("loadConfig: a bad review.max_followup_depth falls back to the default and WARNS (never crashes)", () => {
	for (const json of ['{"review":{"max_followup_depth":-2}}', '{"review":{"max_followup_depth":1.5}}', '{"review":{"max_followup_depth":"2"}}']) {
		const fx = makeFixture(json);
		const warns: string[] = [];
		const orig = console.warn;
		console.warn = (msg: unknown) => { warns.push(String(msg)); };
		try {
			const cfg = loadConfig(fx.repo);
			assert.ok(cfg, json);
			assert.equal(cfg.review.maxFollowupDepth, 2, json);
			assert.equal(warns.length, 1, `exactly one warning for ${json}`);
			assert.match(warns[0], /review\.max_followup_depth/, json);
		} finally {
			console.warn = orig;
			fx.cleanup();
		}
	}
});

// ---------------------------------------------------------------------------
// fake-gh contract the counter rides on: one comments-array entry per message
// ---------------------------------------------------------------------------

function tailFx(configJson: string) {
	const fx = makeFixture(configJson);
	const bin = path.join(fx.dir, "bin");
	mkdirSync(bin, { recursive: true });
	execFileSync("ln", ["-sf", path.join(ROOT, "tests", "fake-gh"), path.join(bin, "gh")]);
	process.env.MULTIPI_HOME = path.join(fx.dir, "home");
	process.env.FAKE_GH_DIR = path.join(fx.dir, "gh");
	process.env.PATH = `${bin}:${process.env.PATH}`;
	return fx;
}

const gh = (fx: ReturnType<typeof makeFixture>, args: string[]): string =>
	execFileSync("gh", args, { cwd: fx.repo, stdio: "pipe" }).toString();

function createTicket(fx: ReturnType<typeof makeFixture>, title: string): number {
	return Number(gh(fx, ["issue", "create", title, "acceptance body"]).trim().split("/").pop());
}
function roundComment(fx: ReturnType<typeof makeFixture>, n: number, i: number): void {
	gh(fx, ["issue", "comment", String(n), "--body", `${SHOULD_FIX_FOLLOWUP_MARKER}: round ${i} finding`]);
}
interface OpenRow { number: number; title: string; body?: string; labels: { name: string }[] }
function openRows(fx: ReturnType<typeof makeFixture>, fields: "number,title" | "number,title,labels" | "number,title,body" = "number,title,labels"): OpenRow[] {
	return JSON.parse(gh(fx, ["issue", "list", "--state", "open", "--json", fields]));
}
function commentBodies(fx: ReturnType<typeof makeFixture>, n: number): string[] {
	const row = JSON.parse(gh(fx, ["issue", "view", String(n), "--json", "title,comments"])) as { comments: { body: string }[] };
	return row.comments.map((c) => c.body);
}

test("fake-gh: issue view returns ONE comments-array entry per message, oldest first, [] when none", () => {
	const fx = tailFx('{"base_branch":"main"}');
	try {
		const n = createTicket(fx, "Shape pin");
		assert.deepEqual(commentBodies(fx, n), [], "a fresh issue has no comments, not one empty blob");
		gh(fx, ["issue", "comment", String(n), "--body", "first"]);
		gh(fx, ["issue", "comment", String(n), "--body", "second"]);
		gh(fx, ["issue", "comment", String(n), "--body", "third"]);
		assert.deepEqual(commentBodies(fx, n), ["first", "second", "third"], "each message is its own entry, in order");
	} finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// (2) the accept-tail engine, offline against fake-gh
// ---------------------------------------------------------------------------

const FINDINGS = "rename the hot path\nassert the eviction order";

// ---------------------------------------------------------------------------
// review round 2, must-fix 1: createIssue must speak the REAL CLI's flag form.
// Positional `gh issue create <title> <body>` is rejected by the real gh
// ("unknown arguments") — the fake historically modelled the positional form
// and masked it; the calls.log pin below ties the extension to the flag form.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

test("createIssue calls gh with --title/--body (the real CLI's contract), not positionally", () => {
	const fx = tailFx('{"base_branch":"main"}');
	try {
		const n = createIssue("", "Flag-form ticket", "line one\nline two");
		assert.ok(Number.isInteger(n) && n > 0, "returns the new issue number");

		const log = readFileSync(path.join(process.env.FAKE_GH_DIR!, "calls.log"), "utf8");
		// A multi-line body makes the calls.log entry span lines: slice from the (last) create
		// verb to the end of the log rather than line-splitting.
		assert.ok(log.includes("issue create"), "the create call was recorded by the fake");
		const call = log.slice(log.lastIndexOf("issue create"));
		assert.match(call, /^issue create --title Flag-form ticket --body line one\nline two\n$/,
			`the real CLI speaks flags, never positionals (calls.log said: ${JSON.stringify(call)})`);

		// the flag-form issue round-trips: title on line 1, the multi-line body intact
		const row = openRows(fx, "number,title,body").find((i) => i.number === n)!;
		assert.equal(row.title, "Flag-form ticket");
		assert.equal(row.body, "line one\nline two");
	} finally { fx.cleanup(); }
});

test("at the cap (default 2), acceptTail CREATES the area backlog, parks the findings and approves the ticket", () => {
	const fx = tailFx('{"base_branch":"main"}');
	try {
		const n = createTicket(fx, "Cache layer");
		roundComment(fx, n, 1);
		roundComment(fx, n, 2);
		const res = acceptTail({ root: fx.repo, repo: "", ticket: n, area: "cache", findings: FINDINGS });
		assert.equal(res.action, "accepted");
		assert.equal(res.rounds, 2);
		assert.equal(res.cap, 2);
		assert.equal(res.backlogAction, "created");
		assert.equal(res.backlogTitle, "Polish backlog — cache");

		const open = openRows(fx, "number,title,labels");
		const backlog = open.find((i) => i.title === res.backlogTitle);
		assert.ok(backlog, "the backlog ticket exists and is open");
		assert.notEqual(backlog!.number, n);
		assert.equal(res.backlogNumber, backlog!.number);
		const mine = open.find((i) => i.number === n)!;
		assert.ok(mine.labels.some((l) => l.name === "dl/approved"), "the original ticket is dl/approved — gate-ready");

		const withBody = openRows(fx, "number,title,body").find((i) => i.number === backlog!.number)!;
		assert.equal(
			withBody.body!,
			`#${n}\n${FINDINGS}`,
			"the parked entry is byte-stable: source ticket, a newline, the findings — NO wall-clock date (determinism pin, review round 2)",
		);
		assert.ok(withBody.body!.includes(`#${n}`), "the parked entry names its source ticket");

		const bodies = commentBodies(fx, n);
		const verdict = bodies.find((b) => b.startsWith("accept-tail"));
		assert.ok(verdict, "the verdict is commented on the ticket (audit trail)");
		assert.ok(verdict!.includes(`#${backlog!.number}`), "the verdict names the backlog ticket it parked into");
	} finally { fx.cleanup(); }
});

test("a second tail APPENDS to the same backlog — never a second backlog ticket", () => {
	const fx = tailFx('{"base_branch":"main"}');
	try {
		const n = createTicket(fx, "Cache layer");
		roundComment(fx, n, 1);
		roundComment(fx, n, 2);
		const first = acceptTail({ root: fx.repo, repo: "", ticket: n, area: "cache", findings: FINDINGS });
		assert.equal(first.backlogAction, "created");

		roundComment(fx, n, 3); // over the cap now
		const second = acceptTail({ root: fx.repo, repo: "", ticket: n, area: "cache", findings: "second-round finding" });
		assert.equal(second.action, "accepted");
		assert.equal(second.backlogAction, "appended");
		assert.equal(second.backlogNumber, first.backlogNumber, "the SAME backlog ticket");

		assert.equal(openRows(fx).filter((i) => i.title === "Polish backlog — cache").length, 1, "exactly one backlog per area");
		assert.ok(
			commentBodies(fx, first.backlogNumber!).some((b) => b.includes("second-round finding")),
			"the appended findings ride as a comment on the backlog",
		);
	} finally { fx.cleanup(); }
});

test("different areas get their own backlog tickets", () => {
	const fx = tailFx('{"base_branch":"main"}');
	try {
		const na = createTicket(fx, "Cache layer");
		const nb = createTicket(fx, "Auth token expiry");
		for (const n of [na, nb]) { roundComment(fx, n, 1); roundComment(fx, n, 2); }
		acceptTail({ root: fx.repo, repo: "", ticket: na, area: "cache", findings: "a" });
		acceptTail({ root: fx.repo, repo: "", ticket: nb, area: "auth", findings: "b" });
		assert.equal(openRows(fx).filter((i) => i.title.startsWith("Polish backlog —")).length, 2);
	} finally { fx.cleanup(); }
});

test("below the cap, acceptTail changes NOTHING (no backlog, no label, no verdict comment)", () => {
	const fx = tailFx('{"base_branch":"main"}');
	try {
		const n = createTicket(fx, "Cache layer");
		roundComment(fx, n, 1);
		const res = acceptTail({ root: fx.repo, repo: "", ticket: n, area: "cache", findings: FINDINGS });
		assert.equal(res.action, "below-cap");
		assert.equal(res.rounds, 1);
		assert.equal(res.cap, 2);
		assert.equal(res.backlogNumber, undefined);

		assert.equal(openRows(fx).filter((i) => i.title.startsWith("Polish backlog —")).length, 0, "no backlog created");
		assert.equal(openRows(fx).find((i) => i.number === n)!.labels.length, 0, "no label applied");
		assert.ok(!commentBodies(fx, n).some((b) => b.startsWith("accept-tail")), "no verdict comment");
	} finally { fx.cleanup(); }
});

test("(3) must-fix re-dispatches never consume the budget, however deep", () => {
	const fx = tailFx('{"base_branch":"main"}');
	try {
		const n = createTicket(fx, "Parser");
		for (let i = 1; i <= 5; i++) gh(fx, ["issue", "comment", String(n), "--body", `must-fix: correctness round ${i} (re-dispatched)`]);
		const res = acceptTail({ root: fx.repo, repo: "", ticket: n, area: "parser", findings: "x" });
		assert.equal(res.action, "below-cap", "five must-fix rounds leave the should-fix budget untouched");
		assert.equal(res.rounds, 0);
	} finally { fx.cleanup(); }
});

test("acceptTail honours an explicit review.max_followup_depth (cap 1 trips after one round)", () => {
	const fx = tailFx('{"base_branch":"main","review":{"max_followup_depth":1}}');
	try {
		const n = createTicket(fx, "Cache layer");
		roundComment(fx, n, 1);
		const res = acceptTail({ root: fx.repo, repo: "", ticket: n, area: "cache", findings: FINDINGS });
		assert.equal(res.action, "accepted");
		assert.equal(res.cap, 1);
	} finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// review round 2, should-fix (a): idempotency across a partial failure — a
// re-run must never double-park, double-verb or double-label.
// ---------------------------------------------------------------------------

test("a re-run with the SAME findings parks ONCE: no duplicate entry, one verdict, one label", () => {
	const fx = tailFx('{"base_branch":"main"}');
	try {
		const n = createTicket(fx, "Cache layer");
		roundComment(fx, n, 1);
		roundComment(fx, n, 2);
		const first = acceptTail({ root: fx.repo, repo: "", ticket: n, area: "cache", findings: FINDINGS });
		assert.equal(first.action, "accepted");

		const second = acceptTail({ root: fx.repo, repo: "", ticket: n, area: "cache", findings: FINDINGS });
		assert.equal(second.action, "accepted", "a re-run is still an acceptance, not an error");
		assert.equal(second.backlogNumber, first.backlogNumber, "the same backlog ticket");
		assert.equal(second.backlogAction, "unchanged", "nothing was parked twice");

		const entries = commentBodies(fx, first.backlogNumber!).filter((b) => b.includes("rename the hot path"));
		assert.equal(entries.length, 0, "the findings stayed in the backlog BODY; the re-run appended nothing");
		const verdicts = commentBodies(fx, n).filter((b) => b.startsWith("accept-tail"));
		assert.equal(verdicts.length, 1, "exactly one verdict comment, not one per run");
		const mine = openRows(fx, "number,title,labels").find((i) => i.number === n)!;
		assert.equal(mine.labels.filter((l) => l.name === "dl/approved").length, 1, "the label is applied once");
	} finally { fx.cleanup(); }
});

test("a re-run after a PARTIAL failure (parked, verdict never posted) heals without re-parking", () => {
	const fx = tailFx('{"base_branch":"main"}');
	try {
		const n = createTicket(fx, "Cache layer");
		roundComment(fx, n, 1);
		roundComment(fx, n, 2);
		// Simulate the crash BETWEEN parking and the verdict: the backlog exists with the
		// entry parked as its first (comment) entry, but the ticket carries no verdict.
		const b = Number(gh(fx, ["issue", "create", "Polish backlog — cache", ""]).trim().split("/").pop());
		gh(fx, ["issue", "comment", String(b), "--body", `#${n}\n${FINDINGS}`]);

		const res = acceptTail({ root: fx.repo, repo: "", ticket: n, area: "cache", findings: FINDINGS });
		assert.equal(res.action, "accepted");
		assert.equal(res.backlogNumber, b);
		assert.equal(res.backlogAction, "unchanged", "the already-parked entry is not appended a second time");
		assert.equal(commentBodies(fx, b).filter((c) => c === `#${n}\n${FINDINGS}`).length, 1, "the entry occurs exactly once");
		assert.equal(commentBodies(fx, n).filter((c) => c.startsWith("accept-tail")).length, 1, "the missing verdict is posted exactly once");
		const mine = openRows(fx, "number,title,labels").find((i) => i.number === n)!;
		assert.ok(mine.labels.some((l) => l.name === "dl/approved"), "the ticket still lands dl/approved");
	} finally { fx.cleanup(); }
});

test("acceptTail: a ticket the tracker does not know is a HARD error, never a silent below-cap", () => {
	const fx = tailFx('{"base_branch":"main"}');
	try {
		assert.throws(
			() => acceptTail({ root: fx.repo, repo: "", ticket: 999, area: "cache", findings: "x" }),
			/999|not|no issue|No issue/i,
		);
	} finally { fx.cleanup(); }
});
