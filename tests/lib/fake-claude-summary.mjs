#!/usr/bin/env node
// Stands in for Claude Code on the isolated summary route: answers the SDK's
// control requests, replies to the first user message with a fixed summary and a
// result carrying known usage, and records its argv to $FAKE_CLAUDE_ARGV.
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.FAKE_CLAUDE_ARGV) writeFileSync(process.env.FAKE_CLAUDE_ARGV, JSON.stringify(process.argv.slice(2)));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const session_id = "00000000-0000-4000-8000-000000000001";
const log = (line) => process.env.FAKE_CLAUDE_LOG && appendFileSync(process.env.FAKE_CLAUDE_LOG, line + "\n");

for await (const line of createInterface({ input: process.stdin })) {
	let message;
	try { message = JSON.parse(line); } catch { continue; }
	log(line.slice(0, 200));
	if (message.type === "control_request") {
		send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
		continue;
	}
	if (message.type !== "user") continue;
	send({ type: "system", subtype: "init", session_id, model: "fake", tools: [], mcp_servers: [], cwd: process.cwd(), permissionMode: "default", apiKeySource: "none", slash_commands: [], output_style: "default" });
	send({ type: "assistant", session_id, parent_tool_use_id: null, message: { id: "msg_fake", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "FAKE SUMMARY" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
	send({
		type: "result", subtype: "success", is_error: false, session_id, result: "FAKE SUMMARY", num_turns: 1,
		duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0.0123,
		usage: { input_tokens: 1200, output_tokens: 345, cache_read_input_tokens: 56000, cache_creation_input_tokens: 789 },
		modelUsage: {}, permission_denials: [],
	});
	break;
}
process.exit(0);
