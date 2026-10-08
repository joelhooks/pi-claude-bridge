/**
 * The isolated summary route — Pi's compaction and branch summaries on a bridge
 * model — runs its own Claude Code process. It used to end with an all-zero
 * usage block, so every summary counted 0 tokens in Pi's session totals and
 * nothing could meter the summarizer. It also ignored the requested thinking
 * level, so summaries always ran at Claude Code's default effort.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// No global config from the developer's machine: its env could lease real secrets.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "summary-usage-agent-"));
const { __test } = await import("../src/index.js");

const cwd = mkdtempSync(join(tmpdir(), "summary-usage-project-"));
const argvFile = join(cwd, "argv.json");
const fakeClaude = join(cwd, "fake-claude");

before(() => {
	const script = fileURLToPath(new URL("./lib/fake-claude-summary.mjs", import.meta.url));
	writeFileSync(fakeClaude, `#!/bin/sh\nFAKE_CLAUDE_ARGV=${JSON.stringify(argvFile)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
	chmodSync(fakeClaude, 0o755);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: fakeClaude } }));
});

const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-haiku-5-5", baseUrl: "claude-bridge",
	contextWindow: 1000000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } };

async function summarize(options = {}) {
	const stream = __test.isolatedStreamFn(model,
		{ systemPrompt: "Summarize.", tools: [], messages: [{ role: "user", content: "conversation to summarize", timestamp: 0 }] },
		{ cwd, cacheRetention: "none", ...options });
	let terminal;
	for await (const event of stream) if (event.type === "done" || event.type === "error") terminal = event;
	return terminal;
}

describe("isolated summary route", () => {
	it("reports the summary's real usage", async () => {
		const terminal = await summarize();
		assert.equal(terminal?.type, "done", `summary failed: ${terminal?.error?.errorMessage}`);
		assert.equal(terminal.message.content.map((c) => c.text).join(""), "FAKE SUMMARY");
		const { input, output, cacheRead, cacheWrite, totalTokens } = terminal.message.usage;
		assert.deepEqual({ input, output, cacheRead, cacheWrite, totalTokens },
			{ input: 1200, output: 345, cacheRead: 56000, cacheWrite: 789, totalTokens: 58334 },
			"Pi's session totals count summaries from this usage");
	});

	it("runs at the requested thinking level", async () => {
		await summarize({ reasoning: "high" });
		const argv = JSON.parse(readFileSync(argvFile, "utf8"));
		assert.equal(argv[argv.indexOf("--effort") + 1], "high", `no --effort high in ${JSON.stringify(argv)}`);
	});

	it("leaves effort to Claude Code when no thinking level is set", async () => {
		await summarize();
		assert.ok(!JSON.parse(readFileSync(argvFile, "utf8")).includes("--effort"));
	});
});
