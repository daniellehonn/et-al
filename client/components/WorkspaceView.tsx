"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type Workspace, type Task, type Objective, type Document, type Decision, type RecentEvent } from "@/lib/api";
import { BlockEditor } from "./BlockEditor";
import { EditableText, DeleteButton } from "./Editable";

const TABS = ["Overview", "Tasks", "Documents", "Decisions", "Timeline"] as const;
type Tab = (typeof TABS)[number];
const FINITE_TYPES = ["project", "course"]; // finite = has an outcome, can be completed

export function WorkspaceView({ id, initialTab, initialDoc }: { id: string; initialTab?: string; initialDoc?: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>((TABS as readonly string[]).includes(initialTab ?? "") ? (initialTab as Tab) : "Overview");
  const { data: workspace, isLoading } = useQuery({ queryKey: ["workspace", id], queryFn: () => api.get<Workspace>(`/workspaces/${id}`) });
  const { data: all } = useQuery({ queryKey: ["workspaces"], queryFn: () => api.get<Workspace[]>("/workspaces") });

  const patchWs = useMutation({
    mutationFn: (body: Partial<Workspace>) => api.patch(`/workspaces/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["workspace", id] }); qc.invalidateQueries({ queryKey: ["workspaces"] }); },
  });
  const deleteWs = useMutation({
    mutationFn: () => api.del(`/workspaces/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["workspaces"] }); window.location.href = "/"; },
    onError: (e) => alert((e as Error).message),
  });

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
        <EditableText as="h1" className="serif et-ws-title" value={workspace.title}
          onSave={(title) => patchWs.mutate({ title })} />
        <div className="et-ws-meta">
          <span className="et-tag" data-type={workspace.type}>{workspace.type}</span>
          {workspace.status === "completed" && <span className="et-tag et-tag-done">✓ completed</span>}
          {workspace.status === "archived" && <span className="et-tag">archived</span>}
          <EditableText className="et-ws-desc" value={workspace.description ?? ""} placeholder="Add a description…"
            onSave={(description) => patchWs.mutate({ description })} />
          <span className="et-ws-actions">
            {FINITE_TYPES.includes(workspace.type) && (
              <button className="et-ws-complete" data-done={workspace.status === "completed" || undefined}
                onClick={() => patchWs.mutate({ status: workspace.status === "completed" ? "active" : "completed" })}>
                {workspace.status === "completed" ? "Reopen" : "Mark complete"}
              </button>
            )}
            <button className="et-ws-archive" onClick={() => patchWs.mutate({ status: workspace.status === "archived" ? "active" : "archived" })}>
              {workspace.status === "archived" ? "Unarchive" : "Archive"}
            </button>
            <DeleteButton onDelete={() => deleteWs.mutate()} confirm size="md"
              label={(all ?? []).some((w) => w.parent_id === id) ? "Delete (sub-workspaces move up)" : "Delete workspace"} />
          </span>
        </div>
      </header>

      <nav className="et-tabs">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className="et-tab" data-active={tab === t}>{t}</button>
        ))}
      </nav>

      <div className="et-tab-body">
        {tab === "Overview" && <Overview id={id} workspace={workspace} setTab={setTab} />}
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
  const qc = useQueryClient();
  const { data: tasks } = useQuery({ queryKey: ["tasks", id], queryFn: () => api.get<Task[]>(`/workspaces/${id}/tasks`) });
  const { data: docs } = useQuery({ queryKey: ["documents", id], queryFn: () => api.get<Document[]>(`/workspaces/${id}/documents`) });
  const { data: workspaces } = useQuery({ queryKey: ["workspaces"], queryFn: () => api.get<Workspace[]>("/workspaces") });
  const complete = useMutation({
    mutationFn: () => api.patch(`/workspaces/${id}`, { status: "completed" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["workspace", id] }); qc.invalidateQueries({ queryKey: ["workspaces"] }); },
  });

  const all = tasks ?? [];
  const open = all.filter((t) => t.status !== "done");
  const done = all.length - open.length;
  const children = (workspaces ?? []).filter((w) => w.parent_id === id);
  const finite = FINITE_TYPES.includes(workspace.type);
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;

  return (
    <div>
      {/* Finite types (project/course): progress toward an outcome. */}
      {finite && (
        <div className="et-progress-card" data-complete={workspace.status === "completed" || undefined}>
          {workspace.status === "completed" ? (
            <div className="et-complete-note"><span className="serif et-complete-check">✓</span> This {workspace.type} is complete.</div>
          ) : (
            <>
              <div className="et-progress-head">
                <span className="eyebrow">Progress toward done</span>
                <span className="et-progress-frac">{done} / {all.length} tasks</span>
              </div>
              <div className="et-progress-bar"><span style={{ width: `${pct}%` }} /></div>
              {all.length > 0 && open.length === 0 && (
                <button className="et-complete-cta" onClick={() => complete.mutate()}>All tasks done — mark this {workspace.type} complete →</button>
              )}
            </>
          )}
        </div>
      )}

      <div className="et-stat-row">
        <button className="et-stat" onClick={() => setTab("Tasks")}>
          <span className="serif et-stat-num">{open.length}</span><span className="eyebrow">Open tasks</span>
        </button>
        {!finite && (
          <button className="et-stat" onClick={() => children[0] && (window.location.href = `/workspace/?id=${children[0].id}`)}>
            <span className="serif et-stat-num">{children.length}</span><span className="eyebrow">Inside</span>
          </button>
        )}
        <button className="et-stat" onClick={() => setTab("Documents")}>
          <span className="serif et-stat-num">{(docs ?? []).length}</span><span className="eyebrow">Documents</span>
        </button>
      </div>

      {/* Ongoing types (area/organization): what's inside — its projects. */}
      {!finite && children.length > 0 && (
        <div className="et-overview-children">
          <span className="eyebrow">Inside this {workspace.type}</span>
          {children.map((w) => (
            <a key={w.id} href={`/workspace/?id=${w.id}`} className="et-child-row" data-status={w.status}>
              <span className="et-ws-dot" data-type={w.type} />
              <span className="et-child-title">{w.title}</span>
              <span className="eyebrow et-child-type">{w.status === "completed" ? "✓ done" : w.type}</span>
            </a>
          ))}
        </div>
      )}

      <div className="et-overview-next">
        <span className="eyebrow">Next up</span>
        {open.slice(0, 3).map((t) => <div key={t.id} className="et-next-task">{t.title}</div>)}
        {open.length === 0 && <div className="et-empty">No open tasks. {finite ? "A finite project should have a next action, or be marked complete." : "Areas are ongoing — add a project or a standing task."}</div>}
      </div>
    </div>
  );
}

// ── Tasks (with optional grouping by objective) ─────────────────────────────
// Objectives are no longer a separate tab; an objective is a label a task can
// carry, and "group by objective" turns the flat list into planning sections.
function Tasks({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data: tasks } = useQuery({ queryKey: ["tasks", id], queryFn: () => api.get<Task[]>(`/workspaces/${id}/tasks`) });
  const { data: objectives } = useQuery({ queryKey: ["objectives", id], queryFn: () => api.get<Objective[]>(`/workspaces/${id}/objectives`) });
  const [groupBy, setGroupBy] = useState<"none" | "objective">("none");
  const [title, setTitle] = useState("");
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["tasks", id] }); qc.invalidateQueries({ queryKey: ["objectives", id] }); };

  const addTask = useMutation({
    mutationFn: (body: { title: string; objective_id?: string | null }) => api.post("/tasks", { workspace_id: id, ...body }),
    onSuccess: invalidate,
  });
  const toggle = useMutation({ mutationFn: (t: Task) => api.patch(`/tasks/${t.id}`, { status: t.status === "done" ? "todo" : "done" }), onSuccess: invalidate });
  const patch = useMutation({ mutationFn: ({ tid, body }: { tid: string; body: Partial<Task> }) => api.patch(`/tasks/${tid}`, body), onSuccess: invalidate });
  const del = useMutation({ mutationFn: (tid: string) => api.del(`/tasks/${tid}`), onSuccess: invalidate });
  const addObj = useMutation({ mutationFn: (t: string) => api.post("/objectives", { workspace_id: id, title: t }), onSuccess: invalidate });

  const handlers = {
    objectives: objectives ?? [],
    onToggle: (t: Task) => toggle.mutate(t),
    onRename: (tid: string, tt: string) => patch.mutate({ tid, body: { title: tt } }),
    onReassign: (tid: string, oid: string | null) => patch.mutate({ tid, body: { objective_id: oid } }),
    onDelete: (tid: string) => del.mutate(tid),
  };

  const all = tasks ?? [];
  const open = all.filter((t) => t.status !== "done");
  const done = all.filter((t) => t.status === "done");

  return (
    <div>
      <div className="et-tasks-toolbar">
        <span className="eyebrow">Group by</span>
        <div className="et-seg">
          <button data-on={groupBy === "none"} onClick={() => setGroupBy("none")}>None</button>
          <button data-on={groupBy === "objective"} onClick={() => setGroupBy("objective")}>Objective</button>
        </div>
      </div>

      {groupBy === "none" ? (
        <>
          {open.map((t) => <TaskRow key={t.id} task={t} showObjective {...handlers} />)}
          {open.length === 0 && <div className="et-empty">Nothing open.</div>}
          <QuickAdd value={title} setValue={setTitle} onAdd={() => title.trim() && addTask.mutate({ title })} placeholder="New task" pending={addTask.isPending} />
          {done.length > 0 && (
            <div className="et-done-group">
              <span className="eyebrow">Done · {done.length}</span>
              {done.map((t) => <TaskRow key={t.id} task={t} showObjective {...handlers} />)}
            </div>
          )}
        </>
      ) : (
        <>
          {(objectives ?? []).map((o) => (
            <ObjectiveSection key={o.id} workspaceId={id} objective={o}
              tasks={all.filter((t) => t.objective_id === o.id)} invalidate={invalidate}
              addTask={(t) => addTask.mutate({ title: t, objective_id: o.id })} {...handlers} />
          ))}
          <ObjectiveSection workspaceId={id} objective={null}
            tasks={all.filter((t) => !t.objective_id)} invalidate={invalidate}
            addTask={(t) => addTask.mutate({ title: t, objective_id: null })} {...handlers} />
          <NewObjective onAdd={(t) => addObj.mutate(t)} pending={addObj.isPending} />
        </>
      )}
    </div>
  );
}

function TaskRow({ task, objectives, showObjective, onToggle, onRename, onReassign, onDelete }: {
  task: Task; objectives: Objective[]; showObjective?: boolean;
  onToggle: (t: Task) => void; onRename: (tid: string, title: string) => void;
  onReassign: (tid: string, oid: string | null) => void; onDelete: (tid: string) => void;
}) {
  return (
    <div className="et-task-row" data-done={task.status === "done" || undefined}>
      <button className="et-check-btn" aria-label="Toggle done" onClick={() => onToggle(task)}>
        <span className="et-check" {...(task.status === "done" ? { "data-checked": true } : {})} />
      </button>
      {task.status !== "done" && <span className="et-prio" data-p={task.priority} />}
      <EditableText className="et-task-title" value={task.title} onSave={(t) => onRename(task.id, t)} />
      {showObjective && (
        <select className="et-task-obj" value={task.objective_id ?? ""} aria-label="Objective"
          onChange={(e) => onReassign(task.id, e.target.value || null)}>
          <option value="">— no objective</option>
          {objectives.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </select>
      )}
      <DeleteButton onDelete={() => onDelete(task.id)} />
    </div>
  );
}

function ObjectiveSection({ workspaceId, objective, tasks, invalidate, addTask, objectives, onToggle, onRename, onReassign, onDelete }: {
  workspaceId: string; objective: Objective | null; tasks: Task[]; invalidate: () => void; addTask: (title: string) => void;
  objectives: Objective[]; onToggle: (t: Task) => void; onRename: (tid: string, title: string) => void;
  onReassign: (tid: string, oid: string | null) => void; onDelete: (tid: string) => void;
}) {
  const qc = useQueryClient();
  const [taskTitle, setTaskTitle] = useState("");
  const renameObj = useMutation({ mutationFn: (title: string) => api.patch(`/objectives/${objective!.id}`, { title }), onSuccess: invalidate });
  const delObj = useMutation({ mutationFn: () => api.del(`/objectives/${objective!.id}`), onSuccess: invalidate });
  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");
  void qc;
  return (
    <div className="et-obj-group">
      <div className="et-obj-head">
        {objective ? (
          <>
            <span className="et-prio" data-p={objective.priority} />
            <EditableText className="et-obj-title" value={objective.title} onSave={(t) => renameObj.mutate(t)} />
            <span className="eyebrow et-status">{open.length} open{done.length ? ` · ${done.length} done` : ""}</span>
            <DeleteButton onDelete={() => delObj.mutate()} confirm label="Delete objective" />
          </>
        ) : (
          <span className="et-obj-title et-obj-none">No objective</span>
        )}
      </div>
      <div className="et-obj-tasks">
        {[...open, ...done].map((t) => (
          <TaskRow key={t.id} task={t} objectives={objectives} onToggle={onToggle} onRename={onRename} onReassign={onReassign} onDelete={onDelete} />
        ))}
        <QuickAdd value={taskTitle} setValue={setTaskTitle} onAdd={() => taskTitle.trim() && (addTask(taskTitle), setTaskTitle(""))} placeholder={objective ? "Add a task to this objective" : "Add an unassigned task"} pending={false} />
      </div>
    </div>
  );
}

function NewObjective({ onAdd, pending }: { onAdd: (title: string) => void; pending: boolean }) {
  const [title, setTitle] = useState("");
  return <QuickAdd value={title} setValue={setTitle} onAdd={() => title.trim() && (onAdd(title), setTitle(""))} placeholder="New objective — the “why” behind a group of tasks" pending={pending} />;
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
  const rename = useMutation({
    mutationFn: ({ did, title }: { did: string; title: string }) => api.patch<Document>(`/documents/${did}`, { title }),
    onSuccess: (doc) => { qc.invalidateQueries({ queryKey: ["documents", id] }); setOpenDoc((cur) => (cur && cur.id === doc.id ? doc : cur)); },
  });
  const del = useMutation({
    mutationFn: (did: string) => api.del(`/documents/${did}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["documents", id] }); setOpenDoc(null); },
  });

  if (openDoc) {
    return (
      <div>
        <button className="et-back" onClick={() => setOpenDoc(null)}>← All documents</button>
        <div className="et-doc-titlebar">
          <EditableText as="h2" className="serif et-doc-title" value={openDoc.title} onSave={(t) => rename.mutate({ did: openDoc.id, title: t })} />
          <DeleteButton onDelete={() => del.mutate(openDoc.id)} confirm label="Delete document" size="md" />
        </div>
        <BlockEditor documentId={openDoc.id} />
      </div>
    );
  }
  return (
    <div>
      {(data ?? []).map((d) => (
        <div key={d.id} className="et-doc-row">
          <button className="et-doc-open" onClick={() => setOpenDoc(d)}>
            <span className="et-doc-icon serif">¶</span>
            <span>{d.title}</span>
          </button>
          <span className="eyebrow et-status">{d.type}</span>
          <DeleteButton onDelete={() => del.mutate(d.id)} confirm label="Delete document" />
        </div>
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
  const del = useMutation({
    mutationFn: (did: string) => api.del(`/decisions/${did}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["decisions", id] }),
  });
  return (
    <div>
      {(data ?? []).map((d) => (
        <div key={d.id} className="et-decision">
          <div className="et-decision-titlerow">
            <div className="et-decision-title">{d.title}</div>
            <DeleteButton onDelete={() => del.mutate(d.id)} confirm label="Delete decision" />
          </div>
          <div className="et-decision-why">{d.rationale}</div>
          <div className="eyebrow">{new Date(d.decided_on).toLocaleDateString()} · {d.actor} <span className="et-immutable">· immutable</span></div>
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
      .et-ws-meta { flex-wrap: wrap; }
      .et-ws-actions { display: inline-flex; align-items: center; gap: 0.4rem; margin-left: auto; }
      .et-ws-archive { background: none; border: 1px solid var(--line-strong); border-radius: 7px; color: var(--ink-soft); font: inherit; font-size: 0.8rem; padding: 0.25rem 0.7rem; cursor: pointer; }
      .et-ws-archive:hover { color: var(--ink); border-color: var(--ink-faint); }
      .et-ws-complete { background: var(--color-sage); border: 1px solid var(--color-sage); border-radius: 7px; color: #fff; font: inherit; font-size: 0.8rem; padding: 0.25rem 0.7rem; cursor: pointer; }
      .et-ws-complete[data-done] { background: none; color: var(--ink-soft); border-color: var(--line-strong); }
      .et-tag-done { color: var(--color-sage) !important; border-color: color-mix(in srgb, var(--color-sage) 45%, transparent) !important; }

      .et-progress-card { border: 1px solid var(--line); background: var(--paper-raised); border-radius: 12px; padding: 1.1rem 1.2rem; margin-bottom: 1.6rem; }
      .et-progress-card[data-complete] { border-color: color-mix(in srgb, var(--color-sage) 40%, transparent); }
      .et-progress-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.6rem; }
      .et-progress-frac { font-size: 0.85rem; color: var(--ink-soft); }
      .et-progress-bar { height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
      .et-progress-bar span { display: block; height: 100%; background: var(--color-sage); border-radius: 4px; transition: width 0.4s ease; }
      .et-complete-cta { margin-top: 0.9rem; background: var(--color-sage); color: #fff; border: none; border-radius: 8px; padding: 0.5rem 0.9rem; font: inherit; font-size: 0.88rem; cursor: pointer; }
      .et-complete-note { display: flex; align-items: center; gap: 0.5rem; color: var(--ink); font-size: 1rem; }
      .et-complete-check { color: var(--color-sage); font-size: 1.4rem; }

      .et-overview-children { display: flex; flex-direction: column; margin-bottom: 1.8rem; }
      .et-child-row { display: flex; align-items: center; gap: 0.6rem; text-decoration: none; color: var(--ink); padding: 0.5rem 0; border-bottom: 1px solid var(--line); }
      .et-child-row:hover .et-child-title { color: var(--color-iris); }
      .et-child-row[data-status="completed"] .et-child-title { color: var(--ink-faint); text-decoration: line-through; }
      .et-child-title { flex: 1; }
      .et-child-type { color: var(--ink-faint); }

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

      .et-task-row { display: flex; align-items: center; gap: 0.7rem; width: 100%; border-bottom: 1px solid var(--line); padding: 0.5rem 0; color: var(--ink); }
      .et-task-row .et-task-title { flex: 1; }
      .et-check-btn { background: none; border: none; padding: 0; cursor: pointer; display: flex; }
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

      .et-doc-row { display: flex; align-items: center; gap: 0.7rem; width: 100%; border-bottom: 1px solid var(--line); padding: 0.5rem 0; color: var(--ink); }
      .et-doc-open { flex: 1; display: flex; align-items: center; gap: 0.7rem; background: none; border: none; font: inherit; text-align: left; cursor: pointer; color: var(--ink); }
      .et-doc-icon { color: var(--color-iris); }
      .et-back { background: none; border: none; color: var(--ink-soft); font: inherit; font-size: 0.85rem; cursor: pointer; padding: 0 0 1rem; }
      .et-doc-titlebar { display: flex; align-items: center; gap: 0.6rem; margin: 0 0 1.2rem; }
      .et-doc-title { font-size: 1.9rem; margin: 0; flex: 1; }

      .et-decision { padding: 0.8rem 0; border-bottom: 1px solid var(--line); }
      .et-decision-titlerow { display: flex; align-items: center; gap: 0.5rem; }
      .et-decision-title { font-weight: 500; flex: 1; }
      .et-immutable { color: var(--ink-faint); }
      .et-decision-why { color: var(--ink-soft); font-size: 0.9rem; margin: 0.2rem 0 0.4rem; }
      .et-decision-form { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1.2rem; }
      .et-decision-form input { background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 8px; padding: 0.55rem 0.75rem; font: inherit; color: var(--ink); }
      .et-decision-form input:focus { outline: none; border-color: var(--color-iris); }
      .et-decision-form button { align-self: flex-start; background: var(--color-iris); color: #fff; border: none; border-radius: 8px; padding: 0.5rem 1.1rem; font: inherit; cursor: pointer; }
      .et-decision-form button:disabled { opacity: 0.4; cursor: default; }

      .et-tasks-toolbar { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1.1rem; }
      .et-seg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: 8px; overflow: hidden; }
      .et-seg button { background: none; border: none; font: inherit; font-size: 0.82rem; color: var(--ink-soft); padding: 0.28rem 0.75rem; cursor: pointer; }
      .et-seg button[data-on="true"] { background: var(--color-iris); color: #fff; }
      .et-task-obj { opacity: 0; background: none; border: 1px solid var(--line); border-radius: 6px; font: inherit; font-size: 0.78rem; color: var(--ink-faint); padding: 0.1rem 0.3rem; max-width: 9rem; transition: opacity 0.12s; }
      .et-task-row:hover .et-task-obj, .et-task-obj:focus { opacity: 1; }
      .et-obj-none { color: var(--ink-faint); font-style: italic; }
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
