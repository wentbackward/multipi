import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { collectStream } from "../../extension/src/streamcap.ts";

/** Feed `chunks` through a readable and await full consumption (all data events delivered). */
async function feed(chunks: string[], cap: number, onOverflow: () => void): Promise<Buffer[]> {
	const p = new PassThrough();
	return await new Promise((resolve, reject) => {
		const collected = collectStream(p, cap, onOverflow);
		p.on("end", () => resolve(collected));
		p.on("error", reject);
		for (const c of chunks) p.write(c);
		p.end();
	});
}

test("collectStream: chunks within the cap are all captured, no overflow", () => {
	let overflows = 0;
	return feed(["aaa", "bbb", "c"], 10, () => {
		overflows += 1;
	}).then((chunks) => {
		assert.equal(Buffer.concat(chunks).toString(), "aaabbbc");
		assert.equal(overflows, 0);
	});
});

test("collectStream: a chunk landing exactly ON the cap is kept (inclusive bound)", () => {
	let overflows = 0;
	return feed(["aaaaa", "bbbbb"], 10, () => {
		overflows += 1;
	}).then((chunks) => {
		assert.equal(Buffer.concat(chunks).toString(), "aaaaabbbbb");
		assert.equal(overflows, 0);
	});
});

test("collectStream: stops capturing at the first chunk past the cap and overflows exactly once", () => {
	let overflows = 0;
	// 5 + 5 = cap (kept); +4 crosses it (discarded); another over-cap chunk must not
	// re-fire the overflow callback (the caller kills the child — repeated kills are noise).
	return feed(["aaaaa", "bbbbb", "cccc", "dddd"], 10, () => {
		overflows += 1;
	}).then((chunks) => {
		assert.equal(Buffer.concat(chunks).toString(), "aaaaabbbbb");
		assert.equal(overflows, 1);
	});
});

test("collectStream: a single chunk over the cap yields nothing, one overflow", () => {
	let overflows = 0;
	return feed(["abcdef"], 4, () => {
		overflows += 1;
	}).then((chunks) => {
		assert.equal(Buffer.concat(chunks).length, 0);
		assert.equal(overflows, 1);
	});
});

test("collectStream: an empty stream captures nothing and never overflows", () => {
	let overflows = 0;
	return feed([], 10, () => {
		overflows += 1;
	}).then((chunks) => {
		assert.equal(Buffer.concat(chunks).length, 0);
		assert.equal(overflows, 0);
	});
});

test("collectStream: omitting onOverflow is a compile error (the kill IS the overflow path)", () => {
	// Compile-time contract (follow-up 4 of #59): onOverflow is REQUIRED. An unbounded
	// silent truncation would hide a runaway child; the only sound overflow action is the
	// kill, and omitting it must fail the type check rather than surface at runtime.
	const p = new PassThrough();
	// @ts-expect-error — onOverflow is a required parameter, not an optional convenience
	void collectStream(p, 10);
	assert.ok(true);
});
