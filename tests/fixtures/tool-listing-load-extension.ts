// Test extension: make the tools/list answer as large as a real pi session's.
// A session with 100+ tools serves ~40k tokens of tool definitions, and Claude
// Code takes long enough to take in a listing that size that a hook reply sent
// right behind it can overtake it.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FILLER = "It exists only to make the tool listing as large as a real pi session's, and returns nothing useful. ";

export default function (pi: ExtensionAPI) {
	const count = Number(process.env.FILLER_TOOLS ?? 120);
	const description = `Never call this tool. ${FILLER.repeat(16)}`;
	const params = Type.Object({ note: Type.Optional(Type.String({ description: "Unused." })) });
	for (let i = 0; i < count; i++) {
		pi.registerTool<typeof params>({
			name: `filler_${i}`,
			label: `Filler ${i}`,
			description,
			parameters: params,
			async execute() {
				return { content: [{ type: "text" as const, text: "filler" }], details: {} };
			},
		});
	}
}
