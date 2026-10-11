/**
 * A Pi whose working directory was removed under it (a worker clone retired
 * while the process ran) cannot spawn Claude Code: the spawn fails with ENOENT,
 * and the Agent SDK reports that as a native binary that "failed to launch",
 * blaming musl versus glibc. That sent people after the wrong fault. The bridge
 * names the missing directory before it spawns anything.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "missing-cwd-agent-"));
const { __test } = await import("../src/index.js");

const gone = join(tmpdir(), "missing-cwd-does-not-exist", "clone");
const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-haiku-5-5", baseUrl: "claude-bridge",
	contextWindow: 1000000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context = { systemPrompt: "Summarize.", tools: [], messages: [{ role: "user", content: "hello", timestamp: 0 }] };

async function terminal(stream) {
	let last;
	for await (const event of stream) if (event.type === "done" || event.type === "error") last = event;
	return last;
}

describe("a working directory that no longer exists", () => {
	it("names the directory on the summary route", async () => {
		const end = await terminal(__test.isolatedStreamFn(model, context, { cwd: gone, cacheRetention: "none" }));
		assert.equal(end?.type, "error");
		assert.match(end.error.errorMessage, /working directory .*clone no longer exists/);
	});

	it("names the directory on a provider turn", async () => {
		const end = await terminal(__test.streamClaudeAgentSdk(model, context, { cwd: gone }));
		assert.equal(end?.type, "error");
		assert.match(end.error.errorMessage, /working directory .*clone no longer exists/);
	});
});
