// Thin fetch client against the Worker. Same-origin in production (the Worker
// co-deploys this bundle); in dev, point at the local Worker via
// NEXT_PUBLIC_API_BASE (e.g. http://localhost:8787).
const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

// Reads are open; the key is only needed for mutations. In dev it's 'dev-key'
// unless the Worker has ET_AL_API_KEY set (then set NEXT_PUBLIC_ET_AL_KEY).
const KEY = process.env.NEXT_PUBLIC_ET_AL_KEY ?? "dev-key";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init && init.method && init.method !== "GET" ? { "x-api-key": KEY } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => req<T>(path),
  post: <T>(path: string, body?: unknown) => req<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) => req<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
};

// ── shared shapes (mirror src/store) ────────────────────────────────────────
export interface Workspace {
  id: string; parent_id: string | null; type: string; title: string;
  description: string | null; status: string; position: number;
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
