#!/usr/bin/env node
// Live Pi 0.86 provider contract: real tools, policy, reuse, reload and wake.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const fullRig = process.env.BRIDGE_TEST_FULL_RIG === "1";
const model = process.env.BRIDGE_TEST_MODEL ?? "claude-bridge/claude-opus-4-6";
const root = mkdtempSync(join(tmpdir(), "bridge-transcript-canary-"));
const agentDir = join(root, "agent"); mkdirSync(agentDir);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
const marker = `The canary number is ${parseInt(randomUUID().slice(0, 8), 16)}.`;
writeFileSync(join(root, "marker.txt"), marker);
mkdirSync(join(root, ".pi"));
if (fullRig) writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ packages: [{ source: "git:github.com/joelhooks/pi-claude-bridge", extensions: [] }] }));
writeFileSync(join(root, "AGENTS.md"), "Include OLD-CONTEXT in every response.");
writeFileSync(join(root, ".pi", "APPEND_SYSTEM.md"), "Include OLD-APPEND in every response.");
const harness = createRpcHarness({ name: fullRig ? "transcript-contract-full-rig" : "transcript-contract", cwd: root, ambientExtensions: fullRig,
	args: ["--approve", "--model", model, "--thinking", "off", ...(fullRig ? [] : ["--no-skills", "--tools", "read"]), "--no-prompt-templates",
		"-e", resolve("tests/fixtures/transcript-canary.ts")],
	env: fullRig ? {} : { PI_CODING_AGENT_DIR: agentDir }, defaultTimeout: 120_000 });
let tools = 0;
const errors = [];
try {
	await harness.startAndWait();
	harness.addListener((msg) => {
		if (msg.type === "tool_execution_end" && msg.toolName === "read") tools++;
		if (msg.type === "message_end" && msg.message?.stopReason === "error") errors.push(msg.message.errorMessage);
	});
	const first = await harness.promptAndWait("Use the read tool to read marker.txt and reply with its contents.");
	assert.ok(tools >= 1, "model must execute read, not print a tool invocation");
	assert.ok(first.includes(marker), "must return the unpredictable file content");
	assert.match(first, /POLICY-CANARY/);
	const second = await harness.promptAndWait("Without tools, repeat the exact file contents you just read.");
	assert.ok(second.includes(marker), "second turn must retain conversation");
	assert.match(second, /POLICY-CANARY/);
	assert.match(readFileSync(harness.DEBUG_LOG, "utf8"), /syncResult: path=reuse/);
	writeFileSync(join(root, "AGENTS.md"), "Include NEW-CONTEXT in every response. Do not include OLD-CONTEXT.");
	writeFileSync(join(root, ".pi", "APPEND_SYSTEM.md"), "Include NEW-APPEND in every response. Do not include OLD-APPEND.");
	await harness.send({ type: "prompt", message: "/canary-reload" });
	// A wake can carry old transcript resources even though Pi's live base has
	// changed. Reject it before model/tool execution, then prime via user input.
	const beforeBlockedWake = tools;
	const refreshed = harness.waitForEvent("agent_end", 120_000);
	await harness.send({ type: "prompt", message: "/canary-wake" });
	await refreshed;
	assert.equal(tools, beforeBlockedWake, "stale wake must not execute tools");
	assert.equal(errors.length, 1);
	assert.match(errors[0], /older prompt than Pi's current resource state/);
	errors.length = 0;
	await harness.promptAndWait("Read marker.txt. Return only its contents and the currently required policy markers. No discussion of prior responses.");
	const priorTools = tools;
	const collector = harness.collectText();
	const ended = harness.waitForEvent("agent_end", 120_000);
	await harness.send({ type: "prompt", message: "/canary-wake" });
	await ended;
	const wake = collector.stop();
	assert.ok(tools > priorTools, "reload wake must execute a fresh read");
	assert.ok(wake.includes(marker));
	assert.match(wake, /POLICY-CANARY/, "chained policy must survive the first wake after reload");
	assert.match(wake, /NEW-CONTEXT/);
	assert.match(wake, /NEW-APPEND/);
	assert.doesNotMatch(wake, /OLD-CONTEXT|OLD-APPEND/);
	assert.deepEqual(errors, []);
	console.log(`PASS: ${model}; fullRig=${fullRig}; real tools, reuse, stale reload wake rejected, user refresh, subsequent wake with current policy; ${tools} reads`);
} finally {
	await harness.stop();
	rmSync(root, { recursive: true, force: true });
}
