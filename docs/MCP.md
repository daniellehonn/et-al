# et al. — MCP Tool Surface

> Companion to [`DESIGN.md`](./DESIGN.md). Two layers: **data** tools (granular,
> CRUD-ish) and **intent** tools (high-level, compose the data tools). Both are
> exposed. Streamable HTTP, Bearer auth, sharing the same store functions as REST.
> `[SPINE]` = first pass · `[DEFER]` = designed, not built.

## Rules that hold for every tool

- Read tools are always safe.
- Write tools execute immediately and are stamped `actor:'ai:<name>'` by the
  handler — a store function can't forget to attribute itself.
- **Documents are the exception**: agents never write blocks directly; they call
  `propose_document_patch` and the human accepts/rejects in the web app.
- **Delete tools** exist for tasks, objectives, sources, insights, and decisions
  — immediate but attributed; skills tell agents to confirm before destructive
  changes. `delete_document` and `delete_workspace` are **not** exposed to agents:
  a document is co-owned (patch-gated) and a workspace delete is a tree-wide
  cascade, so both stay human-only in the web app.
- Agents `capture` rather than invent structure when the destination is unclear.

---

## Orientation `[SPINE]`

| tool | does |
|---|---|
| `get_schema` | the object model, per-type vocabularies, and the product's rules |
| `open_workspace(path)` | resolve `Life → Build → et al.` to a workspace + its summary, and set it as primary context |
| `get_home` | Daily 3, workspace health, inbox count, recent activity |

## Context engine `[SPINE]`

| tool | does |
|---|---|
| `build_context(workspace_id, query?, depth?)` | assemble the context package: Layer 1 (workspace + inherited ancestors, objectives, open tasks, documents, recent decisions) + Layer 2 (1-hop relationships + top-k vector matches). `[DEFER]` Layer 3 global recall. |

## Workspaces `[SPINE]`

`list_workspaces` · `get_workspace` · `create_workspace(parent_id, type, title)` ·
`update_workspace` · `move_workspace(id, new_parent_id)` (cycle-checked).

## Objectives `[SPINE]`

`list_objectives(workspace_id)` · `create_objective` · `update_objective` ·
**`plan_objective(objective_id)`** *(intent)* — propose a task tree from an
objective for the user to confirm.

## Tasks `[SPINE]`

`list_tasks(workspace_id, filters)` · `create_task` · `update_task` ·
`complete_task`.

## Daily 3 `[SPINE]`

| tool | does |
|---|---|
| `get_daily3(date?)` | the three slots + status/streak |
| `set_daily3([task_id,task_id,task_id])` | set/replace the slots (before lock) |
| `confirm_daily3(date?)` | lock the day |
| `suggest_daily3()` *(intent)* | propose 3 tasks using priorities, deadlines, dependencies, momentum, and workspace health; returns proposals for the user to review/swap/confirm — never auto-confirms |

## Inbox, Sources, Insights `[SPINE]`

| tool | does |
|---|---|
| `capture(kind, payload)` | save a raw input to the inbox immediately (Source, `raw` immutable) |
| `list_inbox()` | unprocessed sources |
| `get_source(id)` | source + parsed text/metadata |
| `create_insight(...)` / `list_insights` / `get_insight` | knowledge nodes |
| `process_inbox(source_id)` *(intent)* | read a source and **propose** insights, a workspace placement, and relationships for approval |

## Documents `[SPINE]`

| tool | does |
|---|---|
| `get_document(id)` / `list_documents(workspace_id)` | |
| `get_blocks(document_id)` | ordered blocks |
| `propose_document_patch(document_id, ops, summary)` *(intent)* | submit a git-style patch → surfaces as Accept/Reject in the web app. **The only way an agent changes a document.** |
| `get_document_patches(document_id)` | pending/resolved patches |

Direct block writes (`write_blocks`) exist in the store for the **human** web app
and REST, but are **not exposed to MCP** — agents must go through patches.

## Decisions `[SPINE]`

`list_decisions(workspace_id)` · `record_decision(...)` (immutable once written).

## Knowledge graph `[SPINE]`

`relate(source, target, type)` · `get_backlinks(type, id)` ·
`list_relationships(id)`.

## Search `[SPINE]`

`search(query, {types?, workspace_id?})` — FTS now, hybrid `[DEFER]`.

## Health & review

| tool | does |
|---|---|
| `get_workspace_health(workspace_id?)` `[SPINE]` | the dumb activity/flow score |
| `weekly_review()` *(intent)* `[SPINE]` | returns raw material — stalled projects, untriaged inbox, completed work, health — for the agent to walk through |
| `get_agent_activity()` `[SPINE]` | everything written by `actor:'ai:*'` |

## Deferred intent tools

- `generate_resume(scope)` `[DEFER]` — pull real tasks/decisions/insights → bullets, provenance preserved.
- `review_architecture(workspace_id)` `[DEFER]`.
- Layer-3 global recall inside `build_context` `[DEFER]`.

---

## A canonical agent loop

1. `open_workspace("Life → Build → et al.")` to orient and set context.
2. `build_context(workspace_id, query)` before reasoning about anything.
3. `capture` new inputs immediately; `process_inbox` proposes structure for approval.
4. Propose typed records with the `create_*` tools; `propose_document_patch` for docs.
5. `relate` results so applied knowledge becomes visible.
6. `suggest_daily3` / `weekly_review` for planning and reflection — always
   proposing, never auto-confirming.
