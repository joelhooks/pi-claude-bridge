/**
 * Warm restart: a new Pi process resumes the previous one's transcript.
 *
 * A restarted or forked Pi process has no shared session, so its first query
 * used to rebuild: import Pi's whole history into a fresh Claude Code
 * transcript. Those bytes differ from what the previous process sent, so the
 * request missed the prompt cache past the system prompt, a cache write of the
 * whole history on every restart. The bridge now records its session in Pi's
 * session and the next process resumes it, forked, when nothing has moved.
 */
import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "cc-session-io";

// Keep every transcript these tests write out of the real Claude config dir.
const claudeDir = mkdtempSync(join(tmpdir(), "warm-restart-claude-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;

const { default: activate, __test } = await import("../src/index.js");
const { prefixDigest } = await import("../src/history-digest.js");

const MODEL = "claude-opus-5-5";
const POLICY = "Project policy v1.";
const digestOf = (append) => createHash("sha256").update(append ?? "").digest("hex");

let clock = 1_000;
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const assistant = (text) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages", provider: "claude-bridge", model: MODEL,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
	stopReason: "stop", timestamp: clock++,
});

function withCwd(run) {
	const cwd = mkdtempSync(join(tmpdir(), "warm-restart-"));
	try { return run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

/** The previous process's state: a transcript holding the first two turns, and
 *  the pointer it recorded when the second one ended. Pi's history then holds
 *  that turn's final assistant message and the next user prompt. */
function previousProcess(cwd, { append = POLICY } = {}) {
	const covered = [user("one"), assistant("A1"), user("two")];
	const session = createSession({ projectPath: cwd, claudeDir, model: MODEL });
	session.importMessages([
		{ role: "user", content: "one" },
		{ role: "assistant", content: [{ type: "text", text: "A1" }] },
		{ role: "user", content: "two" },
		{ role: "assistant", content: [{ type: "text", text: "A2" }] },
	]);
	session.save();
	const tail = session.records.filter((r) => r.type === "assistant").at(-1).uuid;
	const pointer = {
		v: 1, sessionId: session.sessionId, cursor: covered.length, prefix: prefixDigest(covered, covered.length),
		appendDigest: digestOf(append), tail, epoch: "",
	};
	const history = [...covered, assistant("A2"), user("three")];
	return { pointer, history, jsonlPath: session.jsonlPath, bytes: readFileSync(session.jsonlPath, "utf8") };
}

const branchWith = (pointer, ...more) => [
	{ id: "m1", type: "message" },
	{ id: "p1", type: "custom", customType: "claude-bridge-session", data: pointer },
	...more,
];

const sync = (history, cwd, append = POLICY) =>
	__test.syncSharedSession(history, cwd, new Map(), MODEL, { topLevel: true, adopt: { append } });

describe("warm restart: adopting the previous process's session", () => {
	after(() => rmSync(claudeDir, { recursive: true, force: true }));
	afterEach(() => {
		__test.resetSharedSession();
		__test.setSessionBranch(undefined);
		__test.setAppendSessionEntry?.(undefined);
	});

	it("resumes the recorded transcript, forked, when everything matches", () => withCwd((cwd) => {
		const prev = previousProcess(cwd);
		__test.setSessionBranch(() => branchWith(prev.pointer));
		const result = sync(prev.history, cwd);
		assert.equal(result.sessionId, prev.pointer.sessionId, "resumes the previous transcript");
		assert.equal(result.fork, true, "resumes it forked, so this process never writes the original");
		assert.ok(!result.fresh, "no rebuild: the transcript already holds the history");
		assert.equal(readFileSync(prev.jsonlPath, "utf8"), prev.bytes, "the previous transcript is untouched");
	}));

	it("rebuilds when Pi's history no longer starts with what the transcript holds", () => withCwd((cwd) => {
		const prev = previousProcess(cwd);
		__test.setSessionBranch(() => branchWith(prev.pointer));
		const edited = [user("one (edited)"), ...prev.history.slice(1)];
		const result = sync(edited, cwd);
		assert.notEqual(result.sessionId, prev.pointer.sessionId);
		assert.equal(result.fresh, true);
		assert.ok(!result.fork);
	}));

	it("rebuilds after a saved rewrite since the pointer", () => withCwd((cwd) => {
		const prev = previousProcess(cwd);
		__test.setSessionBranch(() => branchWith(prev.pointer, { id: "c1", type: "compaction" }));
		const result = sync(prev.history, cwd);
		assert.notEqual(result.sessionId, prev.pointer.sessionId);
		assert.equal(result.fresh, true);
	}));

	it("rebuilds when the verified append prompt differs from the transcript's snapshot", () => withCwd((cwd) => {
		const prev = previousProcess(cwd);
		__test.setSessionBranch(() => branchWith(prev.pointer));
		const result = sync(prev.history, cwd, "Project policy v2.");
		assert.notEqual(result.sessionId, prev.pointer.sessionId);
		assert.equal(result.fresh, true);
	}));

	it("rebuilds when the transcript is gone", () => withCwd((cwd) => {
		const prev = previousProcess(cwd);
		rmSync(prev.jsonlPath);
		__test.setSessionBranch(() => branchWith(prev.pointer));
		const result = sync(prev.history, cwd);
		assert.notEqual(result.sessionId, prev.pointer.sessionId);
		assert.equal(result.fresh, true);
	}));

	it("rebuilds when the transcript went on past the recorded turn", () => withCwd((cwd) => {
		// The old process died mid-turn after Claude Code took the next prompt.
		const prev = previousProcess(cwd);
		appendFileSync(prev.jsonlPath, `${JSON.stringify({ type: "user", uuid: "ffffffff-0000-4000-8000-000000000000", message: { role: "user", content: "unseen" } })}\n`);
		__test.setSessionBranch(() => branchWith(prev.pointer));
		const result = sync(prev.history, cwd);
		assert.notEqual(result.sessionId, prev.pointer.sessionId);
		assert.equal(result.fresh, true);
	}));

	it("rebuilds when the transcript does not hold the recorded turn", () => withCwd((cwd) => {
		const prev = previousProcess(cwd);
		__test.setSessionBranch(() => branchWith({ ...prev.pointer, tail: "eeeeeeee-0000-4000-8000-000000000000" }));
		const result = sync(prev.history, cwd);
		assert.notEqual(result.sessionId, prev.pointer.sessionId);
		assert.equal(result.fresh, true);
	}));

	it("rebuilds when Pi holds more than the final assistant message past the pointer", () => withCwd((cwd) => {
		const prev = previousProcess(cwd);
		__test.setSessionBranch(() => branchWith(prev.pointer));
		const history = [...prev.history.slice(0, -1), user("three"), assistant("A3"), user("four")];
		const result = sync(history, cwd);
		assert.notEqual(result.sessionId, prev.pointer.sessionId);
		assert.equal(result.fresh, true);
	}));

	it("never deletes the adopted transcript when a later rebuild replaces it", () => withCwd((cwd) => {
		const prev = previousProcess(cwd);
		__test.setSessionBranch(() => branchWith(prev.pointer));
		sync(prev.history, cwd);
		__test.setSharedSession({ ...__test.getSharedSession(), needsRebuild: true });
		const rebuilt = sync([...prev.history, assistant("A3"), user("four")], cwd);
		assert.notEqual(rebuilt.sessionId, prev.pointer.sessionId, "a session of our own");
		assert.equal(readFileSync(prev.jsonlPath, "utf8"), prev.bytes, "the original is untouched");
	}));

	it("does not adopt for a nested query", () => withCwd((cwd) => {
		const prev = previousProcess(cwd);
		__test.setSessionBranch(() => branchWith(prev.pointer));
		const result = __test.syncSharedSession(prev.history, cwd, new Map(), MODEL, { topLevel: false });
		assert.notEqual(result.sessionId, prev.pointer.sessionId);
	}));
});

describe("warm restart: recording the session", () => {
	afterEach(() => {
		__test.resetSharedSession();
		__test.setSessionBranch(undefined);
		__test.setAppendSessionEntry?.(undefined);
	});

	const owned = (sessionId, cursor, history) => ({
		sessionId, cursor, cwd: "/x", prefix: prefixDigest(history, cursor), epoch: "", tail: `tail-${cursor}`,
	});

	it("writes one pointer per change, none when nothing moved", () => {
		const writes = [];
		__test.setAppendSessionEntry((customType, data) => writes.push({ customType, data }));
		const id = "44444444-aaaa-4aaa-8aaa-444444444444";
		const history = [user("one"), assistant("A1"), user("two"), assistant("A2"), user("three")];
		__test.notePromptSnapshot(id, POLICY);
		__test.setSharedSession(owned(id, 3, history));
		__test.persistSharedSession();
		__test.persistSharedSession();
		assert.equal(writes.length, 1, "an unchanged session writes nothing");
		assert.equal(writes[0].customType, "claude-bridge-session");
		assert.deepEqual(writes[0].data, {
			v: 1, sessionId: id, cursor: 3, prefix: prefixDigest(history, 3), appendDigest: digestOf(POLICY), tail: "tail-3", epoch: "",
		});
		__test.setSharedSession(owned(id, 5, history));
		__test.persistSharedSession();
		assert.equal(writes.length, 2, "an advanced session writes again");
		assert.equal(writes[1].data.cursor, 5);
	});

	it("writes nothing for a session whose prompt snapshot it does not know, or that it does not own", () => {
		const writes = [];
		__test.setAppendSessionEntry((customType, data) => writes.push({ customType, data }));
		const history = [user("one"), assistant("A1"), user("two")];
		__test.setSharedSession(owned("55555555-aaaa-4aaa-8aaa-555555555555", 3, history));
		__test.persistSharedSession();
		const adopted = "66666666-aaaa-4aaa-8aaa-666666666666";
		__test.notePromptSnapshot(adopted, POLICY);
		__test.setSharedSession({ ...owned(adopted, 3, history), fork: true });
		__test.persistSharedSession();
		assert.equal(writes.length, 0);
	});

	it("records at agent_end through Pi's appendEntry, once per change", () => {
		const handlers = new Map();
		const appended = [];
		activate({
			on: (event, handler) => handlers.set(event, handler),
			registerProvider: () => {},
			appendEntry: (customType, data) => appended.push({ customType, data }),
		});
		handlers.get("session_start")({ reason: "startup" }, {
			ui: { notify: () => {} }, mode: "rpc",
			sessionManager: { getSessionId: () => "pi-session", getBranch: () => [] },
		});
		const id = "77777777-aaaa-4aaa-8aaa-777777777777";
		const history = [user("one"), assistant("A1"), user("two")];
		__test.notePromptSnapshot(id, POLICY);
		__test.setSharedSession(owned(id, 3, history));
		handlers.get("agent_end")({});
		handlers.get("agent_end")({});
		assert.equal(appended.length, 1);
		assert.equal(appended[0].data.sessionId, id);
		handlers.get("session_shutdown")({ reason: "quit" });
	});

	it("records a fork under its own id once its first query completes", () => withCwd((cwd) => {
		const writes = [];
		__test.setAppendSessionEntry((customType, data) => writes.push({ customType, data }));
		const prev = previousProcess(cwd);
		__test.setSessionBranch(() => branchWith(prev.pointer));
		sync(prev.history, cwd);
		__test.persistSharedSession();
		assert.equal(writes.length, 0, "nothing while the session is still the previous process's");
		const forkedId = "88888888-aaaa-4aaa-8aaa-888888888888";
		__test.advanceSharedSession(forkedId, prev.history, prev.history.length, cwd, "", "fork-tail");
		__test.notePromptSnapshot(forkedId, POLICY);
		__test.persistSharedSession();
		assert.equal(writes.length, 1);
		assert.equal(writes[0].data.sessionId, forkedId);
		assert.equal(writes[0].data.tail, "fork-tail");
		assert.equal(__test.getSharedSession().fork, undefined, "the fork is ours: later resumes write it directly");
	}));
});
