import { it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { QueryContext } from "../src/query-state.js";

const dir = mkdtempSync(join(tmpdir(), "multi-request-usage-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "multi-request-claude-"));
const script = fileURLToPath(new URL("./lib/fake-claude-usage.mjs", import.meta.url));
const executable = join(dir, "fake-claude");
writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
chmodSync(executable, 0o755);
const { __test } = await import("../src/index.js");
__test.setProviderSettings({ pathToClaudeCodeExecutable: executable });
__test.promptCaptures.record("You are a coding agent.", { contextFiles: [], skills: [] });
const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-haiku-5-5", baseUrl: "claude-bridge",
	contextWindow: 1000000, maxTokens: 64000,
	cost: { input: 1000000, output: 2000000, cacheRead: 3000000, cacheWrite: 4000000 } };
afterEach(() => { __test.resetSharedSession(); delete process.env.FAKE_USAGE_MODE; });

// The real SDK subprocess path above also emits a query-wide result. It must
// not be added to usage already collected from the individual API messages.
for (const mode of ["streaming", "nonstreaming"]) {
	it(`sums two requests once and retains the latest context size (${mode})`, async () => {
		process.env.FAKE_USAGE_MODE = mode;
		let done;
		for await (const event of __test.streamClaudeAgentSdk(model, {
			systemPrompt: "You are a coding agent.", tools: [], messages: [{ role: "user", content: "Answer", timestamp: 1 }],
		}, { cwd: mkdtempSync(join(tmpdir(), "multi-request-project-")) })) {
			if (event.type === "error") assert.fail(event.error.errorMessage);
			if (event.type === "done") done = event.message;
		}
		assert.ok(done);
		const { input, output, cacheRead, cacheWrite, totalTokens, cost } = done.usage;
		assert.deepEqual({ input, output, cacheRead, cacheWrite }, { input: 110, output: 220, cacheRead: 330, cacheWrite: 440 });
		assert.deepEqual(cost, { input: 110, output: 440, cacheRead: 990, cacheWrite: 1760, total: 3300 });
		assert.equal(totalTokens, 1000, "compaction sees only the latest request's prompt plus output, not cumulative billing");
	});
}

it("deduplicates assistant records, starts omitted counters at zero, and resets per Pi message", async () => {
	const c = new QueryContext();
	const reset = () => {
		c.currentPiStream = { push() {}, end() {} };
		c.resetTurnState(model);
	};
	const assistant = (id, usage) => ({ type: "assistant", message: { id, content: [], usage } });
	const consume = async (messages) => {
		async function* query() { yield* messages; }
		await __test.consumeQuery(query(), new Map(), model, () => false, c);
	};
	reset();
	await consume([
		assistant("first", { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }),
		assistant("first", { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }),
		assistant("second", { input_tokens: 5, output_tokens: 7 }),
		// A delayed duplicate of an older request must not replace latest context.
		assistant("first", { input_tokens: 10, output_tokens: 20 }),
	]);
	assert.equal(c.turnOutput.usage.input, 15);
	assert.equal(c.turnOutput.usage.output, 27);
	assert.equal(c.turnOutput.usage.cacheRead, 30);
	assert.equal(c.turnOutput.usage.cacheWrite, 40);
	assert.equal(c.turnOutput.usage.totalTokens, 12);
	const delivered = structuredClone(c.turnOutput.usage);
	const prior = c.turnOutput;
	reset();
	await consume([assistant("second", { input_tokens: 5, output_tokens: 7 })]);
	assert.equal(c.turnOutput.usage.input, 5);
	assert.equal(c.turnOutput.usage.cacheRead, 0);
	assert.equal(c.turnOutput.usage.totalTokens, 12);
	assert.deepEqual(prior.usage, delivered, "a subsequent Pi message cannot change the delivered usage");
});

