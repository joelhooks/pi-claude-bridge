/**
 * A Pi whose working directory was removed under it (a worker clone retired
 * while the process ran) cannot spawn Claude Code there: the spawn fails with
 * ENOENT, and the Agent SDK reports that as a native binary that "failed to
 * launch", blaming musl versus glibc. That sent people after the wrong fault,
 * and the compaction it broke left the session stuck past its limit.
 *
 * A summary reads no files, so it runs from home instead. A provider turn needs
 * the directory for its tools, so it fails and names the directory.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The user-level bridge config points at a fake Claude Code; the missing
// project directory has none, so a summary that runs proves the fallback.
const agentDir = mkdtempSync(join(tmpdir(), "missing-cwd-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const fakeClaude = join(agentDir, "fake-claude");
const script = fileURLToPath(new URL("./lib/fake-claude-summary.mjs", import.meta.url));
writeFileSync(fakeClaude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
chmodSync(fakeClaude, 0o755);
writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: fakeClaude } }));

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
	it("still summarizes, from home", async () => {
		const end = await terminal(__test.isolatedStreamFn(model, context, { cwd: gone, cacheRetention: "none" }));
		assert.equal(end?.type, "done", `summary failed: ${end?.error?.errorMessage}`);
		assert.equal(end.message.content.map((c) => c.text).join(""), "FAKE SUMMARY");
	});

	it("names the directory on a provider turn", async () => {
		const end = await terminal(__test.streamClaudeAgentSdk(model, context, { cwd: gone }));
		assert.equal(end?.type, "error");
		assert.match(end.error.errorMessage, /working directory .*clone no longer exists/);
	});
});
