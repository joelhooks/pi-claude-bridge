/**
 * A message the bridge has handed to Pi is Pi's. The bridge streams its own
 * turn object as the finished assistant message, and Pi keeps that object in
 * memory. When Pi compacted inside a tool loop, the bridge tore down the live
 * query, and the abort path wrote stopReason "aborted" into the toolUse message
 * Pi had already saved. The session file kept "toolUse"; Pi's in-memory copy
 * read "aborted", so later requests dropped the call and kept its result, and
 * a switch to an OpenAI-style provider failed with "No tool call found for
 * function call output" (2026-10-12).
 *
 * pi-flowing-view's boundary signal tears the live query down the same way after
 * each batch it commits, with midTurn true or false, so it is covered too: the
 * message keeps toolUse, and the next request still pairs the call with its result.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { ctx } from "../src/query-state.js";

const dir = mkdtempSync(join(tmpdir(), "delivered-msg-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "delivered-msg-claude-"));
const script = fileURLToPath(new URL("./lib/fake-claude-tool-wait.mjs", import.meta.url));
const fakeClaude = join(dir, "fake-claude");
writeFileSync(fakeClaude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
chmodSync(fakeClaude, 0o755);

const { default: activate, __test } = await import("../src/index.js");
__test.setProviderSettings({ pathToClaudeCodeExecutable: fakeClaude });
__test.promptCaptures.record("You are a coding agent.", { contextFiles: [], skills: [] });

const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-haiku-5-5", baseUrl: "claude-bridge",
	contextWindow: 1000000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const bash = { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
const context = { systemPrompt: "You are a coding agent.", tools: [bash], messages: [{ role: "user", content: "run true", timestamp: 1 }] };

afterEach(() => { __test.resetSharedSession(); __test.consumeMidTurnContinuation(); });

/** The extension against a stand-in Pi whose event bus the test drives. */
function mockPi() {
	const channels = new Map();
	const events = {
		on(channel, handler) { channels.set(channel, [...(channels.get(channel) ?? []), handler]); return () => {}; },
		emit(channel, data) { for (const handler of channels.get(channel) ?? []) handler(data); },
	};
	activate({ on: () => {}, registerProvider: () => {}, events });
	__test.setProviderSettings({ pathToClaudeCodeExecutable: fakeClaude }); // activation reloads provider settings
	return events;
}

/** One turn that ends on a tool call; returns the message Pi was handed. */
async function deliverToolUseTurn() {
	const cwd = mkdtempSync(join(tmpdir(), "delivered-msg-cwd-"));
	let delivered;
	for await (const event of __test.streamClaudeAgentSdk(model, context, { cwd })) {
		if (event.type === "error") throw new Error(event.error.errorMessage);
		if (event.type === "done") delivered = event.message;
	}
	assert.equal(delivered?.stopReason, "toolUse");
	return delivered;
}

/** Wait until the boundary handler's teardown has let the query go. */
async function queryReleased() {
	for (let i = 0; i < 200 && ctx().teardown; i++) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(ctx().teardown, null, "the boundary handler releases the live query");
	await new Promise((resolve) => setTimeout(resolve, 50)); // let the query's own completion run
}

/** The next request as an OpenAI Responses provider would receive it. */
function nextRequestPairs(delivered) {
	const call = delivered.content.find((block) => block.type === "toolCall");
	const result = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 };
	const target = { id: "gpt-test", provider: "openai", api: "openai-responses", reasoning: true, input: ["text"], compat: {} };
	const items = convertResponsesMessages(target, { systemPrompt: "x", messages: [...context.messages, delivered, result], tools: [] }, new Set(["openai"]), {});
	const calls = new Set(items.filter((item) => item.type === "function_call").map((item) => item.call_id));
	const outputs = items.filter((item) => item.type === "function_call_output").map((item) => item.call_id);
	return outputs.length === 1 && outputs.every((id) => calls.has(id));
}

describe("a message delivered to Pi", () => {
	it("keeps its toolUse stop when a compaction tears the query down", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "delivered-msg-cwd-"));
		let delivered;
		for await (const event of __test.streamClaudeAgentSdk(model, context, { cwd })) {
			if (event.type === "error") throw new Error(event.error.errorMessage);
			if (event.type === "done") delivered = event.message;
		}
		assert.equal(delivered?.stopReason, "toolUse", "the turn ends on the tool call");
		assert.equal(delivered.content.at(-1).type, "toolCall");

		// Pi compacts before delivering the tool result; the bridge releases the live query.
		const settled = await __test.tearDownLiveQueryForCompaction("session_compact:threshold:willRetry=false", 10_000);
		assert.equal(settled, true);

		assert.equal(delivered.stopReason, "toolUse", "Pi's copy must not turn into an aborted turn");
		assert.equal(delivered.errorMessage, undefined);
		assert.ok(nextRequestPairs(delivered), "the next request pairs the call with its result");
	});

	for (const midTurn of [true, false]) {
		it(`keeps its toolUse stop when a flowing-view boundary (midTurn ${midTurn}) tears the query down`, async () => {
			const events = mockPi();
			const delivered = await deliverToolUseTurn();

			events.emit("flowing-view:boundary", { v: 1, lineage: "l", hash: "h", reason: "batch", midTurn });
			await queryReleased();

			assert.equal(delivered.stopReason, "toolUse", "Pi's copy must not turn into an aborted turn");
			assert.equal(delivered.errorMessage, undefined);
			assert.ok(nextRequestPairs(delivered), "the next request pairs the call with its result");
		});
	}
});
