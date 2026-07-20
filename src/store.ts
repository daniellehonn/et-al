// Storage layer. The R2 VAULT bucket is the source of truth; D1 is a derived
// index. Every write funnels through here so the two stay coherent, and any
// drift is fixable by reindex() (the bucket always wins).

import {
  parsePage, serializePage, extractBodyLinks, rewriteWikiLink,
  normalizeTitle, slugify, pageKey, parentTitleFrom,
  SCHEMA_VERSION, TYPE_KEYS, SPACE_KEYS, STATUS_KEYS, UNSORTED,
  type Frontmatter, type ItemSpace, type ItemType, type ItemStatus, type ParsedPage,
} from "./markdown.ts";

export interface Env {
  DB: D1Database;
  VAULT: R2Bucket;
  ET_AL_API_KEY?: string;
  SECOND_BRAIN_API_KEY?: string;
  APP_NAME?: string;
}

const TYPES = new Set<string>(TYPE_KEYS);
const SPACES = new Set<string>(SPACE_KEYS);
const STATUSES = new Set<string>(STATUS_KEYS);

export const SCHEMA_INFO = {
  version: SCHEMA_VERSION,
  storage: "R2 vault (markdown files) is canonical; D1 is a rebuildable index",
  types: TYPE_KEYS,
  spaces: SPACE_KEYS,
  statuses: STATUS_KEYS,
  null_space: "unsorted — a page with no folder; always visible in the Unsorted bucket",
  space_filters: [...SPACE_KEYS, UNSORTED],
  links: {
    format: "[[Title]] wikilinks (Obsidian-style); [[Title|alias]] supported",
    parent: "the frontmatter `parent:` link — hierarchy, 'traces to'. Drives get_children/Cascade.",
    inline: "any [[Title]] in the body — lateral association. Drives backlinks.",
    unresolved: "a [[Title]] with no matching page; click-to-create in the UI",
  },
};

// The shape returned to API/MCP/UI consumers — an index row plus body.
export interface PageDoc {
  id: string;
  path: string;
  title: string;
  type: ItemType;
  space: ItemSpace | null;
  status: ItemStatus;
  tags: string[];
  parent: string | null; // linked title
  due: number | null;
  created_at: number;
  updated_at: number;
  body: string;
}

interface PageRow {
  id: string; path: string; title: string; title_norm: string;
  type: string; space: string | null; status: string; tags_json: string;
  parent_norm: string | null; due: number | null;
  created_at: number; updated_at: number; body_excerpt: string;
}

// --------------------------------------------------------------------------
// Read helpers
// --------------------------------------------------------------------------

function rowToMeta(row: PageRow) {
  return {
    id: row.id, path: row.path, title: row.title,
    type: row.type as ItemType, space: (row.space as ItemSpace | null) ?? null,
    status: row.status as ItemStatus, tags: safeArray(row.tags_json),
    parent: row.parent_norm, due: row.due,
    created_at: row.created_at, updated_at: row.updated_at,
    excerpt: row.body_excerpt,
  };
}

function safeArray(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

export async function getPageByPath(env: Env, path: string): Promise<PageDoc | null> {
  const object = await env.VAULT.get(path);
  if (!object) return null;
  const parsed = parsePage(await object.text());
  return docFromParsed(parsed, path);
}

export async function getPage(env: Env, id: string): Promise<PageDoc | null> {
  const row = await env.DB.prepare("SELECT path FROM pages WHERE id = ?").bind(id).first<{ path: string }>();
  if (!row) return null;
  return getPageByPath(env, row.path);
}

function docFromParsed(parsed: ParsedPage, path: string): PageDoc {
  const fm = parsed.frontmatter;
  return {
    id: fm.id, path, title: fm.title, type: fm.type, space: fm.space,
    status: fm.status, tags: fm.tags, parent: fm.parent, due: fm.due,
    created_at: fm.created_at, updated_at: fm.updated_at, body: parsed.body,
  };
}

export interface ListOptions {
  type?: string | null; space?: string | null; status?: string | null;
  parent?: string | null; // normalized parent title, or the special "unsorted"
  limit?: number; offset?: number;
}

export async function listPages(env: Env, opts: ListOptions) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (opts.type) { assertEnum(opts.type, TYPES, "type"); clauses.push("type = ?"); values.push(opts.type); }
  if (opts.space) {
    if (opts.space === UNSORTED) clauses.push("space IS NULL");
    else { assertEnum(opts.space, SPACES, "space"); clauses.push("space = ?"); values.push(opts.space); }
  }
  if (opts.status) { assertEnum(opts.status, STATUSES, "status"); clauses.push("status = ?"); values.push(opts.status); }
  if (opts.parent) { clauses.push("parent_norm = ?"); values.push(normalizeTitle(opts.parent)); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = clampInt(opts.limit, 1, 200, 50);
  const offset = clampInt(opts.offset, 0, 100000, 0);
  values.push(limit, offset);
  const result = await env.DB
    .prepare(`SELECT * FROM pages ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...values).all<PageRow>();
  return (result.results ?? []).map(rowToMeta);
}

export async function searchPages(env: Env, query: string, opts: ListOptions) {
  if (!query.trim()) return listPages(env, opts);
  const clauses: string[] = ["pages_fts MATCH ?"];
  const values: unknown[] = [query];
  if (opts.type) { assertEnum(opts.type, TYPES, "type"); clauses.push("pages.type = ?"); values.push(opts.type); }
  if (opts.space) {
    if (opts.space === UNSORTED) clauses.push("pages.space IS NULL");
    else { assertEnum(opts.space, SPACES, "space"); clauses.push("pages.space = ?"); values.push(opts.space); }
  }
  if (opts.status) { assertEnum(opts.status, STATUSES, "status"); clauses.push("pages.status = ?"); values.push(opts.status); }
  values.push(clampInt(opts.limit, 1, 200, 50));
  const result = await env.DB.prepare(`
    SELECT pages.* FROM pages_fts JOIN pages ON pages.id = pages_fts.id
    WHERE ${clauses.join(" AND ")} ORDER BY rank LIMIT ?
  `).bind(...values).all<PageRow>();
  return (result.results ?? []).map(rowToMeta);
}

// Backlinks: everyone who links here, with context and kind. Seamless mentions.
export async function getBacklinks(env: Env, id: string) {
  const result = await env.DB.prepare(`
    SELECT links.kind, links.alias, links.context, pages.*
    FROM links JOIN pages ON pages.id = links.source_id
    WHERE links.target_id = ?
    ORDER BY links.kind = 'parent' DESC, pages.updated_at DESC
  `).bind(id).all<PageRow & { kind: string; alias: string | null; context: string }>();
  return (result.results ?? []).map((row) => ({
    ...rowToMeta(row), kind: row.kind, alias: row.alias, context: row.context,
  }));
}

// Children = pages whose `parent` link resolves to this page.
export async function getChildren(env: Env, id: string, opts: ListOptions = {}) {
  const clauses = ["links.target_id = ?", "links.kind = 'parent'"];
  const values: unknown[] = [id];
  if (opts.type) { assertEnum(opts.type, TYPES, "type"); clauses.push("pages.type = ?"); values.push(opts.type); }
  if (opts.status) { assertEnum(opts.status, STATUSES, "status"); clauses.push("pages.status = ?"); values.push(opts.status); }
  const result = await env.DB.prepare(`
    SELECT pages.* FROM links JOIN pages ON pages.id = links.source_id
    WHERE ${clauses.join(" AND ")} ORDER BY pages.created_at ASC
  `).bind(...values).all<PageRow>();
  return (result.results ?? []).map(rowToMeta);
}

export async function listUnresolved(env: Env) {
  const result = await env.DB.prepare(`
    SELECT links.target_norm, COUNT(*) AS refs,
           (SELECT context FROM links l2 WHERE l2.target_norm = links.target_norm LIMIT 1) AS sample
    FROM links WHERE target_id IS NULL
    GROUP BY target_norm ORDER BY refs DESC
  `).all<{ target_norm: string; refs: number; sample: string }>();
  return (result.results ?? []);
}

// --------------------------------------------------------------------------
// Write path
// --------------------------------------------------------------------------

export interface WriteInput {
  title?: string; type?: string; space?: string | null; status?: string;
  tags?: string[]; parent?: string | null; due?: number | string | null; body?: string;
}

export async function createPage(env: Env, input: WriteInput): Promise<PageDoc> {
  const now = Math.floor(Date.now() / 1000);
  const title = (input.title ?? "").trim() || "Untitled";
  const type = input.type === undefined ? "idea" : requireEnum(input.type, TYPES, "type");
  const space = readSpace(input.space);
  const fm: Frontmatter = {
    id: crypto.randomUUID(),
    title,
    type: type as ItemType,
    space,
    status: (input.status === undefined
      ? (type === "goal" ? "active" : "inbox")
      : requireEnum(input.status, STATUSES, "status")) as ItemStatus,
    tags: requireStringArray(input.tags ?? [], "tags"),
    parent: await validateParent(env, input.parent, null),
    due: readDue(input.due),
    created_at: now,
    updated_at: now,
    extra: {},
  };
  const path = await uniquePath(env, space, title, fm.id);
  const parsed: ParsedPage = { frontmatter: fm, body: input.body ?? "" };
  await env.VAULT.put(path, serializePage(parsed));
  await indexPage(env, parsed, path);
  await resolveLinksTo(env, fm.title, fm.id); // any unresolved [[title]] now points here
  return docFromParsed(parsed, path);
}

export async function updatePage(env: Env, id: string, input: WriteInput): Promise<PageDoc | null> {
  const existingPath = (await env.DB.prepare("SELECT path FROM pages WHERE id = ?").bind(id).first<{ path: string }>())?.path;
  if (!existingPath) return null;
  const object = await env.VAULT.get(existingPath);
  if (!object) return null; // index drift; caller can reindex
  const parsed = parsePage(await object.text());
  const fm = parsed.frontmatter;
  const oldTitle = fm.title;
  const oldSpace = fm.space;

  if (input.title !== undefined) fm.title = input.title.trim() || "Untitled";
  if (input.type !== undefined) fm.type = requireEnum(input.type, TYPES, "type") as ItemType;
  if (input.space !== undefined) fm.space = readSpace(input.space);
  if (input.status !== undefined) fm.status = requireEnum(input.status, STATUSES, "status") as ItemStatus;
  if (input.tags !== undefined) fm.tags = requireStringArray(input.tags, "tags");
  if (input.parent !== undefined) fm.parent = await validateParent(env, input.parent, id);
  if (input.due !== undefined) fm.due = readDue(input.due);
  if (input.body !== undefined) parsed.body = input.body;
  fm.updated_at = Math.floor(Date.now() / 1000);

  const titleChanged = normalizeTitle(oldTitle) !== normalizeTitle(fm.title);
  const spaceChanged = (oldSpace ?? null) !== (fm.space ?? null);
  let path = existingPath;
  if (titleChanged || spaceChanged) {
    path = await uniquePath(env, fm.space, fm.title, fm.id);
  }

  await env.VAULT.put(path, serializePage(parsed));
  if (path !== existingPath) await env.VAULT.delete(existingPath);

  // Rename propagation: rewrite [[oldTitle]] in every page that links here.
  if (titleChanged) await propagateRename(env, id, oldTitle, fm.title);

  await indexPage(env, parsed, path);
  if (titleChanged) await resolveLinksTo(env, fm.title, fm.id);
  return docFromParsed(parsed, path);
}

export async function deletePage(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT path FROM pages WHERE id = ?").bind(id).first<{ path: string }>();
  if (!row) return false;
  await env.VAULT.delete(row.path);
  // Inbound links become unresolved (not dangling); outbound cascade-delete.
  await env.DB.prepare("UPDATE links SET target_id = NULL WHERE target_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM links WHERE source_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM pages WHERE id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM pages_fts WHERE id = ?").bind(id).run();
  return true;
}

// --------------------------------------------------------------------------
// Indexing (the derived layer)
// --------------------------------------------------------------------------

async function indexPage(env: Env, parsed: ParsedPage, path: string): Promise<void> {
  const fm = parsed.frontmatter;
  const excerpt = parsed.body.replace(/[#>*_`\-\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

  await env.DB.prepare(`
    INSERT INTO pages (id, path, title, title_norm, type, space, status, tags_json, parent_norm, due, created_at, updated_at, body_excerpt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      path=excluded.path, title=excluded.title, title_norm=excluded.title_norm,
      type=excluded.type, space=excluded.space, status=excluded.status,
      tags_json=excluded.tags_json, parent_norm=excluded.parent_norm, due=excluded.due,
      updated_at=excluded.updated_at, body_excerpt=excluded.body_excerpt
  `).bind(
    fm.id, path, fm.title, normalizeTitle(fm.title), fm.type, fm.space ?? null, fm.status,
    JSON.stringify(fm.tags), fm.parent ? normalizeTitle(fm.parent) : null, fm.due,
    fm.created_at, fm.updated_at, excerpt,
  ).run();

  await env.DB.prepare("DELETE FROM pages_fts WHERE id = ?").bind(fm.id).run();
  await env.DB.prepare("INSERT INTO pages_fts (id, title, body) VALUES (?, ?, ?)")
    .bind(fm.id, fm.title, parsed.body).run();

  // Rebuild this page's outbound links (parent + inline), resolving targets.
  await env.DB.prepare("DELETE FROM links WHERE source_id = ?").bind(fm.id).run();
  const rows: Array<{ targetNorm: string; kind: string; alias: string | null; context: string }> = [];
  if (fm.parent) {
    rows.push({ targetNorm: normalizeTitle(fm.parent), kind: "parent", alias: null, context: `parent: ${fm.parent}` });
  }
  for (const link of extractBodyLinks(parsed.body)) {
    rows.push({ targetNorm: link.targetNorm, kind: "inline", alias: link.alias, context: link.context });
  }
  for (const row of rows) {
    const target = await env.DB.prepare("SELECT id FROM pages WHERE title_norm = ? ORDER BY created_at ASC LIMIT 1")
      .bind(row.targetNorm).first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO links (source_id, target_norm, target_id, kind, alias, context) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(fm.id, row.targetNorm, target?.id ?? null, row.kind, row.alias, row.context).run();
  }
}

// When a page named `title` appears, any previously-unresolved links to it resolve.
async function resolveLinksTo(env: Env, title: string, id: string): Promise<void> {
  await env.DB.prepare("UPDATE links SET target_id = ? WHERE target_norm = ? AND target_id IS NULL")
    .bind(id, normalizeTitle(title)).run();
}

async function propagateRename(env: Env, id: string, oldTitle: string, newTitle: string): Promise<void> {
  const oldNorm = normalizeTitle(oldTitle);
  // Every page that links to the old title (except the page itself).
  const sources = await env.DB.prepare(
    "SELECT DISTINCT source_id FROM links WHERE target_norm = ? AND source_id != ?",
  ).bind(oldNorm, id).all<{ source_id: string }>();
  for (const { source_id } of sources.results ?? []) {
    const pathRow = await env.DB.prepare("SELECT path FROM pages WHERE id = ?").bind(source_id).first<{ path: string }>();
    if (!pathRow) continue;
    const object = await env.VAULT.get(pathRow.path);
    if (!object) continue;
    const parsed = parsePage(await object.text());
    let touched = false;
    if (parsed.frontmatter.parent && normalizeTitle(parsed.frontmatter.parent) === oldNorm) {
      parsed.frontmatter.parent = newTitle; touched = true;
    }
    const rewritten = rewriteWikiLink(parsed.body, oldTitle, newTitle);
    if (rewritten !== parsed.body) { parsed.body = rewritten; touched = true; }
    if (!touched) continue;
    parsed.frontmatter.updated_at = Math.floor(Date.now() / 1000);
    await env.VAULT.put(pathRow.path, serializePage(parsed));
    await indexPage(env, parsed, pathRow.path);
  }
}

// --------------------------------------------------------------------------
// Reindex + legacy migration (bucket -> index; old table -> bucket)
// --------------------------------------------------------------------------

export async function reindex(env: Env): Promise<{ pages: number; links: number; unresolved: number }> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM links"),
    env.DB.prepare("DELETE FROM pages"),
    env.DB.prepare("DELETE FROM pages_fts"),
  ]);

  // Pass 1: insert all pages (so titles exist for resolution in pass 2).
  let cursor: string | undefined;
  const parsedAll: Array<{ parsed: ParsedPage; path: string }> = [];
  do {
    const listing = await env.VAULT.list({ cursor, limit: 1000 });
    for (const obj of listing.objects) {
      if (!obj.key.endsWith(".md")) continue;
      const object = await env.VAULT.get(obj.key);
      if (!object) continue;
      parsedAll.push({ parsed: parsePage(await object.text()), path: obj.key });
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  for (const { parsed, path } of parsedAll) {
    const fm = parsed.frontmatter;
    const excerpt = parsed.body.replace(/[#>*_`\-\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    await env.DB.prepare(`
      INSERT INTO pages (id, path, title, title_norm, type, space, status, tags_json, parent_norm, due, created_at, updated_at, body_excerpt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET path=excluded.path, title=excluded.title, title_norm=excluded.title_norm,
        type=excluded.type, space=excluded.space, status=excluded.status, tags_json=excluded.tags_json,
        parent_norm=excluded.parent_norm, due=excluded.due, updated_at=excluded.updated_at, body_excerpt=excluded.body_excerpt
    `).bind(
      fm.id, path, fm.title, normalizeTitle(fm.title), fm.type, fm.space ?? null, fm.status,
      JSON.stringify(fm.tags), fm.parent ? normalizeTitle(fm.parent) : null, fm.due,
      fm.created_at, fm.updated_at, excerpt,
    ).run();
    await env.DB.prepare("INSERT INTO pages_fts (id, title, body) VALUES (?, ?, ?)")
      .bind(fm.id, fm.title, parsed.body).run();
  }

  // Pass 2: build links, resolving targets against the now-complete page set.
  let linkCount = 0, unresolvedCount = 0;
  for (const { parsed } of parsedAll) {
    const fm = parsed.frontmatter;
    const rows: Array<{ targetNorm: string; kind: string; alias: string | null; context: string }> = [];
    if (fm.parent) rows.push({ targetNorm: normalizeTitle(fm.parent), kind: "parent", alias: null, context: `parent: ${fm.parent}` });
    for (const link of extractBodyLinks(parsed.body)) {
      rows.push({ targetNorm: link.targetNorm, kind: "inline", alias: link.alias, context: link.context });
    }
    for (const row of rows) {
      const target = await env.DB.prepare("SELECT id FROM pages WHERE title_norm = ? ORDER BY created_at ASC LIMIT 1")
        .bind(row.targetNorm).first<{ id: string }>();
      if (!target) unresolvedCount++;
      await env.DB.prepare(
        "INSERT INTO links (source_id, target_norm, target_id, kind, alias, context) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(fm.id, row.targetNorm, target?.id ?? null, row.kind, row.alias, row.context).run();
      linkCount++;
    }
  }
  return { pages: parsedAll.length, links: linkCount, unresolved: unresolvedCount };
}

// One-time: read the legacy `items` table and write one markdown file per row,
// converting related/parent_id UUIDs to [[Title]] links.
export async function migrateFromLegacyD1(env: Env): Promise<{ written: number }> {
  const legacy = await env.DB.prepare("SELECT * FROM items").all<any>().catch(() => ({ results: [] as any[] }));
  const rows = legacy.results ?? [];
  const titleById = new Map<string, string>();
  for (const r of rows) titleById.set(r.id, r.title);

  let written = 0;
  for (const r of rows) {
    const related: string[] = safeArray(r.related ?? "[]");
    const parentTitle = r.parent_id ? titleById.get(r.parent_id) ?? null : null;
    // Rebuild body: existing content + a "Related" section of [[links]].
    let body = String(r.content ?? "");
    const relTitles = related.map((rid) => titleById.get(rid)).filter(Boolean) as string[];
    if (relTitles.length) {
      body += (body ? "\n\n" : "") + "## Related\n" + relTitles.map((t) => `- [[${t}]]`).join("\n");
    }
    // Promote any surviving metadata.checklist to task lines.
    try {
      const meta = JSON.parse(r.metadata ?? "{}");
      if (Array.isArray(meta.checklist) && meta.checklist.length) {
        body += (body ? "\n\n" : "") + meta.checklist
          .map((c: any) => `- [${c.done ? "x" : " "}] ${c.text ?? ""}`).join("\n");
      }
    } catch { /* ignore */ }

    const space: ItemSpace | null =
      r.space && SPACES.has(r.space) ? (r.space as ItemSpace)
      : r.space === null ? null : null;
    const created = Number(r.created_at) || Math.floor(Date.now() / 1000);
    const updated = Number(r.updated_at) || created;
    const type = TYPES.has(r.type) ? r.type : "page";
    const fm: Frontmatter = {
      id: r.id, title: r.title, type, space,
      status: STATUSES.has(r.status) ? r.status : "inbox",
      tags: safeArray(r.tags ?? "[]"),
      parent: parentTitle, due: r.due_date ?? null,
      created_at: created, updated_at: updated, extra: {},
    };
    const path = pageKey(space, r.title, String(r.id).slice(0, 8));
    await env.VAULT.put(path, serializePage({ frontmatter: fm, body }));
    written++;
  }
  await reindex(env);
  return { written };
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

function assertEnum(value: string, allowed: Set<string>, field: string) {
  if (!allowed.has(value)) throw new Error(`Invalid ${field}: ${value}`);
}
function requireEnum(value: unknown, allowed: Set<string>, field: string): string {
  if (typeof value === "string" && allowed.has(value)) return value;
  throw new Error(`Invalid ${field}: ${JSON.stringify(value)} (allowed: ${[...allowed].join(", ")})`);
}
function readSpace(value: unknown): ItemSpace | null {
  if (value === undefined || value === null || value === UNSORTED || value === "") return null;
  if (typeof value === "string" && SPACES.has(value)) return value as ItemSpace;
  throw new Error(`Invalid space: ${JSON.stringify(value)} (allowed: ${[...SPACES].join(", ")}, or null/unsorted)`);
}
function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`Invalid ${field}: expected an array of strings`);
  }
  return (value as string[]).map((s) => s.trim()).filter(Boolean);
}
function readDue(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") { const ms = Date.parse(value); if (Number.isFinite(ms)) return Math.floor(ms / 1000); }
  throw new Error(`Invalid due: ${JSON.stringify(value)}`);
}
// A parent link must resolve to a real page (unless clearing it). This is the
// "writes apply or error" guarantee for hierarchy — no silent dangling parent.
async function validateParent(env: Env, value: unknown, selfId: string | null): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  const title = parentTitleFrom(typeof value === "string" ? value : String(value));
  if (!title) return null;
  const row = await env.DB.prepare("SELECT id, title FROM pages WHERE title_norm = ? ORDER BY created_at ASC LIMIT 1")
    .bind(normalizeTitle(title)).first<{ id: string; title: string }>();
  if (!row) throw new Error(`Invalid parent: no page titled "${title}" (create it first, or link inline instead)`);
  if (selfId && row.id === selfId) throw new Error("Invalid parent: a page cannot be its own parent");
  return row.title; // store the canonical title spelling
}
async function uniquePath(env: Env, space: ItemSpace | null, title: string, id: string): Promise<string> {
  const base = pageKey(space, title);
  const clash = await env.DB.prepare("SELECT id FROM pages WHERE path = ? AND id != ?").bind(base, id).first();
  return clash ? pageKey(space, title, id.slice(0, 8)) : base;
}
function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
