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

export const getHome = () => api.get<HomeData>("/api/home");
export const getAreas = () => api.get<{ areas: Area[] }>("/api/areas");
export const getSession = () => api.get<{ authenticated: boolean }>("/api/session");
export const login = (key: string) => api.post<{ authenticated: boolean }>("/api/session", { key });
export const createCapture = (raw_input: string) =>
  api.post<Capture>("/api/captures", { raw_input });
