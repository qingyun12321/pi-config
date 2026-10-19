// Pure logic for the Tavily Search, Extract, Map, and Crawl APIs.
// https://docs.tavily.com/documentation/api-reference/introduction
// No pi imports here, so `node --test` can load this file directly.

export const DEFAULT_BASE_URL = "https://api.tavily.com";
export const SEARCH_PATH = "/search";
export const EXTRACT_PATH = "/extract";
export const MAP_PATH = "/map";
export const CRAWL_PATH = "/crawl";
export const USAGE_PATH = "/usage";

/** Without an API key, Search and Extract work with this header (rate-limited, free). */
export const KEYLESS_HEADER = "X-Tavily-Access-Mode";

export const MAX_RESULTS_MIN = 1;
export const MAX_RESULTS_MAX = 20;
export const MAX_RESULTS_DEFAULT = 5;
export const SEARCH_CHUNKS_MAX = 3;
export const EXTRACT_CHUNKS_MAX = 5;
export const EXTRACT_URLS_MAX = 20;
export const EXTRACT_TIMEOUT_MIN = 1;
export const EXTRACT_TIMEOUT_MAX = 60;
export const SITE_TIMEOUT_MIN = 10;
export const SITE_TIMEOUT_MAX = 150;
export const SITE_DEPTH_MAX = 5;
export const SITE_BREADTH_MAX = 500;
/** Crawl returns page content, so keep the default page count low for the context window. */
export const CRAWL_LIMIT_DEFAULT = 10;
export const MAP_LIMIT_DEFAULT = 50;

export const SEARCH_DEPTHS = ["basic", "advanced", "fast", "ultra-fast"] as const;
export const TOPICS = ["general", "news", "finance"] as const;
export const TIME_RANGES = ["day", "week", "month", "year"] as const;
export const EXTRACT_DEPTHS = ["basic", "advanced"] as const;

export type SearchDepth = (typeof SEARCH_DEPTHS)[number];
export type Topic = (typeof TOPICS)[number];
export type TimeRange = (typeof TIME_RANGES)[number];
export type ExtractDepth = (typeof EXTRACT_DEPTHS)[number];

// ---------------------------------------------------------------------------
// Response types (only the fields this extension reads)

export interface Usage {
	credits?: number;
}

export interface SearchResult {
	url: string;
	title: string;
	content: string;
	score: number;
	raw_content?: string | null;
	published_date?: string | null;
}

export interface SearchResponse {
	query: string;
	answer?: string | null;
	results: SearchResult[];
	response_time?: number | string;
	usage?: Usage;
	request_id?: string;
}

export interface PageResult {
	url: string;
	title?: string | null;
	raw_content: string;
}

export interface FailedResult {
	url: string;
	error: string;
}

export interface ExtractResponse {
	results: PageResult[];
	failed_results?: FailedResult[];
	usage?: Usage;
	request_id?: string;
}

export interface MapResponse {
	base_url: string;
	results: string[];
	usage?: Usage;
	request_id?: string;
}

export interface CrawlResponse {
	base_url: string;
	results: PageResult[];
	usage?: Usage;
	request_id?: string;
}

// ---------------------------------------------------------------------------
// Request bodies

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanList(values: string[] | undefined): string[] {
	return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

function checkInt(name: string, value: number | undefined, min: number, max: number): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${name} must be an integer from ${min} to ${max}, got ${value}`);
	}
	return value;
}

function checkNumber(name: string, value: number | undefined, min: number, max: number): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < min || value > max) {
		throw new Error(`${name} must be a number from ${min} to ${max}, got ${value}`);
	}
	return value;
}

function checkEnum<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
	if (value === undefined) return undefined;
	if (!allowed.includes(value as T)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
	return value as T;
}

function checkDate(name: string, value: string | undefined): string | undefined {
	const date = value?.trim();
	if (!date) return undefined;
	if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) {
		throw new Error(`${name} must be YYYY-MM-DD, got "${date}"`);
	}
	return date;
}

export interface SearchInput {
	query: string;
	max_results?: number;
	search_depth?: string;
	chunks_per_source?: number;
	topic?: string;
	time_range?: string;
	start_date?: string;
	end_date?: string;
	include_domains?: string[];
	exclude_domains?: string[];
	country?: string;
	language?: string;
	exact_match?: boolean;
	include_answer?: boolean;
	include_raw_content?: boolean;
}

/** Build and validate the request body. Throws with a message the model can act on. */
export function buildSearchBody(input: SearchInput): Record<string, unknown> {
	const query = input.query.trim();
	// The server rejects queries shorter than 2 characters.
	if ([...query].length < 2) throw new Error("query must have at least 2 characters");

	const body: Record<string, unknown> = {
		query,
		max_results:
			checkInt("max_results", input.max_results, MAX_RESULTS_MIN, MAX_RESULTS_MAX) ?? MAX_RESULTS_DEFAULT,
		include_published_date: true,
		include_usage: true,
	};

	const depth = checkEnum("search_depth", input.search_depth, SEARCH_DEPTHS);
	if (depth) body.search_depth = depth;

	const chunks = checkInt("chunks_per_source", input.chunks_per_source, 1, SEARCH_CHUNKS_MAX);
	if (chunks !== undefined) {
		if (depth === "ultra-fast") throw new Error("chunks_per_source does not work with search_depth ultra-fast");
		body.chunks_per_source = chunks;
	}

	const topic = checkEnum("topic", input.topic, TOPICS);
	if (topic) body.topic = topic;

	const timeRange = checkEnum("time_range", input.time_range, TIME_RANGES);
	const startDate = checkDate("start_date", input.start_date);
	const endDate = checkDate("end_date", input.end_date);
	if (timeRange && (startDate || endDate)) throw new Error("Use time_range or start_date/end_date, not both");
	if (startDate && endDate && startDate > endDate) throw new Error("start_date must not be after end_date");
	if (timeRange) body.time_range = timeRange;
	if (startDate) body.start_date = startDate;
	if (endDate) body.end_date = endDate;

	const include = cleanList(input.include_domains);
	if (include.length > 0) body.include_domains = include;
	const exclude = cleanList(input.exclude_domains);
	if (exclude.length > 0) body.exclude_domains = exclude;

	const country = input.country?.trim().toLowerCase();
	if (country) {
		if (topic && topic !== "general") throw new Error("country works only with topic general");
		body.country = country;
	}

	const language = input.language?.trim();
	if (language) body.language = language;

	if (input.exact_match) body.exact_match = true;
	if (input.include_answer) body.include_answer = "basic";
	if (input.include_raw_content) body.include_raw_content = "markdown";
	return body;
}

/** Do the same checks as the server, so that bad URLs fail without a request. */
export function validateUrl(raw: string, { requireScheme = true } = {}): string {
	const url = raw.trim();
	if (url.length === 0) throw new Error("url must not be empty");
	// Map and Crawl also accept a bare domain such as docs.tavily.com.
	const candidate = !requireScheme && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? `https://${url}` : url;
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		throw new Error(`url is not a valid URL: "${url}"`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`url must use http or https, got "${parsed.protocol}"`);
	}
	if (!parsed.hostname) throw new Error("url must have a host");
	if (parsed.username || parsed.password) throw new Error("url must not contain a username or password");
	return url;
}

export interface ExtractInput {
	urls: string[];
	query?: string;
	chunks_per_source?: number;
	extract_depth?: string;
	timeout?: number;
}

export function buildExtractBody(input: ExtractInput): Record<string, unknown> {
	const urls = [...new Set(cleanList(input.urls).map((url) => validateUrl(url)))];
	if (urls.length === 0) throw new Error("urls must have at least one URL");
	if (urls.length > EXTRACT_URLS_MAX) throw new Error(`urls must have at most ${EXTRACT_URLS_MAX} URLs`);

	const body: Record<string, unknown> = { urls, format: "markdown", include_usage: true };
	const query = input.query?.trim();
	const chunks = checkInt("chunks_per_source", input.chunks_per_source, 1, EXTRACT_CHUNKS_MAX);
	if (chunks !== undefined && !query) throw new Error("chunks_per_source works only with query");
	if (query) body.query = query;
	if (chunks !== undefined) body.chunks_per_source = chunks;

	const depth = checkEnum("extract_depth", input.extract_depth, EXTRACT_DEPTHS);
	if (depth) body.extract_depth = depth;
	const timeout = checkNumber("timeout", input.timeout, EXTRACT_TIMEOUT_MIN, EXTRACT_TIMEOUT_MAX);
	if (timeout !== undefined) body.timeout = timeout;
	return body;
}

export interface SiteInput {
	url: string;
	instructions?: string;
	max_depth?: number;
	max_breadth?: number;
	limit?: number;
	select_paths?: string[];
	exclude_paths?: string[];
	select_domains?: string[];
	exclude_domains?: string[];
	allow_external?: boolean;
	timeout?: number;
}

export interface CrawlInput extends SiteInput {
	chunks_per_source?: number;
	extract_depth?: string;
}

function buildSiteBody(input: SiteInput, limitDefault: number): Record<string, unknown> {
	const body: Record<string, unknown> = {
		url: validateUrl(input.url, { requireScheme: false }),
		limit: checkInt("limit", input.limit, 1, 1000) ?? limitDefault,
		include_usage: true,
	};
	const instructions = input.instructions?.trim();
	if (instructions) body.instructions = instructions;
	const depth = checkInt("max_depth", input.max_depth, 1, SITE_DEPTH_MAX);
	if (depth !== undefined) body.max_depth = depth;
	const breadth = checkInt("max_breadth", input.max_breadth, 1, SITE_BREADTH_MAX);
	if (breadth !== undefined) body.max_breadth = breadth;
	for (const key of ["select_paths", "exclude_paths", "select_domains", "exclude_domains"] as const) {
		const values = cleanList(input[key]);
		if (values.length > 0) body[key] = values;
	}
	if (input.allow_external !== undefined) body.allow_external = input.allow_external;
	const timeout = checkNumber("timeout", input.timeout, SITE_TIMEOUT_MIN, SITE_TIMEOUT_MAX);
	if (timeout !== undefined) body.timeout = timeout;
	return body;
}

export function buildMapBody(input: SiteInput): Record<string, unknown> {
	return buildSiteBody(input, MAP_LIMIT_DEFAULT);
}

export function buildCrawlBody(input: CrawlInput): Record<string, unknown> {
	const body = buildSiteBody(input, CRAWL_LIMIT_DEFAULT);
	body.format = "markdown";
	const chunks = checkInt("chunks_per_source", input.chunks_per_source, 1, EXTRACT_CHUNKS_MAX);
	if (chunks !== undefined && !body.instructions) throw new Error("chunks_per_source works only with instructions");
	if (chunks !== undefined) body.chunks_per_source = chunks;
	const depth = checkEnum("extract_depth", input.extract_depth, EXTRACT_DEPTHS);
	if (depth) body.extract_depth = depth;
	return body;
}

// ---------------------------------------------------------------------------
// HTTP client

const STATUS_HINTS: Record<number, string> = {
	400: "The request is invalid. Change the arguments before you retry.",
	401: "The Tavily API key is missing or invalid. Set TAVILY_API_KEY.",
	403: "Tavily rejected this request. Do not retry it unchanged.",
	422: "The request is invalid. Change the arguments before you retry.",
	429: "The rate limit was exceeded. Wait before you retry.",
	432: "The Tavily plan limit was exceeded. Do not retry; use another available tool for the same need.",
	433: "The Tavily pay-as-you-go limit was exceeded. Do not retry; use another available tool for the same need.",
	500: "Tavily had an internal server error.",
};

export class TavilyApiError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	/** The server says that a retry cannot help (for example, a keyless quota). */
	readonly terminal: boolean;
	constructor(status: number, message: string, code?: string, terminal = false) {
		super(message);
		this.name = "TavilyApiError";
		this.status = status;
		this.code = code;
		this.terminal = terminal;
	}
	get retryable(): boolean {
		return !this.terminal && isRetryableStatus(this.status);
	}
	/** The arguments are wrong: the model must fix them, not change tools. */
	get invalidRequest(): boolean {
		return this.status === 400 || this.status === 422;
	}
}

export function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

/** Parse Retry-After (seconds or HTTP date) to milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Tavily uses three error shapes:
 *   {"detail": {"error": "..."}}                      most errors
 *   {"detail": [{"loc": [...], "msg": "..."}]}        422 validation
 *   {"error": {"code", "message", "next_actions"}}    keyless mode
 */
export function parseErrorBody(text: string): { message?: string; code?: string; terminal: boolean } {
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {
		return { message: text.trim().slice(0, 500) || undefined, terminal: false };
	}
	if (json?.error && typeof json.error === "object") {
		const actions = Array.isArray(json.error.next_actions) ? json.error.next_actions : [];
		// An agent in pi cannot pay with x402, so drop that suggestion.
		const steps = actions
			.filter((action: any) => action?.type !== "agentic_payment")
			.map((action: any) => (typeof action?.instruction === "string" ? action.instruction : undefined))
			.filter(Boolean);
		const message = [json.error.message, ...steps].filter(Boolean).join(" ");
		return { message: message || undefined, code: json.error.code, terminal: actions.length > 0 };
	}
	const detail = json?.detail;
	if (typeof detail === "string") return { message: detail, terminal: false };
	if (Array.isArray(detail)) {
		const message = detail
			.map((item: any) => {
				const loc = Array.isArray(item?.loc) ? item.loc.filter((part: unknown) => part !== "body").join(".") : "";
				return loc ? `${loc}: ${item?.msg}` : String(item?.msg ?? "");
			})
			.join("; ");
		return { message: message || undefined, terminal: false };
	}
	if (detail && typeof detail === "object") {
		if (typeof detail.error === "string") return { message: detail.error, terminal: false };
		if (Array.isArray(detail.failed_results)) {
			const failed = detail.failed_results as FailedResult[];
			return { message: failed.map((item) => `${item.url}: ${item.error}`).join("; "), terminal: false };
		}
	}
	return { message: text.trim().slice(0, 500) || undefined, terminal: false };
}

async function readError(response: Response): Promise<TavilyApiError> {
	let parsed: ReturnType<typeof parseErrorBody> = { terminal: false };
	try {
		parsed = parseErrorBody(await response.text());
	} catch {
		// Keep the status-only message.
	}
	const hint = STATUS_HINTS[response.status];
	const message = `Tavily API ${response.status}: ${parsed.message ?? `HTTP ${response.status}`}${hint ? `\n${hint}` : ""}`;
	return new TavilyApiError(response.status, message, parsed.code, parsed.terminal);
}

function abortError(signal: AbortSignal | undefined): Error {
	const reason = signal?.reason;
	return reason instanceof Error ? reason : new Error("Request aborted");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError(signal));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export interface RetryEvent {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	error: Error;
}

export interface RequestOptions {
	/** Undefined selects keyless mode. */
	apiKey?: string;
	baseUrl?: string;
	method?: "GET" | "POST";
	signal?: AbortSignal;
	timeoutMs?: number;
	maxRetries?: number;
	onRetry?: (event: RetryEvent) => void;
	fetchImpl?: typeof fetch;
	/** Base delay for exponential backoff. */
	backoffMs?: number;
	maxBackoffMs?: number;
}

export function requestHeaders(apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	else headers[KEYLESS_HEADER] = "keyless";
	return headers;
}

/**
 * Send a JSON request with a per-attempt timeout and retries for 408, 429,
 * 5xx, and network errors. Retry-After wins over exponential backoff.
 */
export async function requestJson<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const method = options.method ?? "POST";
	const maxAttempts = (options.maxRetries ?? 3) + 1;
	const backoffMs = options.backoffMs ?? 1000;
	const maxBackoffMs = options.maxBackoffMs ?? 30_000;
	const timeoutMs = options.timeoutMs ?? 60_000;

	for (let attempt = 1; ; attempt++) {
		if (options.signal?.aborted) throw abortError(options.signal);

		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		let error: Error;
		let retryAfterMs: number | undefined;
		try {
			const response = await fetchImpl(`${baseUrl}${path}`, {
				method,
				headers: requestHeaders(options.apiKey),
				body: method === "POST" ? JSON.stringify(body) : undefined,
				signal,
			});
			if (response.ok) return (await response.json()) as T;
			const apiError = await readError(response);
			error = apiError;
			retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
			// A long wait (for example the keyless IP quota sends 600 s) is not worth blocking the turn.
			if (apiError.retryable && retryAfterMs !== undefined && retryAfterMs > maxBackoffMs) {
				const wait = Math.ceil(retryAfterMs / 1000);
				throw new TavilyApiError(
					apiError.status,
					`${apiError.message}\nThe server asks to wait ${wait} s before a retry.`,
					apiError.code,
					true,
				);
			}
			if (!apiError.retryable) throw apiError;
		} catch (caught) {
			if (caught instanceof TavilyApiError && !caught.retryable) throw caught;
			if (options.signal?.aborted) throw abortError(options.signal);
			error = caught instanceof Error ? caught : new Error(String(caught));
			if (timeout.aborted) error = new Error(`Tavily API request timed out after ${timeoutMs} ms`);
		}

		if (attempt >= maxAttempts) throw error;
		const exponential = Math.min(maxBackoffMs, backoffMs * 2 ** (attempt - 1));
		const delayMs = Math.min(maxBackoffMs, retryAfterMs ?? exponential * (0.75 + Math.random() * 0.5));
		options.onRetry?.({ attempt, maxAttempts, delayMs, error });
		await sleep(delayMs, options.signal);
	}
}

// ---------------------------------------------------------------------------
// Formatting for the model

function formatScore(score: number): string {
	return Number.isFinite(score) ? score.toFixed(2) : "?";
}

export function formatSearchResults(response: SearchResponse): string {
	const query = response.query;
	const results = Array.isArray(response.results) ? response.results : [];
	const lines: string[] = [];
	const answer = response.answer?.trim();
	if (results.length === 0 && !answer) {
		return `No results for: ${query}\nTry a shorter query or fewer filters. If it still has no results, use another available web search tool.`;
	}
	lines.push(`Search results for: ${query}`, "");
	if (answer) lines.push(`Answer (generated by Tavily, verify against the sources): ${answer}`, "");
	results.forEach((result, index) => {
		lines.push(`[${index + 1}] ${result.title || "(no title)"}`);
		lines.push(`URL: ${result.url}`);
		const meta = [
			result.published_date ? `Published: ${result.published_date}` : undefined,
			`Score: ${formatScore(result.score)}`,
		].filter(Boolean);
		lines.push(meta.join(" | "));
		if (result.content) lines.push(`Content: ${result.content.trim()}`);
		if (result.raw_content) lines.push(`Full content:\n${result.raw_content.trim()}`);
		lines.push("");
	});
	if (results.length > 0) lines.push("Score is 0-1 relevance to the query. Cite the URLs you use.");
	return lines.join("\n").trimEnd();
}

function formatPage(page: PageResult): string {
	const title = page.title?.trim();
	return `${title ? `# ${title}\n` : ""}Source: ${page.url}\n\n${(page.raw_content ?? "").trim()}`.trimEnd();
}

export function formatExtractResults(response: ExtractResponse): string {
	const results = Array.isArray(response.results) ? response.results : [];
	const failed = Array.isArray(response.failed_results) ? response.failed_results : [];
	const parts = results.map(formatPage);
	if (failed.length > 0) {
		parts.push(
			[
				"Failed URLs:",
				...failed.map((item) => `- ${item.url}: ${item.error}`),
				"For a failed URL, try extract_depth advanced once, then another available fetch or browser tool.",
			].join("\n"),
		);
	}
	return parts.join("\n\n---\n\n") || "No content was extracted.";
}

export function formatMapResults(response: MapResponse): string {
	const urls = Array.isArray(response.results) ? response.results : [];
	if (urls.length === 0) return `No URLs found for ${response.base_url}. Try a larger max_depth or fewer path filters.`;
	return [`${urls.length} URLs found for ${response.base_url}:`, ...urls].join("\n");
}

export function formatCrawlResults(response: CrawlResponse): string {
	const pages = Array.isArray(response.results) ? response.results : [];
	if (pages.length === 0) return `No pages crawled for ${response.base_url}. Try a larger max_depth or fewer path filters.`;
	return [`${pages.length} pages crawled from ${response.base_url}`, ...pages.map(formatPage)].join("\n\n---\n\n");
}
