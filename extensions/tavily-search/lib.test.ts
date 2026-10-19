// Run: node --test extensions/tavily-search/lib.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	KEYLESS_HEADER,
	TavilyApiError,
	buildCrawlBody,
	buildExtractBody,
	buildMapBody,
	buildSearchBody,
	formatExtractResults,
	formatSearchResults,
	parseErrorBody,
	parseRetryAfter,
	requestJson,
	validateUrl,
} from "./lib.ts";

test("buildSearchBody sets defaults and maps booleans", () => {
	assert.deepEqual(buildSearchBody({ query: " tavily " }), {
		query: "tavily",
		max_results: 5,
		include_published_date: true,
		include_usage: true,
	});
	const body = buildSearchBody({
		query: "ai news",
		search_depth: "advanced",
		chunks_per_source: 2,
		topic: "news",
		time_range: "week",
		include_domains: [" reuters.com ", ""],
		include_answer: true,
		include_raw_content: true,
		exact_match: true,
	});
	assert.equal(body.include_answer, "basic");
	assert.equal(body.include_raw_content, "markdown");
	assert.deepEqual(body.include_domains, ["reuters.com"]);
	assert.equal(body.exact_match, true);
	assert.equal(buildSearchBody({ query: "xx", country: "United States" }).country, "united states");
});

test("buildSearchBody rejects invalid combinations before a request", () => {
	assert.throws(() => buildSearchBody({ query: "x" }), /at least 2/);
	assert.throws(() => buildSearchBody({ query: "xx", max_results: 21 }), /max_results/);
	assert.throws(() => buildSearchBody({ query: "xx", topic: "bogus" }), /topic must be one of/);
	assert.throws(() => buildSearchBody({ query: "xx", search_depth: "ultra-fast", chunks_per_source: 2 }), /ultra-fast/);
	assert.throws(() => buildSearchBody({ query: "xx", time_range: "day", start_date: "2026-01-01" }), /not both/);
	assert.throws(() => buildSearchBody({ query: "xx", start_date: "2026-1-1" }), /YYYY-MM-DD/);
	assert.throws(() => buildSearchBody({ query: "xx", start_date: "2026-05-01", end_date: "2026-04-01" }), /after/);
	assert.throws(() => buildSearchBody({ query: "xx", topic: "news", country: "japan" }), /topic general/);
});

test("validateUrl and buildExtractBody", () => {
	assert.throws(() => validateUrl("example.com"), /valid URL/);
	assert.equal(validateUrl("docs.tavily.com", { requireScheme: false }), "docs.tavily.com");
	assert.throws(() => validateUrl("ftp://e.com"), /http or https/);
	assert.throws(() => validateUrl("https://u:p@e.com"), /username/);

	assert.deepEqual(buildExtractBody({ urls: ["https://a.com", "https://a.com", " https://b.com "] }), {
		urls: ["https://a.com", "https://b.com"],
		format: "markdown",
		include_usage: true,
	});
	assert.throws(() => buildExtractBody({ urls: [] }), /at least one/);
	assert.throws(() => buildExtractBody({ urls: Array.from({ length: 21 }, (_, i) => `https://e.com/${i}`) }), /at most 20/);
	assert.throws(() => buildExtractBody({ urls: ["https://a.com"], chunks_per_source: 2 }), /only with query/);
	assert.throws(() => buildExtractBody({ urls: ["https://a.com"], timeout: 61 }), /timeout/);
});

test("buildMapBody and buildCrawlBody", () => {
	assert.deepEqual(buildMapBody({ url: "docs.tavily.com", select_paths: ["/docs/.*"] }), {
		url: "docs.tavily.com",
		limit: 50,
		include_usage: true,
		select_paths: ["/docs/.*"],
	});
	const crawl = buildCrawlBody({ url: "https://docs.tavily.com", instructions: "SDK", chunks_per_source: 2 });
	assert.equal(crawl.limit, 10);
	assert.equal(crawl.format, "markdown");
	assert.equal(crawl.chunks_per_source, 2);
	assert.throws(() => buildCrawlBody({ url: "docs.tavily.com", chunks_per_source: 2 }), /only with instructions/);
	assert.throws(() => buildMapBody({ url: "docs.tavily.com", max_depth: 6 }), /max_depth/);
});

test("parseErrorBody handles the three error shapes", () => {
	assert.deepEqual(parseErrorBody('{"detail":{"error":"Invalid topic."}}'), { message: "Invalid topic.", terminal: false });
	assert.deepEqual(
		parseErrorBody('{"detail":[{"type":"string_type","loc":["body","query"],"msg":"Input should be a valid string"}]}'),
		{ message: "query: Input should be a valid string", terminal: false },
	);
	const keyless = parseErrorBody(
		'{"error":{"code":"unsupported_endpoint","message":"Needs a key.","next_actions":[{"type":"signup","instruction":"Ask the user to sign up."}]}}',
	);
	assert.deepEqual(keyless, { message: "Needs a key. Ask the user to sign up.", code: "unsupported_endpoint", terminal: true });
	assert.deepEqual(parseErrorBody("Bad Gateway"), { message: "Bad Gateway", terminal: false });
});

test("parseRetryAfter", () => {
	assert.equal(parseRetryAfter("60"), 60_000);
	assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
	assert.equal(parseRetryAfter(undefined), undefined);
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("requestJson sends the key, or the keyless header without one", async () => {
	const seen: Record<string, string>[] = [];
	const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
		seen.push(init?.headers as Record<string, string>);
		return jsonResponse(200, { ok: true });
	};
	await requestJson("/search", {}, { apiKey: "tvly-k", fetchImpl });
	await requestJson("/search", {}, { fetchImpl });
	assert.equal(seen[0].Authorization, "Bearer tvly-k");
	assert.equal(seen[0][KEYLESS_HEADER], undefined);
	assert.equal(seen[1].Authorization, undefined);
	assert.equal(seen[1][KEYLESS_HEADER], "keyless");
});

test("requestJson retries 429 and 5xx, then succeeds", async () => {
	const statuses = [429, 502, 200];
	let retries = 0;
	const result = await requestJson<{ ok: boolean }>("/search", {}, {
		apiKey: "k",
		backoffMs: 1,
		onRetry: () => retries++,
		fetchImpl: async () => {
			const status = statuses.shift()!;
			return status === 200 ? jsonResponse(200, { ok: true }) : jsonResponse(status, { detail: { error: "busy" } });
		},
	});
	assert.deepEqual(result, { ok: true });
	assert.equal(retries, 2);
});

test("requestJson does not retry 4xx, plan limits, or terminal keyless errors", async () => {
	for (const [status, body] of [
		[400, { detail: { error: "Invalid topic." } }],
		[432, { detail: { error: "Plan limit." } }],
		[429, { error: { code: "keyless_limit", message: "Cap hit.", next_actions: [{ instruction: "Sign up." }] } }],
	] as const) {
		let calls = 0;
		await assert.rejects(
			requestJson("/search", {}, {
				backoffMs: 1,
				fetchImpl: async () => {
					calls++;
					return jsonResponse(status, body);
				},
			}),
			(error: unknown) => error instanceof TavilyApiError && error.status === status,
		);
		assert.equal(calls, 1, `status ${status}`);
	}
});

test("requestJson does not wait for a Retry-After longer than the backoff limit", async () => {
	let calls = 0;
	await assert.rejects(
		requestJson("/search", {}, {
			fetchImpl: async () => {
				calls++;
				return jsonResponse(
					429,
					{ error: { code: "ip_rate_limit_exceeded", message: "Too many keyless requests from this IP address." } },
					{ "retry-after": "600" },
				);
			},
		}),
		(error: unknown) =>
			error instanceof TavilyApiError &&
			error.code === "ip_rate_limit_exceeded" &&
			/Too many keyless requests[\s\S]*wait 600 s/.test(error.message),
	);
	assert.equal(calls, 1);
});

test("requestJson gives up after maxRetries and stops on abort", async () => {
	let calls = 0;
	await assert.rejects(
		requestJson("/x", {}, {
			maxRetries: 2,
			backoffMs: 1,
			fetchImpl: async () => {
				calls++;
				return jsonResponse(500, { detail: { error: "boom" } });
			},
		}),
		/500: boom/,
	);
	assert.equal(calls, 3);

	const controller = new AbortController();
	const promise = requestJson("/x", {}, {
		signal: controller.signal,
		backoffMs: 10_000,
		fetchImpl: async () => jsonResponse(429, {}),
	});
	setTimeout(() => controller.abort(new Error("stop")), 20);
	await assert.rejects(promise, /stop/);
});

test("formatSearchResults and formatExtractResults", () => {
	assert.match(formatSearchResults({ query: "q", results: [] }), /^No results for: q\n.*another available web search tool/);
	const text = formatSearchResults({
		query: "q",
		answer: "A.",
		results: [{ title: "T", url: "https://e.com", content: "snippet", score: 0.9205, published_date: null }],
	});
	assert.match(text, /Answer \(generated by Tavily, verify against the sources\): A\./);
	assert.match(text, /\[1\] T\nURL: https:\/\/e\.com\nScore: 0\.92\nContent: snippet/);

	const extract = formatExtractResults({
		results: [{ url: "https://a.com", title: "A", raw_content: "body" }],
		failed_results: [{ url: "https://b.com", error: "Failed to fetch url" }],
	});
	assert.match(extract, /^# A\nSource: https:\/\/a\.com\n\nbody\n\n---\n\nFailed URLs:\n- https:\/\/b\.com: Failed to fetch url/);
});
