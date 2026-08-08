import { unlink } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fullRedraw } from "./_shared/full-redraw.ts";

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("drop", {
		description: "Delete the current session and start a new one",
		handler: async (_args, ctx) => {
			const previousSessionFile = ctx.sessionManager.getSessionFile();
			if (!previousSessionFile) {
				ctx.ui.notify("Nothing to drop (ephemeral session)", "warning");
				await fullRedraw(ctx);
				return;
			}

			const result = await ctx.newSession({
				withSession: async (replacementCtx) => {
					try {
						await unlink(previousSessionFile);
						replacementCtx.ui.notify("Session dropped", "info");
					} catch (error) {
						if (isMissingFile(error)) {
							replacementCtx.ui.notify("Session dropped", "info");
						} else {
							// Match OMP's best-effort semantics: remain in the new session even if
							// deleting the previous transcript fails.
							replacementCtx.ui.notify(
								`Started a new session, but failed to delete the previous one: ${errorMessage(error)}`,
								"error",
							);
						}
					}

					await fullRedraw(replacementCtx);
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("Drop cancelled", "info");
				await fullRedraw(ctx);
			}
		},
	});
}
