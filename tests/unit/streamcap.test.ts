import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { collectStream } from "../../extension/src/streamcap.ts";

/** Feed `chunks` through a readable and await full consumption (all data events delivered). */
async function feed(chunks: string[]): Promise<Buffer[]> {
	const p = new PassThrough();
	return await new Promise((resolve, reject) => {
		const collected = collectStream(p, CAP, () => {
			overflows += 1;
		});
		p.on("end", () => resolve(collected));
		p.on("error", reject);
		for (const c of chunks) p.write(c);
		p.end();
	});
}

let CAP = 10;
let overflows = 0;

test("collectStream: chunks within the cap are all captured, no overflow", () => {
	CAP = 10;
	overflows = 0;
	return feed(["aaa", "bbb", "c"]).then((chunks) => {
		assert.equal(Buffer.concat(chunks).toString(), "aaabbbc");
		assert.equal(overflows, 0);
	});
});

test("collectStream: a chunk landing exactly ON the cap is kept (inclusive bound)", () => {
	CAP = 10;
	overflows = 0;
	return feed(["aaaaa", "bbbbb"]).then((chunks) => {
		assert.equal(Buffer.concat(chunks).toString(), "aaaaabbbbb");
		assert.equal(overflows, 0);
	});
});

test("collectStream: stops capturing at the first chunk past the cap and overflows exactly once", () => {
	CAP = 10;
	overflows = 0;
	// 5 + 5 = cap (kept); +4 crosses it (discarded); another over-cap chunk must not
	// re-fire the overflow callback (the caller kills the child — repeated kills are noise).
	return feed(["aaaaa", "bbbbb", "cccc", "dddd"]).then((chunks) => {
		assert.equal(Buffer.concat(chunks).toString(), "aaaaabbbbb");
		assert.equal(overflows, 1);
	});
});

test("collectStream: a single chunk over the cap yields nothing, one overflow", () => {
	CAP = 4;
	overflows = 0;
	return feed(["abcdef"]).then((chunks) => {
		assert.equal(Buffer.concat(chunks).length, 0);
		assert.equal(overflows, 1);
	});
});

test("collectStream: an empty stream captures nothing and never overflows", () => {
	CAP = 10;
	overflows = 0;
	return feed([]).then((chunks) => {
		assert.equal(Buffer.concat(chunks).length, 0);
		assert.equal(overflows, 0);
	});
});
