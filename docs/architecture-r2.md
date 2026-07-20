# et al. — R2 Vault Architecture (v4)

This supersedes the D1-as-source-of-truth model. The system is now an
**Obsidian-style markdown vault** stored in an **R2 bucket**, with **D1 demoted
to a disposable, rebuildable index**. Pages are Notion-style block documents that
serialize to markdown; links are `[[wikilinks]]`; backlinks are seamless.

---

## 1. The core inversion

| | Before (v3) | Now (v4) |
|---|---|---|
| Source of truth | D1 `items` table | **R2 markdown files** |
| D1's role | everything | **derived index only** — rebuildable from R2 at any time |
| An item | a table row | **a markdown file** with YAML frontmatter |
| Links | `related` JSON array of UUIDs | **`[[Title]]` wikilinks** in the body + a `parent:` frontmatter link |
| Editing | textarea | **block editor** with `/` slash commands |

**The rule that resolves every conflict:** the bucket wins. D1 is a cache of what
the markdown files say. `POST /api/reindex` throws D1 away and rebuilds it by
reading every object in the bucket. If the two ever disagree, reindex.

Why not pure-R2 with no database? R2 has no query engine — no "list by space",
no full-text search, no "who links here" without scanning every object on every
request. The index gives O(1)-ish queries; making it *derived* keeps the
database-free spirit (you can delete D1 and lose nothing) without the O(n) scans.

---

## 2. File layout in R2

```
{space}/{slug}.md          e.g.  career/ship-the-portfolio.md
identity/{slug}.md               identity/creative-ai-native-dev-identity.md
unsorted/{slug}.md               unsorted/random-thought.md
```

- `space` is the folder: one of `identity, school, career, learning, projects,
  life, saved`, or `unsorted` for unfiled pages (space = null conceptually).
- `slug` is `slugify(title)`. On collision, ` -{id8}` is appended.
- The object key is the page's storage path. It is **derived from space+title**,
  so renaming a page or moving it between spaces **moves the object** (copy+delete).
- The canonical identity of a page across renames is its `id` (a UUID in
  frontmatter). Links, however, are by **title** (the user's choice) — resolved
  title→id at index time.

### File format

```markdown
---
id: 3f9c1a20-...
title: Ship the portfolio
type: goal
space: career
status: active
tags: [portfolio, web]
parent: "[[Creative AI-native dev identity]]"
due: 2026-08-01
created: 2026-07-20T14:03:00Z
updated: 2026-07-20T15:20:00Z
---

The public proof that ties [[Creative AI-native dev identity]] to real work.

## Plan
- [ ] Pick three projects to feature
- [x] Buy the domain

See also [[Resume thoughtmap]].
```

Frontmatter is the metadata; the body is Notion blocks serialized to Markdown.

---

## 3. Frontmatter spec

| Key | Type | Notes |
|---|---|---|
| `id` | UUID | Stable identity. Never changes. Generated on create. |
| `title` | string | Also the link target. Should be unique (see §5). |
| `type` | enum | `page \| goal \| idea \| task \| link` |
| `space` | enum \| absent | folder; absent/`unsorted` = unfiled |
| `status` | enum | `active \| paused \| done \| archived \| inbox` |
| `tags` | string[] | inline `[a, b]` form |
| `parent` | `[[Title]]` \| absent | **the hierarchy link** ("traces to") |
| `due` | date | ISO date, tasks mostly |
| `created` / `updated` | ISO datetime | `updated` is bumped on every write |

We only ever *emit* this subset, so the parser is deterministic. It is also
forgiving for hand-edited files (unknown keys are preserved round-trip in an
`extra` bag so nothing is lost).

---

## 4. Links & backlinks

There are exactly two link kinds, both expressed as `[[Title]]`:

- **`parent` (frontmatter)** — hierarchy, "traces to". Drives `get_children`,
  the Cascade view, and identity tracing. One per page.
- **inline `[[Title]]` (body)** — lateral association. Any number.

**Backlinks** = every page containing a `[[Title]]` that resolves to this page,
via either kind. The index stores each link with the surrounding line as
**context**, so the backlinks panel shows *where* and *why* you're linked —
seamless, like Obsidian's "Linked mentions."

**Unresolved links** — a `[[Title]]` whose title matches no page is kept in the
index with `target_id = NULL`. The UI renders it dashed; clicking it **creates
that page** (Obsidian's "click to create"). This is how the graph grows.

**Rename propagation** — renaming page A→B:
1. move the R2 object to the new slug path,
2. look up every backlink to A in the index (cheap),
3. load each referencing file from R2, rewrite `[[A]]`/`[[A|alias]]` →
   `[[B]]`/`[[B|alias]]`, write it back,
4. reindex the touched files.
Because links are by title, a rename *does* rewrite files — but the index makes
finding them O(1), so it's bounded by the number of actual backlinks.

---

## 5. Index schema (D1, rebuildable)

```
pages(
  id PK, path, title, title_norm, type, space, status,
  tags_json, parent_norm, due, created, updated, body_excerpt
)
links(
  id PK, source_id, target_norm, target_id NULL, kind('parent'|'inline'),
  alias, context
)
pages_fts(id UNINDEXED, title, body)   -- FTS5
```

- `title_norm` = normalized title (lowercase, trimmed, whitespace-collapsed),
  the join key for link resolution. Unique-ish; on duplicate, links resolve to
  the earliest `created` and the index flags a `dup_title` warning.
- Every query the app needs is one indexed SQL statement:
  - list by space → `WHERE space = ?`
  - unsorted bucket → `WHERE space IS NULL`
  - backlinks(X) → `links WHERE target_id = X`
  - children(X) → `links WHERE target_id = X AND kind='parent'`
  - unresolved → `links WHERE target_id IS NULL`
  - search → `pages_fts MATCH ?`

The index carries **no authored data** — everything in it is reproducible from
the markdown. Dropping and rebuilding it is always safe.

---

## 6. Write paths (all funnel through `store.ts`)

**Create / update page**
1. Merge frontmatter, bump `updated`.
2. Serialize `frontmatter + body` → markdown string.
3. If title or space changed → new path; `copy` to new key, `delete` old key,
   and run rename propagation (§4).
4. `PUT` markdown to R2.
5. Re-derive this page's index rows (page row + its links) and upsert; refresh FTS.

**Delete page**
1. `DELETE` R2 object.
2. Remove page row + its outbound links; mark inbound links `target_id=NULL`
   (they become unresolved, not dangling).

**Reindex** (`POST /api/reindex`)
1. `TRUNCATE` the three index tables.
2. `list()` the bucket, `get()` each object, parse, insert page rows.
3. Second pass: resolve every link's `target_norm` → `target_id`.
Idempotent. This is also the recovery path if a write half-failed.

**Legacy migration** (`POST /api/migrate-from-d1`, one-time)
Reads the old `items` table and writes one markdown file per row, converting
`related`/`parent_id` UUIDs into `[[Title]]` links and `metadata.checklist` (if
any survived) into `- [ ]` task lines. Then reindexes. Safe to re-run.

---

## 7. Editor model (the Notion part)

The body is edited as **blocks**. Each block maps to one markdown construct:

| Slash command | Block | Markdown |
|---|---|---|
| `/text` | paragraph | plain line |
| `/h1 /h2 /h3` | heading | `#`, `##`, `###` |
| `/todo` | checkbox | `- [ ]` |
| `/bullet` | bulleted list | `- ` |
| `/number` | numbered list | `1. ` |
| `/quote` | quote | `> ` |
| `/code` | code block | ` ``` ` fence |
| `/divider` | divider | `---` |
| `/callout` | callout | `> [!note]` |
| `/link` or typing `[[` | page link | `[[Title]]` |

- Typing `/` at the start of an empty block opens the **slash menu**.
- Typing `[[` opens **page autocomplete** (fed by `GET /api/pages?fields=title`),
  including a "Create '<query>'" row for new pages.
- `Enter` splits a block; `Backspace` at block start merges up; blocks are the
  editing unit but the wire format is always plain markdown, so files stay
  portable to a real Obsidian vault.
- Saving debounces, serializes blocks→markdown, and `PATCH`es the page. The
  **backlinks panel** re-fetches on save so mentions update live.

The block model is a pure function of the markdown (`parseBlocks` /
`serializeBlocks`), so a file authored in Obsidian opens correctly here and
vice-versa.

---

## 8. What stays the same

- MCP tools remain the agent surface, now operating over the vault. `get_schema`
  still reports the canonical enums (now including `space` folders).
- The identity/Cascade/Constellation model is unchanged conceptually — `parent`
  links replace `parent_id`, `[[wikilinks]]` replace the `related` array.
- Auth (API key → session cookie) is unchanged.
