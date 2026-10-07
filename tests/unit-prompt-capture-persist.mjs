/**
 * A timer/intercom wake skips before_agent_start, so a Pi process that starts on
 * an existing session has nothing to resolve the wake against unless the bridge
 * persisted the session's captures. Seen live: headless lanes woken only by
 * intercom/pi-until failed every wake with "0 known" until a human typed.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt, buildSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import activate, { __test } from "../src/index.js";
import { projectPromptCapture } from "../src/prompt-capture.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { flushPromptCaptures, loadPromptCaptures, promptCaptureDir, prunePromptCapturesAsync, savePromptCaptures } from "../src/prompt-capture-store.js";

const options = () => ({ cwd: "/fixture", selectedTools: ["read"],
	contextFiles: [{ path: "/fixture/AGENTS.md", content: "PROJECT-POLICY" }], skills: [],
	appendSystemPrompt: "CLI-POLICY", sections: {}, promptGuidelines: [] });
const ctxFor = (sessionId) => ({ ui: null, mode: "rpc", sessionManager: { getSessionId: () => sessionId } });
const wake = (prompt, parts, sections) =>
	projectPromptCapture(__test.resolveProviderCapture(prompt, parts, sections), { skillReadTool: "mcp" });

let handlers;
function boot(reason, sessionId) {
	handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider() {}, registerTool() {} });
	handlers.get("session_start")({ reason }, ctxFor(sessionId));
	return handlers;
}
/** One ordinary user turn, the only path that records a capture. */
function userTurn(h, opts, prompt = buildSystemPrompt(opts)) {
	h.get("before_agent_start")({ systemPrompt: prompt, systemPromptOptions: opts });
	h.get("agent_start")({}, { getSystemPrompt: () => prompt });
	h.get("context_with_system")({ messages: [{ role: "system", content: "", sections: buildSystemPromptSections(opts), timestamp: 0 }] });
	h.get("agent_end")({});
	return prompt;
}
/** Process exit, then a new process on the same session. */
function restart(h, reason, sessionId) {
	h.get("session_shutdown")({ reason: "quit" });
	return boot(reason, sessionId);
}
afterEach(() => handlers?.get("session_shutdown")({ reason: "quit" }));

describe("persisted prompt captures", () => {
	for (const reason of ["startup", "resume"]) {
		it(`serves the first wake after a ${reason} without a user turn`, () => {
			const opts = options();
			const h = boot("new", "sess-cold-" + reason);
			const base = userTurn(h, opts);
			const h2 = restart(h, reason, "sess-cold-" + reason);
			h2.get("turn_start")({}, { getSystemPrompt: () => base });
			const result = wake(base);
			for (const text of ["PROJECT-POLICY", "CLI-POLICY"]) assert.ok(result.includes(text));
			assert.doesNotMatch(result, /operating inside pi|Pi documentation/);
		});
	}

	it("keeps a wake that lacks an earlier extension's section working across a restart", () => {
		const opts = options(); const bare = buildSystemPrompt(opts);
		opts.sections["rubicon-loop"] = "LOOP-NOTE";
		const h = boot("new", "sess-section");
		userTurn(h, opts);
		const h2 = restart(h, "startup", "sess-section");
		h2.get("turn_start")({}, { getSystemPrompt: () => bare });
		assert.match(wake(bare), /LOOP-NOTE/);
	});

	it("refreshes resource drift that happened while the process was down", () => {
		const opts = options();
		const h = boot("new", "sess-drift");
		userTurn(h, opts);
		const fresh = { ...opts, contextFiles: [{ path: "/fixture/AGENTS.md", content: "NEW-PROJECT-POLICY" }] };
		const sections = buildSystemPromptSections(fresh);
		const prompt = buildSystemPrompt(fresh);
		const h2 = restart(h, "startup", "sess-drift");
		h2.get("turn_start")({}, { getSystemPrompt: () => prompt });
		const result = wake(prompt, Object.values(sections), sections);
		assert.match(result, /NEW-PROJECT-POLICY/);
		assert.ok(!result.includes("\nPROJECT-POLICY\n"), "stale resource text must not survive");
	});

	it("still fails closed for a changed non-resource section after a restart", () => {
		const opts = options();
		const h = boot("new", "sess-strict");
		userTurn(h, opts);
		const sections = { ...buildSystemPromptSections(opts), rules: "UNVERIFIED" };
		const prompt = Object.values(sections).join("\n\n");
		const h2 = restart(h, "startup", "sess-strict");
		h2.get("turn_start")({}, { getSystemPrompt: () => prompt });
		assert.throws(() => wake(prompt, Object.values(sections), sections), /no capture/);
	});

	it("never restores another session's captures", () => {
		const opts = options();
		const h = boot("new", "sess-owner");
		const base = userTurn(h, opts);
		const h2 = restart(h, "startup", "sess-stranger");
		h2.get("turn_start")({}, { getSystemPrompt: () => base });
		assert.throws(() => wake(base), /no capture/);
	});

	it("starts a new session clean even when its predecessor persisted captures", () => {
		const opts = options();
		const h = boot("new", "sess-before-new");
		const base = userTurn(h, opts);
		h.get("session_start")({ reason: "new" }, ctxFor("sess-after-new"));
		assert.throws(() => __test.resolveProviderCapture(base), /no capture/);
		assert.ok(loadPromptCaptures("sess-before-new"), "the earlier session keeps its captures for a later resume");
	});
});

/** The child keeps the TypeScript loader but not tests/lib/setup.mjs, which would
 *  point it at a fresh capture directory. */
const execArgvWithoutSetup = () => {
	const out = [];
	for (let i = 0; i < process.execArgv.length; i++) {
		const arg = process.execArgv[i];
		if (arg.startsWith("--test")) continue;
		if (arg === "--import" && /setup\.mjs$/.test(process.execArgv[i + 1] ?? "")) { i++; continue; }
		if (/^--import=.*setup\.mjs$/.test(arg)) continue;
		out.push(arg);
	}
	return out;
};

describe("prompt capture store", () => {
	it("writes private files and refuses ids that could escape the directory", async () => {
		const carrier = { version: 1, captures: [{ assembledPrompt: "P", contextFiles: [], skills: [] }] };
		assert.equal(savePromptCaptures("ok-id_1", carrier), true);
		await flushPromptCaptures();
		assert.equal(statSync(join(promptCaptureDir(), "ok-id_1.json")).mode & 0o777, 0o600);
		assert.deepEqual(loadPromptCaptures("ok-id_1"), carrier);
		for (const bad of ["../escape", "a/b", "", "x".repeat(200)]) {
			assert.equal(savePromptCaptures(bad, carrier), false);
			assert.equal(loadPromptCaptures(bad), undefined);
		}
		assert.equal(savePromptCaptures("empty", { version: 1, captures: [] }), false);
		assert.equal(existsSync(join(promptCaptureDir(), "empty.json")), false);
	});

	it("ignores foreign files and prunes month-old captures", async () => {
		mkdirSync(promptCaptureDir(), { recursive: true });
		writeFileSync(join(promptCaptureDir(), "foreign.json"), JSON.stringify({ version: 2 }));
		assert.equal(loadPromptCaptures("foreign"), undefined);
		const carrier = { version: 1, captures: [{ assembledPrompt: "P", contextFiles: [], skills: [] }] };
		savePromptCaptures("old", carrier);
		savePromptCaptures("recent", carrier);
		await flushPromptCaptures();
		const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
		utimesSync(join(promptCaptureDir(), "old.json"), old, old);
		// Two days ahead: past the daily marker that earlier startups claimed.
		await prunePromptCapturesAsync(Date.now() + 2 * 24 * 60 * 60 * 1000);
		assert.equal(loadPromptCaptures("old"), undefined);
		assert.ok(loadPromptCaptures("recent"));
	});

	// 2026-10-06 freezes: Pis sat 30-68 s in a synchronous rename on the
	// main thread during APFS metadata stalls. Saving must not touch the disk inline.
	it("writes off the main thread and keeps only the newest snapshot", async () => {
		const first = { version: 1, captures: [{ assembledPrompt: "FIRST", contextFiles: [], skills: [] }] };
		const second = { version: 1, captures: [{ assembledPrompt: "SECOND", contextFiles: [], skills: [] }] };
		const file = join(promptCaptureDir(), "async-sess.json");
		assert.equal(savePromptCaptures("async-sess", first), true);
		assert.equal(existsSync(file), false, "save returned after touching the disk synchronously");
		savePromptCaptures("async-sess", second);
		assert.equal(loadPromptCaptures("async-sess").captures[0].assembledPrompt, "SECOND", "a pending save must be readable");
		await flushPromptCaptures();
		assert.equal(JSON.parse(readFileSync(file, "utf8")).captures[0].assembledPrompt, "SECOND");
		assert.equal((statSync(file).mode & 0o777), 0o600);
	});

	it("flushes an unwritten save when the process exits", () => {
		const store = fileURLToPath(new URL("../src/prompt-capture-store.ts", import.meta.url));
		const child = spawnSync(process.execPath, [...execArgvWithoutSetup(), "--input-type=module", "-e",
			`const s = await import(${JSON.stringify(store)}); s.savePromptCaptures("exit-sess", { version: 1, captures: [{ assembledPrompt: "EXIT", contextFiles: [], skills: [] }] }); process.exit(0);`],
			{ env: { ...process.env, CLAUDE_BRIDGE_CAPTURE_DIR: promptCaptureDir() }, encoding: "utf8" });
		assert.equal(child.status, 0, child.stderr);
		assert.equal(JSON.parse(readFileSync(join(promptCaptureDir(), "exit-sess.json"), "utf8")).captures[0].assembledPrompt, "EXIT");
	});
});
