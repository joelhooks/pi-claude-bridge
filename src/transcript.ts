import { contentText, getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools, type Context } from "@earendil-works/pi-ai";

/** Exact replay pieces, used only to reconcile capture keys with section order. */
export function transcriptPromptParts(context: Context): string[] | undefined {
	const state = getCurrentSystemMessage(context.messages);
	if (!state?.sections) return undefined;
	return [contentText(state.content), ...Object.values(state.sections)]
		.filter((part): part is string => typeof part === "string" && part.length > 0);
}

/** Prompt/tool state is not Claude conversation history or part of its cursor. */
export function nonSystemMessages(messages: Context["messages"]): Context["messages"] {
	return messages.filter((message) => message.role !== "system");
}

/**
 * Pi 0.86 providers receive TranscriptContext, with prompt/tools carried by system
 * messages. Normalize once before any capture lookup, MCP setup, or cursor write.
 * Use Pi's replay helpers: sorting sections ourselves changes instruction order.
 * Direct Context callers (including isolated tests) need no translation.
 *
 * Boundary repair adapted from upstream 10da850 (issue #106).
 */
export function toBridgeContext(context: Context): Context {
	if (!context.messages.some((message) => message.role === "system")) return context;
	return {
		...context,
		systemPrompt: getCurrentSystemPrompt(context.messages),
		tools: getCurrentTools(context.messages),
		messages: nonSystemMessages(context.messages),
	};
}
