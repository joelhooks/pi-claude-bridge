/**
 * Wake recovery and Claude Code's prompt snapshot.
 *
 * Claude Code pins a session to the append prompt of its first query (a
 * `prompt_snapshot` in the transcript) and ignores the one a resume passes. A
 * recovered wake used to rebuild into a new session every time so that freshly
 * verified policy reached the wire. The rebuild re-imports the whole history,
 * which misses the prompt cache, and most recoveries carried the very policy
 * the session already held: ~300K cache-write tokens each on a busy desk. A
 * recovery now rebuilds only when the snapshot is unknown or differs.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { __test } = await import("../src/index.js");

const TOP = { topLevel: true };
let clock = 1_000;
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const assistant = (text) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages", provider: "claude-bridge", model: "claude-opus-5-5",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
	stopReason: "stop", timestamp: clock++,
});

function withCwd(run) {
	const cwd = mkdtempSync(join(tmpdir(), "recovery-snapshot-"));
	try { return run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

const POLICY = "Project policy v1.";

describe("wake recovery against the session's prompt snapshot", () => {
	afterEach(() => __test.resetSharedSession());

	it("resumes when the session's snapshot holds exactly the verified policy", () => {
		const session = { sessionId: "11111111-aaaa-4aaa-8aaa-111111111111", cursor: 4, cwd: "/x" };
		__test.notePromptSnapshot(session.sessionId, POLICY);
		assert.equal(__test.recoveryNeedsRebuild(session, POLICY), false);
	});

	it("rebuilds when the policy changed since the snapshot", () => {
		const session = { sessionId: "22222222-aaaa-4aaa-8aaa-222222222222", cursor: 4, cwd: "/x" };
		__test.notePromptSnapshot(session.sessionId, POLICY);
		assert.equal(__test.recoveryNeedsRebuild(session, "Project policy v2."), true);
	});

	it("rebuilds when this process never saw the session's snapshot", () => {
		const session = { sessionId: "33333333-aaaa-4aaa-8aaa-333333333333", cursor: 4, cwd: "/x" };
		assert.equal(__test.recoveryNeedsRebuild(session, POLICY), true);
	});

	it("marks a clean start and a rebuild as fresh transcripts, and a resume as not", () => withCwd((cwd) => {
		const first = [user("one")];
		assert.equal(__test.syncSharedSession(first, cwd, new Map(), "claude-opus-5-5", TOP).fresh, true, "clean start");
		const history = [user("one"), assistant("A1"), user("two")];
		const built = __test.syncSharedSession(history, cwd, new Map(), "claude-opus-5-5", TOP);
		assert.equal(built.fresh, true, "first rebuild from priors");
		__test.advanceSharedSession(built.sessionId, history, history.length, cwd);
		const resumed = __test.syncSharedSession([...history, assistant("A2"), user("three")], cwd, new Map(), "claude-opus-5-5", TOP);
		assert.equal(resumed.sessionId, built.sessionId);
		assert.ok(!resumed.fresh, "a resume keeps the existing snapshot");
	}));

	it("forgets the snapshot when a rebuild rewrites the session in place", () => withCwd((cwd) => {
		const history = [user("one"), assistant("A1"), user("two")];
		const built = __test.syncSharedSession(history, cwd, new Map(), "claude-opus-5-5", TOP);
		__test.advanceSharedSession(built.sessionId, history, history.length, cwd);
		__test.notePromptSnapshot(built.sessionId, POLICY);
		__test.setSharedSession({ ...__test.getSharedSession(), needsRebuild: true });
		const rebuilt = __test.syncSharedSession([...history, assistant("A2"), user("three")], cwd, new Map(), "claude-opus-5-5", TOP);
		assert.equal(rebuilt.sessionId, built.sessionId, "in-place rebuild keeps the id");
		assert.equal(__test.recoveryNeedsRebuild(__test.getSharedSession(), POLICY), true);
	}));
});
