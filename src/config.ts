// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/claude-bridge.json)
// and the project Pi config directory, project overriding global. Missing or
// unparseable files are ignored (error to console.error, empty object
// returned) so the extension always starts.

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { parseProviderEnv, type ProviderEnv } from "./provider-env.js";

export interface Config {
	/** Date (YYYY-MM-DD) the one-time startup notice was shown. Written by the extension, not the user. */
	startupNoticeShown?: string;
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		strictMcpConfig?: boolean;
		autoMemoryEnabled?: boolean;
		pathToClaudeCodeExecutable?: string;
		/** Spawn-only overlay; string literals or time-bounded agent-secrets leases. */
		env?: ProviderEnv;
		// Subscription plan tier. Setting to "max" enables Opus 4.6 at 1M context
		plan?: "pro" | "max";
		// Set to true to opt into metered 1M context usage ("extra usage" in
		// Anthropic billing). Enables Sonnet 4.6 [1m] on every plan and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
	};
}

export function tryParseJson(path: string, failClosed = false): Partial<Config> {
	const unavailable = (): Partial<Config> => {
		// Never quote parse/read errors or config contents.
		if (failClosed) throw new Error("claude-bridge: config unavailable");
		console.error(`claude-bridge: failed to parse ${path}`);
		return {};
	};
	// Only a missing directory entry is absent. A dangling symlink or a file
	// disappearing between this check and the read must fail closed at spawn.
	try { lstatSync(path); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		return unavailable();
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		if (failClosed && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) return unavailable();
		return parsed;
	} catch { return unavailable(); }
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-bridge.json");
}

/** Record today's date in the global config so the startup notice shows once, preserving every
 *  other field. Returns the config path for display either way.
 *
 *  Parses directly rather than through tryParseJson, which reports an unparseable file as `{}`:
 *  spreading that would replace a user's whole config with just this marker the first time they
 *  leave a trailing comma in it. Losing the notice is the cheaper failure, so the write is
 *  skipped and the notice simply shows again next session. */
export function markStartupNoticeShown(): string {
	const path = globalConfigPath();
	let existing: Partial<Config> = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			console.error(`claude-bridge: leaving ${path} alone, it does not parse`);
			return path;
		}
	}
	// en-CA renders YYYY-MM-DD in local time; toISOString() would report UTC.
	const next = { ...existing, startupNoticeShown: new Date().toLocaleDateString("en-CA") };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return path;
}

export function loadConfig(cwd: string, failClosed = false): Config {
	const global = tryParseJson(globalConfigPath(), failClosed);
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"), failClosed);
	// Validate both layers before merging: project overrides do not hide bad references.
	const globalEnv = parseProviderEnv(global.provider?.env);
	const projectEnv = parseProviderEnv(project.provider?.env);
	const env = globalEnv === undefined && projectEnv === undefined
		? undefined : { ...globalEnv, ...projectEnv };
	return {
		startupNoticeShown: project.startupNoticeShown ?? global.startupNoticeShown,
		askClaude: { ...global.askClaude, ...project.askClaude },
		provider: { ...global.provider, ...project.provider, ...(env === undefined ? {} : { env }) },
	};
}
