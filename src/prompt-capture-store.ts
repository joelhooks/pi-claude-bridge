import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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

export function savePromptCaptures(sessionId: string | undefined, carrier: PromptCaptureCarrier): boolean {
	const path = sessionId ? capturePath(sessionId) : undefined;
	if (!path || carrier.captures.length === 0) return false;
	mkdirSync(promptCaptureDir(), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(carrier), { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
	return true;
}

export function loadPromptCaptures(sessionId: string | undefined): PromptCaptureCarrier | undefined {
	const path = sessionId ? capturePath(sessionId) : undefined;
	if (!path) return undefined;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const parsed: unknown = JSON.parse(raw);
	return isPromptCaptureCarrier(parsed) ? parsed : undefined;
}

/** Drop captures for sessions nobody has touched in a month. Best effort. */
export function prunePromptCaptures(now = Date.now()): void {
	const dir = promptCaptureDir();
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const path = join(dir, name);
		try {
			if (now - statSync(path).mtimeMs > MAX_AGE_MS) rmSync(path, { force: true });
		} catch {
			// Another process may have removed it first.
		}
	}
}
