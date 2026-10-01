import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, buildSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import activate, { __test } from "../src/index.js";
import { projectPromptCapture } from "../src/prompt-capture.js";

let handlers;
function captureTurn() {
  handlers = new Map();
  activate({ on: (event, handler) => handlers.set(event, handler), registerProvider() {}, registerTool() {} });
  handlers.get("session_start")({ reason: "new" }, { ui: null, mode: "rpc" });
  const options = { cwd: "/fixture", selectedTools: ["read"], contextFiles: [{ path: "/fixture/AGENTS.md", content: "PROJECT-POLICY" }], skills: [], appendSystemPrompt: "CLI-POLICY", sections: {}, promptGuidelines: [] };
  const bare = buildSystemPrompt(options);
  // An earlier extension contributes a typed section on the user turn.
  options.sections["fixture-policy"] = "KNOWN-EXTENSION-POLICY";
  const assembled = buildSystemPrompt(options);
  handlers.get("before_agent_start")({ systemPrompt: assembled, systemPromptOptions: options });
  handlers.get("agent_start")({}, { getSystemPrompt: () => assembled });
  handlers.get("context_with_system")({ messages: [{ role: "system", content: "", sections: buildSystemPromptSections(options), timestamp: 0 }] });
  handlers.get("agent_end")({});
  return { options, bare, assembled };
}
function captureLateWrappedTurn({ reorder = false } = {}) {
  const { options } = captureTurn();
  handlers.get("session_start")({ reason: "new" }, { ui: null, mode: "rpc" });
  options.sections = {};
  const bare = buildSystemPrompt(options);
  handlers.get("before_agent_start")({ systemPrompt: bare, systemPromptOptions: options });
  options.sections["late-policy"] = "LATE-STRUCTURED-POLICY";
  const native = buildSystemPrompt(options);
  options.forceSystemPrompt = `${native}\n\nFORCED-WRAPPER-POLICY`;
  handlers.get("agent_start")({}, { getSystemPrompt: () => buildSystemPrompt(options) });
  const canonicalSections = buildSystemPromptSections(options);
  const sections = reorder ? Object.fromEntries(Object.entries(canonicalSections).reverse()) : canonicalSections;
  handlers.get("context_with_system")({ messages: [{ role: "system", content: "", sections, timestamp: 0 }] }, { getSystemPrompt: () => buildSystemPrompt(options) });
  assert.equal(options.forceSystemPrompt, `${native}\n\nFORCED-WRAPPER-POLICY`, "must restore the forced options synchronously");
  handlers.get("agent_end")({});
  return { options, bare, native: reorder ? Object.values(sections).join("\n\n") : native, sections };
}
afterEach(() => handlers?.get("session_shutdown")({ reason: "quit" }));

describe("custom wake prompt parity", () => {
  it("preserves a known extension section retained by transcript replay when the live base is unchanged", () => {
    const { options, bare, assembled } = captureTurn();
    // Pi ends the prior run, dropping its run-only options. An idle custom wake
    // replays the transcript before preparing the first prompt delta.
    handlers.get("agent_start")({}, { getSystemPrompt: () => bare });
    const sections = buildSystemPromptSections(options);
    const capture = __test.resolveProviderCapture(assembled, Object.values(sections), sections);
    const projected = projectPromptCapture(capture, { skillReadTool: "mcp" });
    for (const policy of ["KNOWN-EXTENSION-POLICY", "PROJECT-POLICY", "CLI-POLICY"]) assert.ok(projected.includes(policy));
  });

  it("captures late native sections beneath a forced wrapper and keeps both policies on a wake", () => {
    const { bare, native, sections } = captureLateWrappedTurn();
    handlers.get("agent_start")({}, { getSystemPrompt: () => bare });
    const capture = __test.resolveProviderCapture(native, Object.values(sections), sections);
    const projected = projectPromptCapture(capture, { skillReadTool: "mcp" });
    for (const policy of ["LATE-STRUCTURED-POLICY", "FORCED-WRAPPER-POLICY", "PROJECT-POLICY", "CLI-POLICY"]) assert.ok(projected.includes(policy));
  });

  it("captures the native alias when transcript section order differs from the forced wrapper", () => {
    const { bare, native, sections } = captureLateWrappedTurn({ reorder: true });
    handlers.get("agent_start")({}, { getSystemPrompt: () => bare });
    const capture = __test.resolveProviderCapture(native, Object.values(sections), sections);
    const projected = projectPromptCapture(capture, { skillReadTool: "mcp" });
    for (const policy of ["LATE-STRUCTURED-POLICY", "FORCED-WRAPPER-POLICY", "PROJECT-POLICY", "CLI-POLICY"]) assert.ok(projected.includes(policy));
  });

  it("rejects instruction drift even after recording a reordered native alias", () => {
    const { options, native, sections } = captureLateWrappedTurn({ reorder: true });
    const current = buildSystemPrompt({ ...options, forceSystemPrompt: undefined, sections: {}, appendSystemPrompt: "CHANGED" });
    handlers.get("agent_start")({}, { getSystemPrompt: () => current });
    assert.throws(() => __test.resolveProviderCapture(native, Object.values(sections), sections), /Claude bridge blocked this delayed turn/);
  });

  it("retains a verified native alias across a tool-loop turn with the same finalized prompt", () => {
    const { options, bare, native, sections } = captureLateWrappedTurn();
    // A tool continuation can use a normalized options copy. Re-capturing the
    // unchanged final prompt must not erase its already verified native alias.
    handlers.get("before_agent_start")({ systemPrompt: bare, systemPromptOptions: options });
    handlers.get("agent_start")({}, { getSystemPrompt: () => buildSystemPrompt(options) });
    handlers.get("context_with_system")({ messages: [{ role: "system", content: "", sections, timestamp: 0 }] }, { getSystemPrompt: () => buildSystemPrompt(options) });
    const finalized = buildSystemPrompt(options);
    handlers.get("turn_start")({}, { getSystemPrompt: () => finalized });
    handlers.get("context_with_system")({ messages: [{ role: "system", content: "", sections, timestamp: 0 }] }, { getSystemPrompt: () => finalized });
    handlers.get("agent_end")({});
    handlers.get("agent_start")({}, { getSystemPrompt: () => bare });
    const capture = __test.resolveProviderCapture(native, Object.values(sections), sections);
    assert.match(projectPromptCapture(capture, { skillReadTool: "mcp" }), /FORCED-WRAPPER-POLICY/);
  });

  it("retains the verified native alias through reload without creating one from cold wake input", () => {
    const { bare, native, sections } = captureLateWrappedTurn();
    handlers.get("session_shutdown")({ reason: "reload" });
    handlers.get("session_start")({ reason: "reload" }, { ui: null, mode: "rpc" });
    handlers.get("agent_start")({}, { getSystemPrompt: () => bare });
    assert.match(projectPromptCapture(__test.resolveProviderCapture(native, Object.values(sections), sections), { skillReadTool: "mcp" }), /FORCED-WRAPPER-POLICY/);
    const changed = { ...sections, "unverified-section": "UNKNOWN" };
    handlers.get("context_with_system")({ messages: [{ role: "system", content: "", sections: changed, timestamp: 0 }] }, { getSystemPrompt: () => bare });
    assert.throws(() => __test.resolveProviderCapture(Object.values(changed).join("\n\n"), Object.values(changed), changed), /Claude bridge blocked this delayed turn/);
  });

  it("still rejects resource drift when a verified native alias exists", () => {
    const { options, native, sections } = captureLateWrappedTurn();
    const current = buildSystemPrompt({ ...options, forceSystemPrompt: undefined, sections: {}, appendSystemPrompt: "CHANGED" });
    handlers.get("agent_start")({}, { getSystemPrompt: () => current });
    assert.throws(() => __test.resolveProviderCapture(native, Object.values(sections), sections), /Claude bridge blocked this delayed turn/);
  });

  it("accepts only an exact permutation of the known retained sections", () => {
    const { options, bare } = captureTurn();
    handlers.get("agent_start")({}, { getSystemPrompt: () => bare });
    const sections = buildSystemPromptSections(options);
    const parts = Object.values(sections).reverse();
    const capture = __test.resolveProviderCapture(parts.join("\n\n"), parts, sections);
    assert.match(projectPromptCapture(capture, { skillReadTool: "mcp" }), /KNOWN-EXTENSION-POLICY/);
  });

  it("rejects unknown or truncated retained prompt text", () => {
    const { bare, assembled } = captureTurn();
    handlers.get("agent_start")({}, { getSystemPrompt: () => bare });
    for (const prompt of [assembled + "\n\nUNKNOWN-POLICY", assembled.slice(0, -1)]) {
      assert.throws(() => __test.resolveProviderCapture(prompt), /Claude bridge blocked this delayed turn/);
    }
  });

  it("rejects removed project or append policy rather than treating it as a missing extension section", () => {
    for (const delta of [{ contextFiles: [] }, { appendSystemPrompt: "" }]) {
      const { options, assembled } = captureTurn();
      const current = buildSystemPrompt({ ...options, sections: {}, ...delta });
      handlers.get("agent_start")({}, { getSystemPrompt: () => current });
      const sections = buildSystemPromptSections(options);
      assert.throws(() => __test.resolveProviderCapture(assembled, Object.values(sections), sections), /Claude bridge blocked this delayed turn/);
    }
  });

  it("still rejects old resource policy even when a known extension section is retained", () => {
    const { options, assembled } = captureTurn();
    const current = buildSystemPrompt({ ...options, sections: {}, appendSystemPrompt: "CURRENT-POLICY" });
    handlers.get("agent_start")({}, { getSystemPrompt: () => current });
    const sections = buildSystemPromptSections(options);
    assert.throws(() => __test.resolveProviderCapture(assembled, Object.values(sections), sections), /Claude bridge blocked this delayed turn/);
  });
});
