#!/usr/bin/env node
// Stands in for Claude Code on live turns and forked summaries. Appends one JSON
// line per run to $FAKE_CLAUDE_RUNS: argv, whether it forks (--fork-session),
// whether it persists the session, the session it resumes, and the prompt.
// A live turn whose prompt contains "USE A TOOL" stops on a tool call and waits,
// as Claude Code does while the bridge runs the tool; other live turns reply
// "OK". A forked run answers as $FAKE_FORK_MODE says: "summary" (default) with
// cache-read usage, "refuse" as the safety classifier does, or "tool" with a
// tool call. The live session reports its own id; a fork reports a new one.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const at = argv.findIndex((arg) => arg === "--resume" || arg.startsWith("--resume="));
const resume = at < 0 ? null : argv[at].startsWith("--resume=") ? argv[at].slice("--resume=".length) : argv[at + 1];
const fork = argv.includes("--fork-session");
const persist = !argv.includes("--no-session-persistence");
const mode = process.env.FAKE_FORK_MODE ?? "summary";
const session_id = fork ? "00000000-0000-4000-8000-0000000000f0" : resume ?? "00000000-0000-4000-8000-0000000000a1";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const init = () => send({ type: "system", subtype: "init", session_id, model: "fake", tools: [], mcp_servers: [], cwd: process.cwd(), permissionMode: "default", apiKeySource: "none", slash_commands: [], output_style: "default" });
const assistant = (content, stop_reason, usage = { input_tokens: 1, output_tokens: 1 }) =>
	send({ type: "assistant", session_id, parent_tool_use_id: null, message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "fake", content, stop_reason, usage } });
const result = (text, usage, is_error = false) => send({
	type: "result", subtype: "success", is_error, session_id, result: text, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0,
	usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage }, modelUsage: {}, permission_denials: [],
});

let answered = false;
for await (const line of createInterface({ input: process.stdin })) {
	let message;
	try { message = JSON.parse(line); } catch { continue; }
	if (message.type === "control_request") {
		send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
		continue;
	}
	if (message.type !== "user" || answered) continue;
	answered = true;
	const content = message.message?.content;
	const prompt = typeof content === "string" ? content : (content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
	appendFileSync(process.env.FAKE_CLAUDE_RUNS, JSON.stringify({ argv, fork, persist, resume, prompt }) + "\n");
	init();
	if (!fork && prompt.includes("USE A TOOL")) {
		assistant([{ type: "tool_use", id: "toolu_live1", name: "mcp__custom-tools__bash", input: { command: "ls" } }], "tool_use");
		continue; // waits for the tool result, as Claude Code does
	}
	if (!fork) {
		assistant([{ type: "text", text: "OK" }], "end_turn");
		result("OK", {});
		break;
	}
	if (mode === "refuse") {
		assistant([], "refusal");
		result("API Error: Claude can't help with this request. Details: [bio]", {}, true);
	} else if (mode === "tool") {
		assistant([{ type: "tool_use", id: "toolu_fork1", name: "mcp__custom-tools__bash", input: { command: "ls" } }], "tool_use");
		result("", {});
	} else {
		const usage = { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 9000, cache_creation_input_tokens: 200 };
		assistant([{ type: "text", text: "FORKED SUMMARY" }], "end_turn", usage);
		result("FORKED SUMMARY", usage);
	}
	break;
}
process.exit(0);
