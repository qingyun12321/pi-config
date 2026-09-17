import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearTerminalAtProcessExit } from "./_shared/full-redraw.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", (event) => {
		if (event.reason === "quit") {
			clearTerminalAtProcessExit();
		}
	});

	pi.registerCommand("exit", {
		description: "Exit pi and clear the terminal",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
