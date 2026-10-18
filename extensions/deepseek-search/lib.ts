// Pure logic for the DeepSeek Search & Fetch APIs.
// https://api-docs.deepseek.com/guides/search/
// No pi imports here, so `node --test` can load this file directly.

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const SEARCH_PATH = "/v1/tools/search";
export const FETCH_PATH = "/v1/tools/fetch";

export const QUERY_MAX_CHARS = 128;
export const ORI_QUESTION_MAX_CHARS = 128;
export const COUNT_MIN = 1;
export const COUNT_MAX = 50;
export const COUNT_DEFAULT = 10;
export const FETCH_URL_MAX_CHARS = 8192;
/** Account-level limit for each API, in requests per second. */
export const QPS_LIMIT = 5;
/** USD per successful request ($0.75 per 1,000). */
export const PRICE_PER_REQUEST_USD = 0.00075;
/** rerank_score at or above this value is a high-quality result. */
export const HIGH_QUALITY_SCORE = 1.5;
/** authority at or above this value is a highly authoritative source. */
export const HIGH_AUTHORITY = 3;

/**
 * Representative IP for each region, for the `localization` field. Each IP was
 * checked on 2026-10-18: "weather forecast" or "local news today" returned
 * sources of that region (for example HK -> hko.gov.hk, AU -> bom.gov.au).
 * Without `localization`, results are biased to mainland China, whatever the
 * caller's own IP is.
 */
export const REGION_IPS = {
	CN: "202.96.209.133",
	HK: "202.181.224.2",
	TW: "168.95.1.1",
	SG: "165.21.83.88",
	JP: "126.0.0.1",
	KR: "168.126.63.1",
	IN: "117.192.0.1",
	AU: "1.120.0.1",
	US: "73.162.0.1",
	CA: "24.114.0.1",
	GB: "81.2.69.142",
	DE: "91.0.0.1",
	FR: "90.0.0.1",
	RU: "95.24.0.1",
} as const;
export type Region = keyof typeof REGION_IPS;
export const REGIONS = Object.keys(REGION_IPS) as Region[];

export function regionIp(region: string): string {
	const ip = REGION_IPS[region.trim().toUpperCase() as Region];
	if (!ip) throw new Error(`Unknown region "${region}". Use one of: ${REGIONS.join(", ")}`);
	return ip;
}

export interface SearchResult {
	rerank_score: number;
	title: string;
	url: string;
	snippet: string;
	summary: string;
	content: string;
	site_name: string | null;
	site_icon: string | null;
	date: string | null;
	authority: number;
}

export interface SearchResponse {
	results: SearchResult[];
}

export interface FetchResponse {
	title: string;
	content: string;
}

export interface SearchRequestBody {
	query: string;
	count?: number;
	ori_question?: string;
	localization?: string;
	need_content?: boolean;
}

/** Structured operator options. Each one becomes a query operator. */
export interface QueryOperators {
	sites?: string[];
	exclude_sites?: string[];
	exclude_terms?: string[];
	exact_phrases?: string[];
	languages?: string[];
	after?: string;
	before?: string;
}

/** Unicode characters (code points), which is how the API counts length. */
export function charCount(text: string): number {
	return [...text].length;
}

const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

function cleanList(values: string[] | undefined): string[] {
	return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

function requireNoSpace(kind: string, value: string): string {
	if (/\s/.test(value)) throw new Error(`${kind} must not contain spaces: "${value}"`);
	return value;
}

function stripQuotes(value: string): string {
	return value.replace(/"/g, "").trim();
}

/**
 * Append the structured operators to the base query. The API forwards the
 * query syntax intact, so operators that the caller wrote by hand still work.
 */
export function buildQuery(base: string, ops: QueryOperators = {}): string {
	const parts: string[] = [base.trim()];

	for (const phrase of cleanList(ops.exact_phrases).map(stripQuotes)) {
		if (phrase) parts.push(`"${phrase}"`);
	}

	const sites = cleanList(ops.sites).map((site) => requireNoSpace("site", site));
	if (sites.length > 0) parts.push(sites.map((site) => `site:${site}`).join(" OR "));

	for (const site of cleanList(ops.exclude_sites)) {
		parts.push(`-site:${requireNoSpace("exclude_sites entry", site)}`);
	}

	for (const term of cleanList(ops.exclude_terms).map(stripQuotes)) {
		if (!term) continue;
		parts.push(/\s/.test(term) ? `-"${term}"` : `-${term}`);
	}

	const languages = cleanList(ops.languages).map((lang) => requireNoSpace("language code", lang));
	if (languages.length > 0) parts.push(`lang:${languages.join(",")}`);

	for (const [name, value] of [
		["after", ops.after],
		["before", ops.before],
	] as const) {
		const date = value?.trim();
		if (!date) continue;
		if (!DATE_RE.test(date)) throw new Error(`${name} must be YYYY, YYYY-MM, or YYYY-MM-DD, got "${date}"`);
		parts.push(`${name}:${date}`);
	}

	return parts.filter((part) => part.length > 0).join(" ");
}

export interface SearchInput extends QueryOperators {
	query: string;
	count?: number;
	ori_question?: string;
	localization?: string;
	region?: string;
	need_content?: boolean;
}

export interface SearchDefaults {
	localization?: string;
	region?: string;
}

/** Priority: explicit IP, then region, then the configured IP, then the configured region. */
export function resolveLocalization(input: SearchInput, defaults: SearchDefaults = {}): string | undefined {
	const ip = input.localization?.trim();
	if (ip) return ip;
	if (input.region?.trim()) return regionIp(input.region);
	const defaultIp = defaults.localization?.trim();
	if (defaultIp) return defaultIp;
	if (defaults.region?.trim()) return regionIp(defaults.region);
	return undefined;
}

/** Build and validate the request body. Throws with a message the model can act on. */
export function buildSearchBody(input: SearchInput, defaults: SearchDefaults = {}): SearchRequestBody {
	const query = buildQuery(input.query, input);
	if (query.trim().length === 0) throw new Error("query must not be empty or only whitespace");
	const length = charCount(query);
	if (length > QUERY_MAX_CHARS) {
		throw new Error(
			`The final query has ${length} characters, but the limit is ${QUERY_MAX_CHARS} (operators included). Shorten it: "${query}"`,
		);
	}

	const body: SearchRequestBody = { query };

	if (input.count !== undefined) {
		if (!Number.isInteger(input.count) || input.count < COUNT_MIN || input.count > COUNT_MAX) {
			throw new Error(`count must be an integer from ${COUNT_MIN} to ${COUNT_MAX}`);
		}
		body.count = input.count;
	}

	const ori = input.ori_question?.trim();
	if (ori) body.ori_question = truncateChars(ori, ORI_QUESTION_MAX_CHARS);

	const localization = resolveLocalization(input, defaults);
	if (localization) body.localization = localization;

	if (input.need_content !== undefined) body.need_content = input.need_content;
	return body;
}

export function truncateChars(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** Do the same checks as the server, so that bad URLs fail without a request. */
export function validateFetchUrl(raw: string): string {
	const url = raw.trim();
	if (url.length === 0) throw new Error("url must not be empty");
	if (url.length > FETCH_URL_MAX_CHARS) throw new Error(`url must be at most ${FETCH_URL_MAX_CHARS} characters`);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`url is not a valid absolute URL: "${url}"`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`url must use http or https, got "${parsed.protocol}"`);
	}
	if (!parsed.hostname) throw new Error("url must have a host");
	if (parsed.username || parsed.password) throw new Error("url must not contain a username or password");
	return url;
}

// ---------------------------------------------------------------------------
// HTTP client

const STATUS_HINTS: Record<number, string> = {
	400: "The request is invalid. Change the arguments before you retry.",
	401: "The DeepSeek API key is missing or invalid. Set DEEPSEEK_API_KEY, or run /login and select DeepSeek.",
	402: "The DeepSeek account has insufficient balance. Top up the account before you retry.",
	403: "The security policy rejected this fetch. Do not retry this URL.",
	404: "The page has no usable content (unavailable, blocked by site policy, or unsupported type). Fetch is often blocked for zhihu, reuters, ft, and wikipedia: try deepseek_search with need_content=true and sites=[<domain>], which returns cached page content.",
	408: "Reading the request body timed out.",
	413: "The request body is too large.",
	429: "The QPS limit was exceeded. Wait before you retry.",
	500: "DeepSeek had an internal server error.",
	504: "A downstream request timed out.",
};

export class DeepSeekApiError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	constructor(status: number, message: string, code?: string) {
		super(message);
		this.name = "DeepSeekApiError";
		this.status = status;
		this.code = code;
	}
	get retryable(): boolean {
		return isRetryableStatus(this.status);
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

/** Keeps request starts at least `1000 / qps` ms apart, across parallel tool calls. */
export class RateLimiter {
	private next = 0;
	private readonly interval: number;
	constructor(qps: number) {
		this.interval = 1000 / qps;
	}
	async acquire(signal?: AbortSignal): Promise<void> {
		const now = Date.now();
		const start = Math.max(now, this.next);
		this.next = start + this.interval;
		if (start > now) await sleep(start - now, signal);
	}
}

export interface RetryEvent {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	error: Error;
}

export interface RequestOptions {
	apiKey: string;
	baseUrl?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxRetries?: number;
	limiter?: RateLimiter;
	onRetry?: (event: RetryEvent) => void;
	fetchImpl?: typeof fetch;
	/** Base delay for exponential backoff. */
	backoffMs?: number;
	maxBackoffMs?: number;
}

async function readError(response: Response): Promise<DeepSeekApiError> {
	let message = `HTTP ${response.status}`;
	let code: string | undefined;
	try {
		const text = await response.text();
		try {
			const json = JSON.parse(text) as { error?: { message?: string; code?: string } };
			if (json.error?.message) message = json.error.message;
			code = json.error?.code;
		} catch {
			if (text.trim()) message = text.trim().slice(0, 500);
		}
	} catch {
		// Keep the status-only message.
	}
	const hint = STATUS_HINTS[response.status];
	return new DeepSeekApiError(response.status, `DeepSeek API ${response.status}: ${message}${hint ? `\n${hint}` : ""}`, code);
}

/**
 * POST JSON with rate limiting, a per-attempt timeout, and retries for
 * 408, 429, 5xx, and network errors, as the API guide recommends.
 */
export async function postJson<T>(path: string, body: unknown, options: RequestOptions): Promise<T> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const maxAttempts = (options.maxRetries ?? 3) + 1;
	const backoffMs = options.backoffMs ?? 1000;
	const maxBackoffMs = options.maxBackoffMs ?? 30_000;
	const timeoutMs = options.timeoutMs ?? 60_000;

	for (let attempt = 1; ; attempt++) {
		if (options.signal?.aborted) throw abortError(options.signal);
		await options.limiter?.acquire(options.signal);

		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		let error: Error;
		let retryAfterMs: number | undefined;
		try {
			const response = await fetchImpl(`${baseUrl}${path}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(body),
				signal,
			});
			if (response.ok) return (await response.json()) as T;
			error = await readError(response);
			retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
			if (!isRetryableStatus(response.status)) throw error;
		} catch (caught) {
			if (caught instanceof DeepSeekApiError && !caught.retryable) throw caught;
			if (options.signal?.aborted) throw abortError(options.signal);
			error = caught instanceof Error ? caught : new Error(String(caught));
			if (timeout.aborted) error = new Error(`DeepSeek API request timed out after ${timeoutMs} ms`);
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

function formatAuthority(authority: number): string {
	return authority < 0 ? "unknown" : `${authority}/4`;
}

export function formatSearchResults(query: string, results: SearchResult[], needContent: boolean): string {
	if (results.length === 0) {
		return `No results for: ${query}\nTry a shorter query or fewer filters. If it still has no results, use another available web search tool.`;
	}
	const lines: string[] = [`Search results for: ${query}`, ""];
	results.forEach((result, index) => {
		lines.push(`[${index + 1}] ${result.title || "(no title)"}`);
		lines.push(`URL: ${result.url}`);
		const meta = [
			result.site_name ? `Site: ${result.site_name}` : undefined,
			result.date ? `Date: ${result.date}` : undefined,
			`Score: ${formatScore(result.rerank_score)}`,
			`Authority: ${formatAuthority(result.authority)}`,
		].filter(Boolean);
		lines.push(meta.join(" | "));
		const summary = result.summary || result.snippet;
		if (summary) lines.push(`Summary: ${summary.trim()}`);
		if (needContent) {
			lines.push(result.content ? `Content:\n${result.content.trim()}` : "Content: (unavailable)");
		}
		lines.push("");
	});
	lines.push(
		`Score is 0-3 (>= ${HIGH_QUALITY_SCORE} is high quality). Authority is 0-4 (>= ${HIGH_AUTHORITY} is highly authoritative). Cite the URLs you use.`,
	);
	return lines.join("\n");
}

export function formatFetchResult(url: string, page: FetchResponse): string {
	const title = page.title?.trim();
	return `${title ? `# ${title}\n` : ""}Source: ${url}\n\n${page.content ?? ""}`.trimEnd();
}
