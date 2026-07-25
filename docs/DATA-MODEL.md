# et al. — Data Model

> Companion to [`DESIGN.md`](./DESIGN.md). D1 (SQLite) is the source of truth.
> `[SPINE]` tables are built first; `[DEFER]` tables are designed but not built.
> IDs are text (ULID-ish, sortable). All timestamps are unix-ms integers.

## Conventions

- Every table has `id`, `created_at`. Mutable tables add `updated_at`.
- Every mutating write records an `event` row (audit) with `actor`.
- `actor` is `'human'` or `'ai:<agent-name>'`. Defaults to `'human'`; the MCP
  handler overrides it to the agent for every write it makes.
- `position` (real/float) orders siblings without renumbering neighbors.

---

## workspace `[SPINE]`

The strict tree. `parent_id` null = a root (e.g. "Life").

| column | type | notes |
|---|---|---|
| id | text pk | |
| parent_id | text fk→workspace.id null | one parent only; enforced not-a-cycle in store |
| type | text | `area` \| `project` \| `course` \| `organization` — templates only |
| title | text | |
| description | text null | |
| status | text | `active` \| `paused` \| `archived` |
| position | real | order among siblings |
| created_at / updated_at | int | |

Rules: no cycles; deleting a workspace with children is rejected (move or archive
first). `type` drives which starter Documents/Objectives are seeded on create.

## objective `[SPINE]`

| column | type | notes |
|---|---|---|
| id | text pk | |
| workspace_id | text fk→workspace.id | |
| parent_objective_id | text fk→objective.id null | sub-objectives |
| title | text | |
| description | text null | |
| status | text | `active` \| `done` \| `paused` |
| priority | int | 0–3 |
| position | real | |
| created_at / updated_at | int | |

## task `[SPINE]`

| column | type | notes |
|---|---|---|
| id | text pk | |
| workspace_id | text fk→workspace.id | |
| objective_id | text fk→objective.id null | may float without an objective |
| title | text | |
| notes | text null | |
| status | text | `todo` \| `doing` \| `blocked` \| `done` |
| priority | int | 0–3 |
| due_date | int null | |
| estimate_min | int null | |
| actor | text | who created it |
| position | real | |
| created_at / completed_at | int | `completed_at` set on → `done` |

## document `[SPINE]` + block `[SPINE]` + block_revision `[SPINE, minimal]`

A Document is a container; its body is ordered **blocks** (the Notion-style
surface both humans and agents edit).

**document**

| column | type | notes |
|---|---|---|
| id | text pk | |
| workspace_id | text fk→workspace.id | |
| title | text | |
| type | text | `design` \| `architecture` \| `roadmap` \| `readme` \| `note` \| `free` |
| status | text | `draft` \| `active` \| `archived` |
| created_at / updated_at | int | |

**block**

| column | type | notes |
|---|---|---|
| id | text pk | |
| document_id | text fk→document.id | |
| type | text | `paragraph` \| `heading` \| `bullet` \| `numbered` \| `todo` \| `code` \| `quote` \| `divider` \| `image` |
| content_json | text | block payload (text, level, checked, lang, r2_key…) |
| position | real | |
| version | int | bumped on edit |
| is_ai | int(bool) | true if last written by an agent |
| created_at / updated_at | int | |

**block_revision** — retained prior versions so a patch is reversible. Minimal
now (append on change); full diff-history UI is `[DEFER]`.

| column | type | notes |
|---|---|---|
| id | text pk | |
| block_id | text fk→block.id | |
| content_json | text | the *previous* content |
| version | int | |
| actor | text | |
| created_at | int | |

**document_patch `[SPINE]`** — an agent's proposed change awaiting Accept/Reject.

| column | type | notes |
|---|---|---|
| id | text pk | |
| document_id | text fk→document.id | |
| ops_json | text | ordered block ops (insert/update/delete/move) |
| summary | text | agent's one-line rationale |
| status | text | `pending` \| `accepted` \| `rejected` |
| actor | text | `ai:<name>` |
| created_at / resolved_at | int | |

## source `[SPINE]`

Raw input. The captured payload is immutable.

| column | type | notes |
|---|---|---|
| id | text pk | |
| workspace_id | text fk→workspace.id null | null while in inbox, unassigned |
| kind | text | `note` \| `idea` \| `url` \| `pdf` \| `youtube` \| `book` \| `image` \| `voice` \| `github` \| `email` \| `document` |
| title | text null | |
| url | text null | |
| r2_key | text null | asset in R2 |
| raw | text null | **immutable** original captured text/payload |
| metadata_json | text null | oEmbed, parsed fields |
| status | text | `inbox` \| `processing` \| `processed` |
| actor | text | |
| created_at / updated_at | int | |

Rule: `raw` is write-once. Processing writes Insights/relationships, never edits
the Source's raw payload.

## insight `[SPINE]`

Atomic knowledge node; carries an embedding.

| column | type | notes |
|---|---|---|
| id | text pk | |
| workspace_id | text fk→workspace.id null | |
| title | text | |
| body | text | |
| source_id | text fk→source.id null | origin, if any |
| embedding_id | text null | Vectorize vector id |
| is_ai | int(bool) | |
| actor | text | |
| created_at / updated_at | int | |

## decision `[SPINE]`

Immutable event. No `updated_at`.

| column | type | notes |
|---|---|---|
| id | text pk | |
| workspace_id | text fk→workspace.id | |
| title | text | |
| rationale | text | |
| alternatives_json | text null | |
| impact | text null | |
| decided_on | int | |
| actor | text | |
| created_at | int | |

## relationship `[SPINE]`

The universal typed edge — connects any two objects of any type.

| column | type | notes |
|---|---|---|
| id | text pk | |
| source_type / source_id | text | |
| target_type / target_id | text | |
| type | text | `references` \| `uses` \| `inspired_by` \| `generated_from` \| `related_to` \| `learned_from` \| `created_from` \| `depends_on` |
| actor | text | |
| created_at | int | |

Backlinks = reverse query on (target_type, target_id). No graph DB.

## daily_focus `[SPINE]`

Three slots per day + the day's tracking.

**daily_focus_day**

| column | type | notes |
|---|---|---|
| date | text pk | `YYYY-MM-DD` |
| confirmed_at | int null | set when the 3 are locked |
| reflection | text null | short end-of-day note |
| created_at | int | |

**daily_focus_slot**

| column | type | notes |
|---|---|---|
| id | text pk | |
| date | text fk→daily_focus_day.date | |
| slot | int | 1..3 |
| task_id | text fk→task.id | |
| status | text | `planned` \| `done` |

Streak/consistency are derived by querying confirmed days, not stored.

## event `[SPINE]`

Audit trail. Every mutation appends one.

| column | type | notes |
|---|---|---|
| id | text pk | |
| actor | text | `human` \| `ai:<name>` |
| action | text | `create` \| `update` \| `delete` \| `complete` \| `patch_proposed` … |
| entity_type | text | |
| entity_id | text | |
| detail_json | text null | |
| created_at | int | |

Powers the Timeline tab, Recent Activity, and `get_agent_activity`.

---

## Search & embeddings

- **Full text `[SPINE]`** — D1 FTS5 across title/body of documents, insights,
  sources, tasks.
- **Semantic `[SPINE]`** — Vectorize, dims per the chosen Workers AI embedding
  model, metric cosine. A `user_id` metadata index is required (Vectorize returns
  zero matches, not an error, when filtering on an unindexed property).
- **Hybrid ranking `[DEFER]`** — merge FTS + vector scores. Keyword-first to start.

## Workspace Health (computed, not a table) `[SPINE = dumb]`

Cached in KV, recomputed on write. Dumb version:

```
health(workspace) = f(
  recency of last event in the workspace,
  open vs. completed tasks,
  staleness of active objectives
) → 0..100
```

No AI, no life-balancing judgment. The `[DEFER]` planning engine will consume
these numbers later.

---

## Deferred tables

- `[DEFER]` **user / auth** — single-user via API key for now; multi-user later.
- `[DEFER]` **document_snapshot** — R2 markdown exports of documents.
- `[DEFER]` **health_history** — time series for the life-balancer.
