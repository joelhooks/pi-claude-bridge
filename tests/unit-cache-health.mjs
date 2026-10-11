/**
 * diag/cache-health.mjs turns Pi session logs into a durable cache-health record
 * and pages on sessions that keep losing the prompt cache. 2026-10-10: one desk
 * re-wrote ~234K tokens on 245 goal continuations before anyone noticed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFullRewrite, scan } from "../diag/cache-health.mjs";

const NOW = Date.parse("2026-10-11T04:30:00Z");
const at = (minutes) => new Date(Date.parse("2026-10-11T04:00:00Z") + minutes * 60_000).toISOString();
const reply = (minutes, { read, write }) => JSON.stringify({ type: "message", timestamp: at(minutes),
	message: { role: "assistant", provider: "claude-bridge", model: "claude-opus-5-5", usage: { input: 2, output: 50, cacheRead: read, cacheWrite: write } } });
const goal = (minutes) => JSON.stringify({ type: "custom_message", customType: "pi-codex-goal", timestamp: at(minutes) });

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "cache-health-"));
	const sessions = join(root, "sessions", "--proj--");
	mkdirSync(sessions, { recursive: true });
	return { root, sessions, state: join(root, "state"), file: join(sessions, "2026-10-11T03-00-00-000Z_busy-desk.jsonl") };
}

describe("cache health", () => {
	it("counts a full rewrite only when most of a large prompt is re-written soon after the last request", () => {
		assert.equal(isFullRewrite(60_000, { cacheRead: 44_000, cacheWrite: 234_000 }), true);
		assert.equal(isFullRewrite(60_000, { cacheRead: 230_000, cacheWrite: 4_000 }), false, "a normal append");
		assert.equal(isFullRewrite(20 * 60_000, { cacheRead: 0, cacheWrite: 234_000 }), false, "expired TTL, not a rebuild");
		assert.equal(isFullRewrite(60_000, { cacheRead: 0, cacheWrite: 20_000 }), false, "too small to matter");
		assert.equal(isFullRewrite(undefined, { cacheRead: 0, cacheWrite: 234_000 }), false, "first request of a process");
	});

	it("alerts once per session and hour at the threshold, naming the trigger", () => {
		const f = fixture();
		const lines = [JSON.stringify({ type: "session_info", id: "a1", timestamp: at(0), name: "🏛️ Busy · owner" }), reply(0, { read: 0, write: 200_000 })];
		for (let i = 1; i <= 10; i++) lines.push(goal(i * 2 - 0.5), reply(i * 2, { read: 44_000, write: 200_000 + i }));
		writeFileSync(f.file, lines.join("\n") + "\n");
		const opts = { sessions: join(f.root, "sessions"), state: f.state, threshold: 10, host: "test", now: NOW };

		const first = scan(opts);
		assert.equal(first.events, 11);
		assert.equal(first.alerts.length, 1);
		assert.deepEqual({ ...first.alerts[0], at: undefined }, { v: 1, at: undefined, host: "test", session: "busy-desk", name: "🏛️ Busy · owner",
			hour: "2026-10-11T04:00Z", fullRewrites: 10, rewriteWriteTokens: 2_000_055, topTrigger: "pi-codex-goal" });
		const summary = JSON.parse(readFileSync(join(f.state, "summary.json"), "utf8"));
		assert.equal(summary.sessions[0].fullRewrites, 10);
		assert.equal(summary.sessions[0].writesPerRewrite, 200_006);

		appendFileSync(f.file, [goal(23), reply(24, { read: 44_000, write: 200_000 })].join("\n") + "\n");
		const second = scan({ ...opts, now: NOW + 600_000 });
		assert.equal(second.events, 1, "reads only what was appended");
		assert.equal(second.alerts.length, 0, "already paged for this hour");
		assert.equal(readFileSync(join(f.state, "alerts.jsonl"), "utf8").trim().split("\n").length, 1);
	});

	it("times gaps from the last request that reached Claude, and names wake recovery as the trigger", () => {
		const f = fixture();
		const parked = (minutes) => JSON.stringify({ type: "message", timestamp: at(minutes),
			message: { role: "assistant", provider: "claude-bridge", model: "claude-opus-5-5", content: [], stopReason: "stop",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
		const recovery = (minutes) => JSON.stringify({ type: "message", timestamp: at(minutes),
			message: { role: "user", content: "[claude-bridge] A delayed message above (timer, watch or intercom) arrived early." } });
		const note = (minutes) => JSON.stringify({ type: "custom_message", customType: "muster-owner-note", timestamp: at(minutes) });
		writeFileSync(f.file, [
			reply(0, { read: 0, write: 200_000 }),
			// Eight idle minutes: the cache expired, whatever the parked wake suggests.
			parked(8), recovery(8.01), note(8.02), reply(8.1, { read: 40_000, write: 200_000 }),
			// One minute later: a real rebuild, caused by the recovery.
			parked(9), recovery(9.01), note(9.02), reply(9.1, { read: 40_000, write: 200_000 }),
		].join("\n") + "\n");
		scan({ sessions: join(f.root, "sessions"), state: f.state, threshold: 10, host: "test", now: NOW });
		const events = readFileSync(join(f.state, "events-2026-10.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(events.length, 3, "a parked wake is not a request");
		assert.deepEqual(events.map((e) => e.full), [false, false, true]);
		assert.equal(events[2].trigger, "wake-recovery");
	});

	it("counts a forked session's copied history once", () => {
		const f = fixture();
		const history = [reply(0, { read: 0, write: 200_000 }), reply(1, { read: 199_000, write: 2_000 })];
		writeFileSync(f.file, history.join("\n") + "\n");
		writeFileSync(join(f.sessions, "2026-10-11T04-05-00-000Z_busy-desk-fork.jsonl"), [...history, reply(6, { read: 201_000, write: 1_000 })].join("\n") + "\n");
		const result = scan({ sessions: join(f.root, "sessions"), state: f.state, threshold: 10, host: "test", now: NOW });
		assert.equal(result.events, 3);
	});
});
