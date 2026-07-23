# et al.

A small, forgiving personal knowledge system built for capture first and agent-assisted cleanup later.

`et al.` means "and others." That fits the core idea: thoughts are never isolated. They arrive with other ideas, notes, people, books, memories, and projects.

This is intentionally not a Notion or Obsidian clone. The core idea is a private, Cloudflare-native memory layer that can grow with you:

- messy capture is valid input
- saved material should become tested knowledge, not a link graveyard
- **the AI lives outside the platform**: Claude works with et al. through MCP and
  skills, and every write it makes is attributed as `actor: 'ai'`
- the UI stays small enough to keep using after the novelty wears off

## Current Shape (v6 — typed life operating system)

v6 turns the generic vault into a **typed personal operating system** built
around one loop: **Capture → Organize → Act → Document → Learn → Publish →
Reflect**. See [`docs/v6-implementation-plan.md`](docs/v6-implementation-plan.md).

The storage model inverted from v5:

- Cloudflare Worker backend (unchanged)
- **D1 is the source of truth** — ~20 typed tables, not a derived index
- **R2 holds assets and Markdown exports/snapshots**, no longer the truth
- **Vectorize** for semantic search (Phase 4); D1 FTS5 for full text today
- **Typed objects, not one `page` type:** Life Areas → Goals → Projects, with
  Project Logs, Knowledge Notes, Captures, Tools, Sources, and Content Items,
  each with its own lifecycle vocabulary
- Rules enforced in the store, not just the UI: an **active project must have a
  next action**; a tool needs a **written verdict** before `tested`; a capture's
  raw input is **immutable**; every write leaves an **audit event**
- **No AI provider inside the Worker.** Ingestion is deterministic (fetch,
  oEmbed, parse); the intelligence is Claude, reached over MCP. Anything an agent
  writes is recorded as `actor: 'ai'` — see `get_agent_activity`.
- Streamable HTTP MCP endpoint for AI agents

### Modules

```text
src/schema.ts       typed object model + per-entity lifecycle vocabularies
src/store/          one module per entity; rules live next to the data
  db.ts             bindings, validation, audit trail, FTS maintenance
  documents.ts      documents + ordered blocks (the writing surface)
  areas/goals/projects/logs/notes/tools/sources/content/captures.ts
  relations.ts      the semantic graph + backlinks + unresolved wikilinks
  search.ts         FTS5 today, hybrid ranking later
src/api.ts          resource registry + /api/home and /api/review aggregates
src/index.ts        Worker router, auth, REST
src/mcp.ts          MCP tool surface (typed vocabulary)
src/status.ts       interim root page until the Phase 3 client lands
```

Retained but **not wired in**, as port sources for later phases:
`src/ui.ts` (block editor → Phase 3) and `src/markdown.ts` (Markdown
export/wikilink parsing → Phase 6). Both carry a header explaining this.

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

Available tools (v6, operating over the typed object model):

**Orientation**
- `get_schema` — the object model, per-entity vocabularies, and the product's rules
- `get_home` — what matters now / next / needs review
- `get_weekly_review` — the guided review as ordered steps with their items

**Capture & inbox**
- `capture` — save a raw thought or link immediately (stored immutably)
- `list_inbox` — captures still awaiting review

**Structure & execution**
- `list_areas` / `create_area` — Life Areas (filters and context, not folders)
- `list_goals` / `create_goal` — measurable direction inside an Area
- `list_projects` / `get_project` / `create_project` / `update_project`
  — activating a project without a `next_action` is rejected
- `list_stale_projects` — active work that has quietly stalled
- `add_log` / `list_logs` — the engineer's log (decision, experiment, problem, learning, reflection)

**Knowledge, tools, content**
- `list_notes` / `create_note` / `update_note` — mastery captured → learning → understood → applied
- `list_tools` / `save_tool` / `update_tool` — a written verdict is required before `tested`
- `create_source` — external material, distinct from the knowledge made from it
- `list_content` / `create_content_seed` — turn real work into a draft, preserving provenance

**Graph, search, documents**
- `relate` — typed semantic edges (learned-from, used-in, created-from, …)
- `get_backlinks` — everything referencing an object
- `search` — full text across every entity
- `list_unresolved_links` — referenced titles with nothing behind them yet
- `get_body` / `write_body` — ordered blocks; generated blocks stay flagged `is_ai`
- `rebuild_search_index` — repairs FTS from canonical D1 (not a recovery path in v6)

The endpoint uses Streamable HTTP through Cloudflare's Agents SDK. It shares the same store functions as the REST API.

### Connect an MCP client

Configure a Streamable HTTP server named `et-al` with the URL above and an HTTP header:

```text
Authorization: Bearer <ET_AL_API_KEY>
```

The endpoint also accepts the existing `x-api-key` header for clients that cannot set `Authorization`. A request without either valid credential receives `401 Unauthorized`. Keep the API key in the client's secret or environment configuration rather than committing it to a config file.

After connecting, verify the client discovers `get_schema` and `get_home`. A good
agent loop is:

1. `get_home` to orient on what matters now.
2. `capture` anything new before deciding where it belongs.
3. Propose typed records to the user, then write them with the `create_*` tools.
4. `relate` the results so applied knowledge becomes visible.
5. `get_weekly_review` for a compact, step-by-step review.

Read tools are safe. The create/update tools mutate immediately, so agents should
confirm before broad or destructive changes — and per the product's core rule, AI
never writes canonical records the user has not approved.

## Working with Claude

The AI interface is the MCP server plus a set of skills, versioned in
`.claude/skills/`:

| Skill | Use it for |
|---|---|
| `et-al` | The object model, the enforced rules, and the rules about the agent itself. Load first. |
| `et-al-inbox` | Triaging the capture queue — biased toward *fewer* records, not more. |
| `et-al-digest` | Turning a saved video or article into connected knowledge notes. |
| `et-al-review` | The guided weekly review. |

To use them elsewhere (Claude Cowork, another machine), copy the folders into
`~/.claude/skills/` and connect the MCP endpoint above.

### What the agent may and may not do

The spec's rule is that AI never silently writes canonical records. Since the
agent sits outside the platform, the human is already in the loop at the
conversation — so instead of an in-app approval queue, et al. guarantees
**attribution**: the Worker wraps the entire MCP handler so every write through
it is stored as `actor: 'ai'`, with the agent name in the audit detail. A store
function cannot forget to attribute itself.

The skills also encode limits that matter more than any of the above:

- never write the user's own explanation, or advance a note's mastery for them
- label generated content (`is_ai` on blocks, `ai_sections` on notes)
- check for duplicates before creating a note
- when the destination is unclear, `capture` rather than inventing structure

## Project Layout

```text
et-al/
  docs/
    Life_Organization_System_Product_Specification.pdf   the product spec
    v6-implementation-plan.md                            the build plan (start here)
    architecture-r2.md, data-model.md                    v5 history
  migrations/0007_v6_schema.sql                          the v6 schema
  src/                                                   see Modules above
  wrangler.toml
```

## Local Setup

```bash
npm install
wrangler r2 bucket create et-al-vault    # assets + Markdown exports
npm run db:migrate:local                 # applies all migrations
npm run dev
```

Semantic search needs two one-time Cloudflare resources. **Both** are required —
Vectorize returns zero matches (not an error) when filtering on a property that
has no metadata index, which makes a missing second step look like "semantic
search found nothing":

```bash
wrangler vectorize create et-al-index --dimensions 768 --metric cosine
wrangler vectorize create-metadata-index et-al-index --property-name=user_id --type=string
```

`GET /health` reports which optional bindings are live, so a misconfiguration is
visible rather than silent. Without them, search degrades to keyword-only.

Then seed the default Life Areas and open the Worker URL Wrangler prints:

```bash
curl -X POST -H "x-api-key: $ET_AL_API_KEY" http://localhost:8787/api/bootstrap
```

Set a local API key for mutating requests:

```bash
npx wrangler secret put ET_AL_API_KEY
```

For development, if the secret is missing, the Worker accepts `dev-key`.

> **Migrating from v5:** there is no conversion path. `0007_v6_schema.sql` drops
> the v5 `pages`/`spaces`/`links` tables, because one generic `page` type cannot
> be mechanically split into the v6 typed entities without inventing data. Export
> anything you want to keep before applying it remotely.

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
