# et al. v6 — Implementation Plan

**Status:** approved direction, pre-code. Supersedes `docs/v6-redesign.md` (the
five-pillar sketch) and reframes the ambitions of
`docs/Life_Organization_System_Product_Specification.pdf` (the "Life Organization
System" spec) onto the existing Cloudflare stack rather than the Postgres/Next
stack that spec recommended.

This document is meant to be executable by another developer without re-reading
the PDF: it restates every decision, maps the spec's object model to concrete D1
tables, and lists the work phase-by-phase with the files each touches.

---

## 1. Locked decisions

These came out of the architecture review (`/.lavish/v6-architecture-review.html`):

| # | Decision | Choice | Consequence |
|---|---|---|---|
| A | **Data store** | **D1 is canonical** (not a derived index). R2 → assets + Markdown export/snapshots. | The spec's §6.2 objection was to *markdown-as-sole-truth*, not to D1. D1 is real relational SQL, so we keep Cloudflare. |
| B | **Semantic search** | **Cloudflare Vectorize** + D1 FTS5 (hybrid ranking). | The only genuine `pgvector` substitution. |
| C | **Backend** | **Cloudflare Worker, kept.** Drizzle (D1 dialect) replaces hand-rolled SQL where it earns its keep. | Evolution, not rebuild. Migrations machinery, R2 binding, MCP surface all carry over. |
| D | **Async work** | **Cloudflare Queues + a consumer Worker.** | Transcription, extraction, embeddings run off the request path. |
| E | **Web client** | **Next.js static export, co-deployed from the Worker's `[assets]` binding** — one origin. | The dense block-editor workspace outgrows server-rendered HTML strings. Co-deploy (not Pages) because it is an **auth** decision: see below. |
| F | **AI pipeline** | **Claude structured tool-use.** Auto-approve **only** high-confidence *metadata* (tags, type hints); every canonical record stays a reviewable proposal. | Matches spec §3.2 "AI proposes, user approves" with the one allowance in §7.9. |
| G | **Block editor** | **Port the existing `ui.ts` block model**, don't adopt TipTap/Lexical. | We already own a working block parser/serializer; product-specific blocks extend it. |

### Why co-deploy, not two origins (Decision E)

The client could have shipped to Pages and called the Worker cross-origin. That
would have been an auth change disguised as a hosting change:

- `Access-Control-Allow-Origin: *` and credentials are **mutually exclusive** per
  the fetch spec, so the wildcard would have to become an echoed allowlist.
- The `et_al_session` cookie would need `SameSite=None; Secure`, which is exactly
  the attribute that currently makes CSRF a non-issue — so CSRF tokens or strict
  origin checks would have to be added back.
- Every mutation would pay a preflight `OPTIONS` round-trip.

Co-deploying buys all of that back for free: same origin, cookie stays
`SameSite=Lax`, zero CORS configuration, no preflight.

**Mechanism.** `wrangler.toml` points `[assets]` at `client/out` (Next
`output: "export"`). `run_worker_first = ["/api/*", "/mcp", "/mcp/*", "/health"]`
sends those paths to the Worker; everything else falls through to the static
bundle, and `not_found_handling = "single-page-application"` serves the app shell
for client-side routes. Verified against the shipped `wrangler/config-schema.json`
rather than from memory.

**If this is ever reversed** — pointing the client at an absolute API origin —
all three items above must be done together. `client/lib/api.ts` carries a note
saying so, because using relative paths is what silently keeps this working.

**A third option exists** if a custom domain is ever added: two deployments can
still share one origin by routing `example.com/api/*` to the Worker and
`example.com/*` to the client. That is not possible across `*.workers.dev` and
`*.pages.dev`, which is why it is not the current choice.

### What this explicitly is NOT

- Not a Postgres migration. Not a Next-only rewrite that discards the Worker.
- Not a from-scratch data layer: the D1 migration + FTS + link-resolution
  machinery in `store.ts` is the template we extend.
- MVP excludes (spec §7.3): full graph editing, calendar/habits, real-time
  collaboration, automated social publishing, project dependencies, arbitrary
  user schemas, dozens of block types.

---

## 2. Architecture at a glance

```
Next.js (Cloudflare Pages)          ← Decision E: dense workspace client
   │  JSON over /api/*
   ▼
Cloudflare Worker (src/index.ts)    ← Decision C: kept, becomes JSON API
   ├── D1  (canonical relational)   ← Decision A: ~15 typed tables
   ├── Vectorize (embeddings)       ← Decision B
   ├── R2  (assets, exports, snaps) ← demoted from source-of-truth
   ├── Queues → consumer Worker     ← Decision D: transcribe/extract/embed
   └── MCP server (src/mcp.ts)      ← carried over, new tools added
```

Data-flow inversion vs today:

- **Today:** write → serialize markdown → `R2.put()` → derive D1 index row.
  (`store.ts` `createPage` / `indexPage`.)
- **v6:** write → D1 transaction across typed tables → enqueue embedding job.
  Markdown is produced **only** on export (`/api/export`), read back only on
  import. `reindex()` becomes an *export/verify* tool, not the recovery path.

---

## 3. The object model → D1 tables

The spec's ~15 entities (PDF §2, §6.6) map to D1 tables. Types/statuses stay as
`const` arrays + zod (the pattern already in `markdown.ts`), one enum per type
instead of the current shared five-type/five-status pair.

| Spec entity (§2) | D1 table | Key columns / lifecycle |
|---|---|---|
| Life Area (§2.2) | `areas` | name, icon, accent, `status: active\|inactive` |
| Goal (§2.3) | `goals` | title, `type: outcome\|habit\|identity`, timeframe, metric, `area_id` |
| Project (§2.4) | `projects` | title, summary, `status: idea\|planned\|active\|paused\|completed\|archived`, `next_action`, dates, `body_document_id` |
| — Project↔Area | `project_areas` | join (many-to-many, §2.11) |
| — Project↔Goal | `project_goals` | join |
| Project Log Entry (§2.5) | `project_logs` | `project_id`, `entry_type: progress\|decision\|experiment\|problem\|learning\|reflection`, `content_seed_status`, `body_document_id` |
| Knowledge Note (§2.6) | `knowledge_notes` | title, `note_type`, `mastery: captured\|learning\|understood\|applied`, `ai_sections`, `body_document_id` |
| Capture (§2.7) | `captures` | `raw_input` (immutable), `input_type`, `processing_status`, `classification`, `review_status`, `proposal_bundle_id` |
| Tool (§2.8) | `tools` | name/url, `status: saved\|shortlisted\|testing\|tested\|adopted\|rejected`, `expected_use`, `verdict`, `rating` |
| Source (§2.9) | `sources` | title/url, `platform`, `transcript`, `summary`, `capture_id`, `processing_version` |
| Content Item (§2.10) | `content_items` | title, `status: idea\|draft\|review\|scheduled\|published\|archived`, `format`, `channel`, `body_document_id` |
| Documents/Blocks (§2.12) | `documents`, `document_blocks` | ordered block JSON — the ported editor's model |
| Relations (§2.11) | `relations` | generic `source_type/id → target_type/id`, `relation_type` |
| Proposal bundle (§3.2) | `proposal_bundles`, `proposed_changes` | preview + granular approve |
| Audit (§6.4) | `audit_events` | which proposal created/modified each record |
| Async | `processing_jobs` | idempotency key, versioning, partial-failure retry |

**Documents vs records** (spec §2.12, §5.1): typed metadata lives in the tables
above; expressive writing lives in `documents` → ordered `document_blocks`. A
project/note/log points at its `body_document_id`. Generic blocks (paragraph,
heading, list, checklist, code, quote, callout, image, table) plus
product-specific blocks (Decision, Experiment, Learning, Content Seed, Relation,
Tool Card, Project Log) — the latter are the ported editor's extensions.

**Carry-over from current schema:** `areas` is the evolution of today's `spaces`
table (folders-as-context survives as Life Areas); the `relations` table
generalizes today's `links` table (parent + inline wikilink); FTS5 (`pages_fts`
→ `documents_fts`) carries over almost verbatim.

---

## 4. AI proposal pipeline (Decision F — the defining bet)

Pipeline (spec §6.4), each step an idempotent queue job keyed by capture id +
`processing_version`:

```
capture → save immutable raw → detect type → fetch/transcribe/parse
        → Claude structured extraction (schema-validated)
        → match existing (dedupe: FTS + Vectorize nearest-neighbour)
        → build proposal_bundle → USER REVIEW
        → transactional write of approved proposed_changes + audit_events
        → enqueue embedding job → Vectorize upsert
```

Non-negotiables to enforce in code (spec §3.2, §6.4):

1. `captures.raw_input` is write-once; processing never mutates it.
2. Claude output validated against a zod schema **before** any `proposed_change`
   row is created (reject-and-retry on mismatch).
3. Confidence < threshold → `review_status = pending`, never auto-applied.
   Auto-apply is allowed **only** for metadata proposals flagged high-confidence
   (Decision F) — records always wait for the user.
4. AI-generated document blocks/sections carry an `ai: true` flag so the UI can
   label them (spec §2.6 `ai_sections`, §5.10 "labels in text, not icon alone").
5. Every write records the originating `proposal_bundle_id` in `audit_events`.

Model: `claude-sonnet-5` for extraction/classification via the Anthropic SDK
with tool-use for the structured schema. (Confirm current model ids against the
`claude-api` skill before wiring.)

---

## 5. Build phases

Ordered to keep a working system at every step. Each phase is a shippable slice.

### Phase 1 — Foundation ✅ COMPLETE

Delivered:
- `migrations/0007_v6_schema.sql` — all 20 tables; drops the v5
  `pages`/`spaces`/`links` schema rather than converting (vault wiped).
- `src/schema.ts` — Drizzle table definitions (D1 dialect) + the per-entity
  lifecycle vocabularies, replacing the shared `TYPE_KEYS`/`STATUS_KEYS`.
- `src/store/` — the monolithic `store.ts` split per entity: `db.ts` (bindings,
  validation, audit, FTS), `documents.ts`, `areas.ts`, `goals.ts`, `projects.ts`,
  `logs.ts`, `notes.ts`, `relations.ts`, `tools.ts`, `sources.ts`, `content.ts`,
  `captures.ts`, `search.ts`.
- `src/api.ts` — resource registry + the `/api/home` and `/api/review` aggregates.
- `src/index.ts` — Worker routes rewired to the typed model.
- `src/mcp.ts` — MCP tools rewritten in the typed vocabulary, with the product's
  rules stated in the tool descriptions.
- `src/status.ts` — interim root page (the v5 UI is retired; see below).
- Multi-tenant: `user_id` on every table from day one (spec §6.8), while auth
  stays the existing cookie/api-key model.

Rules enforced in the store and verified against a running Worker:
- an `active` project without a `next_action` is **rejected** (400);
- a tool reaching `tested`/`adopted`/`rejected` without a written **verdict** is
  rejected; shortlisting without `expected_use` is rejected;
- `captures.raw_input` is write-once — `updateCapture` exposes no path to it;
- every write records an `audit_events` row (status changes carry `from`/`to`);
- unresolved `[[wikilinks]]` resolve automatically when the target is created;
- AI-authored blocks persist an `is_ai` flag.

**Retained-not-wired:** `src/ui.ts` and `src/markdown.ts` are kept as the port
sources for Phase 3 (block editor) and Phase 6 (Markdown export). Both carry a
header saying so. Their v5 constants are superseded by `src/schema.ts`.

### Phase 2 — Capture & Inbox ✅ COMPLETE

Delivered:
- `src/store/jobs.ts` — durable job records. **The `processing_jobs` table, not
  the queue, is the system of record**; a queue message is only a trigger, so a
  lost message delays work but never drops it.
- `src/store/assets.ts` — R2 payloads for image/audio/file captures, with the
  D1 `assets` row canonical and the object as its payload.
- `src/ingest.ts` — deterministic metadata extraction: oEmbed where a provider
  offers it (YouTube, TikTok), HTML/OpenGraph parsing otherwise, byte-capped and
  timeout-bounded. No AI — that is deliberately Phase 4.
- `src/pipeline.ts` — `runJob` (named stages, never throws, always records the
  outcome) and `sweepJobs` (the cron safety net).
- `src/index.ts` — `queue()` consumer and `scheduled()` cron handlers, plus
  `/api/captures/upload`, `/api/captures/{id}/retry`, `/api/jobs`,
  `/api/jobs/sweep`, `/api/jobs/{id}/retry`, `/api/assets/{id}`.
- `wrangler.toml` — `et-al-jobs` queue producer/consumer + a 5-minute cron.
- MCP: `get_capture_status`, `retry_capture`.

Guarantees, verified against a running Worker:
- a capture is durable and confirmed **before** any processing (spec §3.1);
- a failed fetch leaves `raw_input` intact and the capture still reviewable —
  verified with a real 404: status `failed`, `failure_stage: fetch`, raw input
  byte-identical;
- retry creates **no duplicate capture and no duplicate job** (the existing job
  is reset, since the idempotent key would otherwise return the spent job);
- idempotency holds: re-running a succeeded job produces no second Source;
- `failed`/`running` jobs are only swept after a stale window, which doubles as
  backoff against a permanently broken URL and avoids stealing a job from a
  merely-slow Worker;
- text captures complete without fabricating a Source; uploads round-trip
  through R2; YouTube captures resolve real title and author via oEmbed.

**Not yet done here (by design):** transcription and AI classification. A
`classification` on a capture stays null until Phase 4 — an explicit gap rather
than a half-built guess.

### Phase 3 — Projects, logs, knowledge, relations
- Project lifecycle + **next-action enforcement** (active project rejects save
  without `next_action` — spec §3.3).
- Typed `project_logs`, `knowledge_notes` with mastery, `relations` (typed joins
  + generic semantic links), backlinks (generalize today's `getBacklinks`).
- **Port the block editor** (Decision G): lift `parseBlocks`/`serializeBlocks`/
  `renderInline` from `ui.ts` into a shared `src/blocks.ts`, add the
  product-specific block types, persist as `document_blocks` JSON.
- **Exit:** the daily-driver workspace exists.

### Phase 4 — AI proposal pipeline (the defining bet)
- Extraction jobs, zod-validated Claude tool-use, dedupe via Vectorize + FTS.
- `proposal_bundles` / `proposed_changes`, granular approval endpoint,
  transactional apply + `audit_events`.
- **Exit:** the prototype scenario (save a video → propose tool + 2 notes →
  approve selected → link project) runs end-to-end (spec §7.4).

### Phase 5 — Tools, content seeds, hybrid search, weekly review
- Test-Later lifecycle + verdict prompts (spec §3.6).
- Work→content pipeline: log/tool/note → `content_items` seed (§3.7).
- Hybrid ranked search (exact + filter + relation + semantic, §3.9, §6.5).
- Guided weekly review sequence (§3.8).
- **Exit:** the full transformation loop is usable.

### Phase 6 — Export, mobile, Identity Studio (stretch)
- Markdown/R2 export + snapshots (spec §6.3) — the *only* place markdown is now
  written; `reindex()` becomes export/verify.
- Expo capture companion (spec §5.8).
- Identity Studio evidence map (§3.10). Analytics events (§7.7) + scenario test.

---

## 6. Risks & open questions

**Risks (spec §7.8, plus stack-specific):**
- *AI fills the system with low-quality notes* → confidence routing + dedupe +
  visible AI labels (Phase 4 non-negotiables). This is the top product risk.
- *Inbox becomes another backlog* → fast bulk-accept + weekly cleanup.
- *D1 write-transaction limits* — proposal apply writes many rows atomically;
  D1 supports `batch()` but verify size limits during Phase 4 against the
  largest realistic bundle.
- *Vectorize + D1 consistency* — embeddings live outside D1, so a record can
  exist before its vector. Treat vector presence as best-effort; never gate a
  read on it.

**Open questions to resolve before/within each phase:**
1. Next.js on Pages vs a lighter React SPA served by the Worker — Decision E
   picked Next on Pages; confirm the Pages+Worker binding story (does the Next
   app call the Worker cross-origin, or co-deploy?) before Phase 3 client work.
2. Drizzle everywhere vs Drizzle-for-writes + raw SQL for the hybrid-search
   query — decide in Phase 5 when the search query shape is known.
3. Task depth (spec §7.9): simple checklist blocks only (reuse `todo` block) vs a
   `tasks` table. Default: checklist blocks in MVP; revisit if dependencies are
   needed.
4. Whether the MCP surface exposes proposal review or stays read/write CRUD only
   — Phase 4 decision.

---

## 7. Status and next step

**Phases 1 and 2 are complete and deployed.** Migration `0007` has been applied
to remote D1 and the v6 Worker is live. The v5 markdown files remain untouched in
the R2 vault — a D1 migration is SQL against D1 and cannot modify R2 — and the
pre-migration D1 rows are dumped under `.backups/` (gitignored).

Defects found and fixed during verification, worth remembering:
- `rebuildSearchIndex` used a 6-branch `UNION ALL`, which D1 rejects ("too many
  terms in compound SELECT"). It now queries per entity.
- The same function deleted the FTS table *before* gathering rows, so the failure
  above left search silently empty. It now gathers first, then swaps.
- `resetForRetry` originally only cleared the capture's status. Because the job
  key is idempotent per pipeline version, a re-enqueue would have returned the
  spent job and silently done nothing; it now resets the existing job.

**Next: Phase 3 (Projects, logs, knowledge, relations + the block editor port).**
Two things to settle first:
1. The client decision (Next.js on Cloudflare Pages) means deciding whether the
   Next app calls the Worker cross-origin or co-deploys — resolve before the
   client work starts.
2. Verify current Claude model ids (via the `claude-api` skill) before wiring
   extraction in Phase 4; this document names `claude-sonnet-5` provisionally.

Housekeeping: the pre-v5 `items` / `items_fts*` tables still sit in remote D1
(27 rows, unused since v5). They are harmless and are the oldest copy of the
original data, so they have been left alone rather than dropped.
