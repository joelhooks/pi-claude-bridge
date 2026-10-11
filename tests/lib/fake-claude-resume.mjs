#!/usr/bin/env node
// Stands in for Claude Code on a provider turn that resumes an interrupted turn:
// records what it was started with to $FAKE_CLAUDE_RECORD (argv, the resume
// switches, and the last record of the transcript it was asked to resume), then
// answers the SDK's control requests and replies with a fixed text and result
// without waiting for a prompt, as Claude Code does with
// CLAUDE_CODE_RESUME_INTERRUPTED_TURN set.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const resumeArg = argv.findIndex((arg) => arg === "--resume" || arg.startsWith("--resume="));
const resumeId = resumeArg < 0 ? undefined
	: argv[resumeArg].startsWith("--resume=") ? argv[resumeArg].slice("--resume=".length) : argv[resumeArg + 1];
let tail = null;
const projects = join(process.env.CLAUDE_CONFIG_DIR ?? "", "projects");
if (resumeId && existsSync(projects)) {
	for (const dir of readdirSync(projects)) {
		const file = join(projects, dir, `${resumeId}.jsonl`);
		if (!existsSync(file)) continue;
		const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1));
		tail = { type: last.type, content: (last.message?.content ?? []).map((block) => block.type) };
	}
}
writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({
	argv,
	resumeInterruptedTurn: process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN ?? null,
	tail,
}));

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const session_id = resumeId ?? "00000000-0000-4000-8000-000000000002";
let answered = false;
for await (const line of createInterface({ input: process.stdin })) {
	let message;
	try { message = JSON.parse(line); } catch { continue; }
	if (message.type === "control_request") {
		send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
		if (answered) continue;
		answered = true;
		send({ type: "system", subtype: "init", session_id, model: "fake", tools: [], mcp_servers: [], cwd: process.cwd(), permissionMode: "default", apiKeySource: "none", slash_commands: [], output_style: "default" });
		send({ type: "assistant", session_id, parent_tool_use_id: null, message: { id: "msg_fake", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "CONTINUED" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
		send({ type: "result", subtype: "success", is_error: false, session_id, result: "CONTINUED", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, permission_denials: [] });
	}
}
process.exit(0);
