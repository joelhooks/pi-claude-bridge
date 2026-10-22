// Claude Code's tool search for the provider path.
//
// Claude Code can declare MCP tools with `defer_loading`, so only their names
// sit in the prompt and the model pulls a full definition in with its built-in
// `ToolSearch` tool when it needs one. The loaded definition arrives as a
// `tool_reference` block in the conversation, after the cached prefix, so the
// prefix stays the same whichever tools get loaded.
//
// The provider path runs Claude Code with `tools: []`, which also removes
// `ToolSearch`, and Claude Code loads every MCP tool upfront when `ToolSearch`
// is missing. So the setting has to do two things: keep `ToolSearch` as the one
// built-in, and turn tool search on explicitly, because Claude Code before
// 2.1.304 keeps it off behind an `ANTHROPIC_BASE_URL` gateway unless
// `ENABLE_TOOL_SEARCH` says otherwise.
//
// Tools named in `alwaysLoad` are marked `_meta["anthropic/alwaysLoad"]` on the
// MCP server and stay declared upfront, for the few tools nearly every turn uses.

export const TOOL_SEARCH_TOOL = "ToolSearch";

export type ToolSearchSetting = boolean | { alwaysLoad?: string[] };

export interface ToolSearchPlan {
	enabled: boolean;
	/** Pi tool names that load upfront even with tool search on. */
	alwaysLoad: ReadonlySet<string>;
}

const OFF: ToolSearchPlan = { enabled: false, alwaysLoad: new Set() };

/** Parses `provider.toolSearch`. A malformed value throws: guessing would either
 *  defer tools the user meant to keep upfront or silently leave the feature off. */
export function toolSearchPlan(setting: unknown): ToolSearchPlan {
	if (setting === undefined || setting === false) return OFF;
	if (setting === true) return { enabled: true, alwaysLoad: new Set() };
	if (setting !== null && typeof setting === "object" && !Array.isArray(setting)) {
		const keys = Object.keys(setting);
		const alwaysLoad = (setting as { alwaysLoad?: unknown }).alwaysLoad;
		if (keys.every((key) => key === "alwaysLoad")
			&& (alwaysLoad === undefined || (Array.isArray(alwaysLoad) && alwaysLoad.every((name) => typeof name === "string")))) {
			return { enabled: true, alwaysLoad: new Set(alwaysLoad as string[] | undefined ?? []) };
		}
	}
	throw new Error("claude-bridge: provider.toolSearch must be true, false, or { \"alwaysLoad\": [\"<pi tool name>\", ...] }");
}

/** The `tools` option and env overlay Claude Code needs for the plan. */
export function toolSearchQueryOptions(plan: ToolSearchPlan): { tools: string[]; env: Record<string, string> } {
	return plan.enabled
		? { tools: [TOOL_SEARCH_TOOL], env: { ENABLE_TOOL_SEARCH: "true" } }
		: { tools: [], env: {} };
}
