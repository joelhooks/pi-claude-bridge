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
