# Extraction eval

@cf/meta/llama-3.3-70b-instruct-fp8-fast, 20 fixtures, run 2026-10-09.

| fixture | expected found | facts | notes |
|---|---|---|---|
| rrf | 2/2 | 3 |  |
| d1-fts | 2/2 | 2 |  |
| sourdough | 3/3 | 3 |  |
| user-pref | 2/3 | 2 | missed sam+review |
| lcs | 1/2 | 2 | missed longest common subsequence+diff |
| idempotency | 1/2 | 1 | missed unique+race |
| climbing | 2/2 | 3 |  |
| project-decision | 2/3 | 1 | missed proposal+table |
| contact | 2/2 | 3 |  |
| workers-cron | 2/2 | 2 |  |
| espresso | 3/3 | 3 |  |
| vitest-workers | 2/2 | 2 |  |
| reading-habit | 1/2 | 2 | missed minutes+books |
| http-cache | 2/2 | 2 |  |
| meeting-correction | 2/2 | 1 |  |
| noise-cookies | — | 0 (none) | ✓ none |
| noise-promo | — | 0 (none) | ✓ none |
| noise-nav | — | 0 (none) | ✓ none |
| noise-login | — | 0 (none) | ✓ none |
| noise-error | — | 0 (none) | ✓ none |

recall    85%  (29/34 expected facts found)
precision 84%  (27/32 extracted facts matched an expected one)
noise     0 facts across 5 fixtures with nothing durable
outcomes  facts 15, none 5
