import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fullRedraw } from "./_shared/full-redraw.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup") {
			await fullRedraw(ctx);
		}
	});
}
