/**
 * Pi awaits the bridge's session_compact handler inside its compaction. The
 * handler tears down the live Claude Code query, and that wait had no bound: a
 * query that never settled left the session "compacting" with no output, Esc
 * could not clear it, and only a model switch did (2026-10-11). The teardown
 * now gives up after a bound and leaves no live-query state behind.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ctx } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

describe("compaction teardown of a live query", () => {
	afterEach(() => {
		const c = ctx();
		c.teardown = null;
		c.activeQuery = null;
		__test.resetSharedSession();
	});

	it("returns when the query never settles, and leaves no live query behind", async () => {
		const c = ctx();
		c.activeQuery = {};
		c.teardown = () => new Promise(() => {});
		__test.setSharedSession({ sessionId: "11111111-aaaa-4aaa-8aaa-111111111111", cursor: 4, cwd: "/x" });
		const started = Date.now();
		const settled = await Promise.race([
			__test.tearDownLiveQueryForCompaction("test", 50),
			new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000)),
		]);
		assert.equal(settled, false, "the wait must be bounded");
		assert.ok(Date.now() - started < 1_000);
		assert.equal(c.activeQuery, null, "a leftover query would make the next call look nested");
		assert.equal(c.teardown, null);
		assert.equal(__test.getSharedSession().needsRebuild, true);
		assert.equal(__test.getSharedSession().forceRotate, true, "the abandoned process may still write its transcript");
	});

	it("reports a query that settles in time", async () => {
		const c = ctx();
		c.teardown = () => { c.teardown = null; return Promise.resolve(); };
		assert.equal(await __test.tearDownLiveQueryForCompaction("test", 1_000), true);
	});
});
