# et al. Architecture

## Product Intent

`et al.` is a personal operating memory, not a productivity product. The name means "and others," which is the thesis of the system: no thought stands alone. Ideas connect to other ideas, notes, people, books, memories, projects, and future versions of yourself.

It is designed around the behavior pattern where capture is easy during novelty, then maintenance fades. The system should make returning painless: dump messy input, recover context, and ask an agent to help organize it.

The product principle is:

> Capture now. Clarify later. Recover gently.

## Scope

### In Scope For V1

- Fast text capture
- One flexible item model
- Daily review
- Search
- REST API
- D1 persistence
- Small built-in UI
- Streamable HTTP MCP endpoint

### Deferred

- R2 attachments
- Offline PWA cache
- Android share target
- iOS Shortcut integration
- Rich markdown editor
- Graph views (backlinks exist as an MCP tool, not a UI surface)
- Multi-user auth

## System Model

Everything is an item. Notes, goals, links, ideas, tools, and raw dumps live in one table. Structure is added only when it earns its keep.

```text
Browser / Phone
  |
  | REST
  v
Cloudflare Worker
  |
  v
Cloudflare D1

Claude / Codex / MCP Client
  |
  | Streamable HTTP MCP
  v
Cloudflare Worker
  |
  v
Cloudflare D1
```

## Why D1-First

The original design split metadata into D1 and markdown content into R2. That is a good later shape for attachments and large documents, but it makes v1 search and iteration heavier.

For v1, D1 stores both metadata and content:

- fewer moving parts
- easier local development
- simple full-text/search evolution
- easier backup/export
- no two-store consistency bugs

R2 can be added later for attachments or large markdown bodies. When that happens, D1 should still keep a `search_text` or FTS-backed copy for retrieval.

## Data Model

### Item

```sql
CREATE TABLE items (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK(type IN ('note','goal','idea','link','tool','dump')),
  title      TEXT NOT NULL,
  space      TEXT NOT NULL CHECK(space IN ('learning','ideas','goals','saved','life','work')),
  status     TEXT NOT NULL DEFAULT 'inbox'
             CHECK(status IN ('active','paused','done','archived','inbox')),
  tags       TEXT NOT NULL DEFAULT '[]',
  metadata   TEXT NOT NULL DEFAULT '{}',
  content    TEXT NOT NULL DEFAULT '',
  related    TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

The table is mirrored into an `items_fts` FTS5 index by insert/update/delete triggers, which is what `/api/search` queries.

`related` starts as a simple JSON array so relationships can exist before a full graph model does. Later it can graduate into an `item_links` table if connections become central to the experience.

### Type Guidance

Types are hints, not prisons:

- `dump`: unsorted thought, copied text, raw capture
- `note`: class/research/reference note
- `goal`: active outcome with possible milestones
- `idea`: possible project or thought
- `link`: saved URL
- `tool`: AI/product/tool research

### Space Guidance

Spaces are where the item belongs in life:

- `learning`
- `ideas`
- `goals`
- `saved`
- `life`
- `work`

### Metadata Conventions

`metadata` is deliberately schemaless, but two keys are read by the UI:

- `checklist`: `[{ text, done }]`. Any item carrying one renders as a checklist
  instead of prose, which is how lists exist without a `list` type.
- `processed`: set on `link` items to drop them out of the daily review.

Brain dumps stay plain text. Each thought is one `[HH:MM] text` line, newest
first, so a dump degrades gracefully to a normal note.

## API

Reads are open. Mutations require either an `X-API-Key` header or a valid
session cookie (see Authentication).

```text
GET    /health
GET    /api/items
GET    /api/items/:id
POST   /api/items
PATCH  /api/items/:id
DELETE /api/items/:id
GET    /api/search?q=...
GET    /api/review
GET    /api/session
POST   /api/session
DELETE /api/session
```

## Authentication

There is one shared secret, `ET_AL_API_KEY` — this is single-user memory, not a
multi-tenant product. What differs is how each client presents it:

- **Agents and scripts** send `x-api-key` (or `Authorization: Bearer` on `/mcp`).
- **The browser** never holds the key. `POST /api/session` takes it once and
  returns an opaque, key-derived token in an `HttpOnly; SameSite=Lax` cookie
  good for a year; every later write rides that cookie.

The point is that capture stays a single keystroke away. Prompting for a secret
on every write is exactly the friction that kills the capture habit, and
stashing the key in `localStorage` to avoid the prompt would hand it to any
injected script. `SameSite=Lax` keeps cross-site requests from riding the
cookie, and the CORS policy stays wildcard-origin *without* credentials, so
other origins can read but never write.

When a write returns 401, the UI raises one unlock prompt and replays the
pending write after the session is established — no lost capture.

## Daily Review

Daily review should never become a guilt dashboard. It should return a small number of useful prompts:

- active goals with upcoming deadlines
- recent dumps that may need sorting
- recent ideas
- unprocessed links

The UI should show fewer things than the database knows. The agent can handle depth; the human surface should preserve energy.

## Built-in UI

The Worker serves one self-contained HTML page at `/` — no build step, no
framework, state re-rendered from a single `state` object. Its shape:

- **Topbar**: wordmark + item count, search (`Cmd/Ctrl-K`), Capture.
- **Sidebar**: spaces and types as filters, both driven by the same enums as the
  schema so the UI can never drift from what D1 accepts.
- **Home**: the daily review (active goals, toggleable) above the item feed.
- **Detail**: one of three renderings picked from the item itself — checklist if
  `metadata.checklist` exists, timestamped thoughts if the type is `dump`,
  otherwise light markdown prose with an inline editor.

Detail views are chosen by what an item *contains*, not by a stored view
setting, which keeps "everything is an item" true at the presentation layer too.

## MCP

Uses Cloudflare's remote MCP approach with Streamable HTTP, not legacy SSE. The
endpoint exposes the same core behaviors as REST:

```text
list_items
get_item
create_item
update_item
delete_item
search_items
get_daily_review
bulk_update
triage_inbox
suggest_related_items
get_children
get_backlinks
summarize_space
```

MCP should not get a separate data layer. It should call the same item service functions used by REST so behavior stays consistent.

Agent-oriented analysis tools are deterministic and read-only. They return recommendations plus an explicit next step; accepted changes still flow through `update_item` or `bulk_update`. The `/mcp` route retains the same bearer-token or `x-api-key` authentication used by the deployed service.

## Growth Path

### Phase 1: Working Local Memory — done

- D1 schema
- Worker REST API
- workspace UI
- daily review

### Phase 2: Agent Memory — done

- Streamable HTTP MCP endpoint and agent-facing workflow tools
- connect Claude/Codex
- test create/search/review flows

### Phase 3: Capture Surface

- installable PWA
- mobile quick capture
- share sheet shortcuts

### Phase 4: Richer Memory

- attachments in R2
- periodic agent cleanup
- item graduation: dump -> idea -> project/goal
- relationship suggestions: "this reminds me of..."
- people/book/project memory views
- markdown export

## Design Constraints

- Capture forms must be forgiving.
- Required fields should be minimal.
- Inbox/dump is a first-class state.
- Search matters more than navigation.
- Metadata should be flexible enough to evolve.
- UI should avoid showing too many stale obligations at once.
- Authentication should cost the human one keystroke per browser, not one per capture.
