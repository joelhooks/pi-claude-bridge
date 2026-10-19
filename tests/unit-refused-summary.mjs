/**
 * Claude's safety classifiers can refuse a compaction summary. The history being
 * summarized usually holds whatever tripped them, so every later compaction is
 * refused too, and the session can never shrink. With a configured
 * compactionFallbackModel the bridge summarizes that compaction on the fallback
 * instead, says so once in Pi, and logs it. If the fallback fails as well, it
 * reports once and stops trying for the session.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";

const agentDir = mkdtempSync(join(tmpdir(), "refused-summary-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: activate } = await import("../src/index.js");

const cwd = mkdtempSync(join(tmpdir(), "refused-summary-project-"));
const runs = join(cwd, "runs.log");
const fakeClaude = join(cwd, "fake-claude");
const script = fileURLToPath(new URL("./lib/fake-claude-refused-summary.mjs", import.meta.url));
writeFileSync(fakeClaude, `#!/bin/sh\nFAKE_CLAUDE_RUNS=${JSON.stringify(runs)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
chmodSync(fakeClaude, 0o755);
const refusals = join(agentDir, "claude-bridge", "refusals.jsonl");
const setConfig = (provider) => writeFileSync(join(agentDir, "claude-bridge.json"),
	JSON.stringify({ provider: { pathToClaudeCodeExecutable: fakeClaude, ...provider } }));

const fallback = registerFauxProvider({ provider: "faux-fallback", api: "faux-fallback-api", models: [{ id: "summarizer", contextWindow: 500000, maxTokens: 128000 }] });

const claudeModel = { api: "claude-bridge", provider: "claude-bridge", id: "claude-opus-5-5", baseUrl: "claude-bridge",
	contextWindow: 1000000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

function harness() {
	const handlers = new Map();
	const events = { on: () => () => {}, emit: () => {} };
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {}, events });
	const notes = [];
	const ctx = {
		model: claudeModel, cwd,
		ui: { notify: (message, level) => notes.push({ message, level }) },
		sessionManager: { getSessionId: () => "session-under-test" },
		modelRegistry: {
			find: (provider, id) => (provider === "faux-fallback" ? fallback.getModel(id) : undefined),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
	};
	return { compact: (event) => handlers.get("session_before_compact")(event, ctx), notes };
}

const compactEvent = () => ({
	reason: "threshold", willRetry: false, branchEntries: [], signal: new AbortController().signal,
	preparation: {
		firstKeptEntryId: "kept", tokensBefore: 500000, isSplitTurn: false, turnPrefixMessages: [], previousSummary: undefined,
		messagesToSummarize: [{ role: "user", content: "audit the isolation cell", timestamp: 1 }],
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
	},
});
const claudeRuns = () => (existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n").length : 0);
const logged = () => (existsSync(refusals) ? readFileSync(refusals, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);

beforeEach(() => {
	rmSync(runs, { force: true });
	rmSync(refusals, { force: true });
	fallback.setResponses([]);
});

describe("a compaction summary Claude refuses", () => {
	it("is summarized on the configured fallback model, with one notice and one log line", async () => {
		setConfig({ compactionFallbackModel: "faux-fallback/summarizer" });
		fallback.setResponses([fauxAssistantMessage("FALLBACK SUMMARY")]);
		const { compact, notes } = harness();

		const result = await compact(compactEvent());

		assert.equal(claudeRuns(), 1, "Claude Code was asked first");
		assert.match(result?.compaction?.summary ?? "", /FALLBACK SUMMARY/, `no fallback compaction: ${JSON.stringify(result)} ${JSON.stringify(notes)}`);
		assert.equal(notes.length, 1);
		assert.match(notes[0].message, /safety classifier.*Summarized this compaction with faux-fallback\/summarizer/s);
		assert.deepEqual(logged().map(({ kind, session, fallback, ok }) => ({ kind, session, fallback, ok })),
			[{ kind: "summary", session: "session-under-test", fallback: "faux-fallback/summarizer", ok: true }]);
	});

	it("reports once and stops compacting when the fallback fails too", async () => {
		setConfig({ compactionFallbackModel: "faux-fallback/summarizer" });
		fallback.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "fallback down" })]);
		const { compact, notes } = harness();

		assert.deepEqual(await compact(compactEvent()), { cancel: true });
		assert.equal(notes.length, 1);
		assert.equal(notes[0].level, "error");
		assert.match(notes[0].message, /failed too.*will not compact on its own/s);
		assert.equal(logged().at(-1)?.ok, false);

		assert.deepEqual(await compact(compactEvent()), { cancel: true });
		assert.equal(claudeRuns(), 1, "a later compaction must not ask Claude again");
		assert.equal(notes.length, 1, "reported once");
	});

	it("reports once and stops when no fallback is configured", async () => {
		setConfig({});
		const { compact, notes } = harness();

		assert.deepEqual(await compact(compactEvent()), { cancel: true });
		assert.match(notes[0]?.message ?? "", /No compactionFallbackModel is configured/);
		assert.deepEqual(await compact(compactEvent()), { cancel: true });
		assert.equal(claudeRuns(), 1);
		assert.equal(notes.length, 1);
	});
});
