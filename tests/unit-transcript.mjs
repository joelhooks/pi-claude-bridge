import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { __test } from "../src/index.js";
import { PromptCaptures, projectPromptCapture } from "../src/prompt-capture.js";

const user = { role: "user", content: "Hello", timestamp: 0 };
const read = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };
const tool = (name) => ({ ...read, name });
const system = (fields) => ({ role: "system", content: "", timestamp: 0, ...fields });

describe("Pi 0.86 provider transcript boundary", () => {
	afterEach(() => __test.resetSharedSession());

	it("restores policy and callable tools from Pi's actual normalized input", () => {
		const legacy = { systemPrompt: "POLICY", tools: [read], messages: [user] };
		const incoming = normalizeContext(legacy);
		assert.deepEqual(Object.keys(incoming), ["messages"]);
		const context = __test.toBridgeContext(incoming);
		assert.deepEqual(context.messages, [user]);
		assert.equal(context.systemPrompt, "POLICY");
		assert.deepEqual(context.tools, [read]);
		assert.equal(__test.resolveMcpTools(context).mcpTools.length, 1);
		const captures = new PromptCaptures();
		captures.record("POLICY", { contextFiles: [{ path: "AGENTS.md", content: "keep policy" }], skills: [] });
		assert.match(projectPromptCapture(captures.resolveOrDerive(context.systemPrompt), { skillReadTool: "mcp" }), /keep policy/);
	});

	it("does not treat a fresh system head as conversation to resume", () => {
		const cwd = mkdtempSync(join(tmpdir(), "bridge-transcript-"));
		try {
			const incoming = normalizeContext({ systemPrompt: "POLICY", tools: [read], messages: [user] });
			assert.equal(__test.syncSharedSession(incoming.messages, cwd).sessionId, null);
			assert.equal(__test.getSharedSession(), null);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("replays section changes in Pi's order, not a hard-coded bridge order", () => {
		const messages = [
			system({ sections: { preamble: "P", cwd: "C", extension: "X" } }),
			system({ sections: { skills: "S" } }),
			system({ sections: { preamble: "new P", extension: null } }),
			user,
		];
		const actual = __test.toBridgeContext({ messages });
		assert.equal(actual.systemPrompt, getCurrentSystemPrompt(messages));
		assert.equal(actual.systemPrompt, "new P\n\nC\n\nS");
		assert.deepEqual(actual.messages, [user]);
	});

	it("applies tool removals, redefinitions, and an explicitly empty loadout", () => {
		const messages = [system({ toolsAdded: [read, tool("write")] }), user,
			system({ toolsRemoved: [{ name: "read" }], toolsAdded: [{ ...tool("write"), description: "new" }] })];
		assert.deepEqual(__test.toBridgeContext({ messages }).tools, getCurrentTools(messages));
		messages.push(system({ toolsRemoved: [{ name: "write" }] }));
		assert.deepEqual(__test.toBridgeContext({ messages, tools: [read] }).tools, []);
	});

	it("leaves an explicit Context alone when there are no system messages", () => {
		const input = { systemPrompt: "legacy", tools: [], messages: [user] };
		assert.equal(__test.toBridgeContext(input), input);
	});

	it("routes one-off summaries without hijacking ordinary or tool-bearing requests", () => {
		const summary = __test.toBridgeContext(normalizeContext({ systemPrompt: "SUMMARIZE", messages: [user] }));
		assert.equal(__test.isOneOffSummary(summary, { cacheRetention: "none" }), true);
		assert.equal(__test.isOneOffSummary(summary, {}), false);
		assert.equal(__test.isOneOffSummary({ ...summary, tools: [read] }, { cacheRetention: "none" }), false);
		assert.equal(__test.isOneOffSummary({ ...summary, messages: [user, user] }, { cacheRetention: "none" }), false);
	});

	it("normalizes isolated summaries before validating their single user prompt", () => {
		const input = normalizeContext({ systemPrompt: "SUMMARIZE", messages: [user] });
		const context = __test.toBridgeContext(input);
		assert.equal(__test.extractIsolatedSummaryPrompt(context.messages), "Hello");
		assert.equal(context.systemPrompt, "SUMMARIZE");
	});
});
