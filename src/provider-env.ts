import { execFile } from "node:child_process";

export type ProviderEnv = Record<string, string | { secret: string }>;

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
// These would bypass bridge context controls, inject competing authorization,
// spoof the SDK identity, or enable subprocess diagnostics containing credentials.
const RESERVED = new Set([
	"ENABLE_CLAUDEAI_MCP_SERVERS", "DISABLE_AUTO_COMPACT",
	"CLAUDE_CODE_RESUME_INTERRUPTED_TURN", "CLAUDE_CODE_RESUME_REASON", "CLAUDE_CODE_RESUME_PROMPT",
	"CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_CLIENT_APP", "ANTHROPIC_CUSTOM_HEADERS",
	"NODE_OPTIONS", "DEBUG", "DEBUG_CLAUDE_AGENT_SDK", "CLAUDE_CODE_DEBUG",
]);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Never include rejected values (or unvalidated keys/names) in errors. */
export function parseProviderEnv(value: unknown): ProviderEnv | undefined {
	if (value === undefined) return undefined;
	if (!record(value)) throw new Error("claude-bridge: provider.env must be an object");
	const env: ProviderEnv = Object.create(null);
	for (const [key, entry] of Object.entries(value)) {
		if (!ENV_KEY.test(key)) throw new Error("claude-bridge: invalid provider.env key");
		if (RESERVED.has(key)) throw new Error(`claude-bridge: provider.env key ${key} is reserved`);
		if (typeof entry === "string" && !entry.includes("\0")) {
			env[key] = entry;
		} else if (record(entry) && Object.keys(entry).length === 1 &&
			typeof entry.secret === "string" && SECRET_NAME.test(entry.secret)) {
			env[key] = { secret: entry.secret };
		} else {
			throw new Error(`claude-bridge: invalid provider.env entry for ${key}`);
		}
	}
	return env;
}

export type SecretLease = { value: string; expiresAt: number };
export type LeaseSecret = (name: string) => Promise<SecretLease>;

/** Supported agent-secrets CLI, not a Pi tool or a guessed daemon socket.
 * stdout is parsed in memory; stderr and child-process errors are never surfaced.
 * Only names/options go on argv. No shell, exports, or environment files. */
export const leaseSecret: LeaseSecret = (name) => new Promise((resolve, reject) => {
	execFile("secrets", ["lease", name, "--json", "--ttl", "1h", "--client-id", "pi-claude-bridge", "--no-update-check"],
		{ encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			try {
				if (error) throw new Error();
				const response: unknown = JSON.parse(stdout);
				if (!record(response) || response.ok !== true || !record(response.result)) throw new Error();
				const { value, expires_at: expiry } = response.result;
				const expiresAt = typeof expiry === "string" ? Date.parse(expiry) : NaN;
				if (typeof value !== "string" || !value || value.includes("\0") ||
					!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error();
				resolve({ value, expiresAt });
			} catch {
				reject(new Error(`claude-bridge: secret lease failed for ${name}`));
			}
		});
});

/** A cached lease is reused only while it has at least this long left. Without
 *  it, a fixed-cadence wake landing exactly one TTL after the lease that served
 *  an earlier wake passed the cache check and failed the spawn check a few ms
 *  later (2026-10-07: three owner passes in a row at hh:00:01 / hh:30:01). */
export const LEASE_REUSE_MARGIN_MS = 5 * 60 * 1000;

/** Per resolver: missing -> leasing (single flight) -> valid -> near expiry -> leasing.
 * Failed leases are not cached. Cancellation detaches a waiter, not its siblings;
 * the bounded CLI call may finish and cache a valid lease for the next spawn. */
export class ProviderEnvResolver {
	private readonly cache = new Map<string, SecretLease>();
	private readonly pending = new Map<string, Promise<SecretLease>>();
	private readonly expirations = new WeakMap<NodeJS.ProcessEnv, number>();
	constructor(
		private readonly lease: LeaseSecret = leaseSecret,
		private readonly now = Date.now,
		private readonly reuseMarginMs = LEASE_REUSE_MARGIN_MS,
	) {}

	private get(name: string): Promise<SecretLease> {
		const cached = this.cache.get(name);
		if (cached && cached.expiresAt - this.now() > this.reuseMarginMs) return Promise.resolve(cached);
		this.cache.delete(name);
		const pending = this.pending.get(name);
		if (pending) return pending;
		const request = Promise.resolve().then(() => this.lease(name)).then((lease) => {
			if (!lease || typeof lease.value !== "string" || !lease.value || lease.value.includes("\0") ||
				!Number.isFinite(lease.expiresAt) || lease.expiresAt <= this.now()) throw new Error();
			this.cache.set(name, lease);
			// Release raw credentials at TTL even if there is never another spawn.
			const expire = () => {
				if (this.cache.get(name) !== lease) return;
				const remaining = lease.expiresAt - this.now();
				if (remaining > 0) setTimeout(expire, Math.min(remaining, 2_147_483_647)).unref();
				else this.cache.delete(name);
			};
			setTimeout(expire, Math.min(lease.expiresAt - this.now(), 2_147_483_647)).unref();
			return lease;
		}).catch(() => {
			throw new Error(`claude-bridge: secret lease failed for ${name}`);
		}).finally(() => this.pending.delete(name));
		this.pending.set(name, request);
		return request;
	}

	/** Recheck directly at query(), after any synchronous transcript preparation. */
	assertFresh(env: NodeJS.ProcessEnv): void {
		if ((this.expirations.get(env) ?? Infinity) <= this.now()) {
			throw new Error("claude-bridge: secret lease expired before spawn");
		}
	}

	async resolve(env: ProviderEnv, inherited: NodeJS.ProcessEnv, safety: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<NodeJS.ProcessEnv> {
		if (signal?.aborted) throw new Error("claude-bridge: provider.env resolution aborted");
		const work = Promise.all(Object.entries(env).map(async ([key, entry]) => {
			if (typeof entry === "string") return { key, value: entry, expiresAt: Infinity };
			return { key, ...await this.get(entry.secret) };
		}));
		let onAbort: () => void;
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("claude-bridge: provider.env resolution aborted"));
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		try {
			const entries = await Promise.race([work, aborted]);
			if (signal?.aborted) throw new Error("claude-bridge: provider.env resolution aborted");
			// A slow sibling lease must not make an earlier resolved lease stale.
			if (entries.some((entry) => entry.expiresAt <= this.now())) throw new Error("claude-bridge: secret lease expired before spawn");
			const child = { ...inherited, ...Object.fromEntries(entries.map(({ key, value }) => [key, value])), ...safety };
			// Opt-in credentials must not enable SDK/CLI environment diagnostics,
			// including debug flags inherited from the parent shell.
			delete child.DEBUG;
			delete child.DEBUG_CLAUDE_AGENT_SDK;
			delete child.CLAUDE_CODE_DEBUG;
			if (Object.hasOwn(env, "ANTHROPIC_AUTH_TOKEN")) {
				if (!child.ANTHROPIC_AUTH_TOKEN) throw new Error("claude-bridge: provider.env ANTHROPIC_AUTH_TOKEN must not be empty");
				delete child.ANTHROPIC_API_KEY;
				delete child.CLAUDE_CODE_OAUTH_TOKEN;
			}
			this.expirations.set(child, Math.min(...entries.map((entry) => entry.expiresAt)));
			return child;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}
}
