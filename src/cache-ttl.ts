// Prompt-cache TTL for the bridge's Claude Code children.
//
// Claude Code writes 5-minute cache entries unless CLAUDE_CODE_PROMPT_CACHE_TTL
// asks for 1 hour. A 1-hour write costs 2.0x the input price instead of 1.25x,
// and pays back when the conversation comes back after 5-60 minutes: then the
// prompt is read at 0.1x instead of written again. Desks that wake every 10-40
// minutes win; sessions that only run back-to-back, or sleep for hours, lose.
//
// Deciding per conversation was tried and replayed over a day of traffic: every
// variant saved less than 1 hour everywhere, because changing the TTL misses the
// cache and the next request writes its whole prompt again.

export type CacheTtl = "5m" | "1h";

export function parseCacheTtl(value: unknown): CacheTtl {
	return value === "1h" ? "1h" : "5m";
}

/** Child environment overlay for the TTL. */
export function cacheTtlEnv(ttl: CacheTtl): Record<string, string> {
	return ttl === "1h" ? { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" } : {};
}
