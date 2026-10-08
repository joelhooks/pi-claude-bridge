// Content digests for the history the bridge has already handed Claude Code.
//
// syncSharedSession resumes Claude Code's stored transcript instead of resending
// history, so it has to know that what Pi holds now still starts with what that
// transcript was built from. Counting messages is not enough: Pi 1.x lets an
// extension replace a message in place (`context_edit`) or compact at a turn
// boundary without firing `session_compact`, and both leave the count alone or
// shorten it. A digest of the converted-relevant fields catches every such
// rewrite, whoever made it.
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/pi-ai";

type Message = Context["messages"][number];

// Per object: Pi keeps the same message objects from call to call, and builds new
// ones when its projection changes (a context_edit replacement, a compaction), so
// a steady-state turn only digests what it has not seen before.
const digests = new WeakMap<object, string>();

// Only what reaches Claude Code. Timestamps, usage and provider bookkeeping change
// without the conversation changing, and must not force a rebuild.
function canonical(message: Message): unknown {
	const m = message as unknown as Record<string, unknown>;
	return [m.role, m.content, m.toolCallId ?? null, m.toolName ?? null, m.isError ?? null];
}

export function messageDigest(message: Message): string {
	const cached = digests.get(message as object);
	if (cached) return cached;
	const digest = createHash("sha256").update(JSON.stringify(canonical(message))).digest("base64url");
	digests.set(message as object, digest);
	return digest;
}

/** Digest of `messages[0..count)`, or undefined when fewer than `count` exist. */
export function prefixDigest(messages: Context["messages"], count: number): string | undefined {
	if (count > messages.length) return undefined;
	const hash = createHash("sha256");
	for (let i = 0; i < count; i++) hash.update(messageDigest(messages[i])).update("\n");
	return hash.digest("base64url");
}
