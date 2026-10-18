// Run: node --test extensions/deepseek-search/lib.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DeepSeekApiError,
	RateLimiter,
	buildQuery,
	buildSearchBody,
	resolveLocalization,
	formatSearchResults,
	parseRetryAfter,
	postJson,
	validateFetchUrl,
} from "./lib.ts";

test("buildQuery adds every operator", () => {
	assert.equal(
		buildQuery("DeepSeek", {
			exact_phrases: ["exact phrase"],
			sites: ["github.com", "huggingface.co"],
			exclude_sites: ["example.com"],
			exclude_terms: ["advertisement", "release notes"],
			languages: ["zh", "en"],
			after: "2025",
			before: "2026-06-01",
		}),
		'DeepSeek "exact phrase" site:github.com OR site:huggingface.co -site:example.com -advertisement -"release notes" lang:zh,en after:2025 before:2026-06-01',
	);
});

test("buildQuery rejects bad dates and sites with spaces", () => {
	assert.throws(() => buildQuery("x", { after: "June 2025" }), /after must be/);
	assert.throws(() => buildQuery("x", { sites: ["a b.com"] }), /must not contain spaces/);
});

test("buildSearchBody validates length, count, and defaults", () => {
	assert.throws(() => buildSearchBody({ query: "   " }), /empty/);
	assert.throws(() => buildSearchBody({ query: "a".repeat(129) }), /limit is 128/);
	// Code points, not UTF-16 units: 128 emoji are allowed.
	assert.doesNotThrow(() => buildSearchBody({ query: "\u{1F600}".repeat(128) }));
	assert.throws(() => buildSearchBody({ query: "x", count: 51 }), /count/);
	assert.deepEqual(buildSearchBody({ query: "x" }, { localization: "1.2.3.4" }), {
		query: "x",
		localization: "1.2.3.4",
	});
	const body = buildSearchBody({ query: "x", ori_question: "q".repeat(200), need_content: true, count: 5 });
	assert.equal(body.ori_question?.length, 128);
	assert.equal(body.need_content, true);
});

test("resolveLocalization priority: IP, region, default IP, default region", () => {
	assert.equal(resolveLocalization({ query: "x", localization: "1.1.1.1", region: "JP" }), "1.1.1.1");
	assert.equal(resolveLocalization({ query: "x", region: "jp" }, { localization: "2.2.2.2" }), "126.0.0.1");
	assert.equal(resolveLocalization({ query: "x" }, { localization: "2.2.2.2", region: "US" }), "2.2.2.2");
	assert.equal(resolveLocalization({ query: "x" }, { region: "US" }), "73.162.0.1");
	assert.equal(resolveLocalization({ query: "x" }), undefined);
	assert.throws(() => resolveLocalization({ query: "x", region: "XX" }), /Unknown region/);
});

test("validateFetchUrl", () => {
	assert.equal(validateFetchUrl(" https://example.com/a "), "https://example.com/a");
	assert.throws(() => validateFetchUrl("ftp://example.com"), /http or https/);
	assert.throws(() => validateFetchUrl("https://u:p@example.com"), /username/);
	assert.throws(() => validateFetchUrl("example.com"), /valid absolute URL/);
});

test("parseRetryAfter", () => {
	assert.equal(parseRetryAfter("2"), 2000);
	assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
	assert.equal(parseRetryAfter(null), undefined);
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("postJson retries 429 and 5xx, then succeeds", async () => {
	const statuses = [429, 503, 200];
	const seen: unknown[] = [];
	let retries = 0;
	const result = await postJson<{ ok: boolean }>(
		"/v1/tools/search",
		{ query: "x" },
		{
			apiKey: "k",
			backoffMs: 1,
			onRetry: () => retries++,
			fetchImpl: async (url, init) => {
				seen.push({ url, auth: (init?.headers as Record<string, string>).Authorization });
				const status = statuses.shift()!;
				return status === 200 ? jsonResponse(200, { ok: true }) : jsonResponse(status, { error: { message: "busy" } });
			},
		},
	);
	assert.deepEqual(result, { ok: true });
	assert.equal(retries, 2);
	assert.deepEqual(seen[0], { url: "https://api.deepseek.com/v1/tools/search", auth: "Bearer k" });
});

test("postJson does not retry other 4xx and keeps the API message", async () => {
	let calls = 0;
	await assert.rejects(
		postJson("/v1/tools/search", {}, {
			apiKey: "k",
			fetchImpl: async () => {
				calls++;
				return jsonResponse(400, { error: { message: "'count' must be between 1 and 50", code: "invalid_request_error" } });
			},
		}),
		(error: unknown) =>
			error instanceof DeepSeekApiError && error.status === 400 && /'count' must be between/.test(error.message),
	);
	assert.equal(calls, 1);
});

test("postJson gives up after maxRetries", async () => {
	let calls = 0;
	await assert.rejects(
		postJson("/x", {}, {
			apiKey: "k",
			maxRetries: 2,
			backoffMs: 1,
			fetchImpl: async () => {
				calls++;
				return jsonResponse(500, { error: { message: "boom" } });
			},
		}),
		/500: boom/,
	);
	assert.equal(calls, 3);
});

test("postJson stops when the caller aborts", async () => {
	const controller = new AbortController();
	const promise = postJson("/x", {}, {
		apiKey: "k",
		signal: controller.signal,
		backoffMs: 10_000,
		fetchImpl: async () => jsonResponse(429, {}),
	});
	setTimeout(() => controller.abort(new Error("stop")), 20);
	await assert.rejects(promise, /stop/);
});

test("RateLimiter spaces request starts", async () => {
	const limiter = new RateLimiter(20); // 50 ms apart
	const start = Date.now();
	await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
	assert.ok(Date.now() - start >= 95);
});

test("formatSearchResults", () => {
	assert.match(formatSearchResults("q", [], false), /^No results for: q\n.*another available web search tool/);
	const text = formatSearchResults(
		"q",
		[
			{
				rerank_score: 2.4,
				title: "T",
				url: "https://e.com",
				snippet: "s",
				summary: "long summary",
				content: "",
				site_name: null,
				site_icon: null,
				date: null,
				authority: -1,
			},
		],
		true,
	);
	assert.match(text, /\[1\] T\nURL: https:\/\/e\.com\nScore: 2\.40 \| Authority: unknown\nSummary: long summary\nContent: \(unavailable\)/);
});
