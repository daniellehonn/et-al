---
name: et-al
description: Work with the user's et al. knowledge base — notes, tasks, and saved sources — over MCP. Use whenever the user asks you to capture something, write something up, plan work, or find what they saved. Load before any other et-al-* skill.
---

# et al.

A knowledge base one person owns and agents work in. It holds **notes** (what
they write), **tasks** (what they're doing), and **sources** (what they saved).
You operate it from outside, over MCP, and every write you make is attributed
to you.

## Connecting

```
URL:           https://et-al.daniellehonnn.workers.dev/mcp
Authorization: Bearer <ET_AL_API_KEY>
x-mcp-client:  <your name, e.g. claude-code>   (becomes the actor on your writes)
```

Call `get_schema` first if you are unsure of a field.

## What you may do

The trust model is enforced by the server, not by you remembering it:

| You can | Directly | Only by proposing | Not at all |
|---|---|---|---|
| Notes | create (empty), rename, move | change the body: `propose_note_patch` | delete |
| Tasks | create, update, delete | | |
| Sources | capture, file into a note | | |
| Proposals | list | | accept or reject |

A proposal waits for the user in the web app. Tell them it is there; do not
describe it as done.

## Orient before you write

- `search` before creating anything. The same idea written twice under
  near-identical titles is how a knowledge base rots. Prefer proposing an
  addition to an existing note.
- `get_note_tree` shows where things live; put a new note where it belongs.
- `build_context` on a note gives you its ancestors, body, child notes, open
  tasks, filed sources and related material in one call. Use it before
  proposing changes to a note.

## Writing a note

1. `create_note` with a title (and `parent_id`). It is created empty.
2. `propose_note_patch` with `[{op: "replace_content", content: "<markdown>"}]`.
   Headings, bullets (indent to nest), numbered lists, `- [ ]` todos, quotes,
   fenced code and pipe tables all parse.
3. Tell the user the patch is waiting for them.

To edit part of an existing note, `get_note` for block ids and propose
`update` / `insert` / `delete` ops rather than rewriting the whole body.

## Rules about you

- **Never write the user's understanding for them.** You may draft an
  explanation of a concept; how they applied it, what they think, what they
  decided — those are theirs to write.
- **When unsure, capture.** `capture` is cheap and reversible. A note is a
  commitment. If the destination is not obvious, capture and say what you would
  have made.
- **Confirm before `delete_task`.** It takes subtasks with it.

## Related skills

- `et-al-inbox` — work through what the user has saved
- `et-al-digest` — turn a saved source into notes
