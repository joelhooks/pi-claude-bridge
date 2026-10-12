/** provider.cacheTtl maps to Claude Code's prompt-cache TTL environment. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cacheTtlEnv, parseCacheTtl } from "../src/cache-ttl.js";

describe("cache TTL setting", () => {
	it("defaults to 5 minutes and accepts only 1h besides", () => {
		assert.equal(parseCacheTtl(undefined), "5m");
		assert.equal(parseCacheTtl("1h"), "1h");
		assert.equal(parseCacheTtl("adaptive"), "5m");
		assert.equal(parseCacheTtl("2h"), "5m");
	});

	it("sets the child variable only for 1 hour", () => {
		assert.deepEqual(cacheTtlEnv("1h"), { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" });
		assert.deepEqual(cacheTtlEnv("5m"), {});
	});
});
