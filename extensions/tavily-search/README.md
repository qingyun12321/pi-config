# tavily-search

Pi extension for the [Tavily APIs](https://docs.tavily.com/documentation/api-reference/introduction). The extension calls the REST API directly. It does not need the `tvly` CLI, MCP, or Agent Skills.

| Item | Kind | API | Without a key |
|---|---|---|---|
| `tavily_search` | tool | `POST /search` | Yes (keyless) |
| `tavily_extract` | tool | `POST /extract` | Yes (keyless) |
| `tavily_map` | tool | `POST /map` | No, the tool is not active |
| `tavily_crawl` | tool | `POST /crawl` | No, the tool is not active |
| `/tavily` | command | `GET /usage` | Shows the key source, the requests and credits in this pi process, and the account credits |

Research (`/research`) is not included because it is an asynchronous task that can run for minutes.

## API key

The extension uses the first key that it finds:

1. `TAVILY_API_KEY`
2. The Tavily CLI login in `~/.tavily/config.json` (`tvly login`)
3. No key: keyless mode, with the `X-Tavily-Access-Mode: keyless` header. Only Search and Extract work.

A free key gives 1,000 credits each month: <https://app.tavily.com>.

## Configuration (environment variables)

| Variable | Default | Use |
|---|---|---|
| `TAVILY_API_KEY` | none | API key |
| `TAVILY_BASE_URL` | `https://api.tavily.com` | API base URL |
| `TAVILY_TIMEOUT_MS` | `60000` | Minimum timeout for each attempt. Extract, Map, and Crawl get the server-side timeout plus 20 s if that is longer |
| `TAVILY_MAX_RETRIES` | `3` | Retries for 408, 429, 5xx, and network errors |

## Behavior

- `tavily_search` defaults to `max_results` 5 (the API default is 10) and always requests `published_date` and `usage`. `include_answer` and `include_raw_content` are booleans that map to `"basic"` and `"markdown"`.
- `tavily_crawl` defaults to `limit` 10 (the API default is 50), because each page adds content to the context.
- The extension checks the arguments before it sends a request, so invalid calls cost nothing. Examples: a query shorter than 2 characters, `time_range` with `start_date`, `country` with topic `news`, `chunks_per_source` without `query` or `instructions`, more than 20 URLs.
- Extract reports the URLs that failed (`failed_results`) together with the pages that succeeded.
- Errors: the extension reads the three Tavily error shapes (`detail.error`, `detail[]` from 422, and `error.message` from keyless mode). 400, 422, 401, 403, 432, and 433 are not retried. If `Retry-After` is longer than 30 s, the tool fails at once and gives the wait time.
- Fallback: the prompt guidelines and the errors (except invalid arguments) tell the model to try once more with a simpler request, then use another available tool. No tool name is hard-coded.
- Output larger than 50 KB or 2000 lines is truncated. The full output is saved to a temp file, and the result gives its path.
- Keyless responses also report `usage.credits`, but keyless requests are free. `/tavily` counts them separately.

## Test results (2026-10-19, keyless)

| Topic | Result |
|---|---|
| Latency | Search: 2.4-6 s (advanced is slower). Extract: 0.3-2.8 s |
| Keyless quota | After about 10 requests from one IP: HTTP 429 `ip_rate_limit_exceeded`, header `Retry-After: 600` (the body says 60) |
| Keyless Map | HTTP 404 `unsupported_endpoint`, with `next_actions` (sign up, or pay with x402) |
| Bad arguments | 400 `{"detail":{"error":...}}`, 422 `{"detail":[{"loc","msg"}]}` |
| Extract failures | HTTP 200 with the URL in `failed_results` (`Failed to fetch url`, `Error fetching content`). `docs.tavily.com/documentation/rate-limits` failed with basic and advanced depth |
| Chinese query | `台风 最新消息` with topic `news` returned English sources. Set `language` or `country` for sources in other languages |

## Tests

```bash
node --test extensions/tavily-search/lib.test.ts
```
