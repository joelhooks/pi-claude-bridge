import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderEnvResolver, parseProviderEnv } from "../src/provider-env.js";

const token = () => ["synthetic", "credential"].join("-");
const block = { ANTHROPIC_AUTH_TOKEN: { secret: "test_key" } };
const baseline = { PATH: "/bin", ANTHROPIC_API_KEY: "old-api", CLAUDE_CODE_OAUTH_TOKEN: "old-oauth", UNRELATED: "kept" };
const safety = { DISABLE_AUTO_COMPACT: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "0" };

function safeError(error, pattern) {
	assert.match(error.message, pattern);
	assert.equal(error.message.includes(token()), false);
	assert.equal(Object.hasOwn(error, "cause"), false);
	return true;
}

describe("provider.env parser", () => {
	it("accepts only absent, object, string, or exact secret reference", () => {
		assert.equal(parseProviderEnv(undefined), undefined);
		assert.equal(Object.keys(parseProviderEnv({})).length, 0);
		assert.equal(parseProviderEnv({ BASE: "", TOKEN: { secret: "test_key" } }).BASE, "");
		for (const invalid of [null, false, 123, [], "text", { TOKEN: null }, { TOKEN: 42 },
			{ TOKEN: { secret: "" } }, { TOKEN: { secret: token(), extra: true } },
			{ TOKEN: { secret: "--flag" } }, { TOKEN: { secret: "bad\nname" } },
			{ TOKEN: "bad\0value" }, { "bad\nkey": token() }]) {
			assert.throws(() => parseProviderEnv(invalid), (error) => safeError(error, /provider.env/));
		}
	});
	it("rejects knobs that bypass safety, diagnostics, or honest SDK identity", () => {
		for (const key of ["DISABLE_AUTO_COMPACT", "ENABLE_CLAUDEAI_MCP_SERVERS", "CLAUDE_CODE_ENTRYPOINT",
			"CLAUDE_CODE_RESUME_PROMPT", "ANTHROPIC_CUSTOM_HEADERS", "DEBUG_CLAUDE_AGENT_SDK", "NODE_OPTIONS"]) {
			assert.throws(() => parseProviderEnv({ [key]: "anything" }), /reserved/);
		}
	});
});

describe("provider.env leases and child environment", () => {
	it("overlays literals; bridge safety wins; removes only competing auth; parent unchanged", async () => {
		const parent = { ...baseline };
		const resolver = new ProviderEnvResolver(async () => ({ value: token(), expiresAt: Date.now() + 10000 }));
		const env = await resolver.resolve({ ...block, ANTHROPIC_BASE_URL: "https://proxy.example", ANTHROPIC_API_KEY: "ignored" }, parent, safety);
		assert.equal(env.ANTHROPIC_AUTH_TOKEN === token(), true);
		assert.equal(Object.hasOwn(env, "ANTHROPIC_API_KEY"), false);
		assert.equal(Object.hasOwn(env, "CLAUDE_CODE_OAUTH_TOKEN"), false);
		assert.equal(env.UNRELATED, "kept");
		assert.equal(env.DISABLE_AUTO_COMPACT, "1");
		assert.deepEqual(parent, baseline);
		assert.equal(env.ANTHROPIC_BASE_URL, "https://proxy.example");
	});
	it("preserves inherited auth if the block does not explicitly set AUTH_TOKEN", async () => {
		const resolver = new ProviderEnvResolver(() => { throw new Error("must not lease"); });
		assert.deepEqual(await resolver.resolve({}, baseline, safety), { ...baseline, ...safety });
		const env = await resolver.resolve({ UNRELATED: "override" }, baseline, safety);
		assert.equal(env.ANTHROPIC_API_KEY, baseline.ANTHROPIC_API_KEY);
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, baseline.CLAUDE_CODE_OAUTH_TOKEN);
	});
	it("uses returned expiry, refreshes at expiry, singleflights across keys and callers", async () => {
		let now = 1000, calls = 0;
		const resolver = new ProviderEnvResolver(async () => {
			calls++;
			return { value: token(), expiresAt: now + 10 };
		}, () => now, 0);
		await Promise.all(Array.from({ length: 12 }, () => resolver.resolve({ ...block, SECOND: { secret: "test_key" } }, {}, {})));
		assert.equal(calls, 1);
		now = 1009;
		await resolver.resolve(block, {}, {});
		assert.equal(calls, 1);
		now = 1010;
		await Promise.all([resolver.resolve(block, {}, {}), resolver.resolve(block, {}, {})]);
		assert.equal(calls, 2);
	});
	// 2026-10-07: owner passes at hh:00:01 and hh:30:01 met a lease taken exactly
	// one TTL earlier. The cache check passed, the spawn check failed ms later.
	it("re-leases instead of reusing a cached lease that is about to expire", async () => {
		const HOUR = 3_600_000;
		let now = 0, calls = 0, ticking = false;
		const clock = () => (ticking ? (now += 2) - 2 : now);
		const resolver = new ProviderEnvResolver(async () => {
			calls++;
			return { value: token(), expiresAt: now + HOUR };
		}, clock);
		await resolver.resolve(block, {}, {});
		assert.equal(calls, 1);
		now = HOUR - 1;
		ticking = true;
		const child = await resolver.resolve(block, {}, {});
		assert.equal(calls, 2, "a lease with 1 ms left must be replaced, not reused");
		resolver.assertFresh(child);
		ticking = false;
		now = HOUR + 30 * 60_000;
		await resolver.resolve(block, {}, {});
		assert.equal(calls, 2, "a lease with ample time left is still reused");
	});
	it("rechecks validity at the actual query boundary after transcript preparation", async () => {
		let now = 100;
		const resolver = new ProviderEnvResolver(async () => ({ value: token(), expiresAt: 200 }), () => now);
		const child = await resolver.resolve(block, {}, {});
		resolver.assertFresh(child);
		now = 200;
		assert.throws(() => resolver.assertFresh(child), /expired before spawn/);
		resolver.assertFresh({ BASELINE: "unchanged" });
	});
	it("separates names and resolver instances, never reuses a changed secret reference", async () => {
		const names = [];
		const lease = async (name) => { names.push(name); return { value: token(), expiresAt: Date.now() + 10000 }; };
		const resolver = new ProviderEnvResolver(lease);
		await resolver.resolve(block, {}, {});
		await resolver.resolve({ ANTHROPIC_AUTH_TOKEN: { secret: "other_key" } }, {}, {});
		await new ProviderEnvResolver(lease).resolve(block, {}, {});
		assert.deepEqual(names, ["test_key", "other_key", "test_key"]);
	});
	it("redacts client failures and retries instead of stale login fallback", async () => {
		let calls = 0;
		const resolver = new ProviderEnvResolver(async () => {
			calls++;
			throw new Error(token());
		});
		for (let i = 0; i < 2; i++) await assert.rejects(resolver.resolve(block, baseline, safety), (error) => safeError(error, /lease failed for test_key/));
		assert.equal(calls, 2);
	});
	it("rejects empty, invalid, expired and cross-key stale leases", async () => {
		for (const lease of [{ value: "", expiresAt: 200 }, { value: token(), expiresAt: 100 },
			{ value: token(), expiresAt: NaN }, { value: "nul\0value", expiresAt: 200 }]) {
			await assert.rejects(new ProviderEnvResolver(async () => lease, () => 100).resolve(block, baseline, safety), /lease failed/);
		}
		let now = 100;
		const resolver = new ProviderEnvResolver(async (name) => {
			if (name === "slow") { await new Promise((resolve) => setImmediate(resolve)); now = 201; }
			return { value: token(), expiresAt: name === "slow" ? 500 : 200 };
		}, () => now);
		await assert.rejects(resolver.resolve({ A: { secret: "fast" }, B: { secret: "slow" } }, {}, {}), /expired before spawn/);
		await assert.rejects(resolver.resolve({ ANTHROPIC_AUTH_TOKEN: "" }, baseline, safety), /must not be empty/);
	});
	it("detaches cancellation immediately without poisoning another waiter", async () => {
		let finish, calls = 0;
		const resolver = new ProviderEnvResolver(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
		const abort = new AbortController();
		const cancelled = resolver.resolve(block, {}, {}, abort.signal);
		const sibling = resolver.resolve(block, {}, {});
		await new Promise((resolve) => setImmediate(resolve));
		abort.abort();
		await assert.rejects(cancelled, /aborted/);
		finish({ value: token(), expiresAt: Date.now() + 10000 });
		assert.equal((await sibling).ANTHROPIC_AUTH_TOKEN === token(), true);
		assert.equal(calls, 1);
		await assert.rejects(resolver.resolve(block, {}, {}, abort.signal), /aborted/);
		assert.equal(calls, 1);
	});
});
