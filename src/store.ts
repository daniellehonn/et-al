// Storage layer. The R2 VAULT bucket (a real directory tree) is the source of
// truth; D1 is a derived, rebuildable index. Folders = spaces/subspaces; a
// page's space is the folder it lives in. Everything funnels through here so the
// index stays coherent, and any drift is fixable by reindex() (the bucket wins).

import {
  parsePage, serializePage, parseSpaceFile, serializeSpaceFile,
  extractBodyLinks, rewriteWikiLink, normalizeTitle, slugify, segify,
  pageKey, spaceFileKey, isSpaceFile, spacePathOf, parentSpacePath, spaceLeaf,
  normalizeSpacePath, parentTitleFrom,
  SCHEMA_VERSION, TYPE_KEYS, STATUS_KEYS, SEED_SPACES,
  type Frontmatter, type SpaceMeta, type ItemType, type ItemStatus, type ParsedPage,
} from "./markdown.ts";

export interface Env {
  DB: D1Database;
  VAULT: R2Bucket;
  ET_AL_API_KEY?: string;
  SECOND_BRAIN_API_KEY?: string;
  APP_NAME?: string;
}

const TYPES = new Set<string>(TYPE_KEYS);
const STATUSES = new Set<string>(STATUS_KEYS);

export const SCHEMA_INFO = {
  version: SCHEMA_VERSION,
  storage: "R2 vault (a directory tree of markdown files) is canonical; D1 is a rebuildable index",
  types: TYPE_KEYS,
  statuses: STATUS_KEYS,
  seed_spaces: SEED_SPACES,
  spaces: "Folders, nestable without limit. A page's space is the folder it lives in (its path). There is no space enum — the folder tree is the source of truth.",
  space_file: "_space.md in a folder carries that space's metadata + overview note (optional; folders exist without it).",
  structures: {
    folder: "area / place — where a page lives; the nav tree",
    parent: "goal breakdown — a goal owns subtasks/notes/pages via the frontmatter `parent:` link; can cross folders",
    wikilink: "lateral reference — any inline [[Title]]; drives backlinks",
  },
};

export interface PageDoc {
  id: string;
  path: string;
  space_path: string;
  title: string;
  type: ItemType;
  status: ItemStatus;
  tags: string[];
  parent: string | null;
  due: number | null;
  created_at: number;
  updated_at: number;
  body: string;
}

interface PageRow {
  id: string; path: string; space_path: string; title: string; title_norm: string;
  type: string; status: string; tags_json: string; parent_norm: string | null;
  due: number | null; created_at: number; updated_at: number; body_excerpt: string;
}
interface SpaceRow {
  path: string; parent_path: string | null; name: string; slug: string;
  color: string | null; icon: string | null; description: string | null;
  sort: number | null; id: string | null; has_meta: number;
  created_at: number; updated_at: number;
}

function safeArray(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}
function pageMeta(row: PageRow) {
  return {
    id: row.id, path: row.path, space_path: row.space_path, title: row.title,
    type: row.type as ItemType, status: row.status as ItemStatus, tags: safeArray(row.tags_json),
    parent: row.parent_norm, due: row.due, created_at: row.created_at, updated_at: row.updated_at,
    excerpt: row.body_excerpt,
  };
}
function docFromParsed(parsed: ParsedPage, path: string): PageDoc {
  const fm = parsed.frontmatter;
  return {
    id: fm.id, path, space_path: spacePathOf(path), title: fm.title, type: fm.type,
    status: fm.status, tags: fm.tags, parent: fm.parent, due: fm.due,
    created_at: fm.created_at, updated_at: fm.updated_at, body: parsed.body,
  };
}
function spaceView(row: SpaceRow) {
  return {
    path: row.path, parent_path: row.parent_path ?? "", name: row.name, slug: row.slug,
    color: row.color, icon: row.icon, description: row.description, sort: row.sort,
    id: row.id, has_meta: !!row.has_meta,
  };
}

// --------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------

export async function getPageByPath(env: Env, path: string): Promise<PageDoc | null> {
  const object = await env.VAULT.get(path);
  if (!object) return null;
  return docFromParsed(parsePage(await object.text()), path);
}
export async function getPage(env: Env, id: string): Promise<PageDoc | null> {
  const row = await env.DB.prepare("SELECT path FROM pages WHERE id = ?").bind(id).first<{ path: string }>();
  if (!row) return null;
  return getPageByPath(env, row.path);
}

export interface ListOptions {
  space?: string | null;   // exact folder, or with recursive:true its whole subtree
  recursive?: boolean;
  type?: string | null;
  status?: string | null;
  parent?: string | null;  // parent-goal title
  limit?: number; offset?: number;
}

export async function listPages(env: Env, opts: ListOptions) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (opts.space != null) {
    const sp = normalizeSpacePath(opts.space);
    if (opts.recursive) { clauses.push("(space_path = ? OR space_path LIKE ?)"); values.push(sp, sp ? `${sp}/%` : "%"); }
    else { clauses.push("space_path = ?"); values.push(sp); }
  }
  if (opts.type) { assertEnum(opts.type, TYPES, "type"); clauses.push("type = ?"); values.push(opts.type); }
  if (opts.status) { assertEnum(opts.status, STATUSES, "status"); clauses.push("status = ?"); values.push(opts.status); }
  if (opts.parent) { clauses.push("parent_norm = ?"); values.push(normalizeTitle(opts.parent)); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = clampInt(opts.limit, 1, 500, 100), offset = clampInt(opts.offset, 0, 100000, 0);
  values.push(limit, offset);
  const result = await env.DB.prepare(`SELECT * FROM pages ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...values).all<PageRow>();
  return (result.results ?? []).map(pageMeta);
}

export async function searchPages(env: Env, query: string, opts: ListOptions) {
  if (!query.trim()) return listPages(env, opts);
  const clauses: string[] = ["pages_fts MATCH ?"];
  const values: unknown[] = [query];
  if (opts.space != null) {
    const sp = normalizeSpacePath(opts.space);
    if (opts.recursive) { clauses.push("(pages.space_path = ? OR pages.space_path LIKE ?)"); values.push(sp, sp ? `${sp}/%` : "%"); }
    else { clauses.push("pages.space_path = ?"); values.push(sp); }
  }
  if (opts.type) { assertEnum(opts.type, TYPES, "type"); clauses.push("pages.type = ?"); values.push(opts.type); }
  if (opts.status) { assertEnum(opts.status, STATUSES, "status"); clauses.push("pages.status = ?"); values.push(opts.status); }
  values.push(clampInt(opts.limit, 1, 500, 100));
  const result = await env.DB.prepare(`
    SELECT pages.* FROM pages_fts JOIN pages ON pages.id = pages_fts.id
    WHERE ${clauses.join(" AND ")} ORDER BY rank LIMIT ?
  `).bind(...values).all<PageRow>();
  return (result.results ?? []).map(pageMeta);
}

export async function getBacklinks(env: Env, id: string) {
  const result = await env.DB.prepare(`
    SELECT links.kind, links.alias, links.context, pages.*
    FROM links JOIN pages ON pages.id = links.source_id
    WHERE links.target_id = ?
    ORDER BY links.kind = 'parent' DESC, pages.updated_at DESC
  `).bind(id).all<PageRow & { kind: string; alias: string | null; context: string }>();
  return (result.results ?? []).map((row) => ({ ...pageMeta(row), kind: row.kind, alias: row.alias, context: row.context }));
}

// Children = pages whose `parent` goal-link resolves to this page (goal breakdown).
export async function getChildren(env: Env, id: string, opts: ListOptions = {}) {
  const clauses = ["links.target_id = ?", "links.kind = 'parent'"];
  const values: unknown[] = [id];
  if (opts.type) { assertEnum(opts.type, TYPES, "type"); clauses.push("pages.type = ?"); values.push(opts.type); }
  if (opts.status) { assertEnum(opts.status, STATUSES, "status"); clauses.push("pages.status = ?"); values.push(opts.status); }
  const result = await env.DB.prepare(`
    SELECT pages.* FROM links JOIN pages ON pages.id = links.source_id
    WHERE ${clauses.join(" AND ")} ORDER BY pages.created_at ASC
  `).bind(...values).all<PageRow>();
  return (result.results ?? []).map(pageMeta);
}

export async function listUnresolved(env: Env) {
  const result = await env.DB.prepare(`
    SELECT links.target_norm, COUNT(*) AS refs,
      (SELECT context FROM links l2 WHERE l2.target_norm = links.target_norm LIMIT 1) AS sample
    FROM links WHERE target_id IS NULL GROUP BY target_norm ORDER BY refs DESC
  `).all<{ target_norm: string; refs: number; sample: string }>();
  return result.results ?? [];
}

// The full space tree, ordered for nav. Includes counts of direct pages.
export async function listSpaces(env: Env) {
  const spaces = await env.DB.prepare("SELECT * FROM spaces ORDER BY COALESCE(sort, 999999), name").all<SpaceRow>();
  const counts = await env.DB.prepare("SELECT space_path, COUNT(*) AS n FROM pages GROUP BY space_path").all<{ space_path: string; n: number }>();
  const countBy = new Map((counts.results ?? []).map((r) => [r.space_path, r.n]));
  return (spaces.results ?? []).map((row) => ({ ...spaceView(row), page_count: countBy.get(row.path) ?? 0 }));
}

export async function getSpace(env: Env, path: string) {
  const sp = normalizeSpacePath(path);
  const row = await env.DB.prepare("SELECT * FROM spaces WHERE path = ?").bind(sp).first<SpaceRow>();
  if (!row) return null;
  const object = await env.VAULT.get(spaceFileKey(sp));
  const overview = object ? parseSpaceFile(await object.text(), spaceLeaf(sp)).body : "";
  return { ...spaceView(row), overview };
}

// --------------------------------------------------------------------------
// Space writes
// --------------------------------------------------------------------------

export interface SpaceInput {
  path?: string;          // full path for the new/updated space
  parent_path?: string;   // alternative: parent + name
  name?: string; color?: string | null; icon?: string | null;
  description?: string | null; sort?: number | null; overview?: string;
}

export async function createSpace(env: Env, input: SpaceInput): Promise<ReturnType<typeof spaceView> & { overview: string }> {
  const name = (input.name ?? "").trim() || "Untitled space";
  let path: string;
  if (input.path) path = normalizeSpacePath(input.path);
  else path = joinPath(normalizeSpacePath(input.parent_path ?? ""), segify(name));
  if (!path) throw new Error("Invalid space: a space needs a non-empty path");
  const parent = parentSpacePath(path);
  if (parent && !(await spaceExists(env, parent))) throw new Error(`Invalid parent space: "${parent}" does not exist`);
  if (await env.VAULT.get(spaceFileKey(path))) throw new Error(`Space already exists: ${path}`);
  const now = Math.floor(Date.now() / 1000);
  const meta: SpaceMeta = {
    id: crypto.randomUUID(), name,
    color: input.color ?? null, icon: input.icon ?? null,
    description: input.description ?? null, sort: input.sort ?? null,
    created_at: now, updated_at: now, extra: {},
  };
  await env.VAULT.put(spaceFileKey(path), serializeSpaceFile({ meta, body: input.overview ?? "" }));
  await indexSpace(env, path, meta, true);
  return (await getSpace(env, path))!;
}

export async function updateSpace(env: Env, path: string, input: SpaceInput) {
  const sp = normalizeSpacePath(path);
  const key = spaceFileKey(sp);
  const object = await env.VAULT.get(key);
  const parsed = object ? parseSpaceFile(await object.text(), spaceLeaf(sp)) : { meta: freshMeta(spaceLeaf(sp)), body: "" };
  const m = parsed.meta;
  if (input.name !== undefined) m.name = input.name.trim() || m.name;
  if (input.color !== undefined) m.color = input.color;
  if (input.icon !== undefined) m.icon = input.icon;
  if (input.description !== undefined) m.description = input.description;
  if (input.sort !== undefined) m.sort = input.sort;
  if (input.overview !== undefined) parsed.body = input.overview;
  m.updated_at = Math.floor(Date.now() / 1000);
  await env.VAULT.put(key, serializeSpaceFile(parsed));
  await indexSpace(env, sp, m, true);
  return (await getSpace(env, sp))!;
}

// Delete an (empty) space. Refuses if it still holds pages or subspaces, so
// nothing is silently orphaned.
export async function deleteSpace(env: Env, path: string): Promise<{ ok: boolean }> {
  const sp = normalizeSpacePath(path);
  if (!sp) throw new Error("Cannot delete the vault root");
  const pages = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE space_path = ? OR space_path LIKE ?").bind(sp, `${sp}/%`).first<{ n: number }>();
  if ((pages?.n ?? 0) > 0) throw new Error(`Space not empty: move or delete its ${pages!.n} page(s) first`);
  const subs = await env.DB.prepare("SELECT COUNT(*) AS n FROM spaces WHERE parent_path = ?").bind(sp).first<{ n: number }>();
  if ((subs?.n ?? 0) > 0) throw new Error("Space has subspaces: delete those first");
  await env.VAULT.delete(spaceFileKey(sp));
  await env.DB.prepare("DELETE FROM spaces WHERE path = ?").bind(sp).run();
  return { ok: true };
}

async function spaceExists(env: Env, path: string): Promise<boolean> {
  const sp = normalizeSpacePath(path);
  if (!sp) return true; // root always exists
  const row = await env.DB.prepare("SELECT 1 AS x FROM spaces WHERE path = ? UNION SELECT 1 FROM pages WHERE space_path = ? OR space_path LIKE ? LIMIT 1")
    .bind(sp, sp, `${sp}/%`).first();
  return !!row;
}

// --------------------------------------------------------------------------
// Page writes
// --------------------------------------------------------------------------

export interface WriteInput {
  title?: string; type?: string; space_path?: string | null; status?: string;
  tags?: string[]; parent?: string | null; due?: number | string | null; body?: string;
}

export async function createPage(env: Env, input: WriteInput): Promise<PageDoc> {
  const now = Math.floor(Date.now() / 1000);
  const title = (input.title ?? "").trim() || "Untitled";
  const type = input.type === undefined ? "idea" : requireEnum(input.type, TYPES, "type");
  const spacePath = normalizeSpacePath(input.space_path ?? "");
  // Ensure the target folder exists (auto-create its _space.md ancestors) so a
  // page never lands in a phantom space.
  await ensureSpaceChain(env, spacePath);
  const fm: Frontmatter = {
    id: crypto.randomUUID(), title, type: type as ItemType,
    status: (input.status === undefined ? (type === "goal" ? "active" : "inbox") : requireEnum(input.status, STATUSES, "status")) as ItemStatus,
    tags: requireStringArray(input.tags ?? [], "tags"),
    parent: await validateParent(env, input.parent, null),
    due: readDue(input.due), created_at: now, updated_at: now, extra: {},
  };
  const path = await uniquePath(env, spacePath, title, fm.id);
  const parsed: ParsedPage = { frontmatter: fm, body: input.body ?? "" };
  await env.VAULT.put(path, serializePage(parsed));
  await indexPage(env, parsed, path);
  await resolveLinksTo(env, fm.title, fm.id);
  return docFromParsed(parsed, path);
}

export async function updatePage(env: Env, id: string, input: WriteInput): Promise<PageDoc | null> {
  const existingPath = (await env.DB.prepare("SELECT path FROM pages WHERE id = ?").bind(id).first<{ path: string }>())?.path;
  if (!existingPath) return null;
  const object = await env.VAULT.get(existingPath);
  if (!object) return null;
  const parsed = parsePage(await object.text());
  const fm = parsed.frontmatter;
  const oldTitle = fm.title;
  const oldSpace = spacePathOf(existingPath);

  if (input.title !== undefined) fm.title = input.title.trim() || "Untitled";
  if (input.type !== undefined) fm.type = requireEnum(input.type, TYPES, "type") as ItemType;
  if (input.status !== undefined) fm.status = requireEnum(input.status, STATUSES, "status") as ItemStatus;
  if (input.tags !== undefined) fm.tags = requireStringArray(input.tags, "tags");
  if (input.parent !== undefined) fm.parent = await validateParent(env, input.parent, id);
  if (input.due !== undefined) fm.due = readDue(input.due);
  if (input.body !== undefined) parsed.body = input.body;
  fm.updated_at = Math.floor(Date.now() / 1000);

  const newSpace = input.space_path !== undefined ? normalizeSpacePath(input.space_path ?? "") : oldSpace;
  if (input.space_path !== undefined && newSpace !== oldSpace) await ensureSpaceChain(env, newSpace);
  const titleChanged = normalizeTitle(oldTitle) !== normalizeTitle(fm.title);
  const spaceChanged = newSpace !== oldSpace;
  let path = existingPath;
  if (titleChanged || spaceChanged) path = await uniquePath(env, newSpace, fm.title, fm.id);

  await env.VAULT.put(path, serializePage(parsed));
  if (path !== existingPath) await env.VAULT.delete(existingPath);
  if (titleChanged) await propagateRename(env, id, oldTitle, fm.title);
  await indexPage(env, parsed, path);
  if (titleChanged) await resolveLinksTo(env, fm.title, fm.id);
  return docFromParsed(parsed, path);
}

export async function deletePage(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT path FROM pages WHERE id = ?").bind(id).first<{ path: string }>();
  if (!row) return false;
  await env.VAULT.delete(row.path);
  await env.DB.prepare("UPDATE links SET target_id = NULL WHERE target_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM links WHERE source_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM pages WHERE id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM pages_fts WHERE id = ?").bind(id).run();
  return true;
}

// --------------------------------------------------------------------------
// Indexing (derived)
// --------------------------------------------------------------------------

function excerptOf(body: string): string {
  return body.replace(/[#>*_`\-\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

async function indexPage(env: Env, parsed: ParsedPage, path: string): Promise<void> {
  const fm = parsed.frontmatter;
  await env.DB.prepare(`
    INSERT INTO pages (id, path, space_path, title, title_norm, type, status, tags_json, parent_norm, due, created_at, updated_at, body_excerpt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET path=excluded.path, space_path=excluded.space_path, title=excluded.title,
      title_norm=excluded.title_norm, type=excluded.type, status=excluded.status, tags_json=excluded.tags_json,
      parent_norm=excluded.parent_norm, due=excluded.due, updated_at=excluded.updated_at, body_excerpt=excluded.body_excerpt
  `).bind(
    fm.id, path, spacePathOf(path), fm.title, normalizeTitle(fm.title), fm.type, fm.status,
    JSON.stringify(fm.tags), fm.parent ? normalizeTitle(fm.parent) : null, fm.due,
    fm.created_at, fm.updated_at, excerptOf(parsed.body),
  ).run();

  await env.DB.prepare("DELETE FROM pages_fts WHERE id = ?").bind(fm.id).run();
  await env.DB.prepare("INSERT INTO pages_fts (id, title, body) VALUES (?, ?, ?)").bind(fm.id, fm.title, parsed.body).run();

  await env.DB.prepare("DELETE FROM links WHERE source_id = ?").bind(fm.id).run();
  const rows: Array<{ targetNorm: string; kind: string; alias: string | null; context: string }> = [];
  if (fm.parent) rows.push({ targetNorm: normalizeTitle(fm.parent), kind: "parent", alias: null, context: `parent: ${fm.parent}` });
  for (const link of extractBodyLinks(parsed.body)) rows.push({ targetNorm: link.targetNorm, kind: "inline", alias: link.alias, context: link.context });
  for (const row of rows) {
    const target = await env.DB.prepare("SELECT id FROM pages WHERE title_norm = ? ORDER BY created_at ASC LIMIT 1").bind(row.targetNorm).first<{ id: string }>();
    await env.DB.prepare("INSERT INTO links (source_id, target_norm, target_id, kind, alias, context) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(fm.id, row.targetNorm, target?.id ?? null, row.kind, row.alias, row.context).run();
  }
}

async function indexSpace(env: Env, path: string, meta: SpaceMeta, hasMeta: boolean): Promise<void> {
  const sp = normalizeSpacePath(path);
  await env.DB.prepare(`
    INSERT INTO spaces (path, parent_path, name, slug, color, icon, description, sort, id, has_meta, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET parent_path=excluded.parent_path, name=excluded.name, slug=excluded.slug,
      color=excluded.color, icon=excluded.icon, description=excluded.description, sort=excluded.sort,
      id=excluded.id, has_meta=MAX(spaces.has_meta, excluded.has_meta), updated_at=excluded.updated_at
  `).bind(
    sp, parentSpacePath(sp) ?? "", meta.name, spaceLeaf(sp), meta.color, meta.icon, meta.description,
    meta.sort, meta.id, hasMeta ? 1 : 0, meta.created_at, meta.updated_at,
  ).run();
}

function freshMeta(name: string): SpaceMeta {
  const now = Math.floor(Date.now() / 1000);
  return { id: crypto.randomUUID(), name: titleCase(name), color: null, icon: null, description: null, sort: null, created_at: now, updated_at: now, extra: {} };
}

// Make sure every folder on `spacePath` has an index row (implicit spaces get a
// derived row so the nav tree is never missing an ancestor).
async function ensureSpaceChain(env: Env, spacePath: string): Promise<void> {
  const sp = normalizeSpacePath(spacePath);
  if (!sp) return;
  const segs = sp.split("/");
  let acc = "";
  for (const seg of segs) {
    acc = acc ? `${acc}/${seg}` : seg;
    const exists = await env.DB.prepare("SELECT 1 AS x FROM spaces WHERE path = ?").bind(acc).first();
    if (exists) continue;
    const object = await env.VAULT.get(spaceFileKey(acc));
    if (object) await indexSpace(env, acc, parseSpaceFile(await object.text(), spaceLeaf(acc)).meta, true);
    else await indexSpace(env, acc, freshMeta(spaceLeaf(acc)), false);
  }
}

async function resolveLinksTo(env: Env, title: string, id: string): Promise<void> {
  await env.DB.prepare("UPDATE links SET target_id = ? WHERE target_norm = ? AND target_id IS NULL").bind(id, normalizeTitle(title)).run();
}

async function propagateRename(env: Env, id: string, oldTitle: string, newTitle: string): Promise<void> {
  const oldNorm = normalizeTitle(oldTitle);
  const sources = await env.DB.prepare("SELECT DISTINCT source_id FROM links WHERE target_norm = ? AND source_id != ?").bind(oldNorm, id).all<{ source_id: string }>();
  for (const { source_id } of sources.results ?? []) {
    const pathRow = await env.DB.prepare("SELECT path FROM pages WHERE id = ?").bind(source_id).first<{ path: string }>();
    if (!pathRow) continue;
    const object = await env.VAULT.get(pathRow.path);
    if (!object) continue;
    const parsed = parsePage(await object.text());
    let touched = false;
    if (parsed.frontmatter.parent && normalizeTitle(parsed.frontmatter.parent) === oldNorm) { parsed.frontmatter.parent = newTitle; touched = true; }
    const rewritten = rewriteWikiLink(parsed.body, oldTitle, newTitle);
    if (rewritten !== parsed.body) { parsed.body = rewritten; touched = true; }
    if (!touched) continue;
    parsed.frontmatter.updated_at = Math.floor(Date.now() / 1000);
    await env.VAULT.put(pathRow.path, serializePage(parsed));
    await indexPage(env, parsed, pathRow.path);
  }
}

// --------------------------------------------------------------------------
// Reindex + legacy migration
// --------------------------------------------------------------------------

export async function reindex(env: Env): Promise<{ pages: number; spaces: number; links: number; unresolved: number }> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM links"),
    env.DB.prepare("DELETE FROM pages"),
    env.DB.prepare("DELETE FROM pages_fts"),
    env.DB.prepare("DELETE FROM spaces"),
  ]);

  let cursor: string | undefined;
  const pages: Array<{ parsed: ParsedPage; path: string }> = [];
  const spaceMetas = new Map<string, SpaceMeta>();
  const allFolders = new Set<string>();
  do {
    const listing = await env.VAULT.list({ cursor, limit: 1000 });
    for (const obj of listing.objects) {
      if (!obj.key.endsWith(".md")) continue;
      const object = await env.VAULT.get(obj.key);
      if (!object) continue;
      const text = await object.text();
      if (isSpaceFile(obj.key)) {
        const sp = spacePathOf(obj.key);
        spaceMetas.set(sp, parseSpaceFile(text, spaceLeaf(sp)).meta);
        registerFolders(allFolders, sp);
      } else {
        pages.push({ parsed: parsePage(text), path: obj.key });
        registerFolders(allFolders, spacePathOf(obj.key));
      }
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  // Spaces: real metadata where present, derived rows for implicit folders.
  for (const folder of [...allFolders].filter(Boolean).sort()) {
    const meta = spaceMetas.get(folder) ?? freshMeta(spaceLeaf(folder));
    await indexSpace(env, folder, meta, spaceMetas.has(folder));
  }

  // Pass 1: pages (titles must exist before link resolution).
  for (const { parsed, path } of pages) {
    const fm = parsed.frontmatter;
    await env.DB.prepare(`
      INSERT INTO pages (id, path, space_path, title, title_norm, type, status, tags_json, parent_norm, due, created_at, updated_at, body_excerpt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET path=excluded.path, space_path=excluded.space_path, title=excluded.title,
        title_norm=excluded.title_norm, type=excluded.type, status=excluded.status, tags_json=excluded.tags_json,
        parent_norm=excluded.parent_norm, due=excluded.due, updated_at=excluded.updated_at, body_excerpt=excluded.body_excerpt
    `).bind(
      fm.id, path, spacePathOf(path), fm.title, normalizeTitle(fm.title), fm.type, fm.status,
      JSON.stringify(fm.tags), fm.parent ? normalizeTitle(fm.parent) : null, fm.due,
      fm.created_at, fm.updated_at, excerptOf(parsed.body),
    ).run();
    await env.DB.prepare("INSERT INTO pages_fts (id, title, body) VALUES (?, ?, ?)").bind(fm.id, fm.title, parsed.body).run();
  }

  // Pass 2: links, resolved against the complete page set.
  let links = 0, unresolved = 0;
  for (const { parsed } of pages) {
    const fm = parsed.frontmatter;
    const rows: Array<{ targetNorm: string; kind: string; alias: string | null; context: string }> = [];
    if (fm.parent) rows.push({ targetNorm: normalizeTitle(fm.parent), kind: "parent", alias: null, context: `parent: ${fm.parent}` });
    for (const link of extractBodyLinks(parsed.body)) rows.push({ targetNorm: link.targetNorm, kind: "inline", alias: link.alias, context: link.context });
    for (const row of rows) {
      const target = await env.DB.prepare("SELECT id FROM pages WHERE title_norm = ? ORDER BY created_at ASC LIMIT 1").bind(row.targetNorm).first<{ id: string }>();
      if (!target) unresolved++;
      await env.DB.prepare("INSERT INTO links (source_id, target_norm, target_id, kind, alias, context) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(fm.id, row.targetNorm, target?.id ?? null, row.kind, row.alias, row.context).run();
      links++;
    }
  }
  return { pages: pages.length, spaces: allFolders.size, links, unresolved };
}

function registerFolders(set: Set<string>, folder: string) {
  let acc = "";
  for (const seg of normalizeSpacePath(folder).split("/").filter(Boolean)) { acc = acc ? `${acc}/${seg}` : seg; set.add(acc); }
}

// One-time: legacy D1 `items` -> nested vault. The old flat `space` becomes the
// top-level folder; identity items fold into `life` (re-file later — trivial now);
// related/parent_id UUIDs become [[Title]] links; checklists become task lines.
export async function migrateFromLegacyD1(env: Env): Promise<{ written: number }> {
  const legacy = await env.DB.prepare("SELECT * FROM items").all<any>().catch(() => ({ results: [] as any[] }));
  const rows = legacy.results ?? [];
  const titleById = new Map<string, string>();
  for (const r of rows) titleById.set(r.id, r.title);

  const SPACE_REMAP: Record<string, string> = { identity: "life", goals: "life", work: "career", ideas: "projects" };
  let written = 0;
  for (const r of rows) {
    const related: string[] = safeArray(r.related ?? "[]");
    const parentTitle = r.parent_id ? titleById.get(r.parent_id) ?? null : null;
    let body = String(r.content ?? "");
    const relTitles = related.map((rid) => titleById.get(rid)).filter(Boolean) as string[];
    if (relTitles.length) body += (body ? "\n\n" : "") + "## Related\n" + relTitles.map((t) => `- [[${t}]]`).join("\n");
    try {
      const meta = JSON.parse(r.metadata ?? "{}");
      if (Array.isArray(meta.checklist) && meta.checklist.length) {
        body += (body ? "\n\n" : "") + meta.checklist.map((c: any) => `- [${c.done ? "x" : " "}] ${c.text ?? ""}`).join("\n");
      }
    } catch { /* ignore */ }

    const rawSpace: string | null = r.space ?? null;
    const folder = rawSpace ? (SPACE_REMAP[rawSpace] ?? rawSpace) : "life"; // null/identity -> life
    const created = Number(r.created_at) || Math.floor(Date.now() / 1000);
    const fm: Frontmatter = {
      id: r.id, title: r.title, type: TYPES.has(r.type) ? r.type : "page",
      status: STATUSES.has(r.status) ? r.status : "inbox",
      tags: safeArray(r.tags ?? "[]"), parent: parentTitle, due: r.due_date ?? null,
      created_at: created, updated_at: Number(r.updated_at) || created, extra: {},
    };
    await env.VAULT.put(pageKey(folder, r.title, String(r.id).slice(0, 8)), serializePage({ frontmatter: fm, body }));
    written++;
  }
  await reindex(env);
  return { written };
}

// --------------------------------------------------------------------------
// Validation + helpers
// --------------------------------------------------------------------------

function joinPath(base: string, seg: string): string { return base ? `${base}/${seg}` : seg; }
function titleCase(slug: string): string { return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
function assertEnum(value: string, allowed: Set<string>, field: string) { if (!allowed.has(value)) throw new Error(`Invalid ${field}: ${value}`); }
function requireEnum(value: unknown, allowed: Set<string>, field: string): string {
  if (typeof value === "string" && allowed.has(value)) return value;
  throw new Error(`Invalid ${field}: ${JSON.stringify(value)} (allowed: ${[...allowed].join(", ")})`);
}
function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error(`Invalid ${field}: expected an array of strings`);
  return (value as string[]).map((s) => s.trim()).filter(Boolean);
}
function readDue(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") { const ms = Date.parse(value); if (Number.isFinite(ms)) return Math.floor(ms / 1000); }
  throw new Error(`Invalid due: ${JSON.stringify(value)}`);
}
// A parent goal-link must resolve to a real page (or be cleared) — no dangling parent.
async function validateParent(env: Env, value: unknown, selfId: string | null): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  const title = parentTitleFrom(typeof value === "string" ? value : String(value));
  if (!title) return null;
  const row = await env.DB.prepare("SELECT id, title FROM pages WHERE title_norm = ? ORDER BY created_at ASC LIMIT 1").bind(normalizeTitle(title)).first<{ id: string; title: string }>();
  if (!row) throw new Error(`Invalid parent: no page titled "${title}" (create it first, or link inline instead)`);
  if (selfId && row.id === selfId) throw new Error("Invalid parent: a page cannot be its own parent");
  return row.title;
}
async function uniquePath(env: Env, spacePath: string, title: string, id: string): Promise<string> {
  const base = pageKey(spacePath, title);
  const clash = await env.DB.prepare("SELECT id FROM pages WHERE path = ? AND id != ?").bind(base, id).first();
  return clash ? pageKey(spacePath, title, id.slice(0, 8)) : base;
}
function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
