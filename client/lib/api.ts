// Thin fetch client against the Worker. Same-origin in production (the Worker
// co-deploys this bundle); in dev, point at the local Worker via
// NEXT_PUBLIC_API_BASE (e.g. http://localhost:8787).
const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

// Mutations authorize by the httpOnly session cookie the Worker sets at login —
// the key never lives in JS. `credentials: "include"` sends that cookie.
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const err = new Error((body as { error?: string }).error ?? `request failed: ${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => req<T>(path),
  post: <T>(path: string, body?: unknown) => req<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) => req<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body?: unknown) => req<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) }),
  del: <T = { ok: boolean }>(path: string) => req<T>(path, { method: "DELETE" }),
  login: (key: string) => req<{ ok: boolean }>("/login", { method: "POST", body: JSON.stringify({ key }) }),
  logout: () => req<{ ok: boolean }>("/logout", { method: "POST" }),
  session: () => req<{ authed: boolean }>("/session"),
};

// ── shared shapes (mirror src/store) ────────────────────────────────────────
// v8: one primitive. A project, a note, a task and a saved link are all pages;
// what differs is whether a page sits in the tree (parent_page_id) or in a
// collection (collection_id, and its properties mean something).
export interface Page {
  id: string; parent_page_id: string | null; collection_id: string | null;
  title: string; icon: string | null; cover: string | null;
  properties_json: string; position: number; status: string;
  trashed_at: number | null; favorite: number;
  is_ai: number; actor: string; created_at: number; updated_at: number;
}
export interface PageNode extends Page { children: PageNode[] }

/** A page's property values, decoded. */
export function props(p: Page): Record<string, unknown> {
  try { return JSON.parse(p.properties_json) as Record<string, unknown>; } catch { return {}; }
}

export interface PropertyDef { key: string; name: string; type: string; options?: string[] }
export interface Collection {
  id: string; parent_page_id: string | null; title: string; icon: string | null;
  role: string | null; schema_json: string; inline: number; position: number;
}
export function collectionSchema(c: Collection): PropertyDef[] {
  try { return JSON.parse(c.schema_json) as PropertyDef[]; } catch { return []; }
}
export interface CollectionView {
  id: string; collection_id: string; name: string; type: string;
  filter_json: string; sort_json: string; group_by: string | null; position: number;
  widths_json?: string;
}

/** A page from a role collection, with properties already decoded. */
export interface RoleRow extends Page {
  owner_page_id: string | null;
  props: Record<string, unknown>;
}

export interface Health {
  page_id: string; score: number; open_tasks: number; done_tasks: number;
  days_since_activity: number | null;
}
export interface Daily3 {
  date: string; confirmed: boolean; reflection: string | null; streak: number;
  slots: Array<{ slot: number; status: string; task: RoleRow | null }>;
}
export interface RecentEvent {
  id: string; actor: string; action: string; entity_type: string; entity_id: string; created_at: number;
}
export interface Home {
  daily3: Daily3;
  health: Health[];
  root_pages: Page[];
  inbox_count: number;
  recent_activity: RecentEvent[];
}
export interface Block {
  id: string; page_id: string; parent_block_id: string | null; type: string;
  content_json: string; position: number; version: number; is_ai: number;
}
export interface PagePatch {
  id: string; page_id: string; ops_json: string; summary: string;
  status: string; actor: string; created_at: number; page_title?: string;
}

// What the enrich_source queue job writes onto a captured link. It now lands in
// the page's `metadata` property rather than a metadata_json column.
export interface LinkMeta {
  site?: string; title?: string; description?: string; image?: string;
  enriched_at?: number;
}
export function linkMeta(p: Page): LinkMeta | null {
  const raw = props(p).metadata;
  if (typeof raw !== "string") return null;
  try {
    const m = JSON.parse(raw) as LinkMeta;
    return m.enriched_at ? m : null;
  } catch { return null; }
}
// A link captured but not yet decorated. The UI polls while any row is in this
// state, so it must become false eventually no matter what — a link captured
// before enrichment existed, or whose job was dropped, would otherwise keep the
// inbox refetching forever. The job lands in seconds; anything still bare after
// this window is never getting enriched, so stop waiting on it.
const ENRICH_WINDOW_MS = 2 * 60 * 1000;
export function awaitingEnrichment(p: Page): boolean {
  return !!props(p).url && !linkMeta(p) && Date.now() - p.created_at < ENRICH_WINDOW_MS;
}
export interface SearchHit {
  entity_type: string; entity_id: string; title: string; snippet: string; workspace_id: string | null;
}
export interface Relationship {
  id: string; source_type: string; source_id: string; target_type: string; target_id: string; type: string;
}

/** Where a search hit navigates. Everything is a page, so every hit has a home —
 *  in v7 a hit with no workspace was simply an unnavigable dead link. */
export function hitHref(h: SearchHit): string {
  return `/page/?id=${h.entity_id}`;
}

// One block operation, mirrors src/schema BlockOp.
export type BlockOp =
  | { op: "insert"; after?: string | null; parent?: string | null; type: string; content: Record<string, unknown> }
  | { op: "update"; id: string; type?: string; content: Record<string, unknown> }
  | { op: "delete"; id: string }
  | { op: "move"; id: string; after?: string | null; parent?: string | null }
  | { op: "replace_content"; content: string };

// content_json helpers — blocks store { text, ...} as JSON.
export function blockText(b: Block): string {
  try { return (JSON.parse(b.content_json) as { text?: string }).text ?? ""; } catch { return ""; }
}
export function blockContent(b: Block): Record<string, unknown> {
  try { return JSON.parse(b.content_json) as Record<string, unknown>; } catch { return {}; }
}
