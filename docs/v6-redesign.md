# et al. — v6 Redesign Spec: Braindump → Build/Learn/Know → Plan

Status: **proposal, not yet implemented.** Existing vault will be wiped; keeps the
Cloudflare Worker + R2 vault + D1 index + MCP architecture (`docs/architecture-r2.md`).
This doc replaces the space model in `docs/data-model.md` / `docs/architecture-r2.md`
with five fixed pillars instead of a freeform folder tree.

## Why change

The current model (`identity/career/school/life/learning/projects/saved` as a flat
space enum, one universal `type` + `status` pair for everything) drifted in practice:
`life` became a catch-all, `school`/`career` sat empty next to goals that belonged
there, and `page`/`link` types were never used. The root cause: one status/type
vocabulary was forced onto contexts that behave nothing alike — a job application
and a math concept don't have the same lifecycle. v6 gives each pillar its own
vocabulary instead of bending one enum to fit five different jobs.

---

## The five pillars

| Pillar | Folder | What it replaces |
|---|---|---|
| **Braindump** | `braindump/` | the old Unsorted bucket — but permanent, not just a queue |
| **Projects** | `projects/` | old `projects` space, now with a real lifecycle |
| **Things to Learn** | `learning/` | old `learning` space |
| **Knowledge Graph** | `knowledge/` | new — the actual second brain |
| **Planning** | `planning/jobs/`, `planning/clubs/`, `planning/story/` | old `identity` layer + new trackers |

Each pillar is a top-level space (reusing the existing nested-space machinery —
`list_spaces`, folder tree, `_space.md` metadata), but the **type living in it
carries pillar-specific fields**, not the shared five-type/five-status enum every
item currently uses regardless of context.

### The one lineage rule

**Within a pillar, an item evolves in place** (a project's `stage` advances from
`idea` to `shipped` on the same page — it never gets recreated).

**Moving between pillars always spawns a new page**, linked back to its origin via
the existing `parent` field ("traces to"). A braindump thought that becomes a
project doesn't get its type silently swapped — a new `project` page is created in
`projects/`, its `parent` points at the original dump entry, and the dump entry's
status flips to `promoted`. Same when a `learn` topic graduates into a `node`.

This keeps one honest rule instead of two conflicting ones (the old model both
mutated-in-place for idea→page *and* discussed spawn+link as an alternative,
and never committed). It also means the logbook property you want — "when did
this idea first appear" — is never lost to a rename.

---

## Types (replacing the shared `page|goal|idea|task|link` enum)

| Type | Pillar | Purpose |
|---|---|---|
| `dump` | Braindump | raw capture: a thought, a list, a link, anything |
| `project` | Projects | an idea, growing into spec, then a build |
| `log` | any (child of project/story) | dated logbook entry — journal-style child page |
| `learn` | Things to Learn | a tool/topic you want to try, still unexplored |
| `node` | Knowledge Graph | a processed, documented concept — the graph itself |
| `application` | Planning | a job or club application |
| `story` | Planning | identity material: values, skills, experience, gaps |

Standalone `task` is dropped — the block editor already does `/todo` → `- [ ]`
inline checklists, which is how the old `task` type was barely used anyway (1
task existed across 27 items per the v3 usage audit). `due` stays as a generic
optional frontmatter field on any type that needs a deadline (an application
follow-up, a project ship date).

---

## Per-type lifecycle fields

The single global `status: active|paused|done|archived|inbox` enum is dropped.
Each type gets its own field, validated by the app layer (same pattern as now —
TS const arrays + zod — just one enum per type instead of one for all):

| Type | Field | Values |
|---|---|---|
| `dump` | `status` | `raw` (unprocessed) · `kept` (reviewed, staying as-is) · `promoted` (spawned elsewhere) |
| `project` | `stage` | `idea → concept → spec → building → shipped`, plus `paused` / `archived` as sinks |
| `log` | — | none; append-only, ordered by `created` |
| `learn` | `status` | `queued → exploring → graduated`, plus `dropped` |
| `learn` | `category` | `ai-skill \| design \| tool \| hobby \| other` (freeform tag also fine) |
| `node` | — | none required; optionally `maturity: seed\|growing\|evergreen` later |
| `application` | `kind` | `job \| club` |
| `application` | `stage` | `wishlist → applied → screening → interview → offer`, plus `rejected` / `withdrawn` |
| `story` | `category` | `values \| skill \| experience \| goal \| gap` |
| `story` | `status` | `current` (true now) · `aspirational` (working toward) · `outdated` (worth revisiting) |

Jobs and clubs share one folder (`planning/applications/`) and the `application`
type with a `kind` field, rather than two separate folders — same data shape,
the UI just filters into two board tabs. Simpler than duplicating the tracker
logic per kind.

---

## Linking (unchanged mechanics, reused meaning)

Still exactly three structures, same as v5:

- **folder** = pillar/area
- **`parent`** = lineage — goal breakdown *within* Projects, cross-pillar
  provenance (dump→learn, dump→project, learn→node) *between* pillars
- **inline `[[wikilink]]`** = lateral reference, e.g. a `node` linking to another
  `node`, or a `project` page linking to the `node` it's built on

Backlinks, unresolved-link click-to-create, and rename propagation all carry
over unchanged from `architecture-r2.md` §4.

---

## Pillar notes

**Braindump.** Not a queue that empties — a permanent home. Most captures never
leave it (`status: kept`); some spawn a `learn` or `project` page and get marked
`promoted`, staying as the anchor a backlink points to. Fast capture should stay
one action: title + optional body, straight into `braindump/`, `status: raw`.

**Projects.** The engineer's logbook. A project page holds the spec/current
state; `log` child pages (dated, `parent` = the project) hold the running
journal — decisions, build notes, dead ends. `stage` is visible at a glance in
a board view. This is the pillar closest to the old model already, just with an
explicit `stage` field instead of overloading `status`.

**Things to Learn.** Deliberately shallow — a backlog, not a workspace. List
view grouped by `status`, filterable by `category`. The only real action here
is "graduate," which spawns a `node`.

**Knowledge Graph.** The pillar with no folder-tree hierarchy imposed beyond
`knowledge/` itself (optional light sub-folders like `knowledge/ai-ml/` are
fine, but the graph — not the tree — is the real structure). `source` (via
`parent`) links back to the `learn` item it grew from when applicable. This is
where a proper graph view earns its keep — see UI notes below.

**Planning.** Jobs/Clubs are the straightforward part — a kanban by `stage`.
My Story is the old Identity layer, demoted from "sits above everything" to
"one pillar among five," which resolves the old model's awkward asymmetry
(identity items didn't obey the same rules as everything else). It holds
`story` pages: values, a skills inventory, an experience log, and — new —
`category: gap` entries for things you know are missing (skills to build,
experience to get) so the pillar can literally answer "what am I short on."

---

## D1 index changes

- Add a nullable, indexed `stage` column to `pages` (used by `project` and
  `application`; `status` stays for the types that use it).
- `SEED_SPACES` becomes `braindump, projects, learning, knowledge, planning`
  (with `planning/applications` and `planning/story` pre-seeded as subspaces).
- Everything else in `architecture-r2.md` §5 (links table, FTS, reindex) is
  unchanged — the index is still fully rebuildable from the bucket.
- New migration file (`0007_v6_pillars.sql`); old migrations are never rewritten.
  Since the vault is being wiped, this migration can drop and reseed rather than
  carry conversion logic.

## MCP tool changes

Existing page CRUD (`create_page`, `update_page`, `get_page`, `search_pages`,
`get_backlinks`, `get_children`, `reindex_vault`, etc.) generalizes as-is —
`type`, `space_path`, and now `stage` are just more parameters. Additions:

- `capture` — thin wrapper: always creates a `dump` in `braindump/`, `status: raw`.
- `promote` — given a dump/learn id + destination type + title, spawns the new
  page with `parent` set back to the source, and flips the source's status
  (`promoted` / `graduated`). This is the one operation that implements the
  lineage rule, so it belongs in the tool layer rather than being reconstructed
  by hand every time.
- `list_by_stage` — groups projects or applications by `stage`, the data source
  for kanban views.
- `get_gap_analysis` (Planning) — cross-references `story` goals against linked
  evidence (projects/skills/experience) to surface thin spots. Marked as a
  phase-2/stretch tool below — it's a real design problem on its own, not just
  a query.

---

## UI

Top-level nav becomes the five fixed pillars (replacing the dynamic top-level
folder tree; sub-folders still nest within a pillar, e.g. `knowledge/ai-ml`).

1. **Braindump** — pinned capture bar; list of `raw`/`kept` items; a "Sort"
   action opens a small picker (→ Learn / → Project / Keep here).
2. **Projects** — board grouped by `stage`; opening a project shows the page
   plus its `log` children in chronological order underneath.
3. **Things to Learn** — flat list grouped by `status`, category filter chips,
   a "Graduate" action per item.
4. **Knowledge Graph** — node list + search/backlinks (reuses the existing
   panel) + a graph visualization (new — force-directed, scoped to `knowledge/`,
   tag-colored). Graph view is the one genuinely new UI surface; everything
   else reuses the current block editor and backlinks panel unchanged.
5. **Planning** — tabbed: Jobs board / Clubs board (same `application`
   component, filtered by `kind`) / My Story (structured profile view, gap
   list once `get_gap_analysis` exists).

---

## Implementation phases

1. **Schema + backend** — migration 0007, `markdown.ts` type/field constants,
   `store.ts` validation per type.
2. **MCP tools** — `capture`, `promote`, `list_by_stage`; update tool
   descriptions/schemas to match.
3. **UI rebuild** — five-pillar nav, capture bar, kanban board component,
   Learning list, Planning tabs. Block editor and backlinks panel carry over.
4. **Stretch** — graph visualization, gap analysis.

## Open questions before implementation starts

1. Does the type/status/stage vocabulary above feel right, or do any pillars
   need different states (e.g. should Projects have a `blocked` stage)?
2. Confirm the lineage rule (spawn + `parent`-link across pillars, in-place
   `stage` change within a pillar) matches how you actually want to work.
3. One `application` type with `kind: job|club` in a shared folder, vs. two
   fully separate trackers — any reason you'd want them structurally separate
   (e.g. different fields per kind)?
4. Is the graph visualization worth building in phase 3, or fine to defer to
   phase 4 and ship with list+backlinks first?
5. Anything from the old Identity/Cascade view (`docs/identity-ux.md`) worth
   deliberately carrying into My Story, beyond the gap-analysis idea above?
