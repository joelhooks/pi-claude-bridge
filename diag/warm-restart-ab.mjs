#!/usr/bin/env node
// Live A/B for warm restart: does a forked Pi process read the history from cache?
//
// Builds a Pi session holding a large history, quits, starts a new Pi on a fork
// of that session, and reports the fork's first request's cache read and write.
// Run once against a checkout without warm restart and once with it:
//
//   node --import tsx diag/warm-restart-ab.mjs [--ext <bridge checkout>] [--tokens 55000] [--thinking low]
//
// Each run uses a fresh nonce, so one run's cache entries cannot serve another's.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionPath } from "cc-session-io";
import { createRpcHarness } from "../tests/lib/rpc-harness.mjs";

const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const extensionDir = resolve(arg("ext", "."));
const model = arg("model", "claude-bridge/claude-haiku-5-5");
const tokens = Number(arg("tokens", "55000"));
const label = arg("label", "warm-restart-ab");
const thinking = arg("thinking", "low");

const root = mkdtempSync(join(tmpdir(), "warm-restart-ab-"));
const cwd = join(root, "work");
const sessionDir = join(root, "sessions");
mkdirSync(cwd);
mkdirSync(sessionDir);
const nonce = randomUUID();

// ~4 characters a token. Varied words, so the text compresses like prose would.
const WORDS = "amber basalt cobalt delta ember fjord granite harbor iris juniper kelp lantern meadow nickel orchid pewter quartz russet sable tundra umber velvet willow xenon yarrow zephyr".split(" ");
let seed = parseInt(nonce.slice(0, 8), 16);
const next = () => (seed = (seed * 1103515245 + 12345) >>> 0);
const lines = [];
for (let i = 0, chars = 0; chars < tokens * 4; i++) {
	const line = `Record ${i}: ${Array.from({ length: 12 }, () => WORDS[next() % WORDS.length]).join(" ")}.`;
	lines.push(line);
	chars += line.length + 1;
}

const args = ["--session-dir", sessionDir, "--model", model, "--thinking", thinking, "--no-skills", "--tools", "read", "--no-prompt-templates"];
const usages = (harness) => {
	const seen = [];
	harness.addListener((msg) => {
		if (msg.type === "message_end" && msg.message?.role === "assistant") seen.push(msg.message.usage);
	});
	return seen;
};

const first = createRpcHarness({ name: `${label}-1`, cwd, args, persistSession: true, extensionDir, defaultTimeout: 240_000 });
await first.startAndWait();
const firstUsage = usages(first);
// The corpus goes in the second turn, not the first: a real session's history
// builds up over many turns, and where a rebuilt transcript first differs from
// the one Claude Code wrote decides how much of it misses the cache.
await first.promptAndWait(`The session nonce is ${nonce}. Reply with only OK.`);
await first.promptAndWait(`Below is a reference corpus; just acknowledge it with OK.\n\n${lines.join("\n")}`);
// A tool call and thinking: the parts of a real session a rebuild has to convert.
writeFileSync(join(cwd, "marker.txt"), `The marker is ${randomUUID()}.`);
await first.promptAndWait("Use the read tool to read marker.txt, then reply with its contents.");
await first.promptAndWait("What is the session nonce? Reply with only the nonce.");
await first.stop();
const quitAt = Date.now();

const sessionFile = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).map((f) => join(sessionDir, f))[0];
const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const pointers = entries.filter((e) => e.type === "custom" && e.customType === "claude-bridge-session").map((e) => e.data);
const pointer = pointers.at(-1);
const parentPath = pointer ? getSessionPath(pointer.sessionId, cwd, process.env.CLAUDE_CONFIG_DIR) : undefined;
const parentBytes = parentPath ? readFileSync(parentPath, "utf8") : undefined;

const second = createRpcHarness({ name: `${label}-2`, cwd, args: [...args, "--fork", sessionFile], persistSession: true, extensionDir, defaultTimeout: 240_000 });
await second.startAndWait();
const secondUsage = usages(second);
const answer = await second.promptAndWait("Repeat the session nonce once more, and nothing else.");
await second.stop();

const debugLog = readFileSync(second.DEBUG_LOG, "utf8");
console.log(JSON.stringify({
	extensionDir, model, nonce,
	historyTurns: firstUsage.map(({ input, cacheRead, cacheWrite }) => ({ input, cacheRead, cacheWrite })),
	pointersRecorded: pointers.length,
	forkStartedSecondsAfterQuit: Math.round((Date.now() - quitAt) / 1000),
	forkFirstRequest: secondUsage[0] && { input: secondUsage[0].input, cacheRead: secondUsage[0].cacheRead, cacheWrite: secondUsage[0].cacheWrite },
	forkAnsweredNonce: answer.includes(nonce),
	parentTranscriptUnchanged: parentPath ? readFileSync(parentPath, "utf8") === parentBytes : null,
	syncPath: debugLog.match(/syncResult: path=\S+/g),
	warmRestart: debugLog.match(/warm restart: [^\n]*/g),
}, null, 2));
