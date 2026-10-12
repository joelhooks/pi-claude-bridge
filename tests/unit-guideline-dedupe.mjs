/**
 * Several tools may share one guideline block (a goal extension attaches the same
 * text to its get, create and update tools). Pi's own prompt lists each trimmed
 * rule once; the bridge rebuilt the remainder from the raw lists and sent the
 * block once per tool, three copies on every desk with that extension.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import activate, { __test } from "../src/index.js";
import { projectPromptCapture } from "../src/prompt-capture.js";

const SHARED = "Goal tools: keep one active goal and update it when the plan changes.";
const options = () => ({
	cwd: "/fixture", contextFiles: [], skills: [], appendSystemPrompt: "CLI-POLICY", sections: {},
	selectedTools: ["read", "get_goal", "create_goal", "update_goal"],
	toolGuidelines: { get_goal: [SHARED], create_goal: [SHARED], update_goal: [`  ${SHARED}\n`] },
	promptGuidelines: [SHARED, "Prefer small commits."],
});
const count = (text, needle) => text.split(needle).length - 1;

let handlers;
function setup() {
	handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider() {}, registerTool() {} });
	handlers.get("session_start")({ reason: "new" }, { ui: null, mode: "rpc" });
	return handlers;
}
afterEach(() => handlers?.get("session_shutdown")({ reason: "quit" }));

describe("shared tool guidelines", () => {
	it("reach Claude once, as in Pi's own prompt", () => {
		const h = setup(); const opts = options();
		const native = buildSystemPrompt(opts);
		assert.equal(count(native, SHARED), 1, "Pi lists the rule once");
		h.get("before_agent_start")({ systemPrompt: native, systemPromptOptions: opts });
		const projected = projectPromptCapture(__test.promptCaptures.resolveOrDerive(native, undefined), { skillReadTool: "mcp" });
		assert.equal(count(projected, SHARED), 1);
		assert.equal(count(projected, "Prefer small commits."), 1);
		assert.ok(projected.includes("CLI-POLICY"));
	});
});
