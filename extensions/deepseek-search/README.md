# deepseek-search

Pi extension for the [DeepSeek Search & Fetch APIs](https://api-docs.deepseek.com/guides/search/).

| Item | Kind | API |
|---|---|---|
| `deepseek_search` | tool | `POST /v1/tools/search` |
| `deepseek_fetch` | tool | `POST /v1/tools/fetch` |
| `/deepseek-search` | command | Shows the key source, configuration, and request counts with the estimated cost |

## API key

The extension uses the first key that it finds:

1. `DEEPSEEK_SEARCH_API_KEY`
2. The `deepseek` provider key: `DEEPSEEK_API_KEY`, or `/login deepseek` (saved in `~/.pi/agent/auth.json`)

## Configuration (environment variables)

| Variable | Default | Use |
|---|---|---|
| `DEEPSEEK_SEARCH_BASE_URL` | `https://api.deepseek.com` | API base URL |
| `DEEPSEEK_SEARCH_REGION` | none | Default region code (see below) |
| `DEEPSEEK_SEARCH_LOCALIZATION` | none | Default IP address. Overrides the default region |
| `DEEPSEEK_SEARCH_TIMEOUT_MS` | `60000` | Timeout for each attempt |
| `DEEPSEEK_SEARCH_MAX_RETRIES` | `3` | Retries for 408, 429, 5xx, and network errors |

## Behavior

- `deepseek_search` accepts all request fields (`query`, `count`, `need_content`, `ori_question`, `localization`). It also accepts structured operator fields (`sites`, `exclude_sites`, `exact_phrases`, `exclude_terms`, `languages`, `after`, `before`). The extension adds these fields to the query as operators. The final query must be at most 128 characters.
- `region` selects a tested IP for `localization`: CN, HK, TW, SG, JP, KR, IN, AU, US, CA, GB, DE, FR, RU. Priority: `localization`, then `region`, then `DEEPSEEK_SEARCH_LOCALIZATION`, then `DEEPSEEK_SEARCH_REGION`.
- The model decides when to use `need_content`.
- Fallback: the prompt guidelines, empty results, and API errors (except 400) tell the model to try once more with a simpler query, then use another available search, fetch, or browser tool. No tool name is hard-coded.
- The extension checks the arguments before it sends a request, so invalid calls cost nothing.
- Each API has a client-side limit of 5 requests per second, shared across parallel tool calls.
- Retries use `Retry-After` when the server sends it (it did not in tests), else exponential backoff. Other 4xx errors are not retried.
- Output larger than 50 KB or 2000 lines is truncated. The full output is saved to a temp file, and the result gives its path.
- Both tools return `structuredContent` (raw API fields) for codemode scripts.

## Test results (2026-10-18, from a Singapore exit IP)

| Topic | Result |
|---|---|
| Latency | Search: 200-650 ms, average 371 ms. Fetch: 0.1-12 s (weixin and nature: 10-12 s) |
| No `localization` | Results have a mainland-China bias. The caller's IP is not used |
| `localization` | Strong effect on location-dependent queries (weather: HK -> hko.gov.hk, KR -> weather.go.kr, AU -> bom.gov.au). Small effect on general queries (6-9 of 10 results stay the same). Repeated requests are deterministic |
| Invalid `localization` | HTTP 400 `'localization' must be a valid IP address` |
| `ori_question` | No change to order or scores |
| Index gaps | 0 results for `site:` mp.weixin.qq.com, xiaohongshu.com, reddit.com, youtube.com, v2ex.com (v2ex is indexed as global.v2ex.co) |
| Index strengths | douyin.com with `need_content` returns 4.6k-7.6k characters (video transcript). gov.cn sources get authority 4 |
| Fetch blocked (404) | zhihu, reuters, ft, wikipedia. Search with `sites=[domain]` and `need_content=true` returns cached content for all four |
| Fetch works | mp.weixin.qq.com, arxiv HTML (146k characters), github, nature |
| QPS | 8-9 parallel requests get some 429s on Search and Fetch. 5 requests per second to one domain (arxiv) had no 429 |
| Fetch Markdown | Over-escaped (for example `arXiv\.org`, `\#`) |

## Tests

```bash
node --test extensions/deepseek-search/lib.test.ts
```
