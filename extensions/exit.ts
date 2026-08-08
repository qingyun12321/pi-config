import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearTerminalAtProcessExit } from "./_shared/full-redraw.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Exit pi cleanly",
		handler: async (_args, ctx) => {
			clearTerminalAtProcessExit();
			ctx.shutdown();
		},
	});
}
