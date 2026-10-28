import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface RoleDef {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
}

function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadFromDir(dir: string): RoleDef[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const roles: RoleDef[] = [];
	for (const e of entries) {
		if (!e.name.endsWith(".md")) continue;
		const filePath = path.join(dir, e.name);
		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
		roles.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			filePath,
		});
	}
	return roles;
}

/**
 * Discover role definitions: bundled agents dir first, then the project `.pi/agents` dir,
 * where a same-named file OVERRIDES the bundled one (projects may tune role behaviour).
 */
export function discoverRoles(bundledDir: string, projectDir?: string): RoleDef[] {
	const map = new Map<string, RoleDef>();
	for (const r of loadFromDir(bundledDir)) map.set(r.name, r);
	if (projectDir) for (const r of loadFromDir(projectDir)) map.set(r.name, r);
	return [...map.values()];
}

export function findRole(bundledDir: string, name: string, projectDir?: string): RoleDef | undefined {
	return discoverRoles(bundledDir, projectDir).find((r) => r.name === name);
}
