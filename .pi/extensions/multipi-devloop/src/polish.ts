// The polish budget (ticket #105): the brake on the should-fix cascade.
//
// A review that comes back APPROVE with only should-fixes is NOT a correctness gate — the
// ticket may polish, but it must converge. Per ticket, each should-fix re-dispatch is
// recorded as an issue comment whose FIRST non-empty line IS the marker SHOULD_FIX_FOLLOWUP_MARKER
// or the marker followed by a colon (the boundary keeps prose that merely STARTS with the
// marker — "should-fix follow-ups are welcome" — from counting); counting those comments is
// the ticket's follow-up depth, and when the depth reaches `review.max_followup_depth`
// (default 2) the next tail is ACCEPTED: acceptTail parks the findings in the single
// per-area polish backlog (created or appended), comments the verdict on the ticket, and
// labels it dl/approved so it proceeds to the gate.
//
// The parked entry is content-addressed and carries NO wall-clock date (determinism):
// `#<ticket>` + newline + the findings, trimmed. acceptTail is IDEMPOTENT across a re-run
// after a partial failure — a parking whose entry already exists is skipped, a ticket whose
// verdict comment already exists is not re-verb'd, and a ticket already labelled dl/approved
// is not re-labelled. A re-run therefore never double-parks, and a crash between any two of
// the three mutations heals on the next call.
//
// Must-fix rounds never count (their re-dispatch comments carry no marker): correctness
// is not budgeted, and a ticket that keeps producing must-fixes keeps re-dispatching
// until APPROVE-clean.
//
// Pure-node (testable without pi): the decision lives here, scripts/polish-tail.sh is its
// thin hand, and the devloop skill §4 names the branch the orchestrator follows.
import { loadConfig } from "./config.ts";
import { addComment, setLifecycleLabel, createIssue, issueComments, listOpenIssues } from "./issues.ts";

/** The first-line marker of a should-fix re-dispatch comment. A comment counts a round
 * only when its first NON-EMPTY line IS the marker (end-of-line) or the marker followed by a
 * colon — the boundary keeps prose that merely starts with the word ("should-fix
 * follow-ups are welcome") invisible. Inline mentions never count. */
export const SHOULD_FIX_FOLLOWUP_MARKER = "should-fix follow-up";

/** One round per comment whose first non-empty line is the marker with its boundary
 * (bare at end-of-line, or followed by a colon). One marked comment counts once,
 * regardless of how often the marker recurs in it. */
export function countShouldFixRounds(comments: string[]): number {
	let rounds = 0;
	for (const c of comments) {
		const first = c.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
		if (first !== undefined && (first === SHOULD_FIX_FOLLOWUP_MARKER || first.startsWith(SHOULD_FIX_FOLLOWUP_MARKER + ":"))) rounds++;
	}
	return rounds;
}

/** True when `rounds` should-fix re-dispatches leave NO budget at the configured cap — the
 * accept-tail branch. A cap of 0 accepts the very first tail (a valid, explicit choice). */
export function acceptTailDue(rounds: number, maxFollowupDepth: number): boolean {
	return rounds >= maxFollowupDepth;
}

/** The single per-area backlog ticket's title: one per area, appended — never forked. */
export function polishBacklogTitle(area: string): string {
	return `Polish backlog — ${area}`;
}

export interface TailArgs {
	/** Repo root holding the .devloop.json whose review block sets the cap. */
	root: string;
	/** gh repo slug ("" = the tracker default, e.g. the cwd's git remote). */
	repo: string;
	/** The ticket whose review came back APPROVE with only should-fixes. */
	ticket: number;
	/** A non-empty kebab-case area word; the backlog is one ticket per area. */
	area: string;
	/** The should-fix findings, verbatim. */
	findings: string;
}

export interface TailResult {
	/** "accepted": findings parked (or already parked on a re-run), ticket dl/approved, gate-ready.
	 * "below-cap": nothing was changed — re-dispatch the implementer (its comment must open with
	 * the marker). */
	action: "accepted" | "below-cap";
	/** The counted should-fix rounds on the ticket. */
	rounds: number;
	/** The configured cap that was compared. */
	cap: number;
	backlogTitle: string;
	backlogNumber?: number;
	/** "created": first use, the backlog now holds the entry in its body. "appended": the entry
	 * rides as a new comment. "unchanged": a re-run found the entry already parked — nothing
	 * was written (idempotency across a partial failure). */
	backlogAction?: "created" | "appended" | "unchanged";
}

/** The content-addressed parking entry: source ticket, a newline, the findings trimmed.
 * NO wall-clock date — a re-run must produce the SAME bytes so the idempotency guard can
 * recognise it, and a stable entry keeps the backlog byte-stable for operators and tests. */
function parkingEntry(ticket: number, findings: string): string {
	return `#${ticket}\n${findings.trim()}`;
}

/** The deterministic half of the accept-tail verdict (ticket #105). See the module header
 * for the contract; throws when the config is missing or the tracker query fails — a
 * verdict that cannot be computed is an error (rc 3 of the script), never a guess. */
export function acceptTail(a: TailArgs): TailResult {
	if (!a.area || !a.area.trim()) throw new Error("area must be a non-empty word");
	if (!a.findings || !a.findings.trim()) throw new Error("findings must not be empty");
	const cfg = loadConfig(a.root);
	if (!cfg) throw new Error(`no valid .devloop.json at ${a.root}`);
	const cap = cfg.review.maxFollowupDepth;
	const comments = issueComments(a.repo, a.ticket);
	const rounds = countShouldFixRounds(comments);
	const title = polishBacklogTitle(a.area);
	if (!acceptTailDue(rounds, cap)) {
		return { action: "below-cap", rounds, cap, backlogTitle: title };
	}
	// Idempotency (review round 2): the three mutations are each guarded by the state the
	// PREVIOUS run left behind — parking by the entry's own bytes, the verdict by its prefix,
	// the label by the ticket's current labels. A re-run (full or after a partial failure)
	// changes nothing that already happened.
	const entry = parkingEntry(a.ticket, a.findings);
	const open = listOpenIssues(a.repo);
	const source = open.find((i) => i.number === a.ticket);
	const backlog = open.find((i) => i.title === title);
	let backlogNumber: number;
	let backlogAction: "created" | "appended" | "unchanged";
	if (backlog) {
		backlogNumber = backlog.number;
		const alreadyParked = backlog.body === entry || issueComments(a.repo, backlogNumber).some((c) => c.trim() === entry);
		if (alreadyParked) {
			backlogAction = "unchanged";
		} else {
			addComment(a.repo, backlogNumber, entry);
			backlogAction = "appended";
		}
	} else {
		backlogNumber = createIssue(a.repo, title, entry);
		backlogAction = "created";
	}
	if (!comments.some((c) => c.trimStart().startsWith("accept-tail:"))) {
		addComment(
			a.repo,
			a.ticket,
			`accept-tail: ${rounds} should-fix round(s) at the cap (${cap}) — findings parked in "${title}" (#${backlogNumber}); the ticket is dl/approved and proceeds to the gate.`,
		);
	}
	if (!source?.labels.includes("dl/approved")) setLifecycleLabel(a.repo, a.ticket, "dl/approved");
	return { action: "accepted", rounds, cap, backlogTitle: title, backlogNumber, backlogAction };
}
