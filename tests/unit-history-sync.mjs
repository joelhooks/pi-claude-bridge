/**
 * History rewrites that Pi makes without `session_compact`.
 *
 * Pi 1.x lets an extension replace an earlier message (`context_edit`) or compact
 * at a turn boundary (`turn_end`, `agent_before_settle`). Neither fires an event
 * the bridge sees, and the bridge used to resume Claude Code's stored transcript
 * whenever the message count allowed it: an in-place edit never reached the
 * model, and a shortened history started Claude Code with no history at all.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "cc-session-io";
import { ctx } from "../src/query-state.js";

const { default: activate, __test } = await import("../src/index.js");

const TOP = { topLevel: true };
const NESTED = { topLevel: false };

let clock = 1_000;
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const assistant = (text) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages", provider: "claude-bridge", model: "claude-opus-5-5",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
	stopReason: "stop", timestamp: clock++,
});
// What Pi hands the provider after rebuilding its messages from the session
// projection: new objects, same conversation, fresh bookkeeping.
const reprojected = (message) => ({ ...message, timestamp: clock++, ...(message.usage ? { usage: { ...message.usage, cacheRead: 7 } } : {}) });

function transcriptText(sessionId, cwd) {
	return JSON.stringify(openSession({ sessionId, projectPath: cwd }).messages);
}

function withCwd(run) {
	const cwd = mkdtempSync(join(tmpdir(), "history-sync-"));
	try { return run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

function mockPi() {
	const handlers = new Map();
	const channels = new Map();
	const emitted = [];
	const events = {
		on(channel, handler) {
			const list = channels.get(channel) ?? [];
			list.push(handler);
			channels.set(channel, list);
			return () => channels.set(channel, (channels.get(channel) ?? []).filter((h) => h !== handler));
		},
		emit(channel, data) {
			emitted.push({ channel, data });
			for (const handler of channels.get(channel) ?? []) handler(data);
		},
	};
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {}, events });
	return { handlers, events, emitted };
}

const bridgeCtx = { model: { baseUrl: "claude-bridge" }, ui: { notify: () => {} } };
// No `settings`: when the takeover does run, Pi's compact() fails on
// settings.reserveTokens before any model call, and the handler cancels. So
// "ran" shows up as { cancel: true } without spawning Claude Code.
const compactEvent = () => ({
	reason: "threshold", willRetry: false, branchEntries: [], signal: new AbortController().signal,
	preparation: { messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, fileOps: { read: new Set(), edited: new Set() } },
});

describe("content-aware session reuse", () => {
	afterEach(() => __test.resetSharedSession());

	it("rebuilds when an earlier message is replaced in place, and Claude Code gets the replacement", () => withCwd((cwd) => {
		const history = [user("deploy to staging"), assistant("done"), user("now prod"), assistant("done too"), user("status?")];
		const first = __test.syncSharedSession(history, cwd, undefined, undefined, TOP);
		assert.ok(first.sessionId);

		const edited = [user("[edited] deploy to the canary only"), ...history.slice(1)];
		const next = __test.syncSharedSession(edited, cwd, undefined, undefined, TOP);

		assert.equal(next.sessionId, first.sessionId, "rebuilt in place, same Claude Code session id");
		assert.match(transcriptText(next.sessionId, cwd), /deploy to the canary only/, "the replacement must reach Claude Code");
		assert.doesNotMatch(transcriptText(next.sessionId, cwd), /deploy to staging/);
	}));

	it("rebuilds from a shortened history instead of starting Claude Code with none", () => withCwd((cwd) => {
		const history = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")];
		const first = __test.syncSharedSession(history, cwd, undefined, undefined, TOP);

		// A retain-none compaction appended at a turn boundary: one summary, then the new prompt.
		const compacted = [user("Summary of the conversation so far: a, b, c, d."), assistant("ok"), user("continue")];
		const next = __test.syncSharedSession(compacted, cwd, undefined, undefined, TOP);

		assert.equal(next.preserveSharedSession, undefined, "a top-level call must not take the subagent clean start");
		assert.equal(next.sessionId, first.sessionId);
		assert.match(transcriptText(next.sessionId, cwd), /Summary of the conversation so far/);
		assert.equal(__test.getSharedSession().cursor, 2);
	}));

	it("still gives a nested query with a shorter history its own clean start, leaving the parent's session alone", () => withCwd((cwd) => {
		const history = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")];
		__test.syncSharedSession(history, cwd, undefined, undefined, TOP);
		const parent = __test.getSharedSession();

		const result = __test.syncSharedSession([user("Summarize this diff.")], cwd, undefined, undefined, NESTED);

		assert.equal(result.sessionId, null);
		assert.equal(result.preserveSharedSession, true);
		assert.deepEqual(__test.getSharedSession(), parent);
	}));

	it("gives a nested query with different history of the same length a clean start rather than the parent's transcript", () => withCwd((cwd) => {
		const history = [user("a"), assistant("b"), user("c")];
		__test.syncSharedSession(history, cwd, undefined, undefined, TOP);
		const parent = __test.getSharedSession();

		const result = __test.syncSharedSession([user("other"), assistant("work"), user("go")], cwd, undefined, undefined, NESTED);

		assert.equal(result.sessionId, null);
		assert.equal(result.preserveSharedSession, true);
		assert.deepEqual(__test.getSharedSession(), parent);
	}));

	it("keeps resuming across a plain append, including after Pi re-projects the same messages", () => withCwd((cwd) => {
		const history = [user("a"), assistant("b"), user("c")];
		const first = __test.syncSharedSession(history, cwd, undefined, undefined, TOP);
		// The query finished: Claude Code's transcript now covers the prompt too.
		__test.advanceSharedSession(first.sessionId, history, history.length, cwd);

		const next = [...history.map(reprojected), assistant("d"), user("e")];
		const result = __test.syncSharedSession(next, cwd, undefined, undefined, TOP);

		assert.equal(result.sessionId, first.sessionId);
		assert.equal(__test.getSharedSession().cursor, 4, "advanced past the trailing assistant reply");
		assert.equal(__test.sharedPrefixChanged(next), false);
	}));

	it("notices a rewrite under a live query before feeding it tool results", () => withCwd((cwd) => {
		const history = [user("a"), assistant("b"), user("c")];
		const first = __test.syncSharedSession(history, cwd, undefined, undefined, TOP);
		__test.advanceSharedSession(first.sessionId, history, history.length, cwd);

		assert.equal(__test.sharedPrefixChanged([...history, assistant("call"), user("result")]), false);
		assert.equal(__test.sharedPrefixChanged([user("[edited] a"), ...history.slice(1)]), true, "same count, edited");
		assert.equal(__test.sharedPrefixChanged([user("summary"), user("c")]), true, "shortened");
	}));
});

describe("flowing-view boundary signal", () => {
	afterEach(() => {
		__test.resetSharedSession();
		ctx().teardown = null;
		__test.consumeMidTurnContinuation();
	});

	it("marks a rebuild, tears down the live query and continues mid-turn, like session_compact", async () => {
		const { events } = mockPi();
		__test.setSharedSession({ sessionId: "11111111-1111-4111-8111-111111111111", cursor: 4, cwd: "/x" });
		let tornDown = 0;
		ctx().teardown = async () => { tornDown++; };

		events.emit("flowing-view:boundary", { v: 1, lineage: "l", hash: "h", reason: "batch", midTurn: true });
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(__test.getSharedSession().needsRebuild, true);
		assert.equal(tornDown, 1);
		assert.match(__test.consumeMidTurnContinuation() ?? "", /flowing-view:boundary/);
	});
});

describe("compaction claim", () => {
	it("defers the compaction takeover while another extension holds a claim", async () => {
		const { handlers, events } = mockPi();
		const before = handlers.get("session_before_compact");

		events.emit("compaction:claim", { owner: "pi-flowing-view" });
		assert.equal(await before(compactEvent(), bridgeCtx), undefined, "the claimant compacts; the bridge must not spawn Claude Code");

		events.emit("compaction:release", { owner: "pi-flowing-view" });
		assert.deepEqual(await before(compactEvent(), bridgeCtx), { cancel: true }, "without a claim the takeover runs again");
	});

	it("drops claims at session shutdown so a crashed claimant cannot switch the takeover off for good", async () => {
		const { handlers, events } = mockPi();
		events.emit("compaction:claim", { owner: "pi-flowing-view" });
		await handlers.get("session_shutdown")({ reason: "quit" });
		assert.deepEqual(await handlers.get("session_before_compact")(compactEvent(), bridgeCtx), { cancel: true });
	});
});

describe("capability handshake", () => {
	const capabilities = (emitted) => emitted.filter((e) => e.channel === "claude-bridge:capabilities").map((e) => e.data);

	it("answers each query with one capabilities message", () => {
		const { events, emitted } = mockPi();
		events.emit("claude-bridge:capabilities?", { v: 1 });
		assert.deepEqual(capabilities(emitted), [{ v: 1, historyRewrite: 1, boundaryEvent: "flowing-view:boundary", compactionClaim: true }]);
	});

	it("announces itself at session start", async () => {
		const { handlers, emitted } = mockPi();
		await handlers.get("session_start")({ reason: "startup" }, { ui: {}, mode: "tui", sessionManager: { getSessionId: () => "s1" } });
		assert.equal(capabilities(emitted).length, 1);
	});
});
