# et al.

An **MCP-native personal operating system**. et al. is the source of truth for
your life — workspaces, goals, knowledge, and actions — that any AI agent can
understand and operate. The web app lets you visualize and edit; external agents
(Claude Desktop, Claude Code, Cowork, Cursor) help you learn, build, and execute
through the same underlying context.

`et al.` means "and others." Thoughts are never isolated — they arrive with other
ideas, notes, people, and projects.

> **The one architectural decision:** et al. is *not* an AI app. It owns the data
> and context; AI clients connect from **outside** over MCP. No LLM key lives in
> the Worker — the Worker is deterministic (fetch, parse, embed, store, search).
> All reasoning happens in the agent, and every write an agent makes is
> attributed `actor:'ai'`.

The design is documented as a constitution:

- [`docs/DESIGN.md`](docs/DESIGN.md) — the constitution (tagged `[SPINE]` / `[DEFER]`)
- [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) — the D1 schema
- [`docs/MCP.md`](docs/MCP.md) — the two-layer tool surface
- [`docs/convo.md`](docs/convo.md) — the origin conversation

## The object model

Everything lives inside a **Workspace** (a strict tree that doubles as the default
AI context). A workspace holds **Objectives** (why), **Tasks** (what),
**Documents** (living block-editable artifacts), **Sources** (raw inputs),
**Insights** (atomic knowledge nodes), and **Decisions** (immutable choices).
**Relationships** are typed edges connecting anything to anything. The **Daily 3**
is exactly three committed tasks per day.

## Modules

```text
src/schema.ts       object model, per-entity vocabularies, zod validation, Env
src/store/          one module per entity; rules live next to the data
  db.ts             Ctx, ids, the audit trail, FTS maintenance
  workspaces.ts     the strict tree, ancestors (inherited context), path resolve
  objectives / tasks / documents / sources / insights / decisions / relations
  daily.ts          the Daily 3 (lock-on-confirm)
  context.ts        the Context Engine (Layers 1–2)
  health.ts         Workspace Health (dumb activity/flow version)
  home.ts           /home and /review aggregates
  search.ts         D1 FTS5 (hybrid later)
src/api.ts          REST surface for the web app (Hono)
src/mcp.ts          MCP tool surface (data + intent layers), Streamable HTTP
src/index.ts        Worker: routing, auth, health, bootstrap, ingest queue
```

## Cloudflare

- Worker `et-al` · D1 `et-al` · R2 `et-al-vault` · Vectorize `et-al-index` ·
  Workers AI · Queue `et-al-jobs`
- Production URL: <https://et-al.daniellehonnn.workers.dev>

Mutating REST calls and every MCP call require `ET_AL_API_KEY` (Bearer or
`x-api-key`). Locally it lives in `.dev.vars` (gitignored); if unset, the Worker
accepts `dev-key`.

## MCP

```text
URL:  https://et-al.daniellehonnn.workers.dev/mcp
Auth: Authorization: Bearer <ET_AL_API_KEY>
```

Streamable HTTP, JSON-RPC 2.0. The client name (`x-mcp-client` header, default
`claude`) becomes the write actor. Reads are safe; writes execute immediately and
attributed. **Documents are the exception** — agents change them only through
`propose_document_patch`, which surfaces as Accept/Reject in the web app. See
[`docs/MCP.md`](docs/MCP.md) for the full tool list.

A good agent loop: `open_workspace` → `build_context` → `capture` new inputs →
propose typed records with `create_*` → `relate` results → `suggest_daily3` /
`weekly_review`.

## Local setup

```bash
npm install
wrangler r2 bucket create et-al-vault
npm run db:migrate:local
npm run dev
```

Semantic search needs two one-time Cloudflare resources. **Both** are required —
Vectorize returns zero matches (not an error) when filtering on a property with no
metadata index:

```bash
wrangler vectorize create et-al-index --dimensions 768 --metric cosine
wrangler vectorize create-metadata-index et-al-index --property-name=workspace_id --type=string
```

`GET /health` reports which bindings are live. Seed the default Life Areas:

```bash
curl -X POST -H "x-api-key: $ET_AL_API_KEY" http://localhost:8787/api/bootstrap
```

## Deploy

```bash
npm run db:migrate:remote
npm run deploy
```

> **The web app** (Notion-style block editor) is the next build phase. Until it
> lands, `public/` serves a placeholder and the API + MCP are fully usable. See
> the build order at the end of [`docs/DESIGN.md`](docs/DESIGN.md).

## Status

The **spine** is built: schema, store with rules, REST, the MCP surface (37
tools), the Context Engine (Layers 1–2), deterministic ingest, and Daily 3.
Deferred, in likely order: the web app, the AI life-balancer, Context Layer 3,
document diff-history UI, `generate_resume`, and realtime via Durable Objects.
