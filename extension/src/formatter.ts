import { execFile } from "node:child_process";

const SQ = String.fromCharCode(39); // single quote, spelled out to keep the source unambiguous

/** Single-quote a value for embedding in a shell command line (POSIX safe-quoting). */
export function shellQuote(s: string): string {
	if (/^[A-Za-z0-9._/-]*$/.test(s)) return SQ + s + SQ;
	return SQ + s.replaceAll(SQ, SQ + '"' + SQ + '"' + SQ) + SQ;
}

/**
 * Build the format command for a file, or null when formatting is disabled
 * (no format template) or the file's extension is not in formatExtensions.
 * Matching is plain suffix matching as pinned in the config schema:
 * list every distinct extension (".ts" does NOT cover ".tsx").
 */
export function formatTarget(
	cfg: { format: string | null; formatExtensions: string[] | null },
	filePath: string,
): string | null {
	if (!cfg.format) return null;
	if (cfg.formatExtensions && !cfg.formatExtensions.some((ext) => filePath.endsWith(ext))) return null;
	return cfg.format.replaceAll("{file}", shellQuote(filePath));
}

/** Run a shell command (e.g. a formatted `formatTarget`) with a hard timeout. */
export async function applyFormat(command: string, cwd: string): Promise<{ ok: boolean; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			"bash",
			["-c", command],
			{ cwd, timeout: 60_000, env: process.env, maxBuffer: 4 * 1024 * 1024 },
			(err, _stdout, stderr) => {
				resolve({ ok: !err, stderr: String(stderr ?? "") });
			},
		);
	});
}
