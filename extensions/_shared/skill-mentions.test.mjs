import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = realpathSync(execFileSync("mise", ["which", "pi"], { encoding: "utf8" }).trim());
const require = createRequire(cli);
const packageRoot = realpathSync(require.resolve.paths("@earendil-works/pi-coding-agent")
	.map((path) => join(path, "@earendil-works/pi-coding-agent"))
	.find((path) => existsSync(join(path, "package.json"))));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": join(packageRoot, "dist/index.js"),
		"@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
	},
});
const extensionPath = fileURLToPath(new URL("../skill-mentions.ts", import.meta.url));
const { default: extension, findMentions, skillAutocomplete } = await jiti.import(extensionPath);
const names = (text) => findMentions(text).map((mention) => mention.name);

test("recognizes multiple mentions, punctuation, duplicates and multiline input", () => {
	assert.deepEqual(names("请用 $read 阅读，再用 $write 润色。\n$read."), ["read", "write", "read"]);
	assert.deepEqual(names("($read) 【$write】"), ["read", "write"]);
});

test("ignores code, escapes, shell syntax, paths and math", () => {
	for (const text of ["`$read`", "``$read``", "```ts\n$read\n```", "~~~\n$read\n~~~", "```\n$read", "\\$read", "$HOME", "${read}", "$(read)", "foo$read", "$$read$$", "$read$", "$read/file", "$read.md", "$read_more", "    $read"]) {
		assert.deepEqual(names(text), [], text);
	}
	assert.deepEqual(names("```\n$read\n```\n$write"), ["write"]);
	assert.deepEqual(names("`$read` $write"), ["write"]);
});

const skills = [{ name: "read", path: "/skills/read/SKILL.md", description: "Read documents" }, { name: "write", path: "/skills/write/SKILL.md", description: "Polish prose" }];
const options = { signal: new AbortController().signal };
const base = {
	triggerCharacters: ["#"],
	async getSuggestions() { return { items: [], prefix: "base" }; },
	applyCompletion() { return "base"; },
	shouldTriggerFileCompletion() { return false; },
};

test("dollar autocomplete lists descriptions and filters skills", async () => {
	const provider = skillAutocomplete(base, () => skills);
	assert.deepEqual(provider.triggerCharacters, ["#", "$"]);
	assert.deepEqual((await provider.getSuggestions(["use $"], 0, 5, options)).items.map((item) => item.value), ["$read", "$write"]);
	const result = await provider.getSuggestions(["$read then $wr"], 0, 14, options);
	assert.equal(result.prefix, "$wr");
	assert.equal(result.items[0].description, "Polish prose");
	assert.equal(result.items[0].value, "$write");
	assert.equal(await provider.getSuggestions(["$missing"], 0, 8, options), null);
});

test("completion preserves surrounding text and other providers", async () => {
	const provider = skillAutocomplete(base, () => skills);
	assert.deepEqual(provider.applyCompletion(["use $wr next"], 0, 7, { value: "$write" }, "$wr"), { lines: ["use $write next"], cursorLine: 0, cursorCol: 10 });
	assert.deepEqual(provider.applyCompletion(["$wr"], 0, 3, { value: "$write" }, "$wr"), { lines: ["$write "], cursorLine: 0, cursorCol: 7 });
	assert.equal((await provider.getSuggestions(["/skill:"], 0, 7, options)).prefix, "base");
	assert.equal((await provider.getSuggestions(["```", "$wr"], 1, 3, options)).prefix, "base");
	assert.equal(provider.applyCompletion([], 0, 0, { value: "file" }, "@"), "base");
	assert.equal(provider.shouldTriggerFileCompletion([], 0, 0), false);
});

function harness(commands) {
	const handlers = new Map();
	const notifications = [];
	const editors = [];
	const providers = [];
	const transformers = [];
	extension({
		getCommands: () => commands,
		on: (event, handler) => handlers.set(event, handler),
		registerMarkdownTransformer: (transformer) => transformers.push(transformer),
	});
	const ctx = { mode: "tui", hasUI: true, ui: {
		notify: (...args) => notifications.push(args),
		setEditorText: (text) => editors.push(text),
		addAutocompleteProvider: (factory) => providers.push(factory),
	} };
	return { handlers, ctx, notifications, editors, providers, transformers };
}

test("loads every selected skill once, strips metadata and preserves images", () => {
	const dir = mkdtempSync(join(tmpdir(), "skill-mentions-"));
	try {
		const commands = skills.map((skill) => {
			const path = join(dir, `${skill.name}.md`);
			writeFileSync(path, `---\nname: ${skill.name}\n---\nInstructions for ${skill.name}`);
			return { name: `skill:${skill.name}`, source: "skill", sourceInfo: { path } };
		});
		const { handlers, ctx, notifications } = harness(commands);
		const images = [{ type: "image", data: "test", mimeType: "image/png" }];
		const result = handlers.get("input")({ text: "$read $write $read", images, source: "interactive" }, ctx);
		assert.equal(result.action, "transform");
		assert.equal(result.images, images);
		assert.equal((result.text.match(/<skill name=/g) ?? []).length, 2);
		assert.ok(result.text.includes(`References are relative to ${dir}.`));
		assert.ok(result.text.includes("Instructions for read"));
		assert.ok(!result.text.includes("---"));
		assert.equal(notifications[0][0], "Loaded skills: $read, $write");
		assert.equal(handlers.get("input")({ text: "$unknown $HOME", source: "interactive" }, ctx).action, "continue");
		assert.equal(handlers.get("input")({ text: "$read", source: "extension" }, ctx).action, "continue");
		assert.equal(handlers.get("input")({ text: "/skill:write $read", source: "interactive" }, ctx).text.startsWith("/skill:write "), true);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed loading blocks submission and restores the prompt", () => {
	const { handlers, ctx, notifications, editors } = harness([{ name: "skill:read", source: "skill", sourceInfo: { path: "/nonexistent-skill-mentions/SKILL.md" } }]);
	assert.equal(handlers.get("input")({ text: "$read", source: "interactive" }, ctx).action, "handled");
	assert.equal(notifications[0][1], "error");
	assert.deepEqual(editors, ["$read"]);
});

test("registers terminal completion only in TUI mode", () => {
	const { handlers, ctx, providers } = harness([]);
	handlers.get("session_start")({}, { ...ctx, mode: "rpc" });
	assert.equal(providers.length, 0);
	handlers.get("session_start")({}, ctx);
	assert.equal(providers.length, 1);
});

test("renders only the original prompt while retaining skills in model context", async () => {
	const dir = mkdtempSync(join(tmpdir(), "skill-display-"));
	try {
		const path = join(dir, "SKILL.md");
		writeFileSync(path, "---\nname: read\n---\nPRIVATE_SKILL_BODY\n" + "Long instructions.\n".repeat(100));
		const { handlers, ctx } = harness([{ name: "skill:read", source: "skill", sourceInfo: { path } }]);
		const prompt = "$read 请阅读文章。\n保留这一行。";
		const result = handlers.get("input")({ text: prompt, source: "interactive", streamingBehavior: "followUp" }, ctx);
		assert.ok(result.text.includes("PRIVATE_SKILL_BODY"));
		// Recreate the extension to exercise rendering without any in-memory submission state.
		const { transformers } = harness([]);
		const user = { messageType: "user", isStreaming: false, availableWidth: 80 };
		assert.equal(transformers[0](result.text, user), prompt);
		assert.equal(transformers[0](result.text, { ...user, messageType: "assistant" }), result.text);
		assert.equal(transformers[0](result.text, { ...user, messageType: "assistant-thinking" }), result.text);
		assert.equal(transformers[0]("Literal <skill>example</skill>", user), "Literal <skill>example</skill>");
		assert.equal(transformers[0]("Text\n\n<!-- pi:skill-mentions -->\nUnfinished", user), "Text\n\n<!-- pi:skill-mentions -->\nUnfinished");
		const { initTheme } = await import(join(packageRoot, "dist/modes/interactive/theme/theme.js"));
		const { UserMessageComponent } = await import(join(packageRoot, "dist/modes/interactive/components/user-message.js"));
		initTheme("dark");
		for (const width of [30, 80, 140]) {
			const component = new UserMessageComponent(result.text, undefined, 1, transformers);
			const rendered = component.render(width).join("\n");
			assert.ok(rendered.includes("$read"));
			assert.ok(!rendered.includes("PRIVATE_SKILL_BODY"));
			assert.ok(!rendered.includes("Long instructions"));
			assert.ok(!rendered.includes("pi:skill-mentions"));
		}
		assert.ok(result.text.includes("PRIVATE_SKILL_BODY"));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loads through the actual Pi extension loader", async () => {
	const { loadExtensions } = await import(join(packageRoot, "dist/core/extensions/loader.js"));
	const result = await loadExtensions([extensionPath], process.cwd());
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
});
