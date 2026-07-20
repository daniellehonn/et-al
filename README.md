# et al.

A small, forgiving personal knowledge system built for capture first and agent-assisted cleanup later.

`et al.` means "and others." That fits the core idea: thoughts are never isolated. They arrive with other ideas, notes, people, books, memories, and projects.

This is intentionally not a Notion or Obsidian clone. The core idea is a private, Cloudflare-native memory layer that can grow with you:

- messy capture is valid input
- everything is an item
- Claude/Codex can eventually read, write, sort, and review items through MCP
- the UI stays small enough to keep using after the novelty wears off

## Current Shape

- Cloudflare Worker backend
- Cloudflare D1 for item metadata and markdown content
- REST API for browser/mobile usage
- Streamable HTTP MCP endpoint for AI agents
- Daily review endpoint
- Notion-esque built-in workspace UI for capture, review, filtering, and item editing

## Cloudflare

- Account: `Daniellehonnn@gmail.com's Account`
- Worker: `et-al`
- D1 database: `et-al`
- Production URL: <https://et-al.daniellehonnn.workers.dev>

The deployed Worker uses `ET_AL_API_KEY` for mutating API calls. The local development copy stores the same key in `.dev.vars`, which is intentionally gitignored.

## MCP

Remote MCP endpoint:

```text
URL: https://et-al.daniellehonnn.workers.dev/mcp
Authorization: Bearer <ET_AL_API_KEY>
```

Available tools:

- `list_items`
- `get_item`
- `create_item`
- `update_item`
- `delete_item`
- `search_items`
- `get_daily_review`
- `bulk_update`
- `triage_inbox` — preview deterministic organization suggestions for inbox items (read-only)
- `suggest_related_items` — rank likely connections for an item (read-only)
- `summarize_space` — return counts, top tags, and recent highlights for a space (read-only)

The endpoint uses Streamable HTTP through Cloudflare's Agents SDK. It shares the same D1-backed service functions as the REST API.

### Connect an MCP client

Configure a Streamable HTTP server named `et-al` with the URL above and an HTTP header:

```text
Authorization: Bearer <ET_AL_API_KEY>
```

The endpoint also accepts the existing `x-api-key` header for clients that cannot set `Authorization`. A request without either valid credential receives `401 Unauthorized`. Keep the API key in the client's secret or environment configuration rather than committing it to a config file.

After connecting, verify that the client discovers `list_items` and `get_daily_review`. A useful agent loop is:

1. Call `triage_inbox` to preview a small queue.
2. Confirm proposed changes with the user.
3. Apply accepted decisions with `update_item` or `bulk_update`.
4. Call `suggest_related_items`, then write accepted relationships with `update_item`.
5. Use `summarize_space` or `get_daily_review` for a compact review.

The three suggestion/summary tools are read-only. The create, update, bulk-update, and delete tools mutate data immediately, so agents should ask before making destructive or broad changes.

## Project Layout

```text
et-al/
  docs/architecture.md
  migrations/0001_initial.sql
  src/index.ts
  package.json
  wrangler.toml
```

## Local Setup

```bash
npm install
npm run db:migrate:local
npm run dev
```

Then open the local Worker URL shown by Wrangler.

Set a local API key for mutating requests:

```bash
npx wrangler secret put ET_AL_API_KEY
```

For development, if the secret is missing, the Worker accepts `dev-key`.

## Deploy

```bash
npm run db:migrate:remote
npm run deploy
```

## First Useful Loop

1. Capture anything without overthinking it.
2. Open the daily review.
3. Let the system show one or two things worth touching today.
4. Use the MCP triage and relationship tools so an agent can clean up the backlog with you.
