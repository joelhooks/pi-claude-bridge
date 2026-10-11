/**
 * A model switch while a tool runs (`/model` mid-turn) hands the bridge a turn
 * that ends on a tool result for another provider's tool call. No query of ours
 * owns that result, and it used to be taken for an orphan: the turn ended with
 * an empty reply and the agent stopped mid-task. It has to continue instead: the
 * history, foreign tool call included, is rebuilt into a transcript that ends on
 * the tool_use/tool_result pair, and Claude Code resumes it as an interrupted
 * turn. A result for one of our own tool calls with no live query is still an
 * orphan and still ends the turn.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "provider-switch-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "provider-switch-claude-"));
const record = join(agentDir, "record.json");
process.env.FAKE_CLAUDE_RECORD = record;
const fakeClaude = join(agentDir, "fake-claude");
const script = fileURLToPath(new URL("./lib/fake-claude-resume.mjs", import.meta.url));
writeFileSync(fakeClaude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
chmodSync(fakeClaude, 0o755);

const { __test } = await import("../src/index.js");

const cwd = mkdtempSync(join(tmpdir(), "provider-switch-cwd-"));
const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-sonnet-5-5", baseUrl: "claude-bridge",
	contextWindow: 1000000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const tools = [{ name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function turnEndingOnToolResult({ provider, api, model: modelId, toolCallId }) {
	return {
		systemPrompt: "You are a coding agent.",
		tools,
		messages: [
			{ role: "user", content: "Run the tests and fix what fails.", timestamp: 1 },
			{ role: "assistant", provider, api, model: modelId, stopReason: "toolUse", usage, timestamp: 2,
				content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "npm test" } }] },
			{ role: "toolResult", toolCallId, toolName: "bash", isError: false, timestamp: 3,
				content: [{ type: "text", text: "1 failing" }] },
		],
	};
}

async function terminal(stream) {
	let last;
	for await (const event of stream) if (event.type === "done" || event.type === "error") last = event;
	return last;
}
const text = (end) => end.message.content.filter((c) => c.type === "text").map((c) => c.text).join("");

// Pi records the system prompt it assembled before each turn; the bridge
// refuses a turn whose prompt it cannot account for.
__test.setProviderSettings({ pathToClaudeCodeExecutable: fakeClaude });
__test.promptCaptures.record("You are a coding agent.", { contextFiles: [], skills: [] });

beforeEach(() => {
	__test.resetSharedSession();
	rmSync(record, { force: true });
});

describe("a turn that ends on a tool result after a mid-turn model switch", () => {
	it("continues the turn when the tool call came from another provider", async () => {
		const context = turnEndingOnToolResult({
			provider: "cliproxy-codex", api: "openai-responses", model: "gpt-6.1-sol",
			// Codex ids carry characters a tool_use id may not; the import sanitizes them.
			toolCallId: "call_6gZ164XDCWkzQJxR|fc_0cca0d8e4530",
		});
		const end = await terminal(__test.streamClaudeAgentSdk(model, context, { cwd }));
		assert.equal(end?.type, "done", `turn failed: ${end?.error?.errorMessage}`);
		assert.ok(existsSync(record), "Claude Code was never started: the turn ended as an orphan");
		const started = JSON.parse(readFileSync(record, "utf8"));
		assert.equal(started.resumeInterruptedTurn, "1", "resumed as an interrupted turn");
		assert.ok(started.argv.some((arg) => arg.startsWith("--resume")), "resumes the rebuilt transcript");
		assert.deepEqual(started.tail, { type: "user", content: ["tool_result"] }, "the transcript ends on the tool result");
		assert.match(text(end), /CONTINUED/, "the reply of the resumed turn reaches pi");
	});

	it("still ends the turn on an orphaned result for one of its own tool calls", async () => {
		const context = turnEndingOnToolResult({
			provider: "claude-bridge", api: "claude-bridge", model: "claude-sonnet-5-5", toolCallId: "toolu_orphan",
		});
		const end = await terminal(__test.streamClaudeAgentSdk(model, context, { cwd }));
		assert.equal(end?.type, "done");
		assert.equal(end.message.content.length, 0);
		assert.equal(existsSync(record), false, "no Claude Code process for an orphan");
	});
});
