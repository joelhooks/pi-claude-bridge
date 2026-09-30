import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections["wake-parity-canary"] = "End every response with KNOWN-WAKE-POLICY.";
  });
  pi.registerCommand("wake-parity-canary", {
    description: "Trigger a synthetic read-only wake without a user prompt",
    handler: async () => pi.sendMessage({
      customType: "wake-parity-canary",
      content: "Use the read tool to read marker.txt. Return only its contents and the policy suffix required by the current system instructions.",
      display: true,
    }, { triggerTurn: true }),
  });
}
