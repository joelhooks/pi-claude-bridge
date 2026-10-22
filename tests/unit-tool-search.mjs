/**
 * provider.toolSearch reaches Claude Code. Claude Code defers MCP tools only
 * when its own ToolSearch tool is present, and before 2.1.304 only when
 * ENABLE_TOOL_SEARCH is set behind a gateway, so the setting must keep
 * ToolSearch in --tools and set the env var. Tools named in alwaysLoad must be
 * marked on the MCP wire, where Claude Code reads `anthropic/alwaysLoad`.
 *
 * The fake Claude records its --tools argument and env, then lists the bridge's
 * MCP tools the way Claude Code does: an mcp_message control request.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolSearchPlan } from "../src/tool-search.js";

const agentDir = mkdtempSync(join(tmpdir(), "tool-search-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tool-search-claude-"));
delete process.env.ENABLE_TOOL_SEARCH;
const record = join(agentDir, "record.json");
const fakeClaude = join(agentDir, "fake-claude");
const script = join(agentDir, "fake.mjs");
writeFileSync(script, `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const argv = process.argv.slice(2);
const toolsAt = argv.indexOf("--tools");
const seen = { tools: toolsAt === -1 ? null : argv[toolsAt + 1], enableToolSearch: process.env.ENABLE_TOOL_SEARCH ?? null, listed: null };
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const session_id = "00000000-0000-4000-8000-000000000005";
const waiting = new Map();
let nextId = 0;
const mcp = (message) => new Promise((resolve) => {
	const request_id = "mcp-" + ++nextId;
	waiting.set(request_id, resolve);
	send({ type: "control_request", request_id, request: { subtype: "mcp_message", server_name: "custom-tools", message } });
});
async function answer() {
	await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
	const listed = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
	seen.listed = listed.mcp_response.result.tools.map((t) => ({ name: t.name, alwaysLoad: t._meta?.["anthropic/alwaysLoad"] ?? null }));
	writeFileSync(${JSON.stringify(record)}, JSON.stringify(seen));
	send({ type: "system", subtype: "init", session_id, model: "fake", tools: [], mcp_servers: [], cwd: process.cwd(), permissionMode: "default", apiKeySource: "none", slash_commands: [], output_style: "default" });
	send({ type: "assistant", session_id, parent_tool_use_id: null, message: { id: "m", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
	send({ type: "result", subtype: "success", is_error: false, session_id, result: "OK", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, permission_denials: [] });
	process.exit(0);
}
let answered = false;
for await (const line of createInterface({ input: process.stdin })) {
	let m; try { m = JSON.parse(line); } catch { continue; }
	if (m.type === "control_request") { send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } }); continue; }
	if (m.type === "control_response") { waiting.get(m.response.request_id)?.(m.response.response); continue; }
	if (m.type !== "user" || answered) continue;
	answered = true;
	void answer();
}
`);
writeFileSync(fakeClaude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
chmodSync(fakeClaude, 0o755);

const { __test } = await import("../src/index.js");
__test.setProviderSettings({ pathToClaudeCodeExecutable: fakeClaude });
__test.promptCaptures.record("You are a coding agent.", { contextFiles: [], skills: [] });

const cwd = mkdtempSync(join(tmpdir(), "tool-search-cwd-"));
const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-haiku-5-5", baseUrl: "claude-bridge",
	contextWindow: 1000000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
const tools = ["read", "warehouse_stock_lookup"].map((name) => ({ name, description: `${name} tool`, parameters: schema }));
const context = { systemPrompt: "You are a coding agent.", tools, messages: [{ role: "user", content: "hello", timestamp: 1 }] };

const projectConfig = join(cwd, ".pi", "claude-bridge.json");
function writeSetting(setting) {
	mkdirSync(join(projectConfig, ".."), { recursive: true });
	if (setting === undefined) rmSync(projectConfig, { force: true });
	else writeFileSync(projectConfig, JSON.stringify({ provider: { toolSearch: setting } }));
}
async function childSaw() {
	rmSync(record, { force: true });
	for await (const event of __test.streamClaudeAgentSdk(model, context, { cwd })) if (event.type === "error") throw new Error(event.error.errorMessage);
	return JSON.parse(readFileSync(record, "utf8"));
}

beforeEach(() => { __test.resetSharedSession(); writeSetting(undefined); });

describe("tool search wiring", () => {
	it("keeps every tool upfront by default: no built-ins, no tool search", async () => {
		const seen = await childSaw();
		assert.equal(seen.tools, "");
		assert.equal(seen.enableToolSearch, null);
		assert.deepEqual(seen.listed.map((t) => t.alwaysLoad), [null, null]);
	});

	it("keeps ToolSearch and turns tool search on when the project asks for it", async () => {
		writeSetting(true);
		const seen = await childSaw();
		assert.equal(seen.tools, "ToolSearch");
		assert.equal(seen.enableToolSearch, "true");
		assert.deepEqual(seen.listed.map((t) => t.alwaysLoad), [null, null]);
	});

	it("marks the tools named in alwaysLoad on the MCP wire", async () => {
		writeSetting({ alwaysLoad: ["read"] });
		const seen = await childSaw();
		assert.equal(seen.tools, "ToolSearch");
		assert.deepEqual(seen.listed, [
			{ name: "read", alwaysLoad: true },
			{ name: "warehouse_stock_lookup", alwaysLoad: null },
		]);
	});

	it("fails the turn on a malformed setting instead of guessing", async () => {
		writeSetting({ alwaysLoad: "read" });
		await assert.rejects(childSaw(), /provider\.toolSearch must be/);
	});
});

describe("toolSearchPlan", () => {
	it("reads off, on and alwaysLoad", () => {
		assert.equal(toolSearchPlan(undefined).enabled, false);
		assert.equal(toolSearchPlan(false).enabled, false);
		assert.equal(toolSearchPlan(true).enabled, true);
		assert.deepEqual([...toolSearchPlan({ alwaysLoad: ["read", "bash"] }).alwaysLoad], ["read", "bash"]);
		assert.equal(toolSearchPlan({}).enabled, true);
	});

	it("rejects anything else", () => {
		for (const bad of [null, "true", 1, [], { alwaysLoad: [1] }, { alwaysload: ["read"] }]) {
			assert.throws(() => toolSearchPlan(bad), /provider\.toolSearch must be/);
		}
	});
});
