import { writeSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

const CLEAR_SCREEN_AND_SCROLLBACK = "\x1b[2J\x1b[H\x1b[3J";

const emptyComponent: Component = {
	render: () => [],
	invalidate: () => {},
};

/** Clear the terminal after pi has stopped its TUI, immediately before returning to the shell. */
export function clearTerminalAtProcessExit(): void {
	if (!process.stdout.isTTY) {
		return;
	}

	process.once("exit", () => {
		try {
			writeSync(process.stdout.fd, CLEAR_SCREEN_AND_SCROLLBACK);
		} catch {
			// The terminal may already be unavailable during process teardown.
		}
	});
}

/** Clear terminal history and force pi to rebuild its complete TUI frame. */
export async function fullRedraw(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui" || !process.stdout.isTTY) {
		return;
	}

	await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
		// renderNow(true) resets the renderer's diff state. Clear the terminal
		// first so the rebuilt frame replaces both the viewport and scrollback.
		tui.terminal.write(CLEAR_SCREEN_AND_SCROLLBACK);
		tui.renderNow(true);
		done();
		return emptyComponent;
	});
}
