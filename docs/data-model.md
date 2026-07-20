# et al. Data Model

## Philosophy

The system has two layers: **Identity** and **Spaces**. They are not peers. Identity sits above everything else. It answers *who you are and who you want to become*. The spaces answer *what you are doing about it*.

Everything in a space should be traceable back to something in Identity. A career goal in the career space exists because an Identity goal said "I want to become X." A school task exists because an Identity goal said "I value education." The hierarchy is conceptual, enforced through linking rather than database constraints — the flexibility is intentional.

---

## Layer 1 — Identity

**Database representation:** items where `space IS NULL`

Identity is not a space. It has no peer in the navigation. It sits above the space list in the UI and has its own graph view showing how Identity goals branch into the spaces below.

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

When you create a goal in a space (e.g., "Get an internship at a good company"), it should have a `related` link pointing to the Identity goal that motivated it.

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
| `space` | ENUM \| NULL | `school \| career \| learning \| projects \| life \| saved`. NULL = Identity layer. |
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

Two link mechanisms:

**`related` array** — explicit forward links you set. "This item connects to that item." Bidirectional in the UI: the sidebar shows both outbound links (`related`) and inbound backlinks (items whose `related` contains your ID, queried at read time via `GET /api/items/:id/backlinks`).

**`parent_id`** — structural hierarchy. Tasks under a goal. Notes under a page. Course notes under a course overview. Use `GET /api/items/:id/children` to retrieve all children.

### Cascade pattern

Identity goal → (related) → Career goal → (children) → Tasks

```
Identity: "Become a strong software engineer"
  → related → Career: "Land a summer internship"
                → child → Task: "Apply to 10 companies this week"
                → child → Task: "Update resume with latest project"
                → related → Identity: "Resume thoughtmap" (page)
```

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

## Daily Review

The daily review surfaces:
1. Active Identity and space goals
2. Tasks with `due_date` in the next 7 days
3. Recent `inbox` items that need processing
4. Recent ideas

It is intentionally small. The agent handles depth. The review preserves energy.
