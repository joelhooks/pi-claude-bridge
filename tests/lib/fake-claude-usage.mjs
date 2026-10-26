#!/usr/bin/env node
// Two API requests inside one Pi message, with repeated cumulative usage frames.
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const session_id = "00000000-0000-4000-8000-000000000001";
const frame = (event) => send({ type: "stream_event", session_id, parent_tool_use_id: null, event });
for await (const line of createInterface({ input: process.stdin })) {
	let message;
	try { message = JSON.parse(line); } catch { continue; }
	if (message.type === "control_request") {
		send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
		continue;
	}
	if (message.type !== "user") continue;
	send({ type: "system", subtype: "init", session_id, model: "fake", tools: [], mcp_servers: [], cwd: process.cwd(), permissionMode: "default", apiKeySource: "none", slash_commands: [], output_style: "default" });
	for (const [id, usage, content, stop_reason] of [
		["msg_search", { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, [{ type: "tool_use", id: "toolu_search", name: "ToolSearch", input: { query: "read" } }], "tool_use"],
		["msg_answer", { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 400 }, [{ type: "text", text: "ANSWER" }], "end_turn"],
	]) {
		if (process.env.FAKE_USAGE_MODE !== "nonstreaming") {
			frame({ type: "message_start", message: { id, usage: { ...usage, output_tokens: 0 } } });
			frame({ type: "content_block_start", index: 0, content_block: content[0].type === "text" ? { type: "text", text: "" } : content[0] });
			if (content[0].type === "text") frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ANSWER" } });
			frame({ type: "content_block_stop", index: 0 });
			frame({ type: "message_delta", delta: { stop_reason }, usage: { output_tokens: usage.output_tokens / 2 } });
			frame({ type: "message_delta", delta: { stop_reason }, usage: { output_tokens: usage.output_tokens } });
			frame({ type: "message_stop" });
		}
		send({ type: "assistant", session_id, parent_tool_use_id: null, message: { id, type: "message", role: "assistant", model: "fake", content, stop_reason, usage } });
	}
	// Query-wide aggregate, not a third request (and not the latest context size).
	send({ type: "result", subtype: "success", is_error: false, session_id, result: "ANSWER", num_turns: 2, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0,
		usage: { input_tokens: 110, output_tokens: 220, cache_read_input_tokens: 330, cache_creation_input_tokens: 440 }, modelUsage: {}, permission_denials: [] });
	break;
}
process.exit(0);
