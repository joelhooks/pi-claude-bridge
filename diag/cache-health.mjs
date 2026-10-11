#!/usr/bin/env node
// Prompt-cache health, tracked over time from Pi's own session logs.
//
// audit-cache.mjs reads the bridge debug log, which is off by default. This reads
// what every Pi already writes: one usage block per assistant message. A request
// that re-writes more than half of a large prompt within five minutes of the
// previous request lost the cache to a rebuild or a changed prefix, whatever the
// cause; under the five-minute TTL nothing else explains it. Those are the
// requests worth paging on.
//
//   node diag/cache-health.mjs [--sessions DIR] [--state DIR] [--threshold N] [--host NAME] [--lookback HOURS]
// --lookback applies to the first run only (default 2): older history is skipped.
//
// Incremental: remembers a byte offset per session file, so a run reads only
// what was appended since the last one. Writes, under the state directory:
//   events-YYYY-MM.jsonl  one line per claude-bridge request
//   summary.json          the last 24 hours, per session and UTC hour
//   alerts.jsonl          append-only: a session with --threshold or more full
//                         rewrites in one UTC hour, once per session and hour
// Exits 0; a breach is data, not a failure.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";

const FULL_REWRITE = { maxGapMs: 5 * 60_000, minPrompt: 50_000, minShare: 0.5 };
const WAKE_RECOVERY_MARK = "[claude-bridge] A delayed message above";
const FIRST_RUN_LOOKBACK_MS = 2 * 3600_000;
const SEEN_TTL_MS = 48 * 3600_000;

function args(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
	return {
		sessions: out.sessions ?? join(homedir(), ".pi/agent/sessions"),
		state: out.state ?? join(homedir(), ".local/state/claude-cache-health"),
		threshold: Number(out.threshold ?? 10),
		host: out.host ?? hostname().split(".")[0],
		now: out.now ? Date.parse(out.now) : Date.now(),
		lookbackMs: Number(out.lookback ?? 2) * 3600_000,
	};
}

/** True when this request lost the cache: most of a large prompt re-written soon after the last request. */
export function isFullRewrite(gapMs, usage) {
	const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	return gapMs !== undefined && gapMs <= FULL_REWRITE.maxGapMs
		&& prompt > FULL_REWRITE.minPrompt && (usage.cacheWrite ?? 0) > FULL_REWRITE.minShare * prompt;
}

// Session files are named <iso-time>_<session-name>.jsonl.
const sessionName = (file) => basename(file, ".jsonl").replace(/^[^_]*_/, "");

// Session files reach hundreds of megabytes, and a fork starts as a full copy of
// its parent, so read appended bytes in bounded chunks. Returns the offset just
// past the last complete line.
const CHUNK = 4 * 1024 * 1024;
function forEachAppendedLine(file, offset, onLine) {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size;
		if (size < offset) offset = 0; // rewritten or replaced
		let pos = offset;
		let carry = Buffer.alloc(0);
		const buf = Buffer.alloc(CHUNK);
		while (pos < size) {
			const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
			if (n <= 0) break;
			pos += n;
			let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
			let start = 0;
			for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
				onLine(data.toString("utf8", start, nl));
				offset += nl - start + 1;
				start = nl + 1;
			}
			carry = Buffer.from(data.subarray(start));
		}
		return offset;
	} finally {
		closeSync(fd);
	}
}

export function scan(opts) {
	mkdirSync(opts.state, { recursive: true, mode: 0o700 });
	const statePath = join(opts.state, "state.json");
	const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { files: {}, seen: {}, alerted: {} };
	state.names ??= {};
	const firstRun = Object.keys(state.files).length === 0;
	const since = firstRun ? opts.now - (opts.lookbackMs ?? FIRST_RUN_LOOKBACK_MS) : 0;
	const events = [];

	for (const dir of existsSync(opts.sessions) ? readdirSync(opts.sessions) : []) {
		const full = join(opts.sessions, dir);
		let names;
		try { names = readdirSync(full).filter((name) => name.endsWith(".jsonl")); } catch { continue; }
		for (const name of names) {
			const file = join(full, name);
			const fileState = state.files[file] ?? { offset: 0 };
			if (statSync(file).mtimeMs < since && !state.files[file]) {
				state.files[file] = { offset: statSync(file).size };
				continue;
			}
			const offset = forEachAppendedLine(file, fileState.offset, (line) => {
				// The session's display name (its callsign), so an alert says who it is.
				if (line.startsWith('{"type":"session_info"')) {
					try { const name = JSON.parse(line).name; if (name) state.names[sessionName(file)] = name; } catch {}
					return;
				}
				// Cheap prefilter: only messages matter, and most bytes are tool output.
				if (!line.includes('message"')) return; // "message" and "custom_message"
				let entry;
				try { entry = JSON.parse(line); } catch { return; }
				const message = entry.message;
				if (message?.role !== "assistant" || message.provider !== "claude-bridge") {
					// The bridge's wake-recovery prompt names the cause; notes that follow it don't.
					if (message?.role === "user" && line.includes(WAKE_RECOVERY_MARK)) fileState.trigger = "wake-recovery";
					else if ((entry.type === "message" || entry.type === "custom_message") && fileState.trigger !== "wake-recovery") {
						fileState.trigger = entry.customType ?? message?.role ?? entry.type;
					}
					return;
				}
				const t = Date.parse(entry.timestamp);
				const usage = message.usage ?? {};
				// No tokens means nothing reached Claude (a parked wake, a turn refused
				// before sending): not a request, and no reason the cache stayed warm.
				if (!((usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0))) return;
				const gapMs = fileState.lastT === undefined ? undefined : t - fileState.lastT;
				const full = isFullRewrite(gapMs, usage);
				const trigger = fileState.trigger ?? "start";
				fileState.lastT = t;
				fileState.trigger = "toolResult";
				// A fork copies its parent's entries: count each request once.
				const key = `${entry.timestamp}|${usage.cacheWrite ?? 0}|${usage.output ?? 0}`;
				if (state.seen[key] !== undefined || t < since) return;
				state.seen[key] = t;
				events.push({
					t: entry.timestamp, host: opts.host, session: sessionName(file), model: message.model,
					prompt: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
					read: usage.cacheRead ?? 0, write: usage.cacheWrite ?? 0, output: usage.output ?? 0,
					full, ...(full ? { trigger } : {}),
				});
			});
			fileState.offset = offset;
			state.files[file] = fileState;
		}
	}

	for (const [key, t] of Object.entries(state.seen)) if (opts.now - t > SEEN_TTL_MS) delete state.seen[key];
	for (const e of events) {
		appendFileSync(join(opts.state, `events-${e.t.slice(0, 7)}.jsonl`), JSON.stringify(e) + "\n");
	}

	const summary = summarize(opts, state.names);
	const alerts = [];
	for (const row of summary.sessions) {
		const key = `${row.host}|${row.session}|${row.hour}`;
		if (row.fullRewrites < opts.threshold || state.alerted[key]) continue;
		state.alerted[key] = opts.now;
		alerts.push({ v: 1, at: new Date(opts.now).toISOString(), host: row.host, session: row.session, name: row.name, hour: row.hour,
			fullRewrites: row.fullRewrites, rewriteWriteTokens: row.rewriteWriteTokens, topTrigger: row.topTrigger });
	}
	for (const [key, at] of Object.entries(state.alerted)) if (opts.now - at > SEEN_TTL_MS) delete state.alerted[key];
	for (const alert of alerts) appendFileSync(join(opts.state, "alerts.jsonl"), JSON.stringify(alert) + "\n");

	writeAtomic(join(opts.state, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
	writeAtomic(statePath, JSON.stringify(state) + "\n");
	return { events: events.length, alerts };
}

/** Per session and UTC hour over the last 24 hours of events. */
export function summarize(opts, names = {}) {
	const cutoff = opts.now - 24 * 3600_000;
	const months = new Set([new Date(cutoff).toISOString().slice(0, 7), new Date(opts.now).toISOString().slice(0, 7)]);
	const rows = new Map();
	for (const month of months) {
		const path = join(opts.state, `events-${month}.jsonl`);
		if (!existsSync(path)) continue;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line) continue;
			const e = JSON.parse(line);
			if (Date.parse(e.t) < cutoff) continue;
			const hour = `${e.t.slice(0, 13)}:00Z`;
			const key = `${e.host}|${e.session}|${hour}`;
			const row = rows.get(key) ?? { host: e.host, session: e.session, hour, requests: 0, fullRewrites: 0,
				promptTokens: 0, readTokens: 0, writeTokens: 0, rewriteWriteTokens: 0, triggers: {} };
			row.requests++; row.promptTokens += e.prompt; row.readTokens += e.read; row.writeTokens += e.write;
			if (e.full) {
				row.fullRewrites++; row.rewriteWriteTokens += e.write;
				row.triggers[e.trigger] = (row.triggers[e.trigger] ?? 0) + 1;
			}
			rows.set(key, row);
		}
	}
	const sessions = [...rows.values()].map((row) => ({
		...row,
		name: names[row.session] ?? null,
		hitPct: row.promptTokens ? Math.round(row.readTokens / row.promptTokens * 1000) / 10 : null,
		writesPerRewrite: row.fullRewrites ? Math.round(row.rewriteWriteTokens / row.fullRewrites) : null,
		topTrigger: Object.entries(row.triggers).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
	})).sort((a, b) => b.hour.localeCompare(a.hour) || b.fullRewrites - a.fullRewrites);
	const total = sessions.reduce((acc, r) => ({ requests: acc.requests + r.requests, fullRewrites: acc.fullRewrites + r.fullRewrites,
		promptTokens: acc.promptTokens + r.promptTokens, readTokens: acc.readTokens + r.readTokens,
		writeTokens: acc.writeTokens + r.writeTokens, rewriteWriteTokens: acc.rewriteWriteTokens + r.rewriteWriteTokens }),
		{ requests: 0, fullRewrites: 0, promptTokens: 0, readTokens: 0, writeTokens: 0, rewriteWriteTokens: 0 });
	return { v: 1, generatedAt: new Date(opts.now).toISOString(), threshold: opts.threshold, last24h: total, sessions };
}

function writeAtomic(path, text) {
	writeFileSync(`${path}.tmp`, text);
	renameSync(`${path}.tmp`, path);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const result = scan(args(process.argv.slice(2)));
	console.log(JSON.stringify({ events: result.events, alerts: result.alerts.length }));
}
