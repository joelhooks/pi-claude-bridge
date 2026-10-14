/**
 * A steer Claude Code does not drain mid-turn becomes a turn of its own.
 *
 * The bridge writes a steer to Claude Code's stdin just ahead of the tool
 * result, and Claude Code usually folds it into the turn at the next model
 * call. Sometimes it misses: the turn ends with text and a result, then Claude
 * Code runs the queued steer as a new turn. The bridge closed stdin at that
 * first result, so every MCP tool call in the new turn failed at once ("The
 * tool call was interrupted before a result was received"), because tool
 * answers travel back over stdin. Any steer sent into that turn was lost
 * silently (five calls in a row in one session).
 *
 * After a result that follows a steer, stdin stays open for a short grace, and
 * stays open through a turn Claude Code starts from the queue.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "undrained-steer-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "undrained-steer-claude-"));
const script = fileURLToPath(new URL("./lib/fake-claude-undrained-steer.mjs", import.meta.url));
const fakeClaude = join(dir, "fake-claude");
writeFileSync(fakeClaude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
chmodSync(fakeClaude, 0o755);

const { __test } = await import("../src/index.js");
__test.setProviderSettings({ pathToClaudeCodeExecutable: fakeClaude });
__test.promptCaptures.record("You are a coding agent.", { contextFiles: [], skills: [] });

const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-haiku-5-5", baseUrl: "claude-bridge",
	contextWindow: 1000000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const bash = { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };

afterEach(() => { __test.resetSharedSession(); delete process.env.FAKE_STEER_MODE; });

async function run(context, cwd) {
	let done;
	for await (const event of __test.streamClaudeAgentSdk(model, context, { cwd })) {
		if (event.type === "error") throw new Error(event.error.errorMessage);
		if (event.type === "done") done = event.message;
	}
	return done;
}

/** A tool call, then its result with a steer behind it. Returns the second turn's text and duration. */
async function steeredToolTurn() {
	const cwd = mkdtempSync(join(tmpdir(), "undrained-steer-cwd-"));
	const messages = [{ role: "user", content: "run true", timestamp: 1 }];
	const first = await run({ systemPrompt: "You are a coding agent.", tools: [bash], messages }, cwd);
	assert.equal(first?.stopReason, "toolUse");
	const call = first.content.find((block) => block.type === "toolCall");
	const started = Date.now();
	const second = await run({ systemPrompt: "You are a coding agent.", tools: [bash], messages: [
		...messages, first,
		{ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
		{ role: "user", content: "STEER: one more thing", timestamp: 4 },
	] }, cwd);
	const text = second.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	return { text, ms: Date.now() - started };
}

describe("a steer Claude Code does not drain", () => {
	it("keeps stdin open for the turn Claude Code runs from it", async () => {
		const { text } = await steeredToolTurn();
		assert.match(text, /steer turn: STDIN_/, "the queued steer's turn reaches Pi");
		assert.match(text, /STDIN_OPEN/, "its tool answers would have a way back to Claude Code");
	});

	it("still ends promptly when Claude Code drained the steer", async () => {
		process.env.FAKE_STEER_MODE = "drained";
		const { text, ms } = await steeredToolTurn();
		assert.match(text, /steer seen/);
		assert.ok(ms < 3000, `turn ended in ${ms} ms`);
	});
});
