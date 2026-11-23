import { execFileSync } from "node:child_process";

export interface Issue {
	number: number;
	title: string;
	labels: string[];
	body: string;
}

/**
 * Parse the output of `gh ... --json`. Observed gh variants emit either a single JSON array
 * (compact, one line) or NDJSON (one object per line); accept both. Pure: unit-tested directly.
 */
export function parseGhOutput(out: string): unknown[] {
	const trimmed = out.trim();
	if (!trimmed) return [];
	try {
		const v = JSON.parse(trimmed);
		return Array.isArray(v) ? v : [v];
	} catch {
		return trimmed
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	}
}

function ghJson(repo: string, args: string[]): unknown[] {
	const full = repo ? ["--repo", repo, ...args] : args;
	const out = execFileSync("gh", full, {
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 32 * 1024 * 1024,
	}).toString();
	return parseGhOutput(out);
}

interface RawIssue {
	number: number;
	title: string;
	labels?: { name: string }[];
	body?: string;
}

function toIssue(r: RawIssue): Issue {
	return { number: r.number, title: r.title, labels: (r.labels ?? []).map((l) => l.name), body: r.body ?? "" };
}

export function listOpenIssues(repo: string): Issue[] {
	const rows = ghJson(repo, ["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title,labels,body"]) as RawIssue[];
	return rows.map(toIssue);
}

/** Locate ONE open issue by EXACT title, via a title-specific search rather than the
 * 200-capped `listOpenIssues` (ticket #117, the #105 review tail): on a tracker with
 * >200 open issues the general list can drop an existing per-area backlog (or the source
 * ticket), which would FORK the backlog and blind the label guard. A handful of search
 * rows at most, whatever the tracker's open count. `undefined` when no open issue carries
 * the title. */
export function findOpenIssueByTitle(repo: string, title: string): Issue | undefined {
	const rows = ghJson(repo, ["issue", "list", "--state", "open", "--search", `in:title "${title}"`, "--limit", "20", "--json", "number,title,labels,body"]) as RawIssue[];
	return rows.map(toIssue).find((i) => i.title === title);
}

/** One issue by number (a direct view, not the capped list): a verdict that operates on
 * a single ticket must never judge its labels off a listing that may not show it.
 * THROWS when the issue cannot be read — the same rule as `issueComments` (a verdict
 * never guesses on a silent state). */
export function issueView(repo: string, number: number): Issue {
	const rows = ghJson(repo, ["issue", "view", String(number), "--json", "number,title,labels,body"]) as RawIssue[];
	if (!rows.length || !rows[0]) throw new Error(`cannot read issue #${number} from the tracker`);
	return toIssue(rows[0]);
}

export function listClosedIssueNumbers(repo: string): number[] {
	const rows = ghJson(repo, ["issue", "list", "--state", "closed", "--limit", "200", "--json", "number"]) as { number: number }[];
	return rows.map((r) => r.number);
}

/** Latest issue comment (review findings ride here), or "". Truncated to maxChars. */
export function latestComment(repo: string, number: number, maxChars = 6000): string {
	let rows: { comments?: { body: string }[] }[];
	try {
		rows = ghJson(repo, ["issue", "view", String(number), "--json", "title,comments"]) as { comments?: { body: string }[] }[];
	} catch {
		return "";
	}
	const comments = rows[0]?.comments ?? [];
	if (!comments.length) return "";
	return (comments[comments.length - 1].body ?? "").slice(0, maxChars);
}

/** Every comment on an issue, oldest first (ticket #105). Throws when the tracker query
 * fails or the issue does not exist — a VERDICT must never count on a silent empty history.
 * (latestComment above stays fail-soft: its brief context tolerates lossy history.) */
export function issueComments(repo: string, number: number): string[] {
	const rows = ghJson(repo, ["issue", "view", String(number), "--json", "title,comments"]) as { comments?: { body: string }[] }[];
	return (rows[0]?.comments ?? []).map((c) => c.body ?? "");
}

/** Create an issue; returns its number, parsed from the tracker's issue-URL reply.
 * Speaks the REAL CLI's contract — `issue create --title <t> --body <b>`: positional
 * title/body is rejected by `gh` ("unknown arguments"), which a positional fake had masked. */
export function createIssue(repo: string, title: string, body = ""): number {
	const args = ["issue", "create", "--title", title, "--body", body];
	const out = execFileSync("gh", repo ? ["--repo", repo, ...args] : args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
	const m = out.match(/issues\/(\d+)\s*$/);
	if (!m) throw new Error(`cannot parse the issue number from the tracker reply: ${out.slice(0, 120)}`);
	return Number(m[1]);
}

export function issueTitle(repo: string, number: number): string {
	const rows = ghJson(repo, ["issue", "view", String(number), "--json", "title"]) as { title: string }[];
	return rows[0]?.title ?? "";
}

export function addLabel(repo: string, number: number, label: string): void {
	try {
		execFileSync("gh", repo ? ["--repo", repo, "issue", "edit", String(number), "--add-label", label] : ["issue", "edit", String(number), "--add-label", label], {
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		const msg = (e as { stderr?: NodeJS.ArrayBufferView }).stderr?.toString() ?? String(e);
		if (/not found|no matching/i.test(msg)) {
			// First use of a label in this repo: create it, then retry once.
			execFileSync("gh", ["label", "create", label, "--force"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
			execFileSync("gh", ["issue", "edit", String(number), "--add-label", label], {
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			return;
		}
		throw e;
	}
}

export function addComment(repo: string, number: number, body: string): void {
	execFileSync("gh", repo ? ["--repo", repo, "issue", "comment", String(number), "--body", body] : ["issue", "comment", String(number), "--body", body], {
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export function closeIssue(repo: string, number: number, comment: string): void {
	execFileSync("gh", repo ? ["--repo", repo, "issue", "close", String(number), "--comment", comment] : ["issue", "close", String(number), "--comment", comment], {
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}
