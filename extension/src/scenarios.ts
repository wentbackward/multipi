// Pure scenario-store module (dark-factory spec §2, §5.3/§5.5).
// Dependency rule: node builtins only — no @earendil-works/* imports — so doctor, the stage
// script (via node -e) and the startability rule all share one notion of valid/sealed/satisfied.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** One scanned scenario file (per-file result; names never leave doctor). */
export interface ScenarioFile {
	/** Store-relative path, "/"-separated. */
	file: string;
	id?: string;
	title?: string;
	/** Present only when the `required:` line parsed to true|false (missing is invalid, not default-false). */
	required?: boolean;
	/** Parsed lists, present only when the field is valid. */
	spec?: string[];
	tags?: string[];
	valid: boolean;
	reason?: string;
}

/** Counts only — the stage prints counts; only doctor names invalid files. */
export interface StoreCounts {
	total: number;
	required: number;
	invalid: number;
}

/** Judge verdict (spec §5.2: the judge's last line starting with '{'). */
export interface Verdict {
	id: string;
	/** Satisfaction 0..1. */
	satisfied: number;
	required: boolean;
	evidence: string;
	missing: string;
}

export type VerdictResult = { ok: true; verdict: Verdict } | { ok: false; reason: string };

/**
 * Scan the store: `*.md` at any depth, nothing under `.git`. A missing store dir scans to []
 * (a missing store is a note, not a failure — the doctor decides what to print). Files are
 * processed in path-sorted order, which makes the duplicate-id winner deterministic.
 */
export function scanStore(storeDir: string): ScenarioFile[] {
	if (!existsSync(storeDir)) return [];
	const mdFiles: string[] = [];
	const walk = (dir: string, rel: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const r = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) walk(path.join(dir, entry.name), r);
			else if (entry.isFile() && entry.name.endsWith(".md")) mdFiles.push(r);
		}
	};
	walk(storeDir, "");
	mdFiles.sort();

	const files = mdFiles.map((rel) => validateFile(rel, readFileSync(path.join(storeDir, rel), "utf8")));
	const seen = new Set<string>();
	for (const f of files) {
		if (!f.id || seen.has(f.id)) {
			if (f.id && f.valid) {
				f.valid = false;
				f.reason = "duplicate id";
			}
			continue;
		}
		seen.add(f.id);
	}
	return files;
}

/** total / required (valid files only) / invalid counts. */
export function storeCounts(files: ScenarioFile[]): StoreCounts {
	return {
		total: files.length,
		required: files.filter((f) => f.valid && f.required).length,
		invalid: files.filter((f) => !f.valid).length,
	};
}

/**
 * Pinned sealed-share rule (spec §5.5): `int(sha256(id) first 10 hex chars, 16) mod 1000 <
 * sealedShare * 1000`. The digest is pinned so the seal cannot drift across platforms or
 * versions; the choice depends only on the id.
 */
export function isSealed(id: string, sealedShare: number): boolean {
	const hex = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 10);
	return parseInt(hex, 16) % 1000 < sealedShare * 1000;
}

/**
 * Parse a judge transcript into a verdict: the LAST non-empty line must start with '{' and
 * carry id (matching expectedId), satisfied in 0..1, required boolean, evidence and missing
 * strings. Anything else is an error — an invalid verdict counts as score 0 upstream.
 */
export function parseVerdict(output: string, expectedId: string): VerdictResult {
	const lines = output.split(/\r?\n/).map((l) => l.trim());
	let lastIdx = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i] !== "") {
			lastIdx = i;
			break;
		}
	}
	if (lastIdx === -1) return { ok: false, reason: "no verdict line (transcript is empty)" };
	const last = lines[lastIdx];
	if (!last.startsWith("{")) {
		const jsonElsewhere = lines.some((l, i) => i !== lastIdx && l.startsWith("{") && isJsonObject(l));
		return {
			ok: false,
			reason: jsonElsewhere ? "verdict JSON is not on the last line" : "last line is not a JSON verdict",
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(last);
	} catch {
		return { ok: false, reason: "verdict line is not valid JSON" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, reason: "verdict is not a JSON object" };
	}
	const o = parsed as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id === "") return { ok: false, reason: "verdict is missing id" };
	if (o.id !== expectedId) return { ok: false, reason: `verdict id mismatch (expected ${expectedId})` };
	if (typeof o.satisfied !== "number" || !Number.isFinite(o.satisfied)) {
		return { ok: false, reason: "verdict satisfied is not a number" };
	}
	if (o.satisfied < 0 || o.satisfied > 1) return { ok: false, reason: "verdict satisfied out of range 0..1" };
	if (typeof o.required !== "boolean") return { ok: false, reason: "verdict required is not a boolean" };
	if (typeof o.evidence !== "string") return { ok: false, reason: "verdict evidence is not a string" };
	if (typeof o.missing !== "string") return { ok: false, reason: "verdict missing is not a string" };
	return { ok: true, verdict: { id: o.id, satisfied: o.satisfied, required: o.required, evidence: o.evidence, missing: o.missing } };
}

function isJsonObject(line: string): boolean {
	try {
		const v = JSON.parse(line);
		return typeof v === "object" && v !== null && !Array.isArray(v);
	} catch {
		return false;
	}
}

// --- frontmatter (spec §2 file format) ---

interface Frontmatter {
	fields: Map<string, string>;
	body: string;
	reason?: string; // malformed-frontmatter detail
}

/** Parse the `---`-delimited frontmatter; first/only key per line, unknown keys allowed. */
function parseFrontmatter(content: string): Frontmatter {
	const lines = content.split(/\r?\n/);
	const fields = new Map<string, string>();
	if (lines[0]?.trim() !== "---") return { fields, body: "", reason: "missing opening ---" };
	const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
	if (close === -1) return { fields, body: "", reason: "missing closing ---" };
	for (let i = 1; i < close; i++) {
		const line = lines[i];
		if (line.trim() === "") continue;
		const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
		if (!m) return { fields, body: "", reason: `unparseable frontmatter line ${i + 1}` };
		if (fields.has(m[1])) return { fields, body: "", reason: `duplicate frontmatter key ${m[1]}` };
		fields.set(m[1], m[2].trim());
	}
	return { fields, body: lines.slice(close + 1).join("\n").trim() };
}

/**
 * Pinned id charset (review of #13): judge transcript dirs, env seams and result lines are all
 * built from the id, so ids stay inside one safe charset. Anything else (slashes, spaces, dots
 * at the edges of a path component) is rejected here so NEITHER the doctor NOR the stage can
 * turn a store file into a path escape (reproduced vector: `id: ../../xwalk/outside/evil`).
 */
export const SCENARIO_ID_RE = /^[A-Za-z0-9._-]+$/;

function validateFile(file: string, content: string): ScenarioFile {
	const fm = parseFrontmatter(content);
	if (fm.reason) return { file, valid: false, reason: `malformed frontmatter: ${fm.reason}` };

	const fail = (reason: string, extra: Partial<ScenarioFile> = {}): ScenarioFile => ({ file, valid: false, reason, ...extra });

	const id = fm.fields.get("id");
	if (id === undefined || id === "") return fail("missing id");
	if (!SCENARIO_ID_RE.test(id)) return fail(`invalid id: ${id} (ids must match [A-Za-z0-9._-]+)`, { id });
	const title = fm.fields.get("title");
	if (title === undefined || title === "") return fail("missing title", { id });

	const requiredRaw = fm.fields.get("required");
	if (requiredRaw === undefined) return fail("missing required (not default-false)", { id, title });
	let required: boolean;
	if (requiredRaw === "true") required = true;
	else if (requiredRaw === "false") required = false;
	else return fail(`invalid required: ${requiredRaw}`, { id, title });

	const result: ScenarioFile = { file, id, title, required, valid: true };
	for (const field of ["spec", "tags"] as const) {
		const raw = fm.fields.get(field);
		if (raw === undefined) continue;
		const items = parseList(raw);
		if (items === undefined) return fail(`invalid ${field}: expected [a, b] form`, { id, title });
		result[field] = items;
	}
	if (fm.body === "") return fail("empty body", { id, title, required });
	return result;
}

/** Accept only the literal `[a, b]` list form (comma-separated, whitespace tolerant, no nesting). */
function parseList(raw: string): string[] | undefined {
	const m = /^\[([^\[\]]*)\]$/.exec(raw);
	if (!m) return undefined;
	const items = m[1].split(",").map((s) => s.trim()).filter((s) => s !== "");
	return items.length === 0 ? undefined : items;
}
