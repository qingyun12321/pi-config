import { unlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearTerminalAtProcessExit } from "./_shared/full-redraw.ts";

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

function removeAtProcessExit(sessionFile: string): void {
	process.once("exit", () => {
		try {
			// A shutdown handler could recreate the transcript after the command's
			// initial unlink. Remove it once more at the final process boundary.
			unlinkSync(sessionFile);
		} catch (error) {
			if (!isMissingFile(error)) {
				console.error(`Failed to delete session ${sessionFile}: ${errorMessage(error)}`);
			}
		}
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("delete", {
		description: "Delete the current session and exit pi",
		handler: async (_args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				clearTerminalAtProcessExit();
				ctx.shutdown();
				return;
			}

			try {
				await unlink(sessionFile);
			} catch (error) {
				if (!isMissingFile(error)) {
					ctx.ui.notify(`Failed to delete session: ${errorMessage(error)}`, "error");
					return;
				}
			}

			removeAtProcessExit(sessionFile);
			clearTerminalAtProcessExit();
			ctx.shutdown();
		},
	});
}
