# et al. Data Model

**Schema version: 3** (`SCHEMA_VERSION` in `src/index.ts` — the single source of truth for every enum; the DB CHECKs, MCP tool schemas, and UI are all derived from it. `GET /api/schema` and the `get_schema` MCP tool return it.)

## Philosophy

The system has two layers: **Identity** and **Spaces**. They are not peers. Identity sits above everything else. It answers *who you are and who you want to become*. The spaces answer *what you are doing about it*.

Everything in a space should be traceable back to something in Identity. A career goal in the career space exists because an Identity goal said "I want to become X." A school task exists because an Identity goal said "I value education." The hierarchy is conceptual, enforced through linking rather than database constraints — the flexibility is intentional.

---

## Layer 1 — Identity

**Database representation:** items where `space = 'identity'`

Identity is a first-class, writable space value — but it is not a peer of the other spaces. It has no peer row in the navigation; it sits above the space list in the UI and has its own graph view showing how Identity goals branch into the spaces below. (Before schema v3, identity was represented as `space IS NULL`, which conflated it with unfiled items and made writes to it silently vanish. `NULL` now means exactly one thing: **unsorted** — captured but not yet filed, always visible in the Unsorted bucket.)

### What belongs in Identity

| Type | Example |
|------|---------|
| `goal` | "Become a strong software engineer" |
| `page` | "Skills & expertise", "How I want to present myself" |
| `page` | Resume thoughtmap — how you structure your personal brand |
| `page` | Life philosophy, values, personal mission |

### Why it exists

Identity items are the source of truth for:
- Resume and personal website generation (skills, experiences, projects)
- Big-picture goal-setting that cascades down into space goals and tasks
- Personal branding — how you want to be perceived professionally

When you create a goal in a space (e.g., "Get an internship at a good company"), set its `parent_id` to the Identity goal that motivated it ("traces to"). A `related` link also counts as a trace — the identity graph honors both — but `parent_id` is the primary mechanism.

---

## Layer 2 — Spaces

Spaces are contexts, not categories. Each space represents a distinct area of your life with its own planning needs, rhythms, and deliverables.

| Space | What it holds |
|-------|---------------|
| `school` | Course notes, assignments (tasks with due dates), club applications, academic goals |
| `career` | Internship applications, resume drafts, networking notes, career goals |
| `learning` | Tools to try, self-directed experiments, things you want to understand |
| `projects` | Project ideas (quick ideas and fully fleshed-out pages), build plans |
| `life` | Watchlist, health, personal tasks, anything that doesn't fit elsewhere |
| `saved` | Links and resources you want to revisit |

---

## Types

Types describe the *nature* of an item, not where it lives. Any type can live in any space (or in Identity).

| Type | Meaning | Grows into |
|------|---------|------------|
| `idea` | A thought you had. Undeveloped. Lives in inbox. | A `page` when you're ready to develop it |
| `page` | A document. Can be a note, a project spec, a course overview, a tracker. Has content and can have children. | Gets child `task` and `page` items |
| `goal` | An outcome you want to achieve. Starts as a title. Grows into a plan with child tasks. | Gets child `task` items + filled-in content |
| `task` | A discrete action. Has `due_date`. Gets done or it doesn't. | Done |
| `link` | A saved URL. Tagged and filed into a space. | Annotated with content |

### The idea → page flow

Quick capture always produces an `idea`. When you sit down to develop it:
1. Either update `type` from `idea` to `page` and fill in content
2. Or create a new `page` and set `related` to the original idea

Both patterns work. The `idea` stays as a record of when the thought first appeared.

### Goals are pages

A goal starts as a bullet — just a title. When you open it and write a plan, it becomes a page with content. When you attach sub-tasks, it becomes a container. You never need to convert a goal into anything else — it grows in place.

---

## Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | TEXT (UUID) | Primary key |
| `type` | ENUM | `page \| goal \| idea \| task \| link` |
| `title` | TEXT | The bullet. Required. |
| `space` | ENUM \| NULL | `identity \| school \| career \| learning \| projects \| life \| saved`. NULL = unsorted (not yet filed; always visible in the Unsorted bucket, filterable as `space=unsorted`). |
| `status` | ENUM | `active \| paused \| done \| archived \| inbox` |
| `tags` | JSON array | Freeform labels. Indexed for FTS. |
| `metadata` | JSON object | Structured data for specific types (e.g., application stage, skill level) |
| `content` | TEXT | Markdown body. Indexed for FTS. |
| `related` | JSON array | IDs of items this item explicitly links to. |
| `parent_id` | TEXT \| NULL | ID of the parent item. Used for hierarchy (tasks under goals, notes under pages). |
| `due_date` | INTEGER \| NULL | Unix timestamp. Primarily for tasks. |
| `created_at` | INTEGER | Unix timestamp. |
| `updated_at` | INTEGER | Unix timestamp. |

---

## Linking (Obsidian-style)

Two link mechanisms with distinct semantics:

**`parent_id` — "traces to" (hierarchy).** Tasks under a goal. Notes under a page. A space goal under the identity goal that motivated it. Use `GET /api/items/:id/children` / `get_children` to retrieve all children. This is the primary lineage mechanism and drives the Cascade view.

**`related` array — lateral association.** Explicit non-hierarchical links you set. Bidirectional in the UI: the sidebar shows both outbound links (`related`) and inbound backlinks (items whose `related` contains your ID, queried at read time via `GET /api/items/:id/backlinks` / `get_backlinks`).

The identity graph (`GET /api/identity/graph`) treats an item as "traced to identity" via **either** mechanism, marking each link with `via: "parent" | "related"`. Writes referencing a nonexistent `parent_id` or `related` ID error — no silent no-ops.

### Cascade pattern

Identity goal → (children via `parent_id`) → Career goal → (children) → Tasks

```
Identity: "Become a strong software engineer"
  ← parent_id ← Career: "Land a summer internship"
                  ← parent_id ← Task: "Apply to 10 companies this week"
                  ← parent_id ← Task: "Update resume with latest project"
                  → related  → Identity: "Resume thoughtmap" (page, lateral)
```

### Subtasks

Subtasks are real `task` items with `parent_id` set to the owning item — not freeform `metadata.checklist` blobs (migration 0004 converted the existing ones). Progress is queryable: `get_children` with `type=task`.

---

## Metadata conventions (by type)

These are not enforced by the schema — they are conventions used by the app and MCP tools.

**Applications** (internship, club):
```json
{ "stage": "applied | screening | interview | offer | rejected", "org": "...", "role": "...", "url": "..." }
```

**Identity profile items**:
```json
{ "category": "skill | experience | education | project", "level": "beginner | intermediate | expert" }
```

**Watchlist** (`link` in `life` space):
- tags: `["watchlist", "movie"]` or `["watchlist", "tv"]`
- status: `inbox` (want to watch), `done` (watched)

---

## How this is actually used

Measured against the live database on 2026-07-20 — **27 items**, all four migrations (`0001`–`0004`) applied. The model above is the design; this is the reality, and the gaps are informative.

### Space usage

| Space | Actual contents |
|-------|-----------------|
| `identity` | 5 goals |
| `life` | **11 goals + 1 task** — including career and school goals ("Get an internship", "Launch a startup", "Go to all my classes and get As") |
| `projects` | 6 ideas |
| `learning` | 2 goals, 2 ideas |
| `school` | *empty* |
| `career` | *empty* |
| `saved` | *empty* |
| `NULL` (unsorted) | *empty* — nothing is currently unfiled |

`life` has become the default catch-all rather than the residual space the table above describes, and `school` / `career` sit empty despite goals existing that plainly belong to them. Either the filing habit changes or those spaces collapse into `life` — worth deciding rather than leaving as drift.

### Types

3 of 5 types are in use: `goal` (18), `idea` (8), `task` (1). **No `page` and no `link` exists.** Consequences:

- The **idea → page flow** has never actually run. Ideas stay ideas.
- Identity holds **only goals, no pages** — so the "Skills & expertise" / resume-thoughtmap pages the Identity layer was designed around don't exist. Resume and personal-site generation has nothing to read from yet.
- `due_date` is unset everywhere, so the daily review's 7-day task window is always empty.

### Linking

13 space goals trace to an identity goal, and **0 are untraced**. The cascade pattern is genuinely in use — the model's central bet paying off.

Two observations:

1. **`parent_id` and `related` are both set, to the same identity item**, on all 13. Under schema v3 `parent_id` is the primary mechanism and `related` is meant for lateral association, so the `related` half of each pair is redundant. Harmless, but it means `related` currently carries no information of its own.
2. **A slug tag per identity** (`creative-ai-dev`, `student`, `entrepreneur`, `content-creator`, `fitness`) is repeated on every descendant — an informal third lineage mechanism. Redundant with `parent_id`, but unlike `parent_id` it's visible everywhere in the UI.

The 5 identity goals themselves have no parent and no related links, as expected for the top of the hierarchy. They carry an `Identity: ` title prefix and an `identity` tag — self-labelling, because they appear in feeds alongside space items.

Branch weight is very uneven: `Identity: Creative AI-native developer` carries 8 descendants; the other four carry 1–2 each.

### Metadata conventions

The conventions documented above (application `stage`/`org`/`role`, identity `category`/`level`, watchlist tags) are **unused** — metadata is empty except where the app writes its own keys. They remain aspirational.

## Daily Review

The daily review surfaces:
1. Active Identity and space goals
2. Tasks with `due_date` in the next 7 days
3. Recent `inbox` items that need processing
4. Recent ideas

It is intentionally small. The agent handles depth. The review preserves energy.
