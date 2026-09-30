#!/usr/bin/env node
// A real idle custom wake must preserve a known run-only section without
// treating unchanged resource policy as stale. No production config is changed.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const model = process.env.BRIDGE_TEST_MODEL ?? "claude-bridge/claude-opus-4-6";
const fullRig = process.env.BRIDGE_TEST_FULL_RIG === "1";
const root = mkdtempSync(join(tmpdir(), "bridge-wake-parity-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
mkdirSync(join(root, ".pi"));
if (fullRig) writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ packages: [{ source: "git:github.com/joelhooks/pi-claude-bridge", extensions: [] }] }));
writeFileSync(join(root, "AGENTS.md"), "This workspace is a synthetic read-only canary. Never write or publish anything.");
const marker = `The canary number is ${parseInt(randomUUID().slice(0, 8), 16)}.`;
writeFileSync(join(root, "marker.txt"), marker);
const harness = createRpcHarness({ name: "wake-prompt-parity", cwd: root, ambientExtensions: fullRig,
  args: ["--approve", "--model", model, "--thinking", "off", ...(fullRig ? [] : ["--no-skills", "--tools", "read"]), "--no-prompt-templates", "-e", resolve("tests/fixtures/wake-prompt-parity-canary.ts")],
  env: { ...(fullRig ? {} : { PI_CODING_AGENT_DIR: agentDir }), CLAUDE_BRIDGE_CAPTURE_DIR: join(root, "captures") }, defaultTimeout: 120_000 });
let reads = 0;
const errors = [];
try {
  await harness.startAndWait();
  harness.addListener((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "read" && !event.isError) reads++;
    if (event.type === "message_end" && event.message?.stopReason === "error") errors.push(event.message.errorMessage);
  });
  const first = await harness.promptAndWait("Use the read tool to read marker.txt. Return its contents and the current policy suffix.");
  assert.ok(reads >= 1, "initial turn must execute a real read");
  assert.ok(first.includes(marker));
  assert.match(first, /KNOWN-WAKE-POLICY/);
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = reads;
    const collector = harness.collectText();
    const ended = harness.waitForEvent("agent_end", 120_000);
    await harness.send({ type: "prompt", message: "/wake-parity-canary" });
    await ended;
    const reply = collector.stop();
    assert.deepEqual(errors, [], "unchanged known policy must not trip the stale-wake guard");
    assert.ok(reads > before, "idle wake must execute a fresh read");
    assert.ok(reply.includes(marker));
    assert.match(reply, /KNOWN-WAKE-POLICY/, "known extension policy must survive custom wakes");
  }
  console.log(`PASS: ${model}; fullRig=${fullRig}; initial real read plus two idle custom wakes; ${reads} reads; fixtures retained at ${root}`);
} finally {
  await harness.stop();
  // Preserve the canary evidence and any harness records; no transcript cleanup.
}
