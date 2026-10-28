import { execFileSync } from "node:child_process";

export interface Issue {
	number: number;
	title: string;
	labels: string[];
	body: string;
}

/**
 * Run a `gh ... --json` command and parse its NDJSON output
 * (gh --json prints one JSON object per line, not a JSON array).
 */
function ghNdJson(args: string[]): unknown[] {
	const out = execFileSync("gh", args, {
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 32 * 1024 * 1024,
	}).toString();
	return out
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

export function listOpenIssues(): Issue[] {
	const rows = ghNdJson(["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title,labels,body"]) as {
		number: number;
		title: string;
		labels: { name: string }[];
		body: string;
	}[];
	return rows.map((r) => ({ number: r.number, title: r.title, labels: (r.labels ?? []).map((l) => l.name), body: r.body ?? "" }));
}

export function listClosedIssueNumbers(): number[] {
	const rows = ghNdJson(["issue", "list", "--state", "closed", "--limit", "200", "--json", "number"]) as { number: number }[];
	return rows.map((r) => r.number);
}

export function issueTitle(number: number): string {
	const rows = ghNdJson(["issue", "view", String(number), "--json", "title"]) as { title: string }[];
	return rows[0]?.title ?? "";
}

export function addLabel(number: number, label: string): void {
	execFileSync("gh", ["issue", "edit", String(number), "--add-label", label], {
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export function closeIssue(number: number, comment: string): void {
	execFileSync("gh", ["issue", "close", String(number), "--comment", comment], {
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}
