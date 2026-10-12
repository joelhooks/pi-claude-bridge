/**
 * provider.cacheTtl reaches Claude Code: "1h" starts the child with
 * CLAUDE_CODE_PROMPT_CACHE_TTL=1h; without the setting the child gets nothing.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "cache-ttl-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cache-ttl-claude-"));
delete process.env.CLAUDE_CODE_PROMPT_CACHE_TTL;
const record = join(agentDir, "env.json");
const fakeClaude = join(agentDir, "fake-claude");
const script = join(agentDir, "fake.mjs");
writeFileSync(script, `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ ttl: process.env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? null }));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const session_id = "00000000-0000-4000-8000-000000000003";
let answered = false;
for await (const line of createInterface({ input: process.stdin })) {
	let m; try { m = JSON.parse(line); } catch { continue; }
	if (m.type === "control_request") { send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } }); continue; }
	if (m.type !== "user" || answered) continue;
	answered = true;
	send({ type: "system", subtype: "init", session_id, model: "fake", tools: [], mcp_servers: [], cwd: process.cwd(), permissionMode: "default", apiKeySource: "none", slash_commands: [], output_style: "default" });
	send({ type: "assistant", session_id, parent_tool_use_id: null, message: { id: "m", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
	send({ type: "result", subtype: "success", is_error: false, session_id, result: "OK", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, permission_denials: [] });
	break;
}
process.exit(0);
`);
writeFileSync(fakeClaude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
chmodSync(fakeClaude, 0o755);

const { __test } = await import("../src/index.js");
__test.setProviderSettings({ pathToClaudeCodeExecutable: fakeClaude });
__test.promptCaptures.record("You are a coding agent.", { contextFiles: [], skills: [] });

const cwd = mkdtempSync(join(tmpdir(), "cache-ttl-cwd-"));
const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-haiku-5-5", baseUrl: "claude-bridge",
	contextWindow: 1000000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context = { systemPrompt: "You are a coding agent.", tools: [], messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function writeConfig(path, setting) {
	mkdirSync(join(path, ".."), { recursive: true });
	if (setting === undefined) rmSync(path, { force: true });
	else writeFileSync(path, JSON.stringify({ provider: { cacheTtl: setting } }));
}
const projectConfig = join(cwd, ".pi", "claude-bridge.json");
const globalConfig = join(agentDir, "claude-bridge.json");
async function childTtl() {
	rmSync(record, { force: true });
	for await (const event of __test.streamClaudeAgentSdk(model, context, { cwd })) if (event.type === "error") throw new Error(event.error.errorMessage);
	return JSON.parse(readFileSync(record, "utf8")).ttl;
}

beforeEach(() => { __test.resetSharedSession(); writeConfig(projectConfig, undefined); writeConfig(globalConfig, undefined); });

describe("prompt cache TTL wiring", () => {
	it("starts the child with a 1-hour TTL when the project asks for it", async () => {
		writeConfig(projectConfig, "1h");
		assert.equal(await childTtl(), "1h");
	});

	it("leaves the TTL alone by default", async () => {
		assert.equal(await childTtl(), null);
	});

	it("lets a project turn a global 1-hour TTL back to 5 minutes", async () => {
		writeConfig(globalConfig, "1h");
		writeConfig(projectConfig, "5m");
		assert.equal(await childTtl(), null);
	});
});
