#!/usr/bin/env node
// The tool-listing gate: a fresh Claude Code query must not send its first model
// request before Claude Code has Pi's tools in its tool pool.
//
// Claude Code does not wait for SDK MCP servers before an interrupted-turn
// resume, so the bridge holds that turn in a UserPromptSubmit hook. The hook
// used to release as soon as our tools/list handler ran. That is not when Claude
// Code has the tools: it still has to take the answer in, and with a listing the
// size of a real pi session's (~120 tools, ~45k tokens) the hook's reply
// overtakes it. The resumed turn then goes out with no tools and ends having
// only described the call it meant to make.
//
// Two layers. The contracts pin, against the installed CC + SDK, what each kind
// of fresh query does under that load. The bridge test drives the path that lost
// its tools in real sessions: overflow recovery. CC refuses a request with
// "Prompt is too long", pi compacts and retries, and the bridge continues the
// turn through CC's interrupted-turn resume.
//
// Requires: CC logged in. Must run OUTSIDE the sandbox — CC persists session
// state under ~/.claude. Run on its own; the race is load-sensitive.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSession, repairToolPairing } from "cc-session-io";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const CWD = process.cwd();
const MODEL = "claude-haiku-4-5";
const FILLER_TOOLS = 120;
const SERVER = "custom-tools";

const noArgTool = (name, description) => ({ name, description, inputSchema: { type: "object", properties: {} } });
// Same size as tests/fixtures/tool-listing-load-extension.ts: 120 of these make
// a listing the size of a real pi session's.
const FILLER_DESCRIPTION = `Never call this tool. ${"It exists only to make the tool listing as large as a real pi session's, and returns nothing useful. ".repeat(16)}`;

/** Run one query, with the options the bridge's provider query uses, against an
 *  SDK MCP server serving `alpha`, `beta` and FILLER_TOOLS filler tools. `mode` is "interrupted" (a tool_result tail resumed with
 *  CLAUDE_CODE_RESUME_INTERRUPTED_TURN, as the bridge's continuation does) or
 *  "pushed" (an ordinary streamed prompt). Either way the turn still owes a
 *  `beta` call, so whether it makes one shows whether the tools reached its
 *  first request. `gate` builds a UserPromptSubmit hook from `{ listed, handle }`. */
async function loadedQuery({ mode, gate = null }) {
	const sessionId = randomUUID();
	const session = createSession({ sessionId, projectPath: CWD, claudeDir: process.env.CLAUDE_CONFIG_DIR, model: MODEL });
	session.importMessages(repairToolPairing(mode === "interrupted" ? [
		{ role: "user", content: "Call the alpha tool, then call the beta tool, then reply with both values and the word DONE." },
		{ role: "assistant", content: [{ type: "tool_use", id: "pi_call_alpha", name: `mcp__${SERVER}__alpha`, input: {} }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "pi_call_alpha", content: "alpha-VALUE" }] },
	] : [
		{ role: "user", content: "Remember the word kumquat." },
		{ role: "assistant", content: [{ type: "text", text: "Noted: kumquat." }] },
	]));
	session.save();

	const tools = [
		noArgTool("alpha", "Returns the alpha value."),
		noArgTool("beta", "Returns the beta value."),
		...Array.from({ length: FILLER_TOOLS }, (_, i) => noArgTool(`filler_${i}`, FILLER_DESCRIPTION)),
	];
	const calls = [];
	let markListed;
	const listed = new Promise((resolve) => { markListed = resolve; });
	const server = new McpServer({ name: SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
	// Resolves as src/mcp-server.ts does: when the handler runs, not when CC has
	// taken the answer in.
	server.server.setRequestHandler(ListToolsRequestSchema, () => { markListed(); return { tools }; });
	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		calls.push(request.params.name);
		return { content: [{ type: "text", text: `${request.params.name}-VALUE` }] };
	});

	let release;
	const parked = new Promise((resolve) => { release = resolve; });
	async function* input() {
		if (mode === "pushed") {
			yield { type: "user", message: { role: "user", content: [{ type: "text", text: "Call the beta tool, then reply with its value and the word DONE." }] }, parent_tool_use_id: null, session_id: "" };
		}
		await parked;
	}
	const env = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" };
	if (mode === "interrupted") {
		env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = "1";
		env.CLAUDE_CODE_RESUME_REASON = "pi_compaction";
		env.CLAUDE_CODE_RESUME_PROMPT = "[contract] Compacted mid-turn. Continue from the tool results above, taking the next step.";
	}
	const handle = {};
	const q = query({
		prompt: input(),
		options: {
			cwd: CWD, model: MODEL, tools: [], permissionMode: "bypassPermissions", env,
			// The provider query's shape (src/index.ts). It matters: with bare
			// options CC reaches the request sooner and the race changes.
			includePartialMessages: true, effort: "medium",
			settings: { claudeMdExcludes: ["**/CLAUDE.md", "**/.claude/rules/**"], includeGitInstructions: false },
			systemPrompt: { type: "preset", preset: "claude_code", append: "You are running inside pi." },
			extraArgs: { "strict-mcp-config": null, "thinking-display": "summarized" }, maxTurns: 4, resume: sessionId,
			mcpServers: { [SERVER]: { type: "sdk", name: SERVER, instance: server } },
			...(gate ? { hooks: { UserPromptSubmit: [{ hooks: [gate({ listed, handle })] }] } } : {}),
		},
	});
	handle.q = q;

	let init = null;
	let result = null;
	try {
		for await (const message of q) {
			if (message.type === "system" && message.subtype === "init") init = message;
			if (message.type === "result") { result = message; release(); break; }
		}
	} finally {
		release();
		q.close();
	}
	return { init, result, calls };
}

const CONNECTED = [{ name: SERVER, status: "connected" }];
const servers = (init) => (init?.mcp_servers ?? []).map(({ name, status }) => ({ name, status }));

// --- Contracts ---

test("a pushed prompt waits for a production-sized SDK MCP listing on its own", { timeout: 120_000 }, async () => {
	// No hook: CC itself holds a streamed prompt's first request until the SDK
	// server has connected. The bridge gates pushed prompts anyway, at the cost
	// of one status round trip; this pins that the gate is belt and braces there.
	const { init, result, calls } = await loadedQuery({ mode: "pushed" });
	assert.equal(result?.subtype, "success");
	assert.deepEqual(servers(init), CONNECTED, `CC no longer waits for SDK MCP servers before a pushed prompt: ${JSON.stringify(init?.mcp_servers)}`);
	assert.ok(calls.includes("beta"), `pushed prompt did not call beta: ${JSON.stringify(calls)}`);
});

test("releasing the resume once tools/list has been served sends it without a production-sized listing", { timeout: 120_000 }, async () => {
	// The bridge's original gate. Our handler has run, but CC is still taking
	// the listing in when the hook's reply reaches it, and it builds the resumed
	// turn's request without the server. Small listings usually win this race,
	// which is why the gate looked sufficient in tests/int-cc-contracts.mjs.
	const { init, result, calls } = await loadedQuery({
		mode: "interrupted",
		gate: ({ listed }) => async () => { await listed; return { continue: true }; },
	});
	assert.equal(result?.subtype, "success");
	assert.deepEqual(servers(init), [], `the listing now reaches CC before the hook reply: ${JSON.stringify(init?.mcp_servers)} — waiting on tools/list may suffice again`);
	assert.ok(!calls.includes("beta"), `resumed turn called beta without the server connected: ${JSON.stringify(calls)}`);
});

test("a hook that waits for mcpServerStatus() to report connected holds the resume", { timeout: 120_000 }, async () => {
	// What the bridge's gate does now. CC answers mcpServerStatus() while it
	// awaits the hook, and "connected" there means the tools are in the pool
	// the resumed turn's request is built from.
	const { init, result, calls } = await loadedQuery({
		mode: "interrupted",
		gate: ({ listed, handle }) => async () => {
			await listed;
			for (let i = 0; i < 200; i++) {
				const status = await handle.q.mcpServerStatus();
				if (status.some((s) => s.name === SERVER && s.status === "connected")) break;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			return { continue: true };
		},
	});
	assert.equal(result?.subtype, "success");
	assert.deepEqual(servers(init), CONNECTED, `status gate did not hold the resume: ${JSON.stringify(init?.mcp_servers)}`);
	assert.ok(calls.includes("beta"), `resumed turn did not call beta despite the status gate: ${JSON.stringify(calls)}`);
});

// --- Bridge: overflow recovery ---

// Each round is an independent pi session; every one must keep its tools.
const ROUNDS = 4;

/** One pi session through overflow recovery. CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
 *  (a CC test knob, inherited by the CC child) makes CC refuse with "Prompt is
 *  too long" at that many tokens: the refusal overflow recovery starts from in
 *  production. Calibrated on haiku with --no-context-files/--no-skills and the
 *  filler tools: the base request is ~54.7k tokens and each 900-line slice of
 *  src/index.ts adds ~13-14k. So the request after the second slice (~82k) is
 *  refused; the compacted history keeps only that slice (~70k) and fits, as does
 *  the rest of the turn. */
async function overflowRound(round) {
	const agentDir = mkdtempSync(join(tmpdir(), "tool-listing-gate-agent-"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 50 },
	}));
	const harness = createRpcHarness({
		name: `tool-listing-gate-${round}`,
		args: ["-e", "./tests/fixtures/tool-listing-load-extension.ts", "--model", "claude-bridge/claude-haiku-4-5",
			"--no-context-files", "--no-skills", "--no-prompt-templates"],
		env: {
			PI_CODING_AGENT_DIR: agentDir,
			CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: "76500",
			FILLER_TOOLS: String(FILLER_TOOLS),
		},
		defaultTimeout: 300_000,
	});
	await harness.startAndWait();
	try {
		const events = [];
		harness.addListener((msg) => {
			if (msg.type === "tool_execution_end" || msg.type === "agent_end") events.push(msg.type);
			if (msg.type === "compaction_start") events.push(`compaction_start:${msg.reason}`);
			if (msg.type === "message_end" && msg.message?.role === "assistant" && msg.message.stopReason === "error") {
				events.push(`error:${msg.message.errorMessage}`);
			}
		});
		const text = harness.collectText();
		const compacted = harness.waitForMatch((msg) => msg.type === "compaction_end" && msg.reason === "overflow", "overflow compaction_end", 300_000);
		await harness.send({
			type: "prompt",
			message: "Do these steps in order, one tool call at a time. " +
				"1. Use the read tool to read src/index.ts with limit 900. " +
				"2. Use the read tool to read src/index.ts with offset 901 and limit 900. " +
				"3. Use the read tool to read tests/fixtures/compact-file-b.txt. " +
				'4. Reply in chat with exactly two lines: the first line "OVERFLOW-CONTINUED", the second line the full text of compact-file-b.txt.',
		});
		// The refused turn's own agent_end comes before the compaction, so only
		// the one after it ends the recovered turn.
		const endEvent = await compacted;
		await harness.waitForEvent("agent_end", 300_000);
		const answer = text.stop();
		const debugLog = readFileSync(harness.DEBUG_LOG, "utf8");

		// Preconditions: this round really went through overflow recovery.
		assert.equal(endEvent.willRetry, true, `overflow compaction did not retry: ${JSON.stringify(endEvent).slice(0, 300)}`);
		assert.ok(events.some((e) => /^error:.*prompt is too long/i.test(e)), `CC never refused on size (events: ${events.join(" ")})`);
		const continuationAt = debugLog.search(/provider: mid-turn continuation \(session_compact:overflow:willRetry=true\) — resuming/);
		assert.ok(continuationAt !== -1, "overflow recovery did not continue the turn as an interrupted-turn resume");

		const afterCompaction = events.slice(events.indexOf("compaction_start:overflow"));
		return {
			round,
			toolAfterCompaction: afterCompaction.includes("tool_execution_end"),
			answeredB: /compact carry-forward file B/.test(answer),
			gateLines: debugLog.slice(continuationAt).match(/.*tool-listing gate.*|.*continuation prompt gate.*/g) ?? [],
			answer: answer.trim().slice(0, 160),
			logs: [harness.RPC_LOG, harness.DEBUG_LOG],
		};
	} finally {
		await harness.stop();
		rmSync(agentDir, { recursive: true, force: true });
	}
}

test("every overflow-recovery continuation keeps Pi's tools under a production-sized listing", { timeout: ROUNDS * 360_000 }, async () => {
	const rounds = [];
	for (let round = 1; round <= ROUNDS; round++) {
		const outcome = await overflowRound(round);
		console.log(`  round ${round}: tool after compaction=${outcome.toolAfterCompaction} answeredB=${outcome.answeredB} gate=${JSON.stringify(outcome.gateLines.map((l) => l.replace(/^\[[^\]]*\] \[[^\]]*\] /, "")))}`);
		rounds.push(outcome);
	}
	// The symptom: without Pi's tools the resumed turn ends on text alone.
	const lost = rounds.filter((r) => !r.toolAfterCompaction || !r.answeredB);
	assert.deepEqual(lost.map((r) => r.round), [],
		`resumed turns ran without tools in ${lost.length}/${ROUNDS} rounds: ${JSON.stringify(lost.map(({ round, answer, logs }) => ({ round, answer, logs })))}`);
	for (const r of rounds) {
		assert.ok(r.gateLines.some((l) => /tool-listing gate: .*connected/.test(l)), `round ${r.round}: continuation was not held until CC reported the server connected: ${JSON.stringify(r.gateLines)}`);
		assert.ok(!r.gateLines.some((l) => /WARNING/.test(l)), `round ${r.round}: gate hit its cap: ${JSON.stringify(r.gateLines)}`);
	}
});
