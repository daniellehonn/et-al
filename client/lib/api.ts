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
  del: <T = { ok: boolean }>(path: string) => req<T>(path, { method: "DELETE" }),
  login: (key: string) => req<{ ok: boolean }>("/login", { method: "POST", body: JSON.stringify({ key }) }),
  logout: () => req<{ ok: boolean }>("/logout", { method: "POST" }),
  session: () => req<{ authed: boolean }>("/session"),
};

// ── shared shapes (mirror src/store) ────────────────────────────────────────
export interface Workspace {
  id: string; parent_id: string | null; type: string; title: string;
  description: string | null; status: string; position: number;
  icon: string | null; cover: string | null;
}
export interface Task {
  id: string; workspace_id: string; objective_id: string | null; title: string;
  status: string; priority: number; due_date: number | null; completed_at: number | null;
}
export interface Health {
  workspace_id: string; score: number; open_tasks: number; done_tasks: number;
  days_since_activity: number | null;
}
export interface Daily3 {
  date: string; confirmed: boolean; reflection: string | null; streak: number;
  slots: Array<{ slot: number; status: string; task: Task | null }>;
}
export interface RecentEvent {
  id: string; actor: string; action: string; entity_type: string; entity_id: string; created_at: number;
}
export interface Home {
  daily3: Daily3;
  health: Health[];
  active_workspaces: Workspace[];
  inbox_count: number;
  recent_activity: RecentEvent[];
}
export interface Objective {
  id: string; workspace_id: string; parent_objective_id: string | null;
  title: string; description: string | null; status: string; priority: number;
}
export interface Document {
  id: string; workspace_id: string; title: string; type: string; status: string;
  icon: string | null; cover: string | null; updated_at: number;
}
export interface Block {
  id: string; document_id: string; type: string; content_json: string;
  position: number; version: number; is_ai: number;
}
export interface DocumentPatch {
  id: string; document_id: string; ops_json: string; summary: string;
  status: string; actor: string; created_at: number;
}
export interface Decision {
  id: string; workspace_id: string; title: string; rationale: string;
  alternatives_json: string | null; impact: string | null; decided_on: number; actor: string;
}
export interface Insight {
  id: string; workspace_id: string | null; title: string; body: string;
  source_id: string | null; is_ai: number; created_at: number;
}
export interface Source {
  id: string; workspace_id: string | null; kind: string; title: string | null;
  url: string | null; raw: string | null; status: string; created_at: number;
}
export interface SearchHit {
  entity_type: string; entity_id: string; title: string; snippet: string; workspace_id: string | null;
}
export interface Relationship {
  id: string; source_type: string; source_id: string; target_type: string; target_id: string; type: string;
}

// Where a search hit navigates. Documents deep-open in their workspace tab.
export function hitHref(h: SearchHit): string | null {
  const tabFor: Record<string, string> = { task: "Tasks", decision: "Decisions", document: "Documents" };
  if (h.entity_type === "workspace") return `/workspace/?id=${h.entity_id}`;
  if (h.entity_type === "insight") return "/knowledge/";
  if (h.entity_type === "source") return "/inbox/";
  if (!h.workspace_id) return null;
  const tab = tabFor[h.entity_type];
  const doc = h.entity_type === "document" ? `&doc=${h.entity_id}` : "";
  return `/workspace/?id=${h.workspace_id}${tab ? `&tab=${tab}` : ""}${doc}`;
}

// One block operation, mirrors src/schema BlockOp.
export type BlockOp =
  | { op: "insert"; after?: string | null; type: string; content: Record<string, unknown> }
  | { op: "update"; id: string; type?: string; content: Record<string, unknown> }
  | { op: "delete"; id: string }
  | { op: "move"; id: string; after?: string | null };

// content_json helpers — blocks store { text, ...} as JSON.
export function blockText(b: Block): string {
  try { return (JSON.parse(b.content_json) as { text?: string }).text ?? ""; } catch { return ""; }
}
