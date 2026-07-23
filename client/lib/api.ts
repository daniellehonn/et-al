// API client.
//
// Every path here is RELATIVE — never an absolute origin. That is the whole
// point of the co-deploy decision: the Worker serves this bundle from its own
// [assets] binding, so the client and the API are the same origin. Consequences
// worth stating, because they are easy to undo by accident:
//
//   * `credentials: "same-origin"` is enough; the `et_al_session` cookie keeps
//     `SameSite=Lax`, which is what makes CSRF a non-issue.
//   * No CORS headers, no allowlist, and no preflight OPTIONS round-trip before
//     mutations.
//
// If a future build ever points this at an absolute API origin, the cookie must
// become `SameSite=None; Secure`, the Worker must echo a specific origin instead
// of `*`, and CSRF protection has to be reintroduced. Don't do it casually.

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  const data = text ? safeJson(text) : null;

  if (!response.ok) {
    // The Worker reports failures as { error, code }; fall back to the status
    // when a proxy or the runtime returns something else.
    const fromBody =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : "";

    // Reads are open but writes need the session cookie, so an expired or
    // never-established session makes every save fail while the page still
    // looks completely healthy. Announce it globally instead of letting each
    // call site discover it alone — a silent 401 is indistinguishable from a
    // broken app.
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("et-al:unauthorized"));
    }
    throw new ApiError(fromBody || `Request failed (${response.status})`, response.status);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ---------------------------------------------------------------------------
// Shapes mirroring the Worker's responses (src/api.ts, src/store/*)
// ---------------------------------------------------------------------------

export interface HomeData {
  active_projects: Array<{ id: string; title: string; next_action: string | null }>;
  stale_projects: Array<{ id: string; title: string; last_activity_at: number | null }>;
  projects_missing_next_action: Array<{ id: string; title: string }>;
  inbox_count: number;
  inbox: Array<{ id: string; raw_input: string; input_type: string; processing_status: string }>;
  test_queue: Array<{ id: string; name: string; status: string }>;
  recent_learning: Array<{ id: string; title: string; mastery: string }>;
  content_opportunities: Array<{ id: string; title: string | null; project_id: string }>;
}

export interface Area {
  id: string; name: string; icon: string | null; accent: string | null; status: string;
}

export interface Capture {
  id: string; raw_input: string; input_type: string;
  processing_status: string; processing_error: string | null; review_status: string;
  created_at: number;
}

export interface Project {
  id: string; title: string; summary: string | null; status: string;
  priority: string | null; next_action: string | null;
  target_date: number | null; repository_url: string | null; live_url: string | null;
  body_document_id: string | null; portfolio_ready: boolean;
  last_activity_at: number | null; completed_at: number | null;
  area_ids: string[]; goal_ids: string[];
  created_at: number; updated_at: number;
}

export interface ProjectLog {
  id: string; project_id: string; entry_type: string; title: string | null;
  body_document_id: string | null; content_seed_status: string;
  created_at: number; updated_at: number;
}

export interface Note {
  id: string; title: string; note_type: string; mastery: string;
  body_document_id: string | null; created_at: number; updated_at: number;
}

export interface Tool {
  id: string; name: string; url: string | null; status: string;
  expected_use: string | null; test_criteria: string | null;
  verdict: string | null; rating: number | null; tested_at: number | null;
}

export interface Source {
  id: string; title: string; url: string | null; platform: string;
  author: string | null; summary: string | null; transcript: string | null;
}

export interface ContentItem {
  id: string; title: string; status: string; format: string | null;
  channel: string | null; hook: string | null; audience: string | null;
  body_document_id: string | null; published_url: string | null;
}

export interface Block {
  id: string; type: string; text: string;
  data: Record<string, unknown>; is_ai: boolean;
}

export interface DocumentDoc {
  id: string; owner_type: string; owner_id: string | null; blocks: Block[];
}

export interface Relation {
  id: string; source_type: string; source_id: string;
  target_type: string | null; target_id: string | null; target_norm: string | null;
  relation_type: string; context: string;
}

export interface ReviewData {
  steps: Array<{ key: string; title: string; items: unknown[] }>;
}

export interface SearchHit {
  subject_id: string; subject_type: string; title: string; snippet: string;
  /** Which layers produced the hit: "keyword", "semantic", or both. */
  matched?: string[];
  score?: number;
}

/** Query strings built from a filter object, skipping empty values. */
function qs(params: Record<string, string | number | undefined | null>): string {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
}

export const getHome = () => api.get<HomeData>("/api/home");
export const getReview = () => api.get<ReviewData>("/api/review");

export const getProjects = (f: { status?: string; area_id?: string } = {}) =>
  api.get<{ projects: Project[] }>(`/api/projects${qs(f)}`);
export const getProject = (id: string) => api.get<Project>(`/api/projects/${id}`);
export const createProject = (body: Partial<Project>) => api.post<Project>("/api/projects", body);
export const updateProject = (id: string, body: Partial<Project>) =>
  api.patch<Project>(`/api/projects/${id}`, body);

export const getLogs = (f: { project_id?: string; entry_type?: string } = {}) =>
  api.get<{ logs: ProjectLog[] }>(`/api/logs${qs(f)}`);
export const createLog = (body: { project_id: string; entry_type?: string; title?: string }) =>
  api.post<ProjectLog>("/api/logs", body);

export const getNotes = (f: { mastery?: string; note_type?: string } = {}) =>
  api.get<{ notes: Note[] }>(`/api/notes${qs(f)}`);
export const createNote = (body: { title: string; note_type?: string }) =>
  api.post<Note>("/api/notes", body);
export const updateNote = (id: string, body: Partial<Note>) =>
  api.patch<Note>(`/api/notes/${id}`, body);

export const getTools = (f: { status?: string } = {}) =>
  api.get<{ tools: Tool[] }>(`/api/tools${qs(f)}`);
export const createTool = (body: Partial<Tool>) => api.post<Tool>("/api/tools", body);
export const updateTool = (id: string, body: Partial<Tool>) =>
  api.patch<Tool>(`/api/tools/${id}`, body);

export const getSources = () => api.get<{ sources: Source[] }>("/api/sources");

export const getContent = (f: { status?: string } = {}) =>
  api.get<{ content: ContentItem[] }>(`/api/content${qs(f)}`);
export const createContent = (body: Partial<ContentItem>) =>
  api.post<ContentItem>("/api/content", body);
export const updateContent = (id: string, body: Partial<ContentItem>) =>
  api.patch<ContentItem>(`/api/content/${id}`, body);

export const getCaptures = (f: { review_status?: string } = {}) =>
  api.get<{ captures: Capture[] }>(`/api/captures${qs(f)}`);
export const updateCapture = (id: string, body: { review_status?: string }) =>
  api.patch<Capture>(`/api/captures/${id}`, body);
export const retryCapture = (id: string) => api.post<Capture>(`/api/captures/${id}/retry`);
export const deleteCapture = (id: string) => api.delete<{ ok: boolean }>(`/api/captures/${id}`);

/** Lazily creates the body document server-side on first open. */
export const getBody = (resource: string, id: string) =>
  api.get<DocumentDoc>(`/api/${resource}/${id}/body`);
export const saveBody = (
  documentId: string,
  payload: { blocks: Array<Partial<Block>>; subject_type: string; subject_id: string; title: string },
) => api.put<DocumentDoc>(`/api/documents/${documentId}`, payload);

export const getBacklinks = (resource: string, id: string) =>
  api.get<{ backlinks: Relation[] }>(`/api/${resource}/${id}/backlinks`);
export const createRelation = (body: Partial<Relation> & { target_title?: string }) =>
  api.post<Relation>("/api/relations", body);

export const search = (q: string, type?: string) =>
  api.get<{ results: SearchHit[] }>(`/api/search${qs({ q, type })}`);

// ---- session & capture (restored: these back the Home screen and unlock) ----
export const getAreas = () => api.get<{ areas: Area[] }>("/api/areas");
export const getSession = () => api.get<{ authenticated: boolean }>("/api/session");
export const login = (key: string) => api.post<{ authenticated: boolean }>("/api/session", { key });
export const createCapture = (raw_input: string) => api.post<Capture>("/api/captures", { raw_input });

// ---- Phase 5/6 surfaces ----
export interface Goal {
  id: string; title: string; type: string; timeframe: string | null;
  metric_name: string | null; target_value: number | null; current_value: number | null;
  status: string; area_id: string | null;
}

export interface IdentityStudio {
  period_days: number;
  themes: Array<{ area: string; projects: number; notes_applied: number; outputs: number }>;
  evidence: {
    completed_projects: Array<{ id: string; title: string; completed_at: number | null; outputs: number }>;
    applied_knowledge: Array<{ id: string; title: string; used_in: number }>;
    adopted_tools: Array<{ id: string; name: string; verdict: string | null }>;
    published: Array<{ id: string; title: string; channel: string | null; url: string | null }>;
  };
  portfolio_queue: Array<{ id: string; title: string; reason: string }>;
  gaps: string[];
}

export interface CompletionChecklist {
  project_id: string;
  has_retrospective: boolean;
  learnings_to_promote: Array<{ id: string; title: string | null }>;
  reusable_decisions: number;
  outputs: number;
  suggestions: string[];
}

export const getGoals = (f: { area_id?: string; status?: string } = {}) =>
  api.get<{ goals: Goal[] }>(`/api/goals${qs(f)}`);
export const createGoal = (body: Partial<Goal>) => api.post<Goal>("/api/goals", body);
export const updateGoal = (id: string, body: Partial<Goal>) => api.patch<Goal>(`/api/goals/${id}`, body);

export const getIdentity = (days?: number) =>
  api.get<IdentityStudio>(`/api/identity${qs({ days })}`);
export const getCompletion = (projectId: string) =>
  api.get<CompletionChecklist>(`/api/projects/${projectId}/completion`);

export const writeSnapshot = () =>
  api.post<{ prefix: string; files: number; bytes: number }>("/api/export/snapshot");
export const backfillEmbeddings = () =>
  api.post<{ indexed: number; skipped: number }>("/api/embeddings/backfill");

/** Content seed created from real work, preserving provenance. */
export const createSeedFrom = async (
  origin: { type: string; id: string }, title: string,
) => {
  const item = await createContent({ title });
  await createRelation({
    source_type: "content_item", source_id: item.id,
    target_type: origin.type, target_id: origin.id,
    relation_type: "created-from", context: `seeded from ${origin.type}`,
  });
  return item;
};

// ---- deletion ----
// Every entity supported delete server-side from Phase 1; none of it was
// reachable from the UI, which is worse than not having it. These are the
// client bindings for the generic DELETE route.
export const deleteProject = (id: string) => api.delete<{ ok: boolean }>(`/api/projects/${id}`);
export const deleteNote = (id: string) => api.delete<{ ok: boolean }>(`/api/notes/${id}`);
export const deleteGoal = (id: string) => api.delete<{ ok: boolean }>(`/api/goals/${id}`);
export const deleteTool = (id: string) => api.delete<{ ok: boolean }>(`/api/tools/${id}`);
export const deleteSource = (id: string) => api.delete<{ ok: boolean }>(`/api/sources/${id}`);
export const deleteContent = (id: string) => api.delete<{ ok: boolean }>(`/api/content/${id}`);
export const deleteLog = (id: string) => api.delete<{ ok: boolean }>(`/api/logs/${id}`);
export const deleteArea = (id: string) => api.delete<{ ok: boolean }>(`/api/areas/${id}`);
export const completeReview = (steps_completed: number) =>
  api.post<{ ok: boolean }>("/api/review/complete", { steps_completed });
