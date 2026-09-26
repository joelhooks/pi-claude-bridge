import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\nFor this canary, end every reply with POLICY-CANARY.`,
	}));
	pi.registerCommand("canary-reload", {
		description: "Reload the canary runtime",
		handler: async (_args, ctx) => { await ctx.reload(); },
	});
	pi.registerCommand("canary-wake", {
		description: "Trigger a canary turn without before_agent_start",
		handler: async () => pi.sendMessage({
			customType: "bridge-canary",
			content: "Read marker.txt again using the read tool. Return only its contents, the markers required by the current system instructions, and the required policy suffix. No explanation or discussion of earlier responses.",
			display: true,
		}, { triggerTurn: true }),
	});
}
