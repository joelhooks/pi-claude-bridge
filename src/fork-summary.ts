// Compaction summaries on a fork of the live Claude Code conversation.
//
// Pi's own compaction serializes the history into one prompt for a separate
// request. Through the bridge that request shares nothing with the live
// conversation, so it reads none of its prompt cache: a long Opus session pays
// for the whole history again at full input price on every compaction.
//
// A fork resumes a copy of the live transcript (Claude Code's `forkSession`,
// with nothing persisted) and asks for the summary as the next user message. The
// system prompt comes from the transcript's own snapshot, and the bridge declares
// the same tools and thinking settings the live query used, so the request reads
// everything the live conversation already cached.
//
// The live transcript also holds the messages Pi keeps verbatim after the
// compaction, so the instruction names the first of them and asks for a summary
// of what came before. The instruction text follows nicobailon/pi-cached-compaction
// (MIT), which asks the bridge for the same fork with `x-claude-bridge-fork: 1`.

import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

/** Header a summary extension sets on its request to ask for a fork. */
export const FORK_REQUEST_HEADER = "x-claude-bridge-fork";

export function isForkRequest(options?: SimpleStreamOptions): boolean {
	const headers = (options as { headers?: Record<string, string> } | undefined)?.headers;
	if (!headers) return false;
	const value = Object.entries(headers).find(([name]) => name.toLowerCase() === FORK_REQUEST_HEADER)?.[1];
	return String(value).trim() === "1";
}

interface PreviewMessage {
	role?: string;
	content?: unknown;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
}

/** The opening of a message as the model reads it: its text, or its tool calls
 *  written `[tool call: name arguments]`. Undefined when it has no text. */
export function messagePreview(message: PreviewMessage): string | undefined {
	let text: string | undefined;
	if (message.role === "user" || message.role === "toolResult") {
		text = contentText(message.content);
	} else if (message.role === "assistant" && Array.isArray(message.content)) {
		text = message.content
			.flatMap((block) => (block?.type === "text" ? [block.text] : block?.type === "toolCall" ? [`[tool call: ${block.name} ${JSON.stringify(block.arguments)}]`] : []))
			.join("\n");
	}
	text = text?.trim();
	if (!text) return undefined;
	return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export interface KeptStart {
	text: string;
	/** Which of the kept messages opening with `text` it is, counting back from the end (1 for the last). */
	fromEnd: number;
	/** How many messages Pi keeps from the kept start on. */
	count: number;
}

interface BranchEntry {
	id: string;
	type: string;
	message?: PreviewMessage;
}

/** Where the messages Pi keeps verbatim start: the first kept message entry with
 *  text to quote. Pi's cut can land on a metadata entry just before it.
 *  Undefined when nothing from the kept start on has text. */
export function keptStart(branchEntries: readonly BranchEntry[], firstKeptEntryId: string): KeptStart | undefined {
	const start = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
	if (start === -1) return undefined;
	const kept = branchEntries.slice(start).flatMap((entry) => (entry.type === "message" && entry.message ? [entry.message] : []));
	const previews = kept.map(messagePreview);
	const at = previews.findIndex((preview) => preview !== undefined);
	if (at === -1) return undefined;
	const text = previews[at]!;
	return { text, fromEnd: previews.slice(at).filter((preview) => preview === text).length, count: kept.length - at };
}

export function summaryInstruction(kept: KeptStart, customInstructions: string | undefined): string {
	const repeated = kept.fromEnd > 1 ? ` Several kept messages begin with this text: it is number ${kept.fromEnd} of them, counting back from the end.` : "";
	const toolCalls = kept.text.includes("[tool call: ") ? " Tool calls are written as [tool call: name arguments]." : "";
	const focus = customInstructions?.trim() ? `\n\nAdditional focus: ${customInstructions.trim()}` : "";
	return `Stop working on the task and do not call any tools. Write a structured context checkpoint summary of the earlier part of the conversation above. Another LLM will continue the work from your summary, followed by the last ${kept.count} messages of the conversation, which stay in context verbatim.

The kept messages start with the message that begins with the text below.${repeated}${toolCalls}

<kept-start>
${kept.text}
</kept-start>

Summarize only the messages before it, as if the conversation ended right there. Done lists only work finished before it. Whatever happens from that message on, including its tool calls, their results, and later replies, has not happened as far as your summary knows: leave it out, or list it under Next Steps if it was already planned.

If the conversation starts with an earlier summary, fold it into the new one: keep its facts, move finished items to Done, and update Next Steps.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.${focus}`;
}

/** Pi's read/modified file lists for a compaction (computeFileLists and
 *  formatFileOperations in Pi's compaction utils, which Pi does not export). */
export function fileOperations(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }): {
	readFiles: string[];
	modifiedFiles: string[];
	suffix: string;
} {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read].filter((file) => !modified.has(file)).sort();
	const modifiedFiles = [...modified].sort();
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return { readFiles, modifiedFiles, suffix: sections.length ? `\n\n${sections.join("\n\n")}` : "" };
}
