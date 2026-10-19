import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

// OpenAI calls fast mode the "priority" service tier. pi-ai reads the tier the
// server confirms in the response, so cost estimates follow automatically.
const FAST_PROVIDER = "openai";
const FAST_SERVICE_TIER = "priority";
const STATUS_KEY = "fast";

const ARGUMENTS = [
	{ value: "on", label: "on", description: "Enable fast mode for openai models" },
	{ value: "off", label: "off", description: "Disable fast mode" },
	{ value: "status", label: "status", description: "Show the current fast mode state" },
];

// Global, not per session: the agent dir is git-ignored except for tracked config.
function stateFile(): string {
	return join(getAgentDir(), "fast-mode.json");
}

function loadEnabled(): boolean {
	try {
		const state = JSON.parse(readFileSync(stateFile(), "utf8")) as { enabled?: unknown };
		return state.enabled === true;
	} catch {
		return false;
	}
}

async function saveEnabled(enabled: boolean): Promise<void> {
	const file = stateFile();
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appliesTo(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === FAST_PROVIDER;
}

export default function (pi: ExtensionAPI) {
	let enabled = false;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, enabled && appliesTo(ctx) ? "fast" : undefined);
	}

	function describe(ctx: ExtensionContext): string {
		if (!enabled) return "Fast mode is off";
		if (appliesTo(ctx)) return "Fast mode is on";
		return `Fast mode is on, but it applies only to ${FAST_PROVIDER} models`;
	}

	pi.on("session_start", (_event, ctx) => {
		enabled = loadEnabled();
		updateStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !appliesTo(ctx) || !isPlainObject(event.payload)) return;
		// Skip nested requests to other models, for example from another extension.
		if (event.payload.model !== ctx.model?.id) return;
		return { ...event.payload, service_tier: FAST_SERVICE_TIER };
	});

	pi.registerCommand("fast", {
		description: "Toggle fast mode (priority service tier) for openai models",
		getArgumentCompletions: (prefix) => {
			const items = ARGUMENTS.filter((item) => item.value.startsWith(prefix.trim()));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			let next: boolean;
			if (arg === "") next = !enabled;
			else if (arg === "on") next = true;
			else if (arg === "off") next = false;
			else if (arg === "status") {
				ctx.ui.notify(describe(ctx), "info");
				return;
			} else {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}

			enabled = next;
			updateStatus(ctx);
			try {
				await saveEnabled(enabled);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`${describe(ctx)} (not saved: ${message})`, "warning");
				return;
			}
			ctx.ui.notify(describe(ctx), "info");
		},
	});
}
