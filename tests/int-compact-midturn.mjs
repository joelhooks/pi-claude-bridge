#!/usr/bin/env node
// Regression: threshold compaction in the middle of a tool loop.
//
// Pi 0.85 compacts between a tool result and the next assistant response
// (AgentSession._compactBeforeNextAssistantResponse). Before the bridge handled
// that, the tool results were delivered into the live Claude Code process, which
// still held the pre-compaction transcript, so every later request stayed at
// full size and pi compacted again after each tool step — an isolated summary of
// the whole history each time, and a context that never shrank. The bridge now
// kills the live query on session_compact and continues the turn from a session
// rebuilt out of the compacted history, using Claude Code's own interrupted-turn
// resume (CLAUDE_CODE_RESUME_INTERRUPTED_TURN).
//
// The reserve is set so the threshold trips once one large tool result is in
// context, which is inside the turn: the prompt asks for three reads, so the
// compaction lands between two of them and at least one read has to run on the
// rebuilt session — through the continuation query's own MCP server — for the
// answer to come back at all.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const BRIDGE_MODEL = process.env.BRIDGE_TEST_MODEL ?? "claude-bridge/claude-haiku-4-5";
const COMPACT_TIMEOUT = 120_000;
const TEST_TIMEOUT = 300_000;

const testAgentDir = mkdtempSync(join(tmpdir(), "compact-midturn-agent-"));
writeFileSync(join(testAgentDir, "settings.json"), JSON.stringify({
	// ~2K tokens of messages trips the threshold; the first read alone is far past that.
	compaction: { enabled: true, reserveTokens: 198000, keepRecentTokens: 50 },
}));

const harness = createRpcHarness({
	name: "compact-midturn",
	args: ["--model", BRIDGE_MODEL, "--no-context-files", "--no-skills", "--no-prompt-templates"],
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TEST_TIMEOUT,
});

const { startAndWait, stop, send, promptAndWait, waitForMatch, DEBUG_LOG, RPC_LOG } = harness;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

await startAndWait();

try {
	const events = [];
	let toolEndsBeforeCompaction = -1;
	let agentEndBeforeCompaction = false;
	let disableAutoPromise;
	harness.addListener((msg) => {
		if (msg.type === "tool_execution_end" || msg.type === "compaction_start" || msg.type === "compaction_end" || msg.type === "agent_end") {
			events.push(msg.type);
		}
		if (msg.type === "compaction_start" && msg.reason === "threshold" && toolEndsBeforeCompaction === -1) {
			toolEndsBeforeCompaction = events.filter((e) => e === "tool_execution_end").length;
			agentEndBeforeCompaction = events.includes("agent_end");
			// One compaction is the subject; the huge reserve would otherwise also
			// fire at the turn boundary and again on every later turn.
			disableAutoPromise = send({ type: "set_auto_compaction", enabled: false }, 30_000);
		}
	});

	const startPromise = waitForMatch(
		(msg) => msg.type === "compaction_start" && msg.reason === "threshold",
		"threshold compaction_start",
		TEST_TIMEOUT,
	);
	const endPromise = waitForMatch(
		(msg) => msg.type === "compaction_end" && msg.reason === "threshold",
		"threshold compaction_end",
		COMPACT_TIMEOUT + TEST_TIMEOUT,
	);

	console.log("Prompt: three reads in one turn, the first large enough to trip the threshold...");
	const answerPromise = promptAndWait(
		"Do these steps in order, one tool call at a time. " +
		"1. Use the read tool to read tests/fixtures/pi-history-310.jsonl. " +
		"2. Use the read tool to read tests/fixtures/compact-file-b.txt. " +
		"3. Use the read tool to read tests/fixtures/compact-file-a.txt. " +
		'4. Reply in chat with exactly three lines: the first line "MIDTURN-CONTINUED", the second line the full text of compact-file-b.txt, the third line the full text of compact-file-a.txt.',
		TEST_TIMEOUT,
	);

	await startPromise;
	if (disableAutoPromise) await disableAutoPromise;
	const endEvent = await endPromise;
	const answer = await answerPromise;

	console.log(`  event order: ${events.join(" → ")}`);
	assert(toolEndsBeforeCompaction >= 1, `compaction started before any tool finished — not mid-turn (events: ${events.join(" ")})`);
	assert(!agentEndBeforeCompaction, `compaction started after agent_end — not mid-turn (events: ${events.join(" ")})`);
	assert(endEvent.aborted === false, `threshold compaction aborted: ${JSON.stringify(endEvent)}`);
	assert(!endEvent.errorMessage, `threshold compaction errored: ${endEvent.errorMessage}`);
	assert(endEvent.result?.summary?.trim(), `threshold compaction returned empty summary: ${JSON.stringify(endEvent)}`);

	const compactionStarts = events.filter((e) => e === "compaction_start").length;
	assert(compactionStarts === 1, `expected exactly one compaction_start, got ${compactionStarts} (events: ${events.join(" ")})`);

	// The turn continued: at least one read ran on the continuation query, and
	// both small files' contents came back — one of them read after the compaction.
	const toolEndsTotal = events.filter((e) => e === "tool_execution_end").length;
	assert(toolEndsTotal > toolEndsBeforeCompaction, `no tool finished after compaction — turn did not continue (events: ${events.join(" ")})`);
	assert(/MIDTURN-CONTINUED/.test(answer), `answer lacks continuation marker. Got: ${answer.slice(0, 300)}`);
	assert(/compact carry-forward file B/.test(answer), `answer lacks file B contents. Got: ${answer.slice(0, 300)}`);
	assert(/compact carry-forward file A/.test(answer), `answer lacks file A contents. Got: ${answer.slice(0, 300)}`);

	const debugLog = readFileSync(DEBUG_LOG, "utf8");
	const teardownAt = debugLog.search(/session_compact:threshold:willRetry=false: tearing down live query/);
	assert(teardownAt !== -1, "debug log missing live-query teardown on session_compact");
	const continuationAt = debugLog.search(/provider: mid-turn continuation \(session_compact:threshold:willRetry=false\) — resuming/);
	assert(continuationAt > teardownAt, "debug log missing interrupted-turn continuation after teardown");
	const after = debugLog.slice(continuationAt);
	assert(/mode=interrupted-turn/.test(after), "continuation query did not run in interrupted-turn mode");
	// The continuation must run on a rebuilt session, never a resume of the killed one.
	const syncLines = debugLog.slice(teardownAt).match(/syncResult: path=\S+/g) ?? [];
	assert(syncLines[0] === undefined || /path=rebuild/.test(syncLines[0]), `first sync after teardown was not a rebuild: ${syncLines[0]}`);
	assert(!/WARNING: mid-turn continuation/.test(debugLog), "continuation fell back to a text prompt");
	assert(!/WARNING: continuation prompt released/.test(debugLog), "tools/list gate hit its cap on the continuation query");
	assert(!/currentPiStream overwritten/.test(debugLog), "debug log reported currentPiStream overwrite");
	assert(!/left state behind/.test(debugLog), "a query leaked state");

	// Claude Code's transcript for the rebuilt session: the resume prompt runs as a
	// meta user message, and the synthetic pair CC would otherwise materialize
	// for a tool_result tail is absent.
	const jsonlPaths = [...debugLog.matchAll(/jsonlPath=(\S+)/g)].map((m) => m[1]);
	const rebuiltPath = jsonlPaths[jsonlPaths.length - 1];
	assert(rebuiltPath && existsSync(rebuiltPath), `rebuilt session file not found: ${rebuiltPath}`);
	const records = readFileSync(rebuiltPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const resumeRecord = records.find((r) => r.type === "user" && r.isMeta === true
		&& JSON.stringify(r.message?.content).includes("Pi compacted this conversation"));
	assert(resumeRecord, "rebuilt session lacks the bridge's resume prompt as a meta user record");
	const noResponse = records.find((r) => r.type === "assistant" && JSON.stringify(r.message?.content).includes("No response requested."));
	assert(!noResponse, "Claude Code materialized 'No response requested.' — interrupted-turn resume did not engage");

	console.log(`  tokensBefore: ${endEvent.result.tokensBefore}`);
	console.log(`  tool ends before/after compaction: ${toolEndsBeforeCompaction}/${toolEndsTotal - toolEndsBeforeCompaction}`);
	console.log(`  answer: ${answer.trim().replace(/\n/g, " | ").slice(0, 120)}`);
	console.log("PASS");
} catch (e) {
	process.exitCode = 1;
	console.log(`FAIL: ${e.message}\n${e.stack}`);
	console.log(`  RPC log:    ${RPC_LOG}`);
	console.log(`  Debug log:  ${DEBUG_LOG}`);
	try { console.log(`  Debug tail: ${readFileSync(DEBUG_LOG, "utf8").slice(-4000)}`); } catch {}
} finally {
	await stop();
	rmSync(testAgentDir, { recursive: true, force: true });
}
