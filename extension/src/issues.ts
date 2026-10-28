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

function ghJson(args: string[]): unknown[] {
	const out = execFileSync("gh", args, {
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 32 * 1024 * 1024,
	}).toString();
	return parseGhOutput(out);
}

export function listOpenIssues(): Issue[] {
	const rows = ghJson(["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title,labels,body"]) as {
		number: number;
		title: string;
		labels: { name: string }[];
		body: string;
	}[];
	return rows.map((r) => ({ number: r.number, title: r.title, labels: (r.labels ?? []).map((l) => l.name), body: r.body ?? "" }));
}

export function listClosedIssueNumbers(): number[] {
	const rows = ghJson(["issue", "list", "--state", "closed", "--limit", "200", "--json", "number"]) as { number: number }[];
	return rows.map((r) => r.number);
}

/** Latest issue comment (review findings ride here), or "". Truncated to maxChars. */
export function latestComment(number: number, maxChars = 6000): string {
	let rows: { comments?: { body: string }[] }[];
	try {
		rows = ghJson(["issue", "view", String(number), "--json", "title,comments"]) as { comments?: { body: string }[] }[];
	} catch {
		return "";
	}
	const comments = rows[0]?.comments ?? [];
	if (!comments.length) return "";
	return (comments[comments.length - 1].body ?? "").slice(0, maxChars);
}

export function issueTitle(number: number): string {
	const rows = ghJson(["issue", "view", String(number), "--json", "title"]) as { title: string }[];
	return rows[0]?.title ?? "";
}

export function addLabel(number: number, label: string): void {
	try {
		execFileSync("gh", ["issue", "edit", String(number), "--add-label", label], {
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

export function closeIssue(number: number, comment: string): void {
	execFileSync("gh", ["issue", "close", String(number), "--comment", comment], {
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}
