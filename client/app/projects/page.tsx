"use client";

// Projects — the daily driver.
//
// Master-detail rather than a dynamic route: the client is a static export, so
// `/projects/[id]` cannot be prerendered for records that do not exist at build
// time. Selection lives in `?id=`, pushed with history.pushState, which keeps
// URLs shareable without any server-side routing.
//
// The next action is the loudest element on both panes, and the UI refuses to
// activate a project without one — the same rule the store enforces, surfaced
// early so it reads as guidance rather than an error.

import { useCallback, useEffect, useState } from "react";
import BodyEditor from "@/components/BodyEditor";
import {
  getProjects, getProject, createProject, updateProject,
  getLogs, createLog, getBacklinks,
  ApiError, type Project, type ProjectLog, type Relation,
} from "@/lib/api";

const STATUSES = ["idea", "planned", "active", "paused", "completed", "archived"] as const;
const LOG_TYPES = ["progress", "decision", "experiment", "problem", "learning", "reflection"] as const;
const TABS = ["Overview", "Log", "Connections"] as const;

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (status?: string) => {
    try {
      setError(null);
      const { projects } = await getProjects(status ? { status } : {});
      setProjects(projects);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load projects");
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSelectedId(params.get("id"));
    load();
  }, [load]);

  function select(id: string | null) {
    setSelectedId(id);
    const url = id ? `?id=${encodeURIComponent(id)}` : window.location.pathname;
    window.history.pushState({}, "", url);
  }

  function onFilter(status: string) {
    setFilter(status);
    setProjects(null);
    load(status || undefined);
  }

  return (
    <>
      <h1>Projects</h1>
      <p style={{ color: "var(--ink-2)", margin: "4px 0 16px" }}>
        Finite efforts with an outcome. An active project always has a next action.
      </p>

      <div className="pick" style={{ marginBottom: 16 }}>
        <button className={filter === "" ? "on" : ""} onClick={() => onFilter("")}>All</button>
        {STATUSES.map((s) => (
          <button key={s} className={filter === s ? "on" : ""} onClick={() => onFilter(s)}>{s}</button>
        ))}
      </div>

      {error && <div className="error-box" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="split">
        <div className="list-pane">
          <NewProject onCreated={(p) => { load(filter || undefined); select(p.id); }} />
          <div className="card">
            {!projects && <><div className="skeleton" /><div className="skeleton" /></>}
            {projects?.length === 0 && (
              <div className="empty">
                <strong>No projects here</strong>
                Describe an idea above — it starts as an idea and only becomes active once
                you can name the next physical step.
              </div>
            )}
            {projects?.map((p) => (
              <button
                key={p.id}
                className={`row selectable ${selectedId === p.id ? "selected" : ""}`}
                onClick={() => select(p.id)}
              >
                <div className="lead">
                  <div className="title">{p.title}</div>
                  <div className="meta">{p.next_action ?? "No next action"}</div>
                </div>
                <span className={`chip ${p.status === "active" ? "ok" : ""}`}>{p.status}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="detail-pane">
          {selectedId
            ? <ProjectDetail id={selectedId} onSaved={() => load(filter || undefined)} />
            : <div className="card"><div className="empty">
                <strong>Select a project</strong>
                Its overview, engineer log, and connections live here.
              </div></div>}
        </div>
      </div>
    </>
  );
}

function NewProject({ onCreated }: { onCreated: (p: Project) => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      onCreated(await createProject({ title: title.trim(), status: "idea" }));
      setTitle("");
    } finally { setBusy(false); }
  }

  return (
    <form className="capture" style={{ marginBottom: 0 }} onSubmit={submit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)}
        placeholder="New project idea…" aria-label="New project" />
      <button className="btn" disabled={busy || !title.trim()}>Add</button>
    </form>
  );
}

function ProjectDetail({ id, onSaved }: { id: string; onSaved: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [error, setError] = useState<string | null>(null);
  const [nextAction, setNextAction] = useState("");

  const reload = useCallback(async () => {
    const p = await getProject(id);
    setProject(p);
    setNextAction(p.next_action ?? "");
  }, [id]);

  useEffect(() => { setProject(null); setTab("Overview"); reload().catch(() => {}); }, [id, reload]);

  async function patch(body: Partial<Project>) {
    setError(null);
    try {
      const updated = await updateProject(id, body);
      setProject(updated);
      setNextAction(updated.next_action ?? "");
      onSaved();
    } catch (e) {
      // The store rejects activation without a next action; show it plainly.
      setError(e instanceof ApiError ? e.message : "Could not update");
    }
  }

  if (!project) return <div className="card"><div className="skeleton" /><div className="skeleton" /></div>;

  return (
    <>
      <input
        className="title-field"
        value={project.title}
        onChange={(e) => setProject({ ...project, title: e.target.value })}
        onBlur={(e) => e.target.value !== "" && patch({ title: e.target.value })}
        aria-label="Project title"
      />

      <div className="pick" style={{ margin: "8px 0 12px" }}>
        {STATUSES.map((s) => (
          <button key={s} className={project.status === s ? "on" : ""}
            onClick={() => patch({ status: s })}>{s}</button>
        ))}
      </div>

      {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="next-action" style={{ marginBottom: 14 }}>
        <div className="label">Next action{project.status === "active" && " · required"}</div>
        <input
          className="title-field" style={{ fontSize: 14, fontWeight: 600 }}
          value={nextAction}
          onChange={(e) => setNextAction(e.target.value)}
          onBlur={() => nextAction !== (project.next_action ?? "") && patch({ next_action: nextAction })}
          placeholder="The next physical, visible step…"
          aria-label="Next action"
        />
      </div>

      <div className="pick" style={{ marginBottom: 14 }}>
        {TABS.map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {tab === "Overview" && (
        <BodyEditor resource="projects" subjectType="project" id={id} title={project.title} />
      )}
      {tab === "Log" && <ProjectLogTab projectId={id} />}
      {tab === "Connections" && <Connections resource="projects" id={id} />}
    </>
  );
}

function ProjectLogTab({ projectId }: { projectId: string }) {
  const [logs, setLogs] = useState<ProjectLog[] | null>(null);
  const [entryType, setEntryType] = useState<string>("progress");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    getLogs({ project_id: projectId }).then((r) => setLogs(r.logs)).catch(() => setLogs([]));
  }, [projectId]);

  useEffect(() => { setLogs(null); load(); }, [load]);

  async function add() {
    const log = await createLog({ project_id: projectId, entry_type: entryType });
    setOpenId(log.id);
    load();
  }

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <div className="pick">
          {LOG_TYPES.map((t) => (
            <button key={t} className={entryType === t ? "on" : ""} onClick={() => setEntryType(t)}>{t}</button>
          ))}
        </div>
        <button className="btn primary" onClick={add}>Add entry</button>
      </div>

      {!logs && <div className="card"><div className="skeleton" /></div>}
      {logs?.length === 0 && (
        <div className="card"><div className="empty">
          <strong>No log entries yet</strong>
          Decisions, experiments, and dead ends recorded here become reusable evidence —
          and the raw material for content later.
        </div></div>
      )}

      {logs?.map((log) => (
        <div className="card" key={log.id} style={{ marginBottom: 10 }}>
          <div className="row">
            <div className="lead">
              <div className="title">{log.title || log.entry_type}</div>
              <div className="meta">{new Date(log.created_at * 1000).toLocaleString()}</div>
            </div>
            <span className="chip">{log.entry_type}</span>
            <button className="btn" onClick={() => setOpenId(openId === log.id ? null : log.id)}>
              {openId === log.id ? "Close" : "Open"}
            </button>
          </div>
          {openId === log.id && (
            <div style={{ padding: "10px 14px 14px" }}>
              <BodyEditor
                resource="logs" subjectType="project_log" id={log.id}
                title={log.title || log.entry_type}
              />
            </div>
          )}
        </div>
      ))}
    </>
  );
}

export function Connections({ resource, id }: { resource: string; id: string }) {
  const [backlinks, setBacklinks] = useState<Relation[] | null>(null);

  useEffect(() => {
    setBacklinks(null);
    getBacklinks(resource, id).then((r) => setBacklinks(r.backlinks)).catch(() => setBacklinks([]));
  }, [resource, id]);

  return (
    <div className="card">
      {!backlinks && <div className="skeleton" />}
      {backlinks?.length === 0 && (
        <div className="empty">
          <strong>Nothing links here yet</strong>
          Write <code>[[Another page]]</code> in any body to create a connection.
        </div>
      )}
      {backlinks?.map((r) => (
        <div className="row" key={r.id}>
          <div className="lead">
            <div className="title">{r.source_type.replace(/_/g, " ")}</div>
            <div className="meta">{r.context || r.relation_type}</div>
          </div>
          <span className="chip">{r.relation_type}</span>
        </div>
      ))}
    </div>
  );
}
