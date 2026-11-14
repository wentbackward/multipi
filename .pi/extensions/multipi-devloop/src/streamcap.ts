import type { Readable } from "node:stream";

/**
 * execFile-style per-stream maxBuffer collection, shared by every spawned loop script so the
 * caps stay honest in one place. Captures chunks while the running total stays <= `cap`,
 * discards everything past it, and invokes `onOverflow` EXACTLY ONCE on the first over-cap
 * chunk (callers pass the child kill — repeating it per chunk would be noise). `onOverflow`
 * is required: the kill IS the overflow path, and an omitted callback would be a silent
 * unbounded truncation (follow-up 4 of #59).
 *
 * Returns the live chunk array; the stream's data events all precede the child's "close",
 * so callers `Buffer.concat` the array there.
 */
export function collectStream(stream: Readable, cap: number, onOverflow: () => void): Buffer[] {
	const chunks: Buffer[] = [];
	let bytes = 0;
	let overflowed = false;
	stream.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		if (bytes <= cap) {
			chunks.push(chunk);
		} else if (!overflowed) {
			overflowed = true;
			onOverflow();
		}
	});
	return chunks;
}
