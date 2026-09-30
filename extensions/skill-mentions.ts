import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteProvider } from "@earendil-works/pi-tui";

const SKILL_CONTENT_START = "\n\n<!-- pi:skill-mentions -->\n";
const SKILL_CONTENT_END = "\n<!-- /pi:skill-mentions -->";

interface SkillReference {
	name: string;
	path: string;
	description?: string;
}

interface Mention {
	name: string;
	start: number;
	end: number;
}

/** Ignore escaped dollars and Markdown code, including unfinished code fences. */
export function findMentions(text: string): Mention[] {
	const mentions: Mention[] = [];
	let fence: string | undefined;
	let inline = 0;
	let offset = 0;
	for (const line of text.split("\n")) {
		const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (fence) {
			if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
		} else if (!inline && marker) {
			fence = marker[1];
		} else if (!/^(?: {4}|\t)/.test(line)) {
			for (let i = 0; i < line.length; i++) {
				if (!inline && line[i] === "\\") {
					i++;
					continue;
				}
				if (line[i] === "`") {
					let end = i + 1;
					while (line[end] === "`") end++;
					const length = end - i;
					if (!inline) inline = length;
					else if (inline === length) inline = 0;
					i = end - 1;
					continue;
				}
				if (inline || line[i] !== "$" || (i > 0 && !/[\s([{（【，。；：！？]/u.test(line[i - 1]))) continue;
				const name = line.slice(i + 1).match(/^[a-z0-9-]*/)?.[0] ?? "";
				const end = i + 1 + name.length;
				if (!name && end < line.length) continue;
				// Do not interpret shell variables, math delimiters, or paths as mentions.
				if (end < line.length && /[\w$/{\-]/.test(line[end])) continue;
				if (line[end] === "." && /[\w/]/.test(line[end + 1] ?? "")) continue;
				mentions.push({ name, start: offset + i, end: offset + end });
				i = end - 1;
			}
		}
		offset += line.length + 1;
	}
	return mentions;
}

export function skillAutocomplete(current: AutocompleteProvider, getSkills: () => SkillReference[]): AutocompleteProvider {
	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "$"])],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const before = [...lines.slice(0, cursorLine), (lines[cursorLine] ?? "").slice(0, cursorCol)].join("\n");
			const mention = findMentions(before).find((item) => item.end === before.length);
			if (!mention) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (options.signal.aborted) return null;
			const skills = getSkills();
			const matches = mention.name ? fuzzyFilter(skills, mention.name, (skill) => skill.name) : skills;
			return matches.length ? {
				prefix: `$${mention.name}`,
				items: matches.map((skill) => ({ value: `$${skill.name}`, label: `$${skill.name}`, description: skill.description })),
			} : null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!prefix.startsWith("$") || !item.value.startsWith("$")) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const next = [...lines];
			const line = next[cursorLine];
			const suffix = line.slice(cursorCol);
			const inserted = item.value + (/^\s/.test(suffix) ? "" : " ");
			next[cursorLine] = line.slice(0, cursorCol - prefix.length) + inserted + suffix;
			return { lines: next, cursorLine, cursorCol: cursorCol - prefix.length + inserted.length };
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "user" || !markdown.endsWith(SKILL_CONTENT_END)) return markdown;
		const start = markdown.lastIndexOf(SKILL_CONTENT_START);
		return start === -1 ? markdown : markdown.slice(0, start);
	});

	const getSkills = (): SkillReference[] => pi.getCommands()
		.filter((command) => command.source === "skill")
		.map((command) => ({ name: command.name.slice("skill:".length), path: command.sourceInfo.path, description: command.description }));

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.addAutocompleteProvider((current) => skillAutocomplete(current, getSkills));
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const skills = new Map(getSkills().map((skill) => [skill.name, skill]));
		const selected = [...new Set(findMentions(event.text).map((mention) => mention.name))]
			.flatMap((name) => skills.has(name) ? [skills.get(name)!] : []);
		if (!selected.length) return { action: "continue" };
		let blocks: string[];
		try {
			blocks = selected.map((skill) => {
				const body = stripFrontmatter(readFileSync(skill.path, "utf8")).trim();
				return `<skill name=${JSON.stringify(skill.name)} location=${JSON.stringify(skill.path)}>\nReferences are relative to ${dirname(skill.path)}.\n\n${body}\n</skill>`;
			});
		} catch (error) {
			// Never submit a request with only a subset of its explicitly selected skills.
			if (ctx.hasUI) {
				ctx.ui.notify(`Skill loading failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				ctx.ui.setEditorText(event.text);
			}
			return { action: "handled" };
		}
		if (ctx.hasUI) ctx.ui.notify(`Loaded skills: ${selected.map((skill) => `$${skill.name}`).join(", ")}`, "info");
		// Keep a leading /skill: command available for Pi's own expansion pass.
		return { action: "transform", text: `${event.text}${SKILL_CONTENT_START}${blocks.join("\n\n")}${SKILL_CONTENT_END}`, images: event.images };
	});
}
