#!/usr/bin/env node
// Stands in for Claude Code mid tool loop: on the first prompt it answers with
// one tool_use for Pi's bash tool, then waits for the tool result the way
// Claude Code does, until it is interrupted or killed.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const session_id = "00000000-0000-4000-8000-000000000004";
let asked = false;
for await (const line of createInterface({ input: process.stdin })) {
	let message;
	try { message = JSON.parse(line); } catch { continue; }
	if (message.type === "control_request") {
		send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
		continue;
	}
	if (message.type !== "user" || asked) continue;
	asked = true;
	send({ type: "system", subtype: "init", session_id, model: "fake", tools: [], mcp_servers: [], cwd: process.cwd(), permissionMode: "default", apiKeySource: "none", slash_commands: [], output_style: "default" });
	send({ type: "assistant", session_id, parent_tool_use_id: null, message: { id: "msg_tool", type: "message", role: "assistant", model: "fake",
		content: [{ type: "tool_use", id: "toolu_01FakeWaitingCall", name: "mcp__custom-tools__bash", input: { command: "true" } }],
		stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } } });
}
