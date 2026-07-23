---
name: et-al
description: Work with the user's et al. personal operating system — projects, engineer logs, knowledge notes, tools under test, sources, and content. Use whenever the user asks you to capture something, record project work, write up what they learned, track a tool, or turn their work into content. Also use before any other et-al-* skill.
---

# et al.

A personal operating system for one person. It turns what they save, learn, and
build into finished projects, connected knowledge, and content worth sharing.

The loop it exists to serve:

```
Capture → Organize → Act → Document → Learn → Publish → Reflect
```

It is **not** a notes app. The measure of success is not how much is stored, it
is how often something stored becomes something done: a saved tool becomes a
tested tool, a test becomes a project log, a log becomes a note or a draft.

## Connecting

Tools are exposed by a remote MCP server:

```
URL:           https://et-al.daniellehonnn.workers.dev/mcp
Authorization: Bearer <ET_AL_API_KEY>
```

Start with `get_schema` if you are unsure about a field or a lifecycle value; it
returns the whole object model and every allowed value.

## Orient before you write

Call `get_home` first in any working session. It answers the three questions the
system is built around — what matters now, what to do next, what needs review —
and stops you proposing work that is already underway.

## The object model

| Object | What it is |
|---|---|
| **Life Area** | A long-term identity or responsibility (Software Development, Student). A *filter*, not a folder — one project can belong to several. |
| **Goal** | Measurable direction inside an Area. Answers *why* a project matters. |
| **Project** | A finite effort with an outcome. `idea → planned → active → paused → completed → archived`. |
| **Project log** | A dated entry on a project: `progress`, `decision`, `experiment`, `problem`, `learning`, `reflection`. |
| **Knowledge note** | A durable explanation. Mastery: `captured → learning → understood → applied`. |
| **Capture** | Immutable raw input, saved before its destination is known. |
| **Tool** | Something to test. `saved → shortlisted → testing → tested → adopted/rejected`. |
| **Source** | External material consumed — video, article, paper. Distinct from the knowledge made from it. |
| **Content item** | `idea → draft → review → scheduled → published`. |

## Rules the system enforces

These are rejected server-side, so respect them up front rather than discovering
them as errors:

1. **An active project must have a `next_action`** — the next physical, visible
   step. If you cannot name one, use `planned`, not `active`.
2. **A tool needs a written `verdict`** before `tested`, `adopted`, or
   `rejected`. What worked, what failed, would they use it again. A star rating
   is not a verdict. Shortlisting needs an `expected_use`.
3. **Captures are immutable.** `raw_input` can never be edited. Triage resolves a
   capture; it never rewrites it.
4. **Publishing content requires a `published_url`.**

## Rules about you

The user's own understanding is the point of the system. Protect it.

- **Never write the user's explanation for them.** On a knowledge note, "My
  explanation" and "Where I applied it" are theirs. You may draft the
  plain-language explanation, how-it-works, and examples.
- **Label everything you generate.** Set `is_ai: true` on blocks you wrote, and
  record generated sections in a note's `ai_sections`. A generated summary must
  never be mistaken for demonstrated understanding.
- **Never advance `mastery` on the user's behalf.** A note becomes `understood`
  when *they* can explain it, not when you wrote a good summary. Suggest it;
  let them confirm.
- **Check for duplicates before creating.** Use `find_note_by_title` and
  `search` first. The same concept written twice under near-identical titles is
  the main way a knowledge base rots.
- **Every write you make is attributed.** The MCP server records `actor: 'ai'`
  automatically; `get_agent_activity` shows what you did. Do not work around it.

## When unsure, capture

`capture` is cheap and reversible. A typed record is a commitment. If the
destination is not obvious, capture the raw input and say what you would have
created — do not invent structure the user did not ask for.

## Common sequences

**Record something they just did**
`get_home` → `add_log` (pick the entry type) → `open_body` → `write_body`

**They learned a concept**
`find_note_by_title` → `create_note` (mastery stays `captured`) →
`open_body` → `write_body` → `relate` it to the project it came from

**They found a tool**
`save_tool` with `expected_use` → later `update_tool` to `testing` →
finally `update_tool` to `tested` **with a verdict**

**Turn work into content**
`list_logs` or `list_tools` for real material → `create_content_seed` with the
origin so provenance is preserved → `open_body` → `write_body`

## Connecting things

Use `relate` for meaning-bearing links: `learned-from`, `used-in`,
`prerequisite-of`, `inspired-by`, `created-from`, `mentions`. Linking a note to
the project it was used in is what turns "captured" into demonstrable applied
knowledge.

Inside document text, `[[Title]]` creates a link. It resolves automatically if
the target exists, and stays a live "growth edge" (see `list_unresolved_links`)
until it is created.

## Related skills

- `et-al-inbox` — process the capture queue
- `et-al-digest` — turn a source into knowledge notes
- `et-al-review` — run the guided weekly review
