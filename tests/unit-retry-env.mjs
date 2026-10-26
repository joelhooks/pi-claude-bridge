import { it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "retry-env-agent-"));
// Allows the same regression to exercise an unchanged base module.
const { __test } = await import(process.env.BRIDGE_TEST_MODULE ?? "../src/index.js");
const original = process.env.CLAUDE_CODE_MAX_RETRIES;
afterEach(() => {
 __test.setQuery(null);
 if (original === undefined) delete process.env.CLAUDE_CODE_MAX_RETRIES;
 else process.env.CLAUDE_CODE_MAX_RETRIES = original;
});
const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-opus-5-5", baseUrl: "claude-bridge", contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

for (const { name, inherited, providerEnv, expected } of [
 { name: "defaults to 15 without a provider env block", expected: "15" },
 { name: "defaults to 15 with an empty provider env block", providerEnv: {}, expected: "15" },
 { name: "preserves an explicit process env value", inherited: "3", expected: "3" },
 { name: "preserves process env through provider env resolution", inherited: "3", providerEnv: {}, expected: "3" },
 { name: "lets provider.env override the default", providerEnv: { CLAUDE_CODE_MAX_RETRIES: "0" }, expected: "0" },
 { name: "lets provider.env override process env", inherited: "3", providerEnv: { CLAUDE_CODE_MAX_RETRIES: "1" }, expected: "1" },
]) it(name, async () => {
 if (inherited === undefined) delete process.env.CLAUDE_CODE_MAX_RETRIES;
 else process.env.CLAUDE_CODE_MAX_RETRIES = inherited;
 const cwd = mkdtempSync(join(tmpdir(), "retry-env-project-"));
 mkdirSync(join(cwd, ".pi"));
 writeFileSync(join(cwd, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { env: providerEnv } }));
 let childEnv;
 __test.setQuery(({ options }) => {
  childEnv = options.env;
  return {
   async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", is_error: false, result: "summary" }; },
   close() {}, interrupt: async () => {},
  };
 });
 for await (const event of __test.isolatedStreamFn(model,
  { systemPrompt: "Summarize.", tools: [], messages: [{ role: "user", content: "conversation", timestamp: 0 }] },
  { cwd, cacheRetention: "none" })) {
  assert.notEqual(event.type, "error", event.error?.errorMessage);
 }
 assert.ok(childEnv, "summary query must be created");
 assert.equal(childEnv.CLAUDE_CODE_MAX_RETRIES, expected);
 assert.equal(process.env.CLAUDE_CODE_MAX_RETRIES, inherited, "child default must not mutate process env");
});
