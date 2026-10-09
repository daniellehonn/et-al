# Design log

The decisions that shaped et al., newest model first. Each says what the
problem was, what was decided, and what it cost. The code is the reference for
*what*; this is the record of *why*.

## How it got here

et al. was rebuilt five times in its first three weeks, and the rebuilds are
the most useful part of the story.

| Version | Model | What it taught |
|---|---|---|
| v2–v5 | Markdown files in R2, with D1 as a derived index | A file tree is a poor database: every query was a rebuild. |
| v6 | D1 canonical; AI moved *out* of the platform | The platform should hold the data, not the reasoning. |
| v7 | Seven typed entities (workspace, objective, task, document, source, insight, decision) | Typed is right; seven types, each with its own UI tab, was too many. |
| v8 | A Notion clone: pages, collections, typed properties, five view types | Flexible structure, but meaning had to be smuggled back in (see below). |
| v9 | Five fixed things: note, task, source, proposal, event | This one. |

From v8 to today, about 8,200 lines of application code were deleted and 2,800
written — 5,300 fewer — while the test suite and the eval were added. The rest
of this log is mostly about what that made possible.

---

## Agents reason outside; the platform holds the data

**Problem.** An app with an LLM inside it owns your data *and* decides what to
do with it. Every new model or agent means changing the app.

**Decision.** et al. is not an agent. It is the store and the rules; agents
connect from outside over MCP and do their reasoning there. Every agent write
runs under a context whose actor is `ai:<client>`, set by the transport from
the `x-mcp-client` header, so a write cannot forget to attribute itself.

**The one exception** is extraction: when a link is saved, Workers AI reads it
and suggests facts. It is allowed because it can only *propose* — the same gate
as an agent — and because it runs on a Cloudflare binding, so no model vendor
key lives in the Worker.

## Facts are written; prose is proposed

**Problem.** An agent that can rewrite your notes will, eventually, rewrite one
you cared about. An agent that can do nothing is useless.

**Decision.** Split by what a write *is*. A task's status, a note's title or
place in the tree, filing a saved link: these are facts, cheap to change back,
and agents write them directly. A note's body is the user's prose, so an agent
can only propose a change to it. Resolving a proposal, and deleting a note, are
not in the MCP surface at all.

**Consequence.** The trust model is enforced by omission in
[`src/mcp.ts`](../src/mcp.ts), and tested: a test fails if any tool that touches
a body, a block or a proposal is anything other than a read or a proposal.

## Proposals get their own table

**Problem.** In v8 an extracted insight was a page with `proposed: true`, kept
out of search by a filter. Writing the first test suite showed the filter
wasn't there: the insight's body was indexed on write, and unreviewed
machine-written text came back from search and from the context agents were
given. A rule that depends on every query remembering a filter will be broken
by the next query someone writes.

**Decision.** A proposal is a row in `proposal`, with a `kind` (`patch` or
`insight`) and a payload. It is not a note, it is never indexed, and it becomes
real only when accepted — a patch is applied, an insight becomes a note.

**Consequence.** The invariant moved from the queries into the schema. There is
no filter to forget.

## Cutting the Notion clone

**Problem.** v8's pages-and-collections model let the user shape anything. But
agents need to know what a task list *is*, so every collection carried a `role`,
and the typed surface agents relied on was rebuilt on top of property keys the
user was told not to rename. Structure was the user's; meaning was smuggled
back in. Around it grew five view types, filter and sort editors, nine widget
blocks, career blocks, iMessage, a Daily 3 ritual with streaks and automations
with a hand-written cron parser.

**Decision.** Keep the part that is the idea — a store agents work in under a
trust model — and cut the rest. Three content types with fixed shapes (notes,
tasks, sources), plus proposals and the event log. The schema is one migration.

**Consequence.** The MCP surface went from 57 tools to 18, block types from 30
to 11, tables from 13 (plus 11 legacy) to 7. Everything cut is in git history
under the `v8-final` tag.

## One body engine for preview and apply

**Problem.** A review queue is only as trustworthy as its preview. If the diff
is computed one way and the patch applied another, the two can disagree, and
the reviewer approves something other than what lands.

**Decision.** Block ops are a pure function from one body to the next
([`src/store/body.ts`](../src/store/body.ts)). Previewing a proposal runs it and
diffs the result against the current body — as markdown, with an LCS line
diff. Accepting runs the same function and reconciles the stored blocks to its
output by id. The function throws before anything is written if any op names
a block that isn't there, so a patch applies whole or not at all, and one the
note has moved on from is reported as stale.

**Consequence.** A test proposes edits, takes the preview's "after", accepts,
and checks the stored body equals it. Breaking the preview on purpose makes it
fail. The editor's whole-body save goes through the same reconcile, so there is
one write path for bodies.

**Why LCS and not Myers.** Note bodies are hundreds of lines. The quadratic
table is simple, obviously correct, and gives the minimal diff; Myers' algorithm
earns its complexity on large, similar files.

## Blocks record who wrote them

**Problem.** In v8 an accepted patch was applied under the reviewer's identity,
so text an agent wrote was recorded as the user's. The patch row knew better;
the blocks did not.

**Decision.** Every block stores its `actor`. Accepting writes changed blocks
under the proposer's name. Moving a block is not writing it, so a move keeps
the author. Every content change keeps the replaced version in
`block_revision`, attributed to whoever wrote *that* version, and any revision
can be restored.

## Hybrid search, fused by rank

**Decision.** FTS5 for keywords over notes, tasks and sources; Vectorize for
meaning over notes. The two ranked lists are combined with Reciprocal Rank
Fusion (k = 60). Rank-based on purpose: BM25 is unbounded and cosine similarity
isn't on the same scale, so blending raw scores would just weight one arm
arbitrarily. The vector arm is additive — without the binding, or on any error,
search returns keyword results.

**Found on the way.** In v8 the vector arm read from a table the v8 migration had
renamed. The query threw, the error was swallowed by the "additive" guard, and
production search had silently been keyword-only. The guard is still right;
it now has a test that fails if the vector arm stops contributing.

## Extraction is measured, not assumed

**Decision.** At most three facts per source, as proposals: the ceiling on what
reaches the user is what they accept, not what a model produces. And an eval
([`eval/`](../eval/)) runs the real extractor over 20 fixtures — 15 with
expected facts, 5 (a cookie wall, a promo, a nav page…) with nothing durable —
and reports recall, precision and noise.

**What it found.** The first run scored 62% recall, with five clearly
substantive texts producing no facts. A guess (the output token limit) was
tested and was wrong. Making the extractor report *how* each call went — facts,
none, unparsable, error — instead of collapsing failures into "nothing found"
showed every empty result was unparsable: a stray brace, a stray quote, an
unescaped quote copied from the page. About a third of real captures had been
silently losing every suggestion. Extraction now uses schema-constrained
decoding, so the reply is valid by construction. Recall: 79–85% over two runs;
precision 84%; no facts invented from the pages with nothing in them.

## A capture pipeline that fails visibly

**Decision.** Saving is cheap and idempotent: an `Idempotency-Key` returns the
first capture on retry (a unique index settles a race), and a link already
waiting in the inbox is returned rather than saved twice. Fetching happens on a
queue, once per link, and that one response gives the source its preview, its
index entry and its extraction. A failed fetch records why and can be retried;
on its last attempt the queue marks the source failed instead of leaving it
"pending" forever.

## Tests run in the real runtime, at the edge

**Decision.** Vitest with `@cloudflare/vitest-plugin` runs inside `workerd` with
a real D1 and every migration applied. Tests call `/api` and `/mcp` the way the
app and agents do, rather than store functions. A dedicated `test` environment
declares no Workers AI or Vectorize binding, so tests never spend money or
reach production; tests that need a model pass a fake one in.

**Consequence.** The suite was written against v8, before the rewrite. The auth
tests carried over with only their routes changed; the trust and proposal tests
were rewritten for the new model but check the same rules, and their failures
during the rewrite were how gaps in it were found (a patch that could half-apply,
an accepted edit recorded under the wrong author).

## Every read needs a key

**Problem.** Until v9, reads were open and only writes needed the API key — so
anyone with the URL could read everything.

**Decision.** Every `/api` route and `/files/*` requires the key or the session
cookie. The web app exchanges the key once for an `HttpOnly`, `SameSite=Lax`
cookie, so the browser never holds the key in script. Files are served
`Cache-Control: private` so no shared cache can hand them to someone else. The
app and API share one origin, which is what lets the cookie work without CORS.
