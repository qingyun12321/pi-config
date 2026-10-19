import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CRAWL_LIMIT_DEFAULT,
	CRAWL_PATH,
	type CrawlResponse,
	DEFAULT_BASE_URL,
	EXTRACT_CHUNKS_MAX,
	EXTRACT_DEPTHS,
	EXTRACT_PATH,
	EXTRACT_TIMEOUT_MAX,
	EXTRACT_TIMEOUT_MIN,
	EXTRACT_URLS_MAX,
	type ExtractResponse,
	MAP_LIMIT_DEFAULT,
	MAP_PATH,
	type MapResponse,
	MAX_RESULTS_DEFAULT,
	MAX_RESULTS_MAX,
	MAX_RESULTS_MIN,
	type RequestOptions,
	type RetryEvent,
	SEARCH_CHUNKS_MAX,
	SEARCH_DEPTHS,
	SEARCH_PATH,
	type SearchResponse,
	SITE_BREADTH_MAX,
	SITE_DEPTH_MAX,
	SITE_TIMEOUT_MAX,
	SITE_TIMEOUT_MIN,
	TIME_RANGES,
	TOPICS,
	TavilyApiError,
	USAGE_PATH,
	buildCrawlBody,
	buildExtractBody,
	buildMapBody,
	buildSearchBody,
	formatCrawlResults,
	formatExtractResults,
	formatMapResults,
	formatSearchResults,
	requestJson,
} from "./lib.ts";

// Configuration comes from the environment, so no secret is stored in this repo.
//   TAVILY_API_KEY       API key (else the Tavily CLI login in ~/.tavily/config.json;
//                        else keyless mode, which supports only search and extract)
//   TAVILY_BASE_URL      default https://api.tavily.com
//   TAVILY_TIMEOUT_MS    minimum per-attempt timeout, default 60000
//   TAVILY_MAX_RETRIES   retries for 408/429/5xx, default 3
function config() {
	const int = (name: string, fallback: number) => {
		const value = Number.parseInt(process.env[name] ?? "", 10);
		return Number.isFinite(value) && value >= 0 ? value : fallback;
	};
	return {
		baseUrl: process.env.TAVILY_BASE_URL?.trim() || DEFAULT_BASE_URL,
		timeoutMs: int("TAVILY_TIMEOUT_MS", 60_000),
		maxRetries: int("TAVILY_MAX_RETRIES", 3),
	};
}

interface Auth {
	key: string;
	source: string;
}

async function resolveApiKey(): Promise<Auth | undefined> {
	const env = process.env.TAVILY_API_KEY?.trim();
	if (env) return { key: env, source: "TAVILY_API_KEY" };
	const file = join(homedir(), ".tavily", "config.json");
	try {
		const json = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		const key = [json.api_key, json.apiKey, json.key].find((value) => typeof value === "string" && value.trim());
		if (typeof key === "string") return { key: key.trim(), source: "~/.tavily/config.json (tvly login)" };
	} catch {
		// No CLI login.
	}
	return undefined;
}

const KEY_REQUIRED =
	"This Tavily tool needs an API key (keyless mode supports only tavily_search and tavily_extract). " +
	"Set TAVILY_API_KEY (free key with 1,000 credits/month at https://app.tavily.com), or use another available tool.";

const KEY_TOOLS = ["tavily_map", "tavily_crawl"];

type Kind = "search" | "extract" | "map" | "crawl";
interface UsageCount {
	requests: number;
	/** Free requests; the response still reports credits, so do not add them. */
	keyless: number;
	credits: number;
	failed: number;
}
const usage: Record<Kind, UsageCount> = {
	search: { requests: 0, keyless: 0, credits: 0, failed: 0 },
	extract: { requests: 0, keyless: 0, credits: 0, failed: 0 },
	map: { requests: 0, keyless: 0, credits: 0, failed: 0 },
	crawl: { requests: 0, keyless: 0, credits: 0, failed: 0 },
};

function countUsage(kind: Kind, keyless: boolean, credits: number | undefined) {
	usage[kind].requests++;
	if (keyless) usage[kind].keyless++;
	else if (typeof credits === "number" && Number.isFinite(credits)) usage[kind].credits += credits;
}

/** Keep the model-facing text in the built-in limits; keep the full text in a temp file. */
async function truncateForModel(text: string, prefix: string) {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return { text, fullOutputPath: undefined };
	const dir = await mkdtemp(join(tmpdir(), prefix));
	const fullOutputPath = join(dir, "output.md");
	await writeFile(fullOutputPath, text, "utf8");
	const notice =
		`\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines` +
		` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).` +
		` Full output saved to: ${fullOutputPath}]`;
	return { text: truncation.content + notice, fullOutputPath };
}

function retryReporter(onUpdate: ((update: { content: { type: "text"; text: string }[]; details: any }) => void) | undefined) {
	return (event: RetryEvent) => {
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `Retry ${event.attempt}/${event.maxAttempts - 1} in ${Math.round(event.delayMs / 100) / 10}s: ${event.error.message.split("\n")[0]}`,
				},
			],
			details: undefined,
		});
	};
}

/** The client timeout must be longer than the server-side timeout of the endpoint. */
function requestOptions(
	apiKey: string | undefined,
	serverTimeoutSec: number,
	signal: AbortSignal | undefined,
	onRetry: (event: RetryEvent) => void,
): RequestOptions {
	const { baseUrl, timeoutMs, maxRetries } = config();
	return {
		apiKey,
		baseUrl,
		timeoutMs: Math.max(timeoutMs, (serverTimeoutSec + 20) * 1000),
		maxRetries,
		signal,
		onRetry,
	};
}

/** Tell the model to change tools when a retry with the same tool will not help. */
function withFallbackHint(error: unknown, other: string): Error {
	const err = error instanceof Error ? error : new Error(String(error));
	if (err instanceof TavilyApiError && err.invalidRequest) return err;
	if (err.name === "AbortError" || /aborted/i.test(err.message)) return err;
	return new Error(`${err.message}\nIf this cannot be fixed now, use ${other} for the same need.`);
}

async function call<T>(
	kind: Kind,
	path: string,
	body: unknown,
	options: RequestOptions,
	other: string,
): Promise<T & { usage?: { credits?: number } }> {
	try {
		const response = await requestJson<T & { usage?: { credits?: number } }>(path, body, options);
		countUsage(kind, !options.apiKey, response.usage?.credits);
		return response;
	} catch (error) {
		usage[kind].failed++;
		if (!options.apiKey && error instanceof TavilyApiError && error.status === 429) {
			error.message += "\nThe keyless quota is used up. Tell the user to set TAVILY_API_KEY to continue with Tavily.";
		}
		throw withFallbackHint(error, other);
	}
}

function partialText(result: { content: { type: string; text?: string }[] }, fallback: string): string {
	const first = result.content[0];
	return first?.type === "text" && first.text ? first.text : fallback;
}

// ---------------------------------------------------------------------------
// Schemas

const StringList = (description: string) => Type.Optional(Type.Array(Type.String(), { description }));

const SearchParams = Type.Object({
	query: Type.String({
		description: "Search query in natural language or keywords. Write it in the language of the sources you want.",
	}),
	max_results: Type.Optional(
		Type.Integer({
			minimum: MAX_RESULTS_MIN,
			maximum: MAX_RESULTS_MAX,
			description: `Number of results, ${MAX_RESULTS_MIN}-${MAX_RESULTS_MAX} (default ${MAX_RESULTS_DEFAULT}). Use 5 for focused answers and 10 for broad research.`,
		}),
	),
	search_depth: Type.Optional(
		StringEnum(SEARCH_DEPTHS, {
			description:
				"basic (default, 1 credit): balanced. advanced (2 credits): highest relevance, for comparisons and high-confidence answers. fast / ultra-fast (1 credit): lower latency.",
		}),
	),
	chunks_per_source: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: SEARCH_CHUNKS_MAX,
			description: `Relevant snippets per result, 1-${SEARCH_CHUNKS_MAX} (default 3). Not for ultra-fast.`,
		}),
	),
	topic: Type.Optional(
		StringEnum(TOPICS, { description: "general (default), news (current events from mainstream media), or finance." }),
	),
	time_range: Type.Optional(
		StringEnum(TIME_RANGES, { description: "Only results published or updated in this period back from today." }),
	),
	start_date: Type.Optional(Type.String({ description: "Only results published on or after this date: YYYY-MM-DD." })),
	end_date: Type.Optional(Type.String({ description: "Only results published on or before this date: YYYY-MM-DD." })),
	include_domains: StringList('Only results from these domains. Example: ["github.com", "arxiv.org"].'),
	exclude_domains: StringList("Exclude results from these domains."),
	country: Type.Optional(
		Type.String({
			description:
				'Boost results from this country. Lowercase English name, for example "china", "united states", "japan". Only for topic general.',
		}),
	),
	language: Type.Optional(
		Type.String({ description: 'Boost results in this language. ISO 639-1 code, for example "en", "zh-cn".' }),
	),
	exact_match: Type.Optional(
		Type.Boolean({ description: 'Only results that contain the "quoted phrases" of the query exactly.' }),
	),
	include_answer: Type.Optional(
		Type.Boolean({ description: "Also return a short LLM-generated answer from Tavily (default false)." }),
	),
	include_raw_content: Type.Optional(
		Type.Boolean({
			description:
				"Also return the full page content of each result as Markdown (default false). Uses much more context; prefer tavily_extract for a few selected URLs.",
		}),
	),
});

const ExtractParams = Type.Object({
	urls: Type.Array(Type.String(), {
		minItems: 1,
		maxItems: EXTRACT_URLS_MAX,
		description: `HTTP or HTTPS URLs to read, 1-${EXTRACT_URLS_MAX}.`,
	}),
	query: Type.Optional(
		Type.String({
			description: "Your intent. With it, only the most relevant chunks of each page are returned, which saves context.",
		}),
	),
	chunks_per_source: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: EXTRACT_CHUNKS_MAX,
			description: `Chunks of about 800 characters per page, 1-${EXTRACT_CHUNKS_MAX} (default 3). Only with query.`,
		}),
	),
	extract_depth: Type.Optional(
		StringEnum(EXTRACT_DEPTHS, {
			description:
				"basic (default). advanced: gets tables, embedded and JavaScript-rendered content, and succeeds more often; costs 2x and is slower.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			minimum: EXTRACT_TIMEOUT_MIN,
			maximum: EXTRACT_TIMEOUT_MAX,
			description: `Server-side timeout in seconds, ${EXTRACT_TIMEOUT_MIN}-${EXTRACT_TIMEOUT_MAX} (default 10 for basic, 30 for advanced).`,
		}),
	),
});

const siteFields = (limitDefault: number) => ({
	url: Type.String({ description: "Root URL or domain to start from, for example docs.tavily.com." }),
	instructions: Type.Optional(
		Type.String({ description: 'Natural-language focus, for example "Find all pages about the Python SDK".' }),
	),
	max_depth: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: SITE_DEPTH_MAX,
			description: `Link levels to follow from the root, 1-${SITE_DEPTH_MAX} (default 1).`,
		}),
	),
	max_breadth: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: SITE_BREADTH_MAX,
			description: `Links to follow on each page, 1-${SITE_BREADTH_MAX} (default 20).`,
		}),
	),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, description: `Maximum number of pages to process (default ${limitDefault}).` }),
	),
	select_paths: StringList('Only URLs whose path matches these regex patterns. Example: ["/docs/.*", "/api/v1.*"].'),
	exclude_paths: StringList("Skip URLs whose path matches these regex patterns."),
	select_domains: StringList('Only these domains or subdomains (regex). Example: ["^docs\\\\.example\\\\.com$"].'),
	exclude_domains: StringList("Skip these domains or subdomains (regex)."),
	allow_external: Type.Optional(Type.Boolean({ description: "Include links to external domains (default true)." })),
	timeout: Type.Optional(
		Type.Number({
			minimum: SITE_TIMEOUT_MIN,
			maximum: SITE_TIMEOUT_MAX,
			description: `Server-side timeout in seconds, ${SITE_TIMEOUT_MIN}-${SITE_TIMEOUT_MAX} (default 150).`,
		}),
	),
});

const MapParams = Type.Object(siteFields(MAP_LIMIT_DEFAULT));

const CrawlParams = Type.Object({
	...siteFields(CRAWL_LIMIT_DEFAULT),
	chunks_per_source: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: EXTRACT_CHUNKS_MAX,
			description: `Return only the most relevant chunks per page, 1-${EXTRACT_CHUNKS_MAX}. Only with instructions.`,
		}),
	),
	extract_depth: Type.Optional(
		StringEnum(EXTRACT_DEPTHS, { description: "basic (default) or advanced (tables and embedded content, 2x cost)." }),
	),
});

interface SearchDetails {
	query: string;
	keyless: boolean;
	answer: boolean;
	credits?: number;
	results: { title: string; url: string; score: number; published_date?: string | null }[];
	fullOutputPath?: string;
}

interface PagesDetails {
	keyless?: boolean;
	credits?: number;
	pages: { url: string; title?: string | null; chars: number }[];
	failed: { url: string; error: string }[];
	fullOutputPath?: string;
}

interface MapDetails {
	baseUrl: string;
	credits?: number;
	urls: string[];
	fullOutputPath?: string;
}

function creditsText(credits: number | undefined, keyless: boolean | undefined): string {
	if (keyless) return " keyless";
	return typeof credits === "number" ? ` ${credits} credit${credits === 1 ? "" : "s"}` : "";
}

function renderPages(details: PagesDetails | undefined, expanded: boolean, theme: any, noun: string) {
	if (!details) return new Text("", 0, 0);
	let text = theme.fg(details.pages.length > 0 ? "success" : "warning", `${details.pages.length} ${noun}`);
	if (details.failed.length > 0) text += theme.fg("error", `, ${details.failed.length} failed`);
	text += theme.fg("dim", creditsText(details.credits, details.keyless));
	if (details.fullOutputPath) text += theme.fg("warning", " (truncated)");
	const shown = expanded ? details.pages : details.pages.slice(0, 3);
	for (const page of shown) {
		text += `\n${theme.fg("muted", "-")} ${page.title || page.url} ${theme.fg("dim", `${page.chars.toLocaleString()} chars`)}`;
		if (page.title) text += `\n  ${theme.fg("dim", page.url)}`;
	}
	if (!expanded && details.pages.length > shown.length) {
		text += `\n${theme.fg("dim", `... ${details.pages.length - shown.length} more`)}`;
	}
	for (const item of details.failed) text += `\n${theme.fg("error", `x ${item.url}: ${item.error}`)}`;
	if (expanded && details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
	return new Text(text, 0, 0);
}

export default function (pi: ExtensionAPI) {
	// Without a key, Map and Crawl can only fail, so do not offer them to the model.
	pi.on("session_start", async () => {
		if (await resolveApiKey()) return;
		const active = pi.getActiveTools();
		const next = active.filter((name) => !KEY_TOOLS.includes(name));
		if (next.length !== active.length) pi.setActiveTools(next);
	});

	pi.registerTool({
		name: "tavily_search",
		label: "Tavily Search",
		description:
			"Search the live web with Tavily, a search engine for AI agents. Returns ranked results with title, URL, published date, relevance score, and the most relevant content snippets; optionally a short generated answer or the full page content. Supports news and finance topics, date, domain, country, and language filters.",
		promptSnippet: "tavily_search: search the live web (Tavily)",
		promptGuidelines: [
			"Use tavily_search when the sources are unknown or current information is needed. Use tavily_extract to read known URLs, tavily_map to list the pages of a site, and tavily_crawl to read many pages of a site.",
			"Keep tavily_search queries short and specific. Use topic, time_range, start_date, include_domains, and country instead of putting these constraints into the query.",
			"Use tavily_search search_depth advanced for comparisons and high-confidence answers; basic is enough for quick lookups.",
			"Cite the URLs of the sources you use. Treat the tavily_search answer field only as a lead and verify it against the results.",
			"If tavily_search gives no results, irrelevant results, or an error, try once more with a shorter query or fewer filters. If that also fails, use another available web search tool for the same need. Do not repeat a call that failed.",
		],
		parameters: SearchParams,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

		async execute(_toolCallId, params, signal, onUpdate) {
			const body = buildSearchBody(params);
			const auth = await resolveApiKey();
			const response = await call<SearchResponse>(
				"search",
				SEARCH_PATH,
				body,
				requestOptions(auth?.key, 0, signal, retryReporter(onUpdate)),
				"another available web search tool",
			);
			const results = Array.isArray(response.results) ? response.results : [];
			const { text, fullOutputPath } = await truncateForModel(formatSearchResults(response), "pi-tavily-search-");
			const details: SearchDetails = {
				query: String(body.query),
				keyless: !auth,
				answer: Boolean(response.answer),
				credits: response.usage?.credits,
				results: results.map(({ title, url, score, published_date }) => ({ title, url, score, published_date })),
				fullOutputPath,
			};
			return { content: [{ type: "text", text }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("tavily_search ")) + theme.fg("accent", `"${args.query}"`);
			const extras = [
				args.search_depth && args.search_depth !== "basic" ? args.search_depth : undefined,
				args.topic && args.topic !== "general" ? `topic: ${args.topic}` : undefined,
				args.time_range ? `last ${args.time_range}` : undefined,
				args.start_date ? `from ${args.start_date}` : undefined,
				args.end_date ? `to ${args.end_date}` : undefined,
				args.include_domains?.length ? `sites: ${args.include_domains.join(", ")}` : undefined,
				args.country ? `country: ${args.country}` : undefined,
				args.language ? `lang: ${args.language}` : undefined,
				args.max_results ? `max: ${args.max_results}` : undefined,
				args.include_answer ? "with answer" : undefined,
				args.include_raw_content ? "with content" : undefined,
			].filter(Boolean);
			if (extras.length > 0) text += theme.fg("dim", ` (${extras.join("; ")})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", partialText(result, "Searching...")), 0, 0);
			const details = result.details as SearchDetails | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.results.length === 0 && !details.answer) return new Text(theme.fg("dim", "No results"), 0, 0);
			let text = theme.fg("success", `${details.results.length} results`);
			if (details.answer) text += theme.fg("success", " + answer");
			text += theme.fg("dim", creditsText(details.credits, details.keyless));
			if (details.fullOutputPath) text += theme.fg("warning", " (truncated)");
			const shown = expanded ? details.results : details.results.slice(0, 3);
			shown.forEach((item, index) => {
				const score = Number.isFinite(item.score) ? item.score.toFixed(2) : "?";
				text += `\n${theme.fg("muted", `${index + 1}.`)} ${item.title || "(no title)"} ${theme.fg("dim", `[${score}]`)}`;
				text += `\n   ${theme.fg("dim", item.url)}`;
			});
			if (!expanded && details.results.length > shown.length) {
				text += `\n${theme.fg("dim", `... ${details.results.length - shown.length} more`)}`;
			}
			if (expanded && details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "tavily_extract",
		label: "Tavily Extract",
		description:
			"Read 1-20 web pages with Tavily Extract and return their content as clean Markdown. With query, return only the most relevant chunks of each page. Use it after tavily_search, or when the user gives URLs.",
		promptSnippet: "tavily_extract: read web pages as Markdown (Tavily)",
		promptGuidelines: [
			"Give tavily_extract a query when you need only part of a long page, to save context. Put several URLs in one tavily_extract call instead of many calls.",
			"If tavily_extract fails for a URL, try once with extract_depth advanced. If that also fails, use another available fetch or browser tool.",
		],
		parameters: ExtractParams,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

		async execute(_toolCallId, params, signal, onUpdate) {
			const body = buildExtractBody(params);
			const auth = await resolveApiKey();
			const serverTimeout = params.timeout ?? (params.extract_depth === "advanced" ? 30 : 10);
			const response = await call<ExtractResponse>(
				"extract",
				EXTRACT_PATH,
				body,
				requestOptions(auth?.key, serverTimeout, signal, retryReporter(onUpdate)),
				"another available fetch or browser tool",
			);
			const pages = Array.isArray(response.results) ? response.results : [];
			const { text, fullOutputPath } = await truncateForModel(formatExtractResults(response), "pi-tavily-extract-");
			const details: PagesDetails = {
				keyless: !auth,
				credits: response.usage?.credits,
				pages: pages.map((page) => ({ url: page.url, title: page.title, chars: page.raw_content?.length ?? 0 })),
				failed: Array.isArray(response.failed_results) ? response.failed_results : [],
				fullOutputPath,
			};
			return { content: [{ type: "text", text }], details };
		},

		renderCall(args, theme) {
			const urls = Array.isArray(args.urls) ? args.urls : [];
			let text = theme.fg("toolTitle", theme.bold("tavily_extract ")) + theme.fg("accent", urls[0] ?? "");
			if (urls.length > 1) text += theme.fg("dim", ` +${urls.length - 1} more`);
			if (args.query) text += theme.fg("dim", ` (query: "${args.query}")`);
			if (args.extract_depth === "advanced") text += theme.fg("dim", " (advanced)");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", partialText(result, "Extracting...")), 0, 0);
			return renderPages(result.details as PagesDetails | undefined, expanded, theme, "pages");
		},
	});

	pi.registerTool({
		name: "tavily_map",
		label: "Tavily Map",
		description:
			"List the URLs of a website with Tavily Map, which follows links from a root URL like a graph. Returns URLs only, no content. Needs a Tavily API key.",
		promptSnippet: "tavily_map: list the page URLs of a website (Tavily)",
		promptGuidelines: [
			"Use tavily_map to find the right pages of a known site before tavily_extract or tavily_crawl. Use instructions and select_paths to keep the result focused.",
		],
		parameters: MapParams,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

		async execute(_toolCallId, params, signal, onUpdate) {
			const body = buildMapBody(params);
			const auth = await resolveApiKey();
			if (!auth) throw new Error(KEY_REQUIRED);
			const response = await call<MapResponse>(
				"map",
				MAP_PATH,
				body,
				requestOptions(auth.key, params.timeout ?? SITE_TIMEOUT_MAX, signal, retryReporter(onUpdate)),
				"tavily_search with include_domains, or another available tool",
			);
			const urls = Array.isArray(response.results) ? response.results : [];
			const { text, fullOutputPath } = await truncateForModel(formatMapResults(response), "pi-tavily-map-");
			const details: MapDetails = { baseUrl: response.base_url, credits: response.usage?.credits, urls, fullOutputPath };
			return { content: [{ type: "text", text }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("tavily_map ")) + theme.fg("accent", args.url);
			if (args.instructions) text += theme.fg("dim", ` ("${args.instructions}")`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", partialText(result, "Mapping...")), 0, 0);
			const details = result.details as MapDetails | undefined;
			if (!details) return new Text("", 0, 0);
			let text = theme.fg(details.urls.length > 0 ? "success" : "warning", `${details.urls.length} URLs`);
			text += theme.fg("dim", creditsText(details.credits, false));
			if (details.fullOutputPath) text += theme.fg("warning", " (truncated)");
			const shown = expanded ? details.urls : details.urls.slice(0, 5);
			for (const url of shown) text += `\n${theme.fg("dim", url)}`;
			if (!expanded && details.urls.length > shown.length) {
				text += `\n${theme.fg("dim", `... ${details.urls.length - shown.length} more`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "tavily_crawl",
		label: "Tavily Crawl",
		description:
			"Crawl a website with Tavily Crawl: follow links from a root URL and return the content of each page as Markdown. Use it to read many pages of a site or section. Needs a Tavily API key.",
		promptSnippet: "tavily_crawl: read many pages of a website (Tavily)",
		promptGuidelines: [
			"Keep tavily_crawl small: set instructions, select_paths, and a low limit. Use tavily_map first when you do not know the site structure.",
		],
		parameters: CrawlParams,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

		async execute(_toolCallId, params, signal, onUpdate) {
			const body = buildCrawlBody(params);
			const auth = await resolveApiKey();
			if (!auth) throw new Error(KEY_REQUIRED);
			const response = await call<CrawlResponse>(
				"crawl",
				CRAWL_PATH,
				body,
				requestOptions(auth.key, params.timeout ?? SITE_TIMEOUT_MAX, signal, retryReporter(onUpdate)),
				"tavily_map with tavily_extract, or another available tool",
			);
			const pages = Array.isArray(response.results) ? response.results : [];
			const { text, fullOutputPath } = await truncateForModel(formatCrawlResults(response), "pi-tavily-crawl-");
			const details: PagesDetails = {
				credits: response.usage?.credits,
				pages: pages.map((page) => ({ url: page.url, title: page.title, chars: page.raw_content?.length ?? 0 })),
				failed: [],
				fullOutputPath,
			};
			return { content: [{ type: "text", text }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("tavily_crawl ")) + theme.fg("accent", args.url);
			const extras = [
				args.instructions ? `"${args.instructions}"` : undefined,
				args.select_paths?.length ? `paths: ${args.select_paths.join(", ")}` : undefined,
				`limit: ${args.limit ?? CRAWL_LIMIT_DEFAULT}`,
			].filter(Boolean);
			text += theme.fg("dim", ` (${extras.join("; ")})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", partialText(result, "Crawling...")), 0, 0);
			return renderPages(result.details as PagesDetails | undefined, expanded, theme, "pages");
		},
	});

	pi.registerCommand("tavily", {
		description: "Show Tavily configuration, usage in this pi process, and account credits",
		handler: async (_args, ctx) => {
			const auth = await resolveApiKey();
			const { baseUrl, timeoutMs, maxRetries } = config();
			const lines = [
				`API key: ${auth ? auth.source : "missing (keyless mode: only tavily_search and tavily_extract)"}`,
				`Base URL: ${baseUrl}`,
				`Timeout: at least ${timeoutMs} ms, retries: ${maxRetries}`,
				...(Object.keys(usage) as Kind[]).map((kind) => {
					const u = usage[kind];
					const keyless = u.keyless > 0 ? `, ${u.keyless} keyless` : "";
					return `${kind}: ${u.requests} ok (${u.credits} credit${u.credits === 1 ? "" : "s"}${keyless}), ${u.failed} failed`;
				}),
			];
			if (auth) {
				try {
					const account = await requestJson<any>(USAGE_PATH, undefined, {
						apiKey: auth.key,
						baseUrl,
						method: "GET",
						timeoutMs: 15_000,
						maxRetries: 0,
					});
					const limit = (value: unknown) => (value === null || value === undefined ? "unlimited" : String(value));
					if (account?.key) lines.push(`Key credits used: ${account.key.usage ?? "?"} / ${limit(account.key.limit)}`);
					if (account?.account) {
						const a = account.account;
						lines.push(`Plan ${a.current_plan ?? "?"}: ${a.plan_usage ?? "?"} / ${limit(a.plan_limit)} credits`);
						if (a.paygo_limit) lines.push(`Pay-as-you-go: ${a.paygo_usage ?? 0} / ${a.paygo_limit}`);
					}
				} catch (error) {
					lines.push(`Account usage unavailable: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
				}
			}
			ctx.ui.notify(lines.join("\n"), auth ? "info" : "warning");
		},
	});
}
