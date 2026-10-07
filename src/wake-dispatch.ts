import { randomUUID } from "node:crypto";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "./convert.js";

export const WAKE_RECOVERY_PROMPT = "[claude-bridge] A delayed message above (timer, watch or intercom) arrived before the bridge had your current instructions. "
	+ "They are refreshed now. Act on that message if it still needs action; otherwise reply briefly that nothing is needed.";
const BLOCKED_WAKE = "claude-bridge/wake-capture-blocked";
const RECOVERY_PREFIX = "[claude-bridge] A delayed message above";
const TERMINAL_RECOVERY = "Claude bridge wake recovery is terminal. Submit a new ordinary prompt with the original instructions; this recovery context cannot be replayed.";
type Messages = Context["messages"];
type IssuedBoundary = { id: string; bodies: string };
type BoundaryState = { tag: "idle" } | (IssuedBoundary & { tag: "issued" | "validated" | "consumed" | "invalidated" });

function userTurnStart(messages: Messages): number {
	let start = messages.length;
	while (start > 0 && messages[start - 1].role === "user") start--;
	return start;
}
function userText(message: Messages[number] | undefined): string | undefined {
	if (message?.role !== "user") return undefined;
	return typeof message.content === "string" ? message.content
		: message.content.length === 1 && message.content[0].type === "text" ? message.content[0].text : undefined;
}
const bodies = (messages: Messages) => JSON.stringify(messages.map((message) => message.content));
function barrierId(message: Messages[number] | undefined): string | undefined {
	if (message?.role !== "assistant") return undefined;
	const id = message.diagnostics?.filter((d) => d.type === BLOCKED_WAKE).at(-1)?.details?.recoveryId;
	return typeof id === "string" ? id : undefined;
}

/** issued -> validated -> consumed; rejection/navigation/failure -> invalidated.
 * Dispatch is terminal, even when it demonstrably failed before inference: no
 * retry classification or blind replay. Retired process-issued nonces reject
 * the same recovery context before session sync/SDK construction. Ordinary
 * inspection stays pure; only prepare/consume/invalidate change authority.
 * No state is persisted in prompt carriers or written back into transcripts.
 */
export class WakeRecoveryBoundary {
	private state: BoundaryState = { tag: "idle" };
	private retired = new Set<string>();

	markBlocked(output: AssistantMessage, messages: Messages): void {
		this.invalidate();
		const turn = messages.slice(userTurnStart(messages));
		if (!turn.length) return;
		const id = randomUUID();
		output.diagnostics = [...(output.diagnostics ?? []), { type: BLOCKED_WAKE, timestamp: Date.now(), details: { recoveryId: id } }];
		this.state = { tag: "issued", id, bodies: bodies(turn) };
	}

	/** The recovery prompt must open the trailing user run, but it need not end it:
	 *  extensions append status notes as user messages
	 *  after it. Treating those as a fresh turn replayed the empty barrier as
	 *  history, which Claude Code shows the model as "No response requested."
	 *  (2026-10-06: 38 of 114 such recoveries apologized for a reply never sent). */
	turnStart(messages: Messages): number {
		const ordinary = userTurnStart(messages);
		const pending = this.state;
		if ((pending.tag !== "issued" && pending.tag !== "validated") || ordinary >= messages.length
			|| userText(messages[ordinary]) !== WAKE_RECOVERY_PROMPT) return ordinary;
		const empty = messages[ordinary - 1];
		if (empty?.role !== "assistant" || empty.provider !== PROVIDER_ID || empty.api !== PROVIDER_ID
			|| empty.stopReason !== "stop" || empty.content.length !== 0
			|| [empty.usage.input, empty.usage.output, empty.usage.cacheRead, empty.usage.cacheWrite,
				empty.usage.totalTokens, empty.usage.reasoning ?? 0].some((tokens) => tokens !== 0)
			|| barrierId(empty) !== pending.id) return ordinary;
		const start = userTurnStart(messages.slice(0, ordinary - 1));
		return bodies(messages.slice(start, ordinary - 1)) === pending.bodies ? start : ordinary;
	}

	/** Applies even while the first dispatch's outcome is still unknown. */
	assertNotRetired(messages: Messages): void {
		const at = userTurnStart(messages);
		const id = barrierId(messages[at - 1]);
		if (id && userText(messages[at])?.startsWith(RECOVERY_PREFIX) && this.retired.has(id)) {
			throw new Error(TERMINAL_RECOVERY);
		}
	}

	/** Fresh provider dispatch only, after policy verification but before sync. */
	prepare(messages: Messages): boolean {
		this.assertNotRetired(messages);
		const at = userTurnStart(messages);
		const id = barrierId(messages[at - 1]);
		const recoveryAttempt = userText(messages[at])?.startsWith(RECOVERY_PREFIX);
		if (this.state.tag !== "issued" && this.state.tag !== "validated") return false;
		if (this.turnStart(messages) === userTurnStart(messages)) {
			const owned = id === this.state.id;
			this.invalidate();
			if (owned && recoveryAttempt) throw new Error(TERMINAL_RECOVERY);
			return false;
		}
		this.state = { ...this.state, tag: "validated" };
		return true;
	}

	consume(messages: Messages): void {
		if (this.turnStart(messages) < userTurnStart(messages) && this.state.tag !== "idle") {
			this.retired.add(this.state.id);
			this.state = { ...this.state, tag: "consumed" };
		} else this.invalidate();
	}
	invalidate(): void {
		if (this.state.tag === "idle") return;
		this.retired.add(this.state.id);
		this.state = { ...this.state, tag: "invalidated" };
	}
	clear(): void { this.state = { tag: "idle" }; this.retired.clear(); }
}
