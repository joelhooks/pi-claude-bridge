import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { buildSystemPrompt, buildSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import activate, { __test } from "../src/index.js";
import { projectPromptCapture, PromptCaptures } from "../src/prompt-capture.js";
import { transcriptPromptParts } from "../src/transcript.js";

const options = () => ({ cwd: "/fixture", selectedTools: ["read"],
	contextFiles: [{ path: "/fixture/AGENTS.md", content: "PROJECT-POLICY" }], skills: [],
	appendSystemPrompt: "CLI-POLICY", sections: {}, promptGuidelines: [] });
const project = (key, parts) => projectPromptCapture(__test.promptCaptures.resolveOrDerive(key, parts), { skillReadTool: "mcp" });
let handlers;
function setup() {
	handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider() {}, registerTool() {} });
	handlers.get("session_start")({ reason: "new" }, { ui: null, mode: "rpc" });
	return handlers;
}
afterEach(() => handlers?.get("session_shutdown")({ reason: "quit" }));

describe("Pi 0.86 finalized prompt capture", () => {
	it("captures late structured sections and guidelines without losing context", () => {
		const h = setup(); const opts = options();
		h.get("before_agent_start")({ systemPrompt: buildSystemPrompt(opts), systemPromptOptions: opts });
		opts.sections.fixture = "LATE-SECTION";
		opts.promptGuidelines.push("LATE-GUIDELINE");
		const final = buildSystemPrompt(opts);
		h.get("agent_start")({}, { getSystemPrompt: () => final });
		const result = project(final);
		for (const text of ["PROJECT-POLICY", "CLI-POLICY", "LATE-SECTION", "LATE-GUIDELINE"]) assert.ok(result.includes(text));
		assert.doesNotMatch(result, /operating inside pi|Pi documentation/);
	});

	it("keeps chained forceSystemPrompt appends and restores them on a reload wake", () => {
		const h = setup(); const opts = options(); const base = buildSystemPrompt(opts);
		h.get("before_agent_start")({ systemPrompt: base, systemPromptOptions: opts });
		opts.forceSystemPrompt = `${base}\n\nCHAINED-POLICY`;
		h.get("agent_start")({}, { getSystemPrompt: () => opts.forceSystemPrompt });
		assert.match(project(opts.forceSystemPrompt), /CHAINED-POLICY/);
		h.get("session_shutdown")({ reason: "reload" });
		h.get("session_start")({ reason: "reload" }, { ui: null, mode: "rpc" });
		h.get("turn_start")({}, { getSystemPrompt: () => opts.forceSystemPrompt });
		const result = projectPromptCapture(__test.resolveProviderCapture(base), { skillReadTool: "mcp" });
		assert.match(result, /PROJECT-POLICY/); assert.match(result, /CHAINED-POLICY/);
		assert.doesNotMatch(result, /operating inside pi/);
		h.get("session_start")({ reason: "new" }, { ui: null, mode: "rpc" });
		assert.throws(() => project(opts.forceSystemPrompt), /no capture/);
		assert.throws(() => __test.resolveProviderCapture(base), /no capture/);
		assert.equal(__test.resolveProviderCapture(undefined), undefined);
	});

	it("resolves a wake whose prompt lacks sections an earlier extension added", () => {
		// A project extension runs before the bridge and sets
		// systemPromptOptions.sections in before_agent_start. The bridge records a base
		// that already includes the section, but a wake skips before_agent_start and
		// Pi sends the bare base. Seen live: 122020-char wake vs 122355-char capture.
		const h = setup(); const opts = options(); const bare = buildSystemPrompt(opts);
		opts.sections["rubicon-loop"] = "LOOP-NOTE";
		const withSection = buildSystemPrompt(opts);
		assert.ok(withSection.startsWith(bare) && withSection.length > bare.length, "section must trail the base");
		h.get("before_agent_start")({ systemPrompt: withSection, systemPromptOptions: opts });
		h.get("agent_start")({}, { getSystemPrompt: () => withSection });
		h.get("agent_end")({});
		const wake = () => projectPromptCapture(__test.resolveProviderCapture(bare), { skillReadTool: "mcp" });
		for (const text of ["PROJECT-POLICY", "CLI-POLICY", "LOOP-NOTE"]) assert.ok(wake().includes(text));
		assert.doesNotMatch(wake(), /operating inside pi/);
		// The same holds after /reload carries the capture over.
		h.get("session_shutdown")({ reason: "reload" });
		h.get("session_start")({ reason: "reload" }, { ui: null, mode: "rpc" });
		assert.match(wake(), /LOOP-NOTE/);
		// Only whole trailing section blocks may be missing.
		assert.throws(() => __test.resolveProviderCapture(bare.replace("PROJECT-POLICY", "CHANGED-POLICY")), /no capture/);
		assert.throws(() => __test.resolveProviderCapture(bare.slice(0, -3)), /no capture/);
		assert.throws(() => __test.resolveProviderCapture(`${bare}\n\n<other>\nX\n</other>`), /no capture/);
	});

	it("does not treat non-section trailing text as a missing section", () => {
		const h = setup(); const opts = options(); const bare = buildSystemPrompt(opts);
		const appended = `${bare}\n\nFREE-TEXT-POLICY`;
		h.get("before_agent_start")({ systemPrompt: appended, systemPromptOptions: opts });
		h.get("agent_start")({}, { getSystemPrompt: () => appended });
		assert.throws(() => __test.resolveProviderCapture(bare), /no capture/);
	});

	it("projects the base when an earlier extension already forced a wrapped prompt", () => {
		const h = setup(); const opts = options(); const base = buildSystemPrompt(opts);
		opts.forceSystemPrompt = `${base}\n\nEARLY-EXTENSION-POLICY`;
		const forced = opts.forceSystemPrompt;
		// Real Pi exposes a getter that re-renders the shared mutable options.
		h.get("before_agent_start")({ get systemPrompt() { return buildSystemPrompt(opts); }, systemPromptOptions: opts });
		h.get("agent_start")({}, { getSystemPrompt: () => buildSystemPrompt(opts) });
		const result = project(forced);
		assert.equal(opts.forceSystemPrompt, forced, "must not change the prompt seen by other extensions");
		for (const text of ["PROJECT-POLICY", "CLI-POLICY", "EARLY-EXTENSION-POLICY"]) assert.ok(result.includes(text));
		assert.doesNotMatch(result, /operating inside pi|Pi documentation/);
	});

	it("preserves a standalone full replacement instead of resurrecting old policy", () => {
		const h = setup(); const opts = options();
		h.get("before_agent_start")({ systemPrompt: buildSystemPrompt(opts), systemPromptOptions: opts });
		opts.forceSystemPrompt = "EXACT REPLACEMENT";
		h.get("agent_start")({}, { getSystemPrompt: () => opts.forceSystemPrompt });
		assert.equal(project(opts.forceSystemPrompt), "EXACT REPLACEMENT");
	});

	it("matches only complete equal sections when transcript order differs from the builder", () => {
		const h = setup(); const opts = options();
		const sections = buildSystemPromptSections(opts);
		const { project_context, ...initial } = sections;
		const messages = [
			{ role: "system", content: "", sections: initial, timestamp: 0 },
			{ role: "system", content: "", sections: { project_context }, timestamp: 1 },
		];
		const canonical = buildSystemPrompt(opts);
		const replayed = getCurrentSystemPrompt(messages);
		assert.notEqual(canonical, replayed, "must exercise reordered sections");
		h.get("before_agent_start")({ systemPrompt: canonical, systemPromptOptions: opts });
		h.get("turn_start")({}, { getSystemPrompt: () => canonical });
		const parts = transcriptPromptParts({ messages });
		assert.equal(project(replayed, parts), project(canonical));
		assert.throws(() => project(replayed.replace("PROJECT-POLICY", "CHANGED-POLICY"), parts), /no capture/);
		assert.throws(() => project(replayed.slice(0, -1), parts), /no capture/);
	});

	it("does not accept injected parts as an alias for unrelated prompt text", () => {
		const c = new PromptCaptures();
		c.record("A\n\nB", { custom: "POLICY", contextFiles: [], skills: [] });
		assert.throws(() => c.resolveOrDerive("UNRELATED", ["B", "A"]), /no capture/);
	});
});
