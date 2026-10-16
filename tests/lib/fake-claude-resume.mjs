#!/usr/bin/env node
// Stands in for Claude Code on a provider turn that resumes a transcript ending
// on a tool result. Records to $FAKE_CLAUDE_RECORD what it was started with (argv,
// the interrupted-turn switch, the last record of the transcript it resumes) and
// what its turn ran with: the prompt, and the system prompt append in force when
// the model ran. As Claude Code does, with CLAUDE_CODE_RESUME_INTERRUPTED_TURN set
// it runs the resumed turn at startup, before it reads the SDK's initialize
// request that carries the append; otherwise it takes initialize first and runs
// the turn on the prompt that arrives on stdin. Replies with a fixed text.
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
const resumeInterruptedTurn = process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN ?? null;
const record = (turn) => writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv, resumeInterruptedTurn, tail, ...turn }));

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const session_id = resumeId ?? "00000000-0000-4000-8000-000000000002";
const reply = () => {
	send({ type: "system", subtype: "init", session_id, model: "fake", tools: [], mcp_servers: [], cwd: process.cwd(), permissionMode: "default", apiKeySource: "none", slash_commands: [], output_style: "default" });
	send({ type: "assistant", session_id, parent_tool_use_id: null, message: { id: "msg_fake", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "CONTINUED" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
	send({ type: "result", subtype: "success", is_error: false, session_id, result: "CONTINUED", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, permission_denials: [] });
};
const interruptedTurn = resumeInterruptedTurn === "1" && tail?.content.includes("tool_result");
// The resumed turn has run, on no append, before any input is read.
if (interruptedTurn) record({ ran: "interrupted-turn", appendAtTurn: null, prompt: null });
let append = null;
let answered = false;
for await (const line of createInterface({ input: process.stdin })) {
	let message;
	try { message = JSON.parse(line); } catch { continue; }
	if (message.type === "control_request") {
		if (message.request?.subtype === "initialize") append = message.request.appendSystemPrompt ?? null;
		send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
		if (interruptedTurn && !answered) { answered = true; reply(); }
		continue;
	}
	if (message.type === "user" && !answered) {
		answered = true;
		const content = message.message?.content;
		const prompt = typeof content === "string" ? content : (content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
		record({ ran: "prompt", appendAtTurn: append, prompt });
		reply();
	}
}
process.exit(0);
