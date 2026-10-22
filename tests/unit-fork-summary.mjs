/**
 * A compaction summary used to run as a one-shot: the whole history serialized
 * into one new prompt, which reads none of the live conversation's prompt cache.
 * When Pi's history is the one Claude Code holds, the summary now runs on a
 * fork of that conversation instead: the same transcript, system prompt and
 * tools, with the summary instruction as one more user turn. The fork is never
 * persisted, so the live transcript is only read. Mid-run, it forks the running
 * query's own session. A fork the classifier refuses keeps the fallback-model
 * path; a fork that cannot run, or calls a tool, falls back to the one-shot.
 * A summary extension can ask for the same with `x-claude-bridge-fork: 1`.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";

const agentDir = mkdtempSync(join(tmpdir(), "fork-summary-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "fork-summary-claude-"));
const runs = join(agentDir, "runs.jsonl");
process.env.FAKE_CLAUDE_RUNS = runs;
const fakeClaude = join(agentDir, "fake-claude");
const script = fileURLToPath(new URL("./lib/fake-claude-fork.mjs", import.meta.url));
writeFileSync(fakeClaude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
chmodSync(fakeClaude, 0o755);

const { default: activate, __test } = await import("../src/index.js");

const cwd = mkdtempSync(join(tmpdir(), "fork-summary-cwd-"));
const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-opus-5-5", baseUrl: "claude-bridge",
	contextWindow: 1000000, maxTokens: 128000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } };
const systemPrompt = "You are a coding agent.";
const tools = [{ name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const fallback = registerFauxProvider({ provider: "faux-fallback", api: "faux-fallback-api", models: [{ id: "summarizer", contextWindow: 500000, maxTokens: 128000 }] });

__test.promptCaptures.record(systemPrompt, { contextFiles: [{ path: join(cwd, "AGENTS.md"), content: "Project rule: keep the build green." }], skills: [] });
// The live path takes settings from the test hook; the one-shot and fallback paths read the config file.
const settings = (extra = {}) => {
	const provider = { pathToClaudeCodeExecutable: fakeClaude, ...extra };
	__test.setProviderSettings(provider);
	writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ provider }));
};

const handlers = new Map();
const emitted = [];
activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {}, events: { on: () => () => {}, emit: (channel, data) => emitted.push({ channel, data }) } });
const cacheEvents = () => emitted.filter((e) => e.channel === "claude-bridge:cache").map((e) => e.data);
const notes = [];
const piCtx = {
	model, cwd,
	ui: { notify: (message, level) => notes.push({ message, level }) },
	sessionManager: { getSessionId: () => "session-under-test" },
	modelRegistry: {
		find: (provider, id) => (provider === "faux-fallback" ? fallback.getModel(id) : undefined),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
	},
};

async function terminal(stream) {
	let last;
	for await (const event of stream) if (event.type === "done" || event.type === "error") last = event;
	return last;
}
const text = (message) => message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
const started = () => (existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
const user = (content, timestamp) => ({ role: "user", content, timestamp });

/** One live turn; returns Pi's history after it. */
async function liveTurn(prompt) {
	const messages = [user(prompt, 1)];
	const end = await terminal(__test.streamClaudeAgentSdk(model, { systemPrompt, tools, messages }, { cwd }));
	assert.ok(end?.type === "done", `live turn failed: ${end?.error?.errorMessage}`);
	return [...messages, end.message];
}

function entries(messages) {
	return messages.map((message, i) => ({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: new Date(1000 + i).toISOString(), message }));
}
function compactEvent(branch, firstKeptEntryId) {
	return {
		type: "session_before_compact", reason: "threshold", willRetry: false, customInstructions: undefined,
		branchEntries: entries(branch), signal: new AbortController().signal,
		preparation: {
			firstKeptEntryId, tokensBefore: 9300, isSplitTurn: false, turnPrefixMessages: [], previousSummary: undefined,
			messagesToSummarize: branch.slice(0, 1),
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		},
	};
}
const compact = (event) => handlers.get("session_before_compact")(event, piCtx);

beforeEach(async () => {
	await __test.tearDownLiveQueryForCompaction("test-reset", 2000);
	__test.resetSharedSession();
	rmSync(runs, { force: true });
	delete process.env.FAKE_FORK_MODE;
	notes.length = 0;
	emitted.length = 0;
	fallback.setResponses([]);
	settings();
});
after(async () => { await __test.tearDownLiveQueryForCompaction("test-end", 2000); });

describe("a compaction summary on the bridge", () => {
	it("runs on an unpersisted fork of the live conversation and reads its cache", async () => {
		const history = await liveTurn("Remember the codeword PELICAN-42.");
		const branch = [...history, user("Now check the stock.", 3)];
		const live = __test.getSharedSession()?.sessionId;
		assert.deepEqual(cacheEvents().map(({ ttl, sessionId }) => ({ ttl, sessionId })), [{ ttl: "5m", sessionId: live }],
			"the live turn announces its cache lifetime");

		const result = await compact(compactEvent(branch, "e2"));

		const summary = started().at(-1);
		assert.equal(summary.fork, true, `the summary did not fork: ${JSON.stringify(summary)}`);
		assert.equal(summary.persist, false, "a fork must not be written to disk");
		assert.equal(summary.resume, live, "forks the live session");
		assert.match(summary.prompt, /Now check the stock\./, "the instruction names where the kept messages start");
		assert.match(result?.compaction?.summary ?? "", /^FORKED SUMMARY/);
		assert.equal(result.compaction.firstKeptEntryId, "e2");
		assert.equal(result.compaction.usage?.cacheRead, 9000);
		assert.equal(__test.getSharedSession()?.sessionId, live, "the live session is untouched");
		assert.equal(cacheEvents().length, 1, "a fork must not move the live cache's expiry");
	});

	it("forks the running query's session when compaction fires mid-run", async () => {
		const messages = [user("USE A TOOL to list the files.", 1)];
		const end = await terminal(__test.streamClaudeAgentSdk(model, { systemPrompt, tools, messages }, { cwd }));
		assert.equal(end?.message?.stopReason, "toolUse", `expected a pending tool call: ${end?.error?.errorMessage}`);
		const call = end.message.content.find((c) => c.type === "toolCall");
		const branch = [...messages, end.message,
			{ role: "toolResult", toolCallId: call.id, toolName: "bash", isError: false, timestamp: 3, content: [{ type: "text", text: "README.md" }] }];

		const result = await compact(compactEvent(branch, "e2"));

		const summary = started().at(-1);
		assert.equal(summary.fork, true, `the summary did not fork the running query: ${JSON.stringify(summary)}`);
		assert.equal(summary.resume, "00000000-0000-4000-8000-0000000000a1");
		assert.match(result?.compaction?.summary ?? "", /^FORKED SUMMARY/);
	});

	it("keeps the fallback-model path when the classifier refuses the fork", async () => {
		const history = await liveTurn("Remember the codeword PELICAN-42.");
		settings({ compactionFallbackModel: "faux-fallback/summarizer" });
		process.env.FAKE_FORK_MODE = "refuse";
		fallback.setResponses([fauxAssistantMessage("FALLBACK SUMMARY")]);

		const result = await compact(compactEvent([...history, user("Now check the stock.", 3)], "e2"));

		assert.deepEqual(started().slice(1).map((run) => run.fork), [true], "asked the fork once, and no one-shot");
		assert.match(result?.compaction?.summary ?? "", /FALLBACK SUMMARY/, JSON.stringify(result));
		assert.match(notes[0]?.message ?? "", /safety classifier/);
	});

	it("summarizes as a one-shot when the fork calls a tool", async () => {
		const history = await liveTurn("Remember the codeword PELICAN-42.");
		process.env.FAKE_FORK_MODE = "tool";

		const result = await compact(compactEvent([...history, user("Now check the stock.", 3)], "e2"));

		assert.deepEqual(started().slice(1).map((run) => run.fork), [true, false], "a fork, then the one-shot");
		assert.equal(result?.compaction?.summary?.startsWith("FORKED SUMMARY"), false);
		assert.ok(result?.compaction?.summary, JSON.stringify(result));
	});

	it("summarizes as a one-shot when Pi's history is not the live conversation", async () => {
		await liveTurn("Remember the codeword PELICAN-42.");
		const other = [user("A different conversation entirely.", 1), { ...user("And more.", 2) }, user("Now check the stock.", 3)];

		const result = await compact(compactEvent(other, "e2"));

		assert.deepEqual(started().slice(1).map((run) => run.fork), [false]);
		assert.ok(result?.compaction?.summary);
	});
});

describe("a summary extension's fork request", () => {
	const fork = { cwd, headers: { "x-claude-bridge-fork": "1" } };

	it("runs on a fork of the live conversation", async () => {
		const history = await liveTurn("Remember the codeword PELICAN-42.");
		const end = await terminal(__test.streamClaudeAgentSdk(model, { systemPrompt, tools, messages: [...history, user("Summarize the conversation.", 3)] }, fork));

		assert.equal(end?.type, "done", end?.error?.errorMessage);
		assert.equal(text(end.message), "FORKED SUMMARY");
		assert.equal(end.message.usage.cacheRead, 9000);
		const run = started().at(-1);
		assert.deepEqual([run.fork, run.persist, run.prompt], [true, false, "Summarize the conversation."]);
	});

	it("runs as a one-shot of the history when there is no live conversation", async () => {
		const end = await terminal(__test.streamClaudeAgentSdk(model, { systemPrompt, tools,
			messages: [user("Remember the codeword PELICAN-42.", 1), user("Summarize the conversation.", 3)] }, fork));

		assert.equal(end?.type, "done", end?.error?.errorMessage);
		const run = started().at(-1);
		assert.equal(run.fork, false);
		assert.match(run.prompt, /<conversation>[\s\S]*PELICAN-42[\s\S]*<\/conversation>\s*Summarize the conversation\./);
	});
});
