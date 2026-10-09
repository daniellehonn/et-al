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

export interface Note {
  id: string; parent_id: string | null; title: string; position: number;
  source_id: string | null; actor: string; trashed_at: number | null; trash_root: number;
  created_at: number; updated_at: number;
}
export interface NoteNode extends Note { children: NoteNode[] }

/** Every note in a tree, depth-first. */
export function flattenTree(nodes: NoteNode[], out: NoteNode[] = []): NoteNode[] {
  for (const n of nodes) { out.push(n); flattenTree(n.children, out); }
  return out;
}

export interface Block {
  id: string; note_id: string; parent_block_id: string | null; type: string;
  content_json: string; position: number; version: number; actor: string;
}

export interface HistoryEntry {
  id: string; block_id: string; content_json: string; version: number; actor: string;
  created_at: number; block_type: string | null; current_content: string | null;
}

export type TaskStatus = "todo" | "doing" | "done";
export interface Task {
  id: string; title: string; status: TaskStatus; due_at: number | null;
  parent_id: string | null; note_id: string | null; position: number; actor: string;
  completed_at: number | null; created_at: number; updated_at: number;
}
export interface TaskNode extends Task { subtasks: TaskNode[] }

export interface Source {
  id: string; title: string; url: string | null; text: string | null;
  status: "inbox" | "done"; note_id: string | null;
  fetch_status: "pending" | "fetched" | "failed" | null; fetch_error: string | null;
  site: string | null; description: string | null; image: string | null;
  actor: string; created_at: number; updated_at: number;
}

export interface Proposal {
  id: string; kind: "patch" | "insight"; note_id: string | null; source_id: string | null;
  summary: string; payload: string; status: "pending" | "accepted" | "rejected";
  actor: string; result_id: string | null; created_at: number;
  note_title: string | null; source_title: string | null;
}
/** What accepting a proposal would do: a patch's diff (or why it is stale),
 *  or the insight that would become a note. */
export type ProposalPreview =
  | { kind: "patch"; before: string[]; after: string[]; diff: Array<{ kind: "same" | "add" | "del"; text: string }> }
  | { kind: "patch"; stale: string }
  | { kind: "insight"; insight: InsightPayload };

/** What an insight proposal carries. */
export interface InsightPayload { title: string; content: string; segment: string; importance: number }

export interface RecentEvent {
  id: string; actor: string; action: string; entity_type: string; entity_id: string; created_at: number;
  detail: Record<string, unknown> | null;
}

/** An event as a sentence and a place to go: "proposed an edit: Expand the list". */
export function describeEvent(e: RecentEvent): { text: string; subject: string; href: string | null } {
  const d = e.detail ?? {};
  const subject = String(d.title ?? d.summary ?? "");
  const verbs: Record<string, string> = {
    "create:note": "created a note", "update:note": "renamed a note", "move:note": "moved a note",
    "create:task": "added a task", "update:task": "updated a task", "complete:task": "finished a task", "delete:task": "deleted a task",
    "capture:source": "saved", "file:source": "filed a source",
    "propose:proposal": d.kind === "insight" ? "suggested an insight" : "proposed an edit",
  };
  const href = e.entity_type === "note" ? `/note/?id=${e.entity_id}`
    : e.entity_type === "source" ? `/source/?id=${e.entity_id}`
    : e.entity_type === "task" ? "/tasks/"
    : e.entity_type === "proposal" ? "/review/" : null;
  return { text: verbs[`${e.action}:${e.entity_type}`] ?? `${e.action.replace(/_/g, " ")} ${e.entity_type}`, subject, href };
}

export interface SearchHit {
  entity_type: "note" | "task" | "source" | "proposal"; entity_id: string; title: string; snippet: string;
}

/** Where a search hit navigates. */
export function hitHref(h: SearchHit): string {
  if (h.entity_type === "source") return `/source/?id=${h.entity_id}`;
  if (h.entity_type === "task") return "/tasks/";
  return `/note/?id=${h.entity_id}`;
}

/** Who wrote something, for display: an agent's client name, or "you". */
export function actorLabel(actor: string): string {
  return actor === "human" ? "you" : actor === "system" ? "extractor" : actor.replace(/^ai:/, "");
}

// One block operation, mirrors src/schema BlockOp.
export type BlockOp =
  | { op: "insert"; after?: string | null; parent?: string | null; type: string; content: Record<string, unknown> }
  | { op: "update"; id: string; type?: string; content: Record<string, unknown> }
  | { op: "delete"; id: string }
  | { op: "move"; id: string; after?: string | null; parent?: string | null }
  | { op: "replace_content"; content: string };
