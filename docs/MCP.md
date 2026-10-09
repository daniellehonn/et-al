# MCP tools

```
URL:            https://<your-worker>/mcp        (Streamable HTTP, JSON-RPC 2.0)
Authorization:  Bearer <ET_AL_API_KEY>
x-mcp-client:   <your client's name>              (becomes the actor: ai:<name>)
```

Eighteen tools. What is *not* here is as deliberate as what is: there is no tool
that writes a note's body, accepts or rejects a proposal, or deletes a note.
Those belong to the user and exist only in the web app's REST API. A test fails
if a tool is added here without a section below.

Bad input comes back as an error naming the field, e.g. `title: Too small`.

## Orient

### `get_schema`
How et al. is organised and what an agent may do in it. Read first.

### `search`
`{ query }` — notes, tasks and sources. Keyword (FTS5) and meaning (Vectorize)
results fused by rank. Proposals are never indexed, so never returned.

### `build_context`
`{ note_id, query? }` — everything needed to work on a note in one call: the
note, its ancestors, its body, child notes, open tasks, filed sources, and
related material for the query (or the note's title).

### `get_note_tree`
Every note, nested. Titles and ids only.

### `get_note`
`{ id }` — the note, its ancestors, its body as markdown (to read), and its
blocks with ids (to target with granular patch ops).

### `get_agent_activity`
Recent writes by agents and the extractor, newest first, with what each was.

## Notes

### `create_note`
`{ title, parent_id? }` — an empty note. Its body arrives by proposal.

### `update_note`
`{ id, title }` — rename.

### `move_note`
`{ id, parent_id? }` — re-parent; omit `parent_id` for the root. Cycle-checked.

### `propose_note_patch`
`{ note_id, ops, summary }` — propose a change to a note's body. Ops:

| op | shape |
|---|---|
| `replace_content` | `{ content: "<markdown>" }` — headings, nested bullets, numbered, `- [ ]` todos, quotes, fenced code, pipe tables |
| `insert` | `{ type, content: { text }, after?, parent? }` |
| `update` | `{ id, content: { text }, type? }` |
| `delete` | `{ id }` — and everything nested under it |
| `move` | `{ id, after?, parent? }` |

The patch is dry-run against the note when proposed, so an op naming a block
that isn't there fails for the agent, not the reviewer. When accepted it is
written under the agent's name, all of it or none of it.

## Tasks

### `list_tasks`
`{ note_id?, open? }` — next to do first: in progress, then by due date.

### `create_task`
`{ title, parent_id?, note_id?, due_at? }` — `due_at` is unix ms; `parent_id`
makes a subtask.

### `update_task`
`{ id, title?, status?, due_at?, note_id? }` — status is `todo | doing | done`.

### `delete_task`
`{ id }` — with its subtasks. Confirm with the user first.

## Capture

### `capture`
`{ url?, text?, title?, note_id?, key? }` — save to the inbox now. A link is
fetched in the background and may produce proposed insights. `key` makes
retries safe; a link already waiting in the inbox is returned as
`already_captured: true` rather than saved twice.

### `list_inbox`
Captured sources not yet dealt with, newest first.

### `file_source`
`{ id, note_id?, title?, status? }` — file into a note (which clears it from the
inbox), retitle, or mark `done`.

### `list_proposals`
`{ note_id? }` — what is waiting for the user: patches and extracted insights.
Read-only: only the user can resolve them.
