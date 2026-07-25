"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type Workspace, type Task, type Objective, type Document, type Decision, type RecentEvent } from "@/lib/api";
import { BlockEditor } from "./BlockEditor";

const TABS = ["Overview", "Objectives", "Tasks", "Documents", "Decisions", "Timeline"] as const;
type Tab = (typeof TABS)[number];

export function WorkspaceView({ id, initialTab, initialDoc }: { id: string; initialTab?: string; initialDoc?: string }) {
  const [tab, setTab] = useState<Tab>((TABS as readonly string[]).includes(initialTab ?? "") ? (initialTab as Tab) : "Overview");
  const { data: workspace, isLoading } = useQuery({ queryKey: ["workspace", id], queryFn: () => api.get<Workspace>(`/workspaces/${id}`) });
  const { data: all } = useQuery({ queryKey: ["workspaces"], queryFn: () => api.get<Workspace[]>("/workspaces") });

  if (isLoading) return <div className="et-ws-page"><div className="et-empty">Loading…</div></div>;
  if (!workspace) return <div className="et-ws-page"><div className="et-empty">Workspace not found.</div></div>;

  // Breadcrumb from the cached tree.
  const crumbs: Workspace[] = [];
  let cur: Workspace | undefined = workspace;
  const byId = new Map((all ?? []).map((w) => [w.id, w]));
  while (cur) { crumbs.unshift(cur); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined; }

  return (
    <div className="et-ws-page">
      <header className="et-ws-header">
        <div className="eyebrow et-crumbs">
          {crumbs.map((w, i) => (
            <span key={w.id}>{i > 0 && <span className="et-crumb-sep"> / </span>}
              {w.id === id ? <span className="et-crumb-here">{w.title}</span> : <a href={`/workspace/?id=${w.id}`}>{w.title}</a>}
            </span>
          ))}
        </div>
        <h1 className="serif et-ws-title">{workspace.title}</h1>
        <div className="et-ws-meta">
          <span className="et-tag" data-type={workspace.type}>{workspace.type}</span>
          {workspace.description && <span className="et-ws-desc">{workspace.description}</span>}
        </div>
      </header>

      <nav className="et-tabs">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className="et-tab" data-active={tab === t}>{t}</button>
        ))}
      </nav>

      <div className="et-tab-body">
        {tab === "Overview" && <Overview id={id} workspace={workspace} setTab={setTab} />}
        {tab === "Objectives" && <Objectives id={id} />}
        {tab === "Tasks" && <Tasks id={id} />}
        {tab === "Documents" && <Documents id={id} initialDoc={initialDoc} />}
        {tab === "Decisions" && <Decisions id={id} />}
        {tab === "Timeline" && <Timeline id={id} />}
      </div>

      <WorkspaceStyles />
    </div>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────
function Overview({ id, workspace, setTab }: { id: string; workspace: Workspace; setTab: (t: Tab) => void }) {
  const { data: tasks } = useQuery({ queryKey: ["tasks", id], queryFn: () => api.get<Task[]>(`/workspaces/${id}/tasks`) });
  const { data: objectives } = useQuery({ queryKey: ["objectives", id], queryFn: () => api.get<Objective[]>(`/workspaces/${id}/objectives`) });
  const { data: docs } = useQuery({ queryKey: ["documents", id], queryFn: () => api.get<Document[]>(`/workspaces/${id}/documents`) });
  const open = (tasks ?? []).filter((t) => t.status !== "done");
  const cards: Array<[string, number, Tab]> = [
    ["Open tasks", open.length, "Tasks"],
    ["Objectives", (objectives ?? []).length, "Objectives"],
    ["Documents", (docs ?? []).length, "Documents"],
  ];
  return (
    <div>
      <div className="et-stat-row">
        {cards.map(([label, n, t]) => (
          <button key={label} className="et-stat" onClick={() => setTab(t)}>
            <span className="serif et-stat-num">{n}</span>
            <span className="eyebrow">{label}</span>
          </button>
        ))}
      </div>
      <div className="et-overview-next">
        <span className="eyebrow">Next up</span>
        {open.slice(0, 3).map((t) => <div key={t.id} className="et-next-task">{t.title}</div>)}
        {open.length === 0 && <div className="et-empty">No open tasks. {workspace.type === "project" ? "An active project should have a next action." : ""}</div>}
      </div>
    </div>
  );
}

// ── Objectives (planning view: tasks nested under each objective) ────────────
function Objectives({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data: objectives } = useQuery({ queryKey: ["objectives", id], queryFn: () => api.get<Objective[]>(`/workspaces/${id}/objectives`) });
  const { data: tasks } = useQuery({ queryKey: ["tasks", id], queryFn: () => api.get<Task[]>(`/workspaces/${id}/tasks`) });
  const [title, setTitle] = useState("");
  const add = useMutation({
    mutationFn: () => api.post("/objectives", { workspace_id: id, title }),
    onSuccess: () => { setTitle(""); qc.invalidateQueries({ queryKey: ["objectives", id] }); },
  });
  const toggle = useMutation({
    mutationFn: (t: Task) => api.patch(`/tasks/${t.id}`, { status: t.status === "done" ? "todo" : "done" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks", id] }),
  });
  const tasksFor = (oid: string) => (tasks ?? []).filter((t) => t.objective_id === oid);

  return (
    <div>
      {(objectives ?? []).map((o) => (
        <ObjectiveGroup key={o.id} workspaceId={id} objective={o} tasks={tasksFor(o.id)} onToggle={(t) => toggle.mutate(t)} />
      ))}
      {objectives?.length === 0 && <div className="et-empty">No objectives yet — the &ldquo;why&rdquo; behind the work. Break one into tasks below.</div>}
      <QuickAdd value={title} setValue={setTitle} onAdd={() => title.trim() && add.mutate()} placeholder="New objective — why does this matter?" pending={add.isPending} />
    </div>
  );
}

function ObjectiveGroup({ workspaceId, objective, tasks, onToggle }: { workspaceId: string; objective: Objective; tasks: Task[]; onToggle: (t: Task) => void }) {
  const qc = useQueryClient();
  const [taskTitle, setTaskTitle] = useState("");
  const addTask = useMutation({
    mutationFn: () => api.post("/tasks", { workspace_id: workspaceId, objective_id: objective.id, title: taskTitle }),
    onSuccess: () => { setTaskTitle(""); qc.invalidateQueries({ queryKey: ["tasks", workspaceId] }); },
  });
  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");
  return (
    <div className="et-obj-group">
      <div className="et-obj-head">
        <span className="et-prio" data-p={objective.priority} />
        <span className="et-obj-title">{objective.title}</span>
        <span className="eyebrow et-status">{open.length} open{done.length ? ` · ${done.length} done` : ""}</span>
      </div>
      <div className="et-obj-tasks">
        {[...open, ...done].map((t) => (
          <button key={t.id} className="et-task-row" data-done={t.status === "done" || undefined} onClick={() => onToggle(t)}>
            <span className="et-check" {...(t.status === "done" ? { "data-checked": true } : {})} />
            <span className="et-task-title">{t.title}</span>
          </button>
        ))}
        <QuickAdd value={taskTitle} setValue={setTaskTitle} onAdd={() => taskTitle.trim() && addTask.mutate()} placeholder="Add a task to this objective" pending={addTask.isPending} />
      </div>
    </div>
  );
}

// ── Tasks ───────────────────────────────────────────────────────────────────
function Tasks({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["tasks", id], queryFn: () => api.get<Task[]>(`/workspaces/${id}/tasks`) });
  const [title, setTitle] = useState("");
  const add = useMutation({
    mutationFn: () => api.post("/tasks", { workspace_id: id, title }),
    onSuccess: () => { setTitle(""); qc.invalidateQueries({ queryKey: ["tasks", id] }); },
  });
  const toggle = useMutation({
    mutationFn: (t: Task) => api.patch(`/tasks/${t.id}`, { status: t.status === "done" ? "todo" : "done" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks", id] }),
  });
  const open = (data ?? []).filter((t) => t.status !== "done");
  const done = (data ?? []).filter((t) => t.status === "done");
  return (
    <div>
      {open.map((t) => (
        <button key={t.id} className="et-task-row" onClick={() => toggle.mutate(t)}>
          <span className="et-check" />
          <span className="et-prio" data-p={t.priority} />
          <span className="et-task-title">{t.title}</span>
        </button>
      ))}
      {open.length === 0 && <div className="et-empty">Nothing open.</div>}
      <QuickAdd value={title} setValue={setTitle} onAdd={() => title.trim() && add.mutate()} placeholder="New task" pending={add.isPending} />
      {done.length > 0 && (
        <div className="et-done-group">
          <span className="eyebrow">Done · {done.length}</span>
          {done.map((t) => (
            <button key={t.id} className="et-task-row" data-done onClick={() => toggle.mutate(t)}>
              <span className="et-check" data-checked />
              <span className="et-task-title">{t.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Documents (+ editor) ─────────────────────────────────────────────────────
function Documents({ id, initialDoc }: { id: string; initialDoc?: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["documents", id], queryFn: () => api.get<Document[]>(`/workspaces/${id}/documents`) });
  const [openDoc, setOpenDoc] = useState<Document | null>(null);
  const [deepLinked, setDeepLinked] = useState(false);

  // Deep-link: open the document named in the URL once, when documents load.
  useEffect(() => {
    if (deepLinked || !initialDoc || !data) return;
    const match = data.find((d) => d.id === initialDoc);
    setDeepLinked(true);
    if (match) setOpenDoc(match);
  }, [data, initialDoc, deepLinked]);
  const [title, setTitle] = useState("");
  const add = useMutation({
    mutationFn: () => api.post<Document>("/documents", { workspace_id: id, title }),
    onSuccess: (doc) => { setTitle(""); qc.invalidateQueries({ queryKey: ["documents", id] }); setOpenDoc(doc); },
  });

  if (openDoc) {
    return (
      <div>
        <button className="et-back" onClick={() => setOpenDoc(null)}>← All documents</button>
        <h2 className="serif et-doc-title">{openDoc.title}</h2>
        <BlockEditor documentId={openDoc.id} />
      </div>
    );
  }
  return (
    <div>
      {(data ?? []).map((d) => (
        <button key={d.id} className="et-doc-row" onClick={() => setOpenDoc(d)}>
          <span className="et-doc-icon serif">¶</span>
          <span>{d.title}</span>
          <span className="eyebrow et-status">{d.type}</span>
        </button>
      ))}
      {data?.length === 0 && <div className="et-empty">No documents. These are the living artifacts you and agents co-write.</div>}
      <QuickAdd value={title} setValue={setTitle} onAdd={() => title.trim() && add.mutate()} placeholder="New document" pending={add.isPending} />
    </div>
  );
}

// ── Decisions ────────────────────────────────────────────────────────────────
function Decisions({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["decisions", id], queryFn: () => api.get<Decision[]>(`/workspaces/${id}/decisions`) });
  const [title, setTitle] = useState("");
  const [rationale, setRationale] = useState("");
  const add = useMutation({
    mutationFn: () => api.post("/decisions", { workspace_id: id, title, rationale }),
    onSuccess: () => { setTitle(""); setRationale(""); qc.invalidateQueries({ queryKey: ["decisions", id] }); },
  });
  return (
    <div>
      {(data ?? []).map((d) => (
        <div key={d.id} className="et-decision">
          <div className="et-decision-title">{d.title}</div>
          <div className="et-decision-why">{d.rationale}</div>
          <div className="eyebrow">{new Date(d.decided_on).toLocaleDateString()} · {d.actor}</div>
        </div>
      ))}
      {data?.length === 0 && <div className="et-empty">No decisions recorded. Capture the &ldquo;we chose X because Y&rdquo; that history forgets.</div>}
      <div className="et-decision-form">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Decision" />
        <input value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Rationale — why" />
        <button disabled={!title.trim() || !rationale.trim() || add.isPending} onClick={() => add.mutate()}>Record</button>
      </div>
    </div>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────────
function Timeline({ id }: { id: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["timeline", id], queryFn: () => api.get<RecentEvent[]>(`/workspaces/${id}/timeline`) });
  return (
    <div className="et-timeline">
      {(data ?? []).map((e) => (
        <div key={e.id} className="et-tl-row">
          <span className="et-tl-mark" data-ai={e.actor.startsWith("ai:")}>{e.actor.startsWith("ai:") ? "&" : "·"}</span>
          <span className="et-tl-text">{e.action.replace(/_/g, " ")} <span className="et-tl-type">{e.entity_type}</span></span>
          <span className="eyebrow et-tl-time">{new Date(e.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        </div>
      ))}
      {!isLoading && (data?.length ?? 0) === 0 && <div className="et-empty">Nothing has happened here yet.</div>}
    </div>
  );
}

function QuickAdd({ value, setValue, onAdd, placeholder, pending }: { value: string; setValue: (v: string) => void; onAdd: () => void; placeholder: string; pending: boolean }) {
  return (
    <form className="et-quickadd" onSubmit={(e) => { e.preventDefault(); onAdd(); }}>
      <span className="et-quickadd-plus">+</span>
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} disabled={pending} />
    </form>
  );
}

function WorkspaceStyles() {
  return (
    <style>{`
      .et-ws-page { max-width: 54rem; margin: 0 auto; padding: 3.5rem 2.5rem 6rem; }
      .et-ws-header { margin-bottom: 1.6rem; }
      .et-crumbs a { color: var(--ink-faint); text-decoration: none; }
      .et-crumbs a:hover { color: var(--ink-soft); }
      .et-crumb-here { color: var(--ink-soft); }
      .et-crumb-sep { opacity: 0.5; }
      .et-ws-title { font-size: 2.6rem; line-height: 1.08; margin: 0.4rem 0 0.5rem; }
      .et-ws-meta { display: flex; align-items: center; gap: 0.7rem; }
      .et-tag { font-family: var(--font-mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; padding: 0.18rem 0.5rem; border-radius: 5px; background: var(--paper-raised); border: 1px solid var(--line); color: var(--ink-soft); }
      .et-tag[data-type="project"] { color: var(--color-iris); border-color: color-mix(in srgb, var(--color-iris) 40%, transparent); }
      .et-ws-desc { color: var(--ink-soft); font-size: 0.9rem; }

      .et-tabs { display: flex; gap: 0.3rem; border-bottom: 1px solid var(--line); margin-bottom: 1.8rem; overflow-x: auto; }
      .et-tab { background: none; border: none; font: inherit; font-size: 0.9rem; color: var(--ink-faint); padding: 0.55rem 0.7rem; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
      .et-tab:hover { color: var(--ink-soft); }
      .et-tab[data-active="true"] { color: var(--ink); border-bottom-color: var(--color-iris); font-weight: 500; }

      .et-stat-row { display: flex; gap: 1rem; margin-bottom: 2rem; }
      .et-stat { flex: 1; background: var(--paper-raised); border: 1px solid var(--line); border-radius: 12px; padding: 1.1rem 1.2rem; display: flex; flex-direction: column; gap: 0.2rem; cursor: pointer; text-align: left; transition: border-color 0.12s; }
      .et-stat:hover { border-color: var(--line-strong); }
      .et-stat-num { font-size: 2.2rem; line-height: 1; color: var(--color-iris); }
      .et-overview-next { display: flex; flex-direction: column; gap: 0.5rem; }
      .et-next-task { padding: 0.5rem 0; border-bottom: 1px solid var(--line); }

      .et-list-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.7rem; padding: 0.55rem 0; border-bottom: 1px solid var(--line); }
      .et-prio { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); }
      .et-prio[data-p="2"] { background: var(--color-amber); }
      .et-prio[data-p="3"] { background: var(--color-iris); }
      .et-status { color: var(--ink-faint); }

      .et-task-row { display: flex; align-items: center; gap: 0.7rem; width: 100%; background: none; border: none; border-bottom: 1px solid var(--line); font: inherit; text-align: left; padding: 0.55rem 0; cursor: pointer; color: var(--ink); }
      .et-check { width: 16px; height: 16px; border: 1.5px solid var(--line-strong); border-radius: 5px; flex: none; transition: background 0.12s; }
      .et-check[data-checked] { background: var(--color-sage); border-color: var(--color-sage); }
      .et-task-row[data-done] .et-task-title { color: var(--ink-faint); text-decoration: line-through; }
      .et-done-group { margin-top: 1.4rem; display: flex; flex-direction: column; }
      .et-done-group .eyebrow { padding: 0.4rem 0; }

      .et-quickadd { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 0; margin-top: 0.3rem; }
      .et-quickadd-plus { color: var(--ink-faint); }
      .et-quickadd input { flex: 1; min-width: 0; background: none; border: none; font: inherit; color: var(--ink); }
      .et-quickadd input:focus { outline: none; }
      .et-quickadd input::placeholder { color: var(--ink-faint); }

      .et-doc-row { display: flex; align-items: center; gap: 0.7rem; width: 100%; background: none; border: none; border-bottom: 1px solid var(--line); font: inherit; text-align: left; padding: 0.6rem 0; cursor: pointer; color: var(--ink); }
      .et-doc-icon { color: var(--color-iris); }
      .et-back { background: none; border: none; color: var(--ink-soft); font: inherit; font-size: 0.85rem; cursor: pointer; padding: 0 0 1rem; }
      .et-doc-title { font-size: 1.9rem; margin: 0 0 1.2rem; }

      .et-decision { padding: 0.8rem 0; border-bottom: 1px solid var(--line); }
      .et-decision-title { font-weight: 500; }
      .et-decision-why { color: var(--ink-soft); font-size: 0.9rem; margin: 0.2rem 0 0.4rem; }
      .et-decision-form { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1.2rem; }
      .et-decision-form input { background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 8px; padding: 0.55rem 0.75rem; font: inherit; color: var(--ink); }
      .et-decision-form input:focus { outline: none; border-color: var(--color-iris); }
      .et-decision-form button { align-self: flex-start; background: var(--color-iris); color: #fff; border: none; border-radius: 8px; padding: 0.5rem 1.1rem; font: inherit; cursor: pointer; }
      .et-decision-form button:disabled { opacity: 0.4; cursor: default; }

      .et-obj-group { margin-bottom: 1.6rem; }
      .et-obj-head { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0; border-bottom: 1px solid var(--line-strong); }
      .et-obj-title { font-weight: 500; flex: 1; }
      .et-obj-tasks { padding-left: 1.1rem; margin-top: 0.2rem; }
      .et-obj-tasks .et-task-row { border-bottom: 1px solid var(--line); }

      .et-timeline { display: flex; flex-direction: column; }
      .et-tl-row { display: grid; grid-template-columns: 1rem 1fr auto; align-items: baseline; gap: 0.6rem; padding: 0.45rem 0; border-bottom: 1px solid var(--line); font-size: 0.88rem; }
      .et-tl-mark { font-family: var(--font-display); color: var(--ink-faint); text-align: center; }
      .et-tl-mark[data-ai="true"] { color: var(--color-iris); }
      .et-tl-text { color: var(--ink-soft); }
      .et-tl-type { color: var(--ink); }
      .et-tl-time { color: var(--ink-faint); }

      .et-empty { color: var(--ink-faint); font-size: 0.9rem; padding: 0.6rem 0; font-style: italic; }
    `}</style>
  );
}
