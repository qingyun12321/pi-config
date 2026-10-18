import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	COUNT_DEFAULT,
	COUNT_MAX,
	COUNT_MIN,
	DEFAULT_BASE_URL,
	FETCH_PATH,
	type FetchResponse,
	PRICE_PER_REQUEST_USD,
	postJson,
	QPS_LIMIT,
	QUERY_MAX_CHARS,
	RateLimiter,
	REGIONS,
	type RequestOptions,
	type RetryEvent,
	SEARCH_PATH,
	type SearchResponse,
	type SearchResult,
	buildSearchBody,
	DeepSeekApiError,
	formatFetchResult,
	formatSearchResults,
	validateFetchUrl,
} from "./lib.ts";

// Configuration comes from the environment, so no secret is stored in this repo.
//   DEEPSEEK_SEARCH_API_KEY      key for these tools only (else the "deepseek" provider key:
//                                DEEPSEEK_API_KEY or /login)
//   DEEPSEEK_SEARCH_BASE_URL     default https://api.deepseek.com
//   DEEPSEEK_SEARCH_REGION       default region code (CN, US, JP, ...), see REGION_IPS
//   DEEPSEEK_SEARCH_LOCALIZATION default IP address for localized results (wins over the region)
//   DEEPSEEK_SEARCH_TIMEOUT_MS   per-attempt timeout, default 60000
//   DEEPSEEK_SEARCH_MAX_RETRIES  retries for 408/429/5xx, default 3
function config() {
	const int = (name: string, fallback: number) => {
		const value = Number.parseInt(process.env[name] ?? "", 10);
		return Number.isFinite(value) && value >= 0 ? value : fallback;
	};
	return {
		baseUrl: process.env.DEEPSEEK_SEARCH_BASE_URL?.trim() || DEFAULT_BASE_URL,
		localization: process.env.DEEPSEEK_SEARCH_LOCALIZATION?.trim() || undefined,
		region: process.env.DEEPSEEK_SEARCH_REGION?.trim() || undefined,
		timeoutMs: int("DEEPSEEK_SEARCH_TIMEOUT_MS", 60_000),
		maxRetries: int("DEEPSEEK_SEARCH_MAX_RETRIES", 3),
	};
}

async function resolveApiKey(ctx: ExtensionContext): Promise<{ key: string; source: string } | undefined> {
	const own = process.env.DEEPSEEK_SEARCH_API_KEY?.trim();
	if (own) return { key: own, source: "DEEPSEEK_SEARCH_API_KEY" };
	const provider = await ctx.modelRegistry.getApiKeyForProvider("deepseek");
	if (provider) return { key: provider, source: "deepseek provider (DEEPSEEK_API_KEY or /login)" };
	return undefined;
}

const MISSING_KEY =
	"No DeepSeek API key. Set DEEPSEEK_API_KEY (or DEEPSEEK_SEARCH_API_KEY), or run /login and select DeepSeek.";

// Search and Fetch have separate account-level QPS quotas.
const searchLimiter = new RateLimiter(QPS_LIMIT);
const fetchLimiter = new RateLimiter(QPS_LIMIT);

interface Usage {
	requests: number;
	billable: number;
	failed: number;
}
const usage: Record<"search" | "fetch", Usage> = {
	search: { requests: 0, billable: 0, failed: 0 },
	fetch: { requests: 0, billable: 0, failed: 0 },
};

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

function requestOptions(
	apiKey: string,
	limiter: RateLimiter,
	signal: AbortSignal | undefined,
	onRetry: (event: RetryEvent) => void,
): RequestOptions {
	const { baseUrl, timeoutMs, maxRetries } = config();
	return { apiKey, baseUrl, timeoutMs, maxRetries, limiter, signal, onRetry };
}

// ---------------------------------------------------------------------------
// Schemas

const StringList = (description: string) => Type.Optional(Type.Array(Type.String(), { description }));

const SearchParams = Type.Object({
	query: Type.String({
		description:
			`Search query. The final query (with the operators added from the other fields) must be at most ${QUERY_MAX_CHARS} characters. ` +
			'Inline operators also work: site:, -site:, -term, -"phrase", "phrase", lang:zh,en, after:2025, before:2026-06-01.',
	}),
	count: Type.Optional(
		Type.Integer({
			minimum: COUNT_MIN,
			maximum: COUNT_MAX,
			description: `Number of results, ${COUNT_MIN}-${COUNT_MAX} (default ${COUNT_DEFAULT}). The price is per request, not per result.`,
		}),
	),
	need_content: Type.Optional(
		Type.Boolean({
			description:
				"Also return the full page content of each result (default false). Without it, each result has a 600-800 character summary. The price is the same either way; content uses more context.",
		}),
	),
	ori_question: Type.Optional(
		Type.String({
			description:
				"The user's original question that caused this search, at most 128 characters. It improves query understanding.",
		}),
	),
	sites: StringList('Only these sites, joined with OR. Example: ["github.com", "huggingface.co"].'),
	exclude_sites: StringList("Exclude these sites."),
	exact_phrases: StringList("Results must contain each exact phrase."),
	exclude_terms: StringList("Exclude pages that contain these terms or phrases."),
	languages: StringList('Language codes. Example: ["zh", "en"].'),
	after: Type.Optional(Type.String({ description: "Published after this date: YYYY or YYYY-MM-DD." })),
	before: Type.Optional(Type.String({ description: "Published before this date: YYYY or YYYY-MM-DD." })),
	region: Type.Optional(
		StringEnum(REGIONS, {
			description:
				"Localize the results to this region. Without it, results are biased to mainland China. Set it for location-dependent queries (weather, local news, shops, prices, laws) outside mainland China, or when the user is in another region.",
		}),
	),
	localization: Type.Optional(
		Type.String({
			description: "Exact IP address to localize the results. Overrides region. Use only an IP that the user gave.",
		}),
	),
});

const SearchResultSchema = Type.Object({
	rerank_score: Type.Number(),
	title: Type.String(),
	url: Type.String(),
	snippet: Type.String(),
	summary: Type.String(),
	content: Type.String(),
	site_name: Type.Union([Type.String(), Type.Null()]),
	site_icon: Type.Union([Type.String(), Type.Null()]),
	date: Type.Union([Type.String(), Type.Null()]),
	authority: Type.Integer(),
});

const SearchOutput = Type.Object({
	query: Type.String(),
	results: Type.Array(SearchResultSchema),
});

const FetchParams = Type.Object({
	url: Type.String({ description: "HTTP or HTTPS URL of the page to read, at most 8192 characters, without credentials." }),
});

const FetchOutput = Type.Object({
	url: Type.String(),
	title: Type.String(),
	content: Type.String(),
});

interface SearchDetails {
	query: string;
	needContent: boolean;
	results: Pick<SearchResult, "title" | "url" | "site_name" | "date" | "rerank_score" | "authority">[];
	fullOutputPath?: string;
}

interface FetchDetails {
	url: string;
	title: string;
	chars: number;
	fullOutputPath?: string;
}

/** Tell the model to change tools when a retry with the same tool will not help. */
function withFallbackHint(error: unknown, kind: "search" | "fetch"): Error {
	const err = error instanceof Error ? error : new Error(String(error));
	// 400 means the arguments are wrong: the model must fix them, not change tools.
	if (err instanceof DeepSeekApiError && err.status === 400) return err;
	if (err.name === "AbortError" || /aborted/i.test(err.message)) return err;
	const other = kind === "search" ? "another available web search tool" : "another available fetch or browser tool";
	return new Error(`${err.message}\nIf this cannot be fixed now, use ${other} for the same need.`);
}

function countUsage(kind: "search" | "fetch", billable: boolean) {
	usage[kind].requests++;
	if (billable) usage[kind].billable++;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "deepseek_search",
		label: "Web Search",
		description:
			"Search the live web with the DeepSeek Search API. Returns ranked results with title, URL, site, date, relevance score, authority, and a long model-oriented summary; optionally the full page content. Supports site, language, date, exact-phrase, and exclusion filters.",
		promptSnippet: "deepseek_search: search the live web (DeepSeek Search API)",
		promptGuidelines: [
			"Use deepseek_search for current events, recent releases, or facts that may have changed after your training data. Use deepseek_fetch to read a specific URL in full.",
			"Keep deepseek_search queries short and specific. Use the sites, languages, after, and before fields instead of long queries.",
			"Prefer results with a high score and authority. Cite the URLs of the sources you use.",
			"deepseek_search results default to a mainland-China view. Set region for location-dependent queries about other places.",
			"If deepseek_search gives no results, irrelevant results, or an error, try once more with a shorter query or fewer filters. If that also fails, use another available web search tool for the same need. Do not repeat a call that failed.",
			"The deepseek_search index has no content from reddit.com, youtube.com, xiaohongshu.com, or mp.weixin.qq.com. For those sources, use another available search tool directly.",
			"If deepseek_fetch fails, try deepseek_search with sites=[domain] and need_content=true, which returns cached page content. If that also fails, use another available fetch or browser tool.",
		],
		parameters: SearchParams,
		outputSchema: SearchOutput,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const body = buildSearchBody(params, config());
			const auth = await resolveApiKey(ctx);
			if (!auth) throw new Error(MISSING_KEY);

			let response: SearchResponse;
			try {
				response = await postJson<SearchResponse>(
					SEARCH_PATH,
					body,
					requestOptions(auth.key, searchLimiter, signal, retryReporter(onUpdate)),
				);
			} catch (error) {
				usage.search.failed++;
				throw withFallbackHint(error, "search");
			}
			const results = Array.isArray(response.results) ? response.results : [];
			countUsage("search", results.length > 0);

			const needContent = body.need_content === true;
			const { text, fullOutputPath } = await truncateForModel(
				formatSearchResults(body.query, results, needContent),
				"pi-deepseek-search-",
			);
			const details: SearchDetails = {
				query: body.query,
				needContent,
				results: results.map(({ title, url, site_name, date, rerank_score, authority }) => ({
					title,
					url,
					site_name,
					date,
					rerank_score,
					authority,
				})),
				fullOutputPath,
			};
			return {
				content: [{ type: "text", text }],
				details,
				structuredContent: { query: body.query, results } as any,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("deepseek_search "));
			text += theme.fg("accent", `"${args.query}"`);
			const extras = [
				args.sites?.length ? `sites: ${args.sites.join(", ")}` : undefined,
				args.region ? `region: ${args.region}` : undefined,
				args.languages?.length ? `lang: ${args.languages.join(",")}` : undefined,
				args.after ? `after: ${args.after}` : undefined,
				args.before ? `before: ${args.before}` : undefined,
				args.count ? `count: ${args.count}` : undefined,
				args.need_content ? "with content" : undefined,
			].filter(Boolean);
			if (extras.length > 0) text += theme.fg("dim", ` (${extras.join("; ")})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				const first = result.content[0];
				const message = first?.type === "text" ? first.text : "Searching...";
				return new Text(theme.fg("warning", message), 0, 0);
			}
			const details = result.details as SearchDetails | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.results.length === 0) return new Text(theme.fg("dim", "No results"), 0, 0);
			let text = theme.fg("success", `${details.results.length} results`);
			if (details.fullOutputPath) text += theme.fg("warning", " (truncated)");
			const shown = expanded ? details.results : details.results.slice(0, 3);
			shown.forEach((item, index) => {
				const score = Number.isFinite(item.rerank_score) ? item.rerank_score.toFixed(1) : "?";
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
		name: "deepseek_fetch",
		label: "Web Fetch",
		description:
			"Read one web page with the DeepSeek Fetch API and return its content as Markdown. Use it after deepseek_search to read a result in full, or when the user gives a URL.",
		promptSnippet: "deepseek_fetch: read a web page as Markdown (DeepSeek Fetch API)",
		parameters: FetchParams,
		outputSchema: FetchOutput,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const url = validateFetchUrl(params.url);
			const auth = await resolveApiKey(ctx);
			if (!auth) throw new Error(MISSING_KEY);

			let page: FetchResponse;
			try {
				page = await postJson<FetchResponse>(
					FETCH_PATH,
					{ url },
					requestOptions(auth.key, fetchLimiter, signal, retryReporter(onUpdate)),
				);
			} catch (error) {
				usage.fetch.failed++;
				throw withFallbackHint(error, "fetch");
			}
			const title = page.title ?? "";
			const content = page.content ?? "";
			countUsage("fetch", content.length > 0);

			const { text, fullOutputPath } = await truncateForModel(
				formatFetchResult(url, { title, content }),
				"pi-deepseek-fetch-",
			);
			const details: FetchDetails = { url, title, chars: content.length, fullOutputPath };
			return {
				content: [{ type: "text", text }],
				details,
				structuredContent: { url, title, content },
			};
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("deepseek_fetch ")) + theme.fg("accent", args.url), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				const first = result.content[0];
				const message = first?.type === "text" ? first.text : "Fetching...";
				return new Text(theme.fg("warning", message), 0, 0);
			}
			const details = result.details as FetchDetails | undefined;
			if (!details) return new Text("", 0, 0);
			let text = theme.fg("success", details.title || "(no title)");
			text += theme.fg("dim", ` ${details.chars.toLocaleString()} chars`);
			if (details.fullOutputPath) text += theme.fg("warning", " (truncated)");
			if (expanded) {
				const first = result.content[0];
				if (first?.type === "text") {
					const lines = first.text.split("\n");
					text += `\n${theme.fg("dim", lines.slice(0, 30).join("\n"))}`;
					if (lines.length > 30) text += `\n${theme.fg("muted", `... ${lines.length - 30} more lines`)}`;
				}
				if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("deepseek-search", {
		description: "Show DeepSeek Search/Fetch configuration and usage in this pi process",
		handler: async (_args, ctx) => {
			const auth = await resolveApiKey(ctx);
			const { baseUrl, localization, region, timeoutMs, maxRetries } = config();
			const line = (kind: "search" | "fetch") => {
				const u = usage[kind];
				return `${kind}: ${u.requests} ok (${u.billable} billable, ~$${(u.billable * PRICE_PER_REQUEST_USD).toFixed(4)}), ${u.failed} failed`;
			};
			ctx.ui.notify(
				[
					`API key: ${auth ? auth.source : "missing"}`,
					`Base URL: ${baseUrl}`,
					`Default localization: ${localization ?? (region ? `region ${region}` : "(none, mainland-China bias)")}`,
					`Timeout: ${timeoutMs} ms, retries: ${maxRetries}, client QPS: ${QPS_LIMIT}`,
					line("search"),
					line("fetch"),
				].join("\n"),
				auth ? "info" : "warning",
			);
		},
	});
}
