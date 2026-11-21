// The polish budget (ticket #105): the brake on the should-fix cascade.
//
// A review that comes back APPROVE with only should-fixes is NOT a correctness gate — the
// ticket may polish, but it must converge. Per ticket, each should-fix re-dispatch is
// recorded as an issue comment whose FIRST line begins with SHOULD_FIX_FOLLOWUP_MARKER;
// counting those comments is the ticket's follow-up depth, and when the depth reaches
// `review.max_followup_depth` (default 2) the next tail is ACCEPTED: acceptTail parks the
// findings in the single per-area polish backlog (created or appended), comments the
// verdict on the ticket, and labels it dl/approved so it proceeds to the gate.
//
// Must-fix rounds never count (their re-dispatch comments carry no marker): correctness
// is not budgeted, and a ticket that keeps producing must-fixes keeps re-dispatching
// until APPROVE-clean.
//
// Pure-node (testable without pi): the decision lives here, scripts/polish-tail.sh is its
// thin hand, and the devloop skill §4 names the branch the orchestrator follows.
import { loadConfig } from "./config.ts";
import { addComment, addLabel, createIssue, issueComments, listOpenIssues } from "./issues.ts";

/** The first-line marker of a should-fix re-dispatch comment. A comment counts a round
 * only when its first NON-EMPTY line begins with it — inline mentions are invisible. */
export const SHOULD_FIX_FOLLOWUP_MARKER = "should-fix follow-up";

/** The ticket's follow-up depth: one per comment whose first non-empty line opens with the
 * marker. One marked comment counts once, regardless of how often the marker recurs in it. */
export function countShouldFixRounds(comments: string[]): number {
	let rounds = 0;
	for (const c of comments) {
		const first = c.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
		if (first !== undefined && first.startsWith(SHOULD_FIX_FOLLOWUP_MARKER)) rounds++;
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
	/** "accepted": findings parked, ticket dl/approved, gate-ready. "below-cap": nothing was
	 * changed — re-dispatch the implementer (its comment must open with the marker). */
	action: "accepted" | "below-cap";
	/** The counted should-fix rounds on the ticket. */
	rounds: number;
	/** The configured cap that was compared. */
	cap: number;
	backlogTitle: string;
	backlogNumber?: number;
	backlogAction?: "created" | "appended";
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
	const rounds = countShouldFixRounds(issueComments(a.repo, a.ticket));
	const title = polishBacklogTitle(a.area);
	if (!acceptTailDue(rounds, cap)) {
		return { action: "below-cap", rounds, cap, backlogTitle: title };
	}
	const entry = `#${a.ticket} (${new Date().toISOString().slice(0, 10)})\n${a.findings.trim()}`;
	const backlog = listOpenIssues(a.repo).find((i) => i.title === title);
	let backlogNumber: number;
	let backlogAction: "created" | "appended";
	if (backlog) {
		backlogNumber = backlog.number;
		addComment(a.repo, backlogNumber, entry);
		backlogAction = "appended";
	} else {
		backlogNumber = createIssue(a.repo, title, entry);
		backlogAction = "created";
	}
	addComment(
		a.repo,
		a.ticket,
		`accept-tail: ${rounds} should-fix round(s) at the cap (${cap}) — findings parked in "${title}" (#${backlogNumber}); the ticket is dl/approved and proceeds to the gate.`,
	);
	addLabel(a.repo, a.ticket, "dl/approved");
	return { action: "accepted", rounds, cap, backlogTitle: title, backlogNumber, backlogAction };
}
