import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PromptCaptureSnapshot } from "./prompt-capture.js";

// Per-session prompt captures on disk, so a resumed or restarted Pi process can
// serve a timer/intercom wake before anyone types. A wake skips
// before_agent_start, so without this the first wake after a restart has nothing
// to resolve against and fails closed — and a headless lane that is only ever
// woken never recovers. /reload keeps using the in-memory carrier; this covers
// every path where the process itself is new.
//
// The file holds assembled system prompts, so it is private (0600) and lives
// beside Pi's own session state rather than in the project.

export type WakePrompt = {
	basePrompt: string;
	assembledPrompt: string;
	/** Final typed native prompt, verified against live ordinary-turn options. */
	nativePrompt?: string;
};
export type PromptCaptureCarrier = { version: 1; captures: PromptCaptureSnapshot[]; wakePrompt?: WakePrompt };

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PRUNE_MARKER = ".last-prune";

export const isPromptCaptureCarrier = (value: unknown): value is PromptCaptureCarrier =>
	typeof value === "object"
	&& value !== null
	&& (value as { version?: unknown }).version === 1
	&& Array.isArray((value as { captures?: unknown }).captures);

export function promptCaptureDir(): string {
	return process.env.CLAUDE_BRIDGE_CAPTURE_DIR || join(homedir(), ".pi", "agent", "claude-bridge", "prompt-captures");
}

/** Session ids are Pi's own (uuid-like); anything else is refused rather than
 *  sanitized, so a hostile id can never address a path outside the directory. */
function capturePath(sessionId: string): string | undefined {
	return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? join(promptCaptureDir(), `${sessionId}.json`) : undefined;
}

/** Latest unwritten (or in-flight) snapshot per file. Writes run off the main
 *  thread: during APFS metadata stalls a synchronous rename froze the whole Pi
 *  for 30-68 s (2026-10-06). One writer per file; newer saves replace queued
 *  ones, so only the latest snapshot is written. */
const pendingWrites = new Map<string, { latest: string; queued: boolean }>();
let exitFlushArmed = false;

export function savePromptCaptures(sessionId: string | undefined, carrier: PromptCaptureCarrier): boolean {
	const path = sessionId ? capturePath(sessionId) : undefined;
	if (!path || carrier.captures.length === 0) return false;
	const latest = JSON.stringify(carrier);
	const slot = pendingWrites.get(path);
	if (slot) {
		slot.latest = latest;
		slot.queued = true;
	} else {
		const fresh = { latest, queued: true };
		pendingWrites.set(path, fresh);
		void drainWrites(path, fresh);
	}
	armExitFlush();
	return true;
}

async function drainWrites(path: string, slot: { latest: string; queued: boolean }): Promise<void> {
	while (slot.queued) {
		slot.queued = false;
		const text = slot.latest;
		const tmp = `${path}.${process.pid}.tmp`;
		try {
			await mkdir(promptCaptureDir(), { recursive: true, mode: 0o700 });
			await writeFile(tmp, text, { mode: 0o600 });
			await chmod(tmp, 0o600);
			await rename(tmp, path);
		} catch {
			// Best effort, as before: a failed write costs only the restart-wake path.
		}
	}
	pendingWrites.delete(path);
}

/** Process exit can't await. Flush whatever is still unwritten synchronously,
 *  only here, so a restart keeps the last turn's captures. */
function armExitFlush(): void {
	if (exitFlushArmed) return;
	exitFlushArmed = true;
	process.once("exit", () => {
		for (const [path, slot] of pendingWrites) {
			const tmp = `${path}.${process.pid}.exit.tmp`;
			try {
				mkdirSync(promptCaptureDir(), { recursive: true, mode: 0o700 });
				writeFileSync(tmp, slot.latest, { mode: 0o600 });
				chmodSync(tmp, 0o600);
				renameSync(tmp, path);
			} catch {
				// Nothing more to do at exit.
			}
		}
	});
}

/** Resolves once every queued capture write has reached disk. */
export async function flushPromptCaptures(): Promise<void> {
	while (pendingWrites.size > 0) await new Promise((resolve) => setTimeout(resolve, 5));
}

export function loadPromptCaptures(sessionId: string | undefined): PromptCaptureCarrier | undefined {
	const path = sessionId ? capturePath(sessionId) : undefined;
	if (!path) return undefined;
	let raw: string;
	const pending = pendingWrites.get(path);
	if (pending) {
		const parsed: unknown = JSON.parse(pending.latest);
		return isPromptCaptureCarrier(parsed) ? parsed : undefined;
	}
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const parsed: unknown = JSON.parse(raw);
	return isPromptCaptureCarrier(parsed) ? parsed : undefined;
}

/** Drop captures for sessions nobody has touched in a week. Best effort and
 *  asynchronous: the directory holds a thousand-plus files, and statting them
 *  synchronously stalled every Pi startup by over a second. Runs at most once a
 *  day across all processes, using a marker file's mtime. Fire and forget. */
export function prunePromptCaptures(now = Date.now()): void {
	void prunePromptCapturesAsync(now).catch(() => {});
}

export async function prunePromptCapturesAsync(now: number): Promise<void> {
	const dir = promptCaptureDir();
	const marker = join(dir, PRUNE_MARKER);
	try {
		if (now - (await stat(marker)).mtimeMs < PRUNE_INTERVAL_MS) return;
	} catch {
		// No marker yet: prune now.
	}
	let names: string[];
	try {
		names = await readdir(dir);
		// Claim the slot first so concurrent startups don't all walk the directory.
		await writeFile(marker, "", { mode: 0o600 });
		await utimes(marker, now / 1000, now / 1000);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		try {
			if (now - (await stat(path)).mtimeMs > MAX_AGE_MS) await rm(path, { force: true });
		} catch {
			// Another process may have removed it first.
		}
	}
}
