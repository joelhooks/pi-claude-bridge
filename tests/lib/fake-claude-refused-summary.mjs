#!/usr/bin/env node
// Stands in for Claude Code on the isolated summary route when Claude's safety
// classifier stops the summary: the assistant message ends with stop_reason
// "refusal" and no text, and the result reports the API error Claude Code shows.
// Appends one line per run to $FAKE_CLAUDE_RUNS.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.FAKE_CLAUDE_RUNS) appendFileSync(process.env.FAKE_CLAUDE_RUNS, "run\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const session_id = "00000000-0000-4000-8000-000000000003";
const error = "API Error: Claude can't help with this request. Details: [bio]";

for await (const line of createInterface({ input: process.stdin })) {
	let message;
	try { message = JSON.parse(line); } catch { continue; }
	if (message.type === "control_request") {
		send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
		continue;
	}
	if (message.type !== "user") continue;
	send({ type: "system", subtype: "init", session_id, model: "fake", tools: [], mcp_servers: [], cwd: process.cwd(), permissionMode: "default", apiKeySource: "none", slash_commands: [], output_style: "default" });
	send({ type: "assistant", session_id, parent_tool_use_id: null, message: { id: "msg_refused", type: "message", role: "assistant", model: "fake", content: [], stop_reason: "refusal", usage: { input_tokens: 1, output_tokens: 1 } } });
	send({
		type: "result", subtype: "success", is_error: true, session_id, result: error, num_turns: 1,
		duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0,
		usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		modelUsage: {}, permission_denials: [],
	});
	break;
}
process.exit(0);
