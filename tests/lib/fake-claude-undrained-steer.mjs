#!/usr/bin/env node
// Stands in for Claude Code when a steer misses its mid-turn drain. On the first
// prompt it calls Pi's bash tool. The steer that arrives with the tool result is
// left queued: the turn ends with text and a result, then Claude Code runs the
// queued steer as a turn of its own. That turn reports whether stdin was still
// open, since its MCP tool answers would travel back over stdin.
// FAKE_STEER_MODE=drained instead treats the steer as drained mid-turn: one turn, one result.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const session_id = "00000000-0000-4000-8000-000000000005";
const drained = process.env.FAKE_STEER_MODE === "drained";
const text = (id, body) => send({ type: "assistant", session_id, parent_tool_use_id: null, message: { id, type: "message", role: "assistant", model: "fake",
	content: [{ type: "text", text: body }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
const result = () => send({ type: "result", subtype: "success", session_id, is_error: false, result: "", duration_ms: 1, duration_api_ms: 1, num_turns: 1,
	total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });

let stdinOpen = true;
let prompts = 0;
const input = createInterface({ input: process.stdin });
input.on("close", () => {
	stdinOpen = false;
	// Like Claude Code, finish a turn already under way before exiting.
	setTimeout(() => process.exit(0), 100);
});
input.on("line", (line) => {
	let message;
	try { message = JSON.parse(line); } catch { return; }
	if (message.type === "control_request") {
		send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
		return;
	}
	if (message.type !== "user") return;
	prompts += 1;
	if (prompts === 1) {
		send({ type: "system", subtype: "init", session_id, model: "fake", tools: [], mcp_servers: [], cwd: process.cwd(), permissionMode: "default", apiKeySource: "none", slash_commands: [], output_style: "default" });
		send({ type: "assistant", session_id, parent_tool_use_id: null, message: { id: "msg_tool", type: "message", role: "assistant", model: "fake",
			content: [{ type: "tool_use", id: "toolu_01FakeSteeredCall", name: "mcp__custom-tools__bash", input: { command: "true" } }],
			stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } } });
		return;
	}
	if (prompts !== 2) return;
	// The steer. The tool result itself never comes: no MCP server runs here.
	if (drained) {
		text("msg_one", "turn one done, steer seen");
		result();
		return;
	}
	text("msg_one", "turn one done");
	result();
	// Claude Code dequeues the leftover steer a few ms after the result.
	setTimeout(() => {
		text("msg_two", `steer turn: STDIN_${stdinOpen ? "OPEN" : "CLOSED"}`);
		result();
	}, 20);
});
