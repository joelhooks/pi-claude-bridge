/**
 * A host routed through a proxy has no Claude Code login of its own; the
 * provider env block is its only credential. The compaction summary spawns
 * Claude Code with settingSources: [], so ~/.claude/settings.json cannot fill
 * the gap there. 2026-10-07: a worker's compaction failed with "Not logged in"
 * on a host whose bridge ignored provider.env.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No global config from the developer's machine: its env could lease real secrets.
const agentDir = mkdtempSync(join(tmpdir(), "spawn-env-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { __test } = await import("../src/index.js");

const cwd = mkdtempSync(join(tmpdir(), "spawn-env-project-"));
const envDump = join(cwd, "child-env.txt");
const fakeClaude = join(cwd, "fake-claude");

before(() => {
	writeFileSync(fakeClaude, `#!/bin/sh\nenv > ${JSON.stringify(envDump)}\nexit 1\n`);
	chmodSync(fakeClaude, 0o755);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "claude-bridge.json"), JSON.stringify({
		provider: {
			pathToClaudeCodeExecutable: fakeClaude,
			env: { ANTHROPIC_BASE_URL: "https://proxy.invalid", ANTHROPIC_AUTH_TOKEN: "probe-token" },
		},
	}));
});

const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-opus-5-5", baseUrl: "claude-bridge",
	contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

describe("provider env on every Claude Code spawn", () => {
	it("passes the provider env to the compaction summary child", async () => {
		const stream = __test.isolatedStreamFn(model,
			{ systemPrompt: "Summarize.", tools: [], messages: [{ role: "user", content: "conversation to summarize", timestamp: 0 }] },
			{ cwd, cacheRetention: "none" });
		for await (const _event of stream) { /* drain until the fake child fails */ }
		assert.ok(existsSync(envDump), "the fake Claude Code was never spawned");
		const env = Object.fromEntries(readFileSync(envDump, "utf8").split("\n").filter(Boolean)
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
		assert.equal(env.ANTHROPIC_BASE_URL, "https://proxy.invalid", "compaction child bypassed the proxy");
		assert.equal(env.ANTHROPIC_AUTH_TOKEN, "probe-token", "compaction child had no proxy credential");
	});
});
