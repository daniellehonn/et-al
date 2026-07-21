# et al.

A small, forgiving personal knowledge system built for capture first and agent-assisted cleanup later.

`et al.` means "and others." That fits the core idea: thoughts are never isolated. They arrive with other ideas, notes, people, books, memories, and projects.

This is intentionally not a Notion or Obsidian clone. The core idea is a private, Cloudflare-native memory layer that can grow with you:

- messy capture is valid input
- everything is an item
- Claude/Codex can eventually read, write, sort, and review items through MCP
- the UI stays small enough to keep using after the novelty wears off

## Current Shape (v5 — nested R2 vault)

The system is an **Obsidian-style markdown vault with nested folders** (see
[`docs/architecture-r2.md`](docs/architecture-r2.md)):

- Cloudflare Worker backend
- **R2 bucket (`VAULT`) is the source of truth** — a directory tree of markdown
  files. **Folders are spaces/subspaces** (nest freely); a page's space is the
  folder it lives in. Each folder may hold an optional `_space.md` (metadata +
  overview note)
- **D1 is a derived, rebuildable index** (space tree, titles, link graph, FTS).
  Losing it is recoverable via `POST /api/reindex`; the bucket always wins
- **Three distinct structures:** folder = area, `parent:` link = goal breakdown,
  inline `[[wikilink]]` = lateral reference
- **Notion-style block editor** with `/` slash commands, `[[` page autocomplete,
  a folder tree nav, breadcrumbs, and seamless live backlinks + goal-children
- REST API for browser/mobile usage
- Streamable HTTP MCP endpoint for AI agents

### Modules

```text
src/markdown.ts  frontmatter + wikilink + block parse/serialize (pure, unit-tested)
src/store.ts     R2 writes + D1 index sync + rename propagation + reindex
src/mcp.ts       MCP tool surface over the store
src/ui.ts        the block-editor single-page app
src/index.ts     router, auth, REST, identity graph
```

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

Available tools (v5, operating over the nested vault):

- `get_schema` — canonical enums + the three structures (folder / parent / wikilink)
- `list_spaces` — the full folder tree with page counts
- `get_space` / `create_space` / `update_space` / `delete_space` — folders + `_space.md`
- `move_space` — move or rename a folder, carrying its pages and subspaces (the only way to reorganize the tree; `update_space` changes a display name, never a path)
- `list_pages` — filter by `space_path` (+`recursive` for subtrees), type, status, parent
- `get_page`
- `create_page` — into a `space_path`; `parent` is the goal it breaks down
- `update_page` — moving `space_path` moves the file; renaming rewrites `[[old title]]` everywhere
- `delete_page`
- `search_pages`
- `get_backlinks` — who links here, with context + parent/inline kind
- `get_children` — pages whose `parent` goal-link resolves here
- `list_unresolved_links` — `[[titles]]` with no page yet (growth edges)
- `reindex_vault` — rebuild the D1 index from the R2 bucket

The endpoint uses Streamable HTTP through Cloudflare's Agents SDK. It shares the same store functions as the REST API.

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
wrangler r2 bucket create et-al-vault    # one-time: create the vault bucket
npm run db:migrate:local                 # builds the derived index tables
npm run dev
```

### One-time migration from the old D1 model

If you have existing rows in the legacy `items` table, seed the vault from them,
then verify:

```bash
curl -X POST -H "x-api-key: $ET_AL_API_KEY" https://<worker>/api/migrate-from-d1
curl -X POST -H "x-api-key: $ET_AL_API_KEY" https://<worker>/api/reindex
```

`migrate-from-d1` writes one markdown file per legacy item into the matching
top-level folder (`work→career`, `ideas→projects`, and the old `identity` items
fold into `life/` — re-file them anywhere once it's all folders), converting
`related`/`parent_id` UUIDs into `[[Title]]` links and any `metadata.checklist`
into `- [ ]` task lines. It is safe to re-run. Once the vault looks right, the
`items` table can be dropped.

Note: the current index migration is `0006_nested_spaces.sql` (schema v5). Apply
migrations through 0006 before deploying the v5 worker.

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
