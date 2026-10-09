"use client";
// Tasks: one list, next-to-do first, with subtasks nested under their parent.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { actorLabel, api, type TaskNode, type TaskStatus } from "@/lib/api";

const DAY = 86_400_000;

/** "today", "in 3d", "2d late" — relative, because that is how a deadline is read. */
function dueLabel(due: number): { text: string; late: boolean } {
  const days = Math.round((new Date(due).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / DAY);
  if (days < 0) return { text: `${-days}d late`, late: true };
  if (days === 0) return { text: "today", late: false };
  if (days === 1) return { text: "tomorrow", late: false };
  return { text: `in ${days}d`, late: false };
}

export function TasksView() {
  const qc = useQueryClient();
  const { data: tasks, isLoading } = useQuery({ queryKey: ["tasks"], queryFn: () => api.get<TaskNode[]>("/tasks") });
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [showDone, setShowDone] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["tasks"] });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await api.post("/tasks", { title: title.trim(), due_at: due ? new Date(`${due}T12:00`).getTime() : undefined });
    setTitle("");
    setDue("");
    refresh();
  };

  const visible = (tasks ?? []).filter((t) => showDone || t.status !== "done");
  const doneCount = (tasks ?? []).filter((t) => t.status === "done").length;

  return (
    <div className="et-tasks">
      <header>
        <div className="eyebrow">Next to do first</div>
        <h1 className="serif">Tasks</h1>
      </header>

      <form className="et-task-add" onSubmit={add}>
        <input id="et-task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" aria-label="Task" />
        <input id="et-task-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
        <button type="submit" disabled={!title.trim()}>Add</button>
      </form>

      <div className="et-task-list">
        {visible.map((t) => <TaskRow key={t.id} task={t} depth={0} showDone={showDone} onChange={refresh} />)}
        {!isLoading && visible.length === 0 && <div className="et-empty">Nothing to do. Add a task above.</div>}
      </div>

      {doneCount > 0 && (
        <button className="et-task-toggle" onClick={() => setShowDone((v) => !v)}>
          {showDone ? "Hide" : "Show"} {doneCount} done
        </button>
      )}
      <TaskStyles />
    </div>
  );
}

function TaskRow({ task, depth, showDone, onChange }: { task: TaskNode; depth: number; showDone: boolean; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  const [sub, setSub] = useState("");
  const set = async (patch: Record<string, unknown>) => { await api.patch(`/tasks/${task.id}`, patch); onChange(); };
  const next: Record<TaskStatus, TaskStatus> = { todo: "doing", doing: "todo", done: "done" };
  const due = task.due_at && task.status !== "done" ? dueLabel(task.due_at) : null;
  const subtasks = task.subtasks.filter((s) => showDone || s.status !== "done");

  return (
    <>
      <div className="et-task" data-status={task.status} style={{ paddingLeft: `${depth * 1.6}rem` }}>
        <input type="checkbox" checked={task.status === "done"} aria-label={`Done: ${task.title}`}
          onChange={(e) => set({ status: e.target.checked ? "done" : "todo" })} />
        <input className="et-task-title" defaultValue={task.title} aria-label="Task title"
          onBlur={(e) => { if (e.target.value.trim() && e.target.value !== task.title) set({ title: e.target.value.trim() }); }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        {task.status !== "done" && (
          <button className="et-task-chip" data-on={task.status === "doing"} onClick={() => set({ status: next[task.status] })}
            title="Mark in progress">{task.status === "doing" ? "in progress" : "start"}</button>
        )}
        {due && <span className="et-task-due" data-late={due.late}>{due.text}</span>}
        {task.note_id && <a className="et-task-note" href={`/note/?id=${task.note_id}`}>note</a>}
        {task.actor !== "human" && <span className="et-task-by">{actorLabel(task.actor)}</span>}
        <button className="et-task-act" onClick={() => setAdding((v) => !v)} title="Add a subtask">+</button>
        <button className="et-task-act" onClick={async () => {
          const n = task.subtasks.length;
          if (!confirm(`Delete "${task.title}"${n ? ` and its ${n} subtask${n === 1 ? "" : "s"}` : ""}?`)) return;
          await api.del(`/tasks/${task.id}`);
          onChange();
        }} title="Delete">×</button>
      </div>
      {adding && (
        <form className="et-task-sub" style={{ paddingLeft: `${(depth + 1) * 1.6}rem` }} onSubmit={async (e) => {
          e.preventDefault();
          if (!sub.trim()) return;
          await api.post("/tasks", { title: sub.trim(), parent_id: task.id });
          setSub("");
          setAdding(false);
          onChange();
        }}>
          <input id={`et-sub-${task.id}`} autoFocus value={sub} onChange={(e) => setSub(e.target.value)} placeholder="Subtask" aria-label="Subtask" />
        </form>
      )}
      {subtasks.map((s) => <TaskRow key={s.id} task={s} depth={depth + 1} showDone={showDone} onChange={onChange} />)}
    </>
  );
}

function TaskStyles() {
  return (
    <style>{`
      .et-tasks { max-width: 46rem; margin: 0 auto; padding: 3.5rem 2.5rem 6rem; }
      @media (max-width: 860px) { .et-tasks { padding: 3.5rem 1.1rem 5rem; } }
      .et-tasks h1 { font-size: 2.4rem; margin: 0.3rem 0 1.5rem; }
      .et-task-add { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
      .et-task-add input { background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 9px; padding: 0.6rem 0.8rem; font: inherit; color: var(--ink); }
      .et-task-add input:first-child { flex: 1; min-width: 12rem; }
      .et-task-add input:focus { outline: none; border-color: var(--color-iris); }
      .et-task-add button { background: var(--color-iris); color: #fff; border: none; border-radius: 9px; padding: 0 1.2rem; font: inherit; cursor: pointer; }
      .et-task-add button:disabled { opacity: 0.4; }
      .et-task-list { display: flex; flex-direction: column; }
      .et-task { display: flex; align-items: center; gap: 0.55rem; padding: 0.45rem 0; border-bottom: 1px solid var(--line); }
      .et-task-title { flex: 1; min-width: 0; background: none; border: none; font: inherit; font-size: 0.95rem; color: var(--ink); padding: 0.15rem 0; }
      .et-task-title:focus { outline: none; border-bottom: 1px solid var(--color-iris); }
      .et-task[data-status="done"] .et-task-title { color: var(--ink-faint); text-decoration: line-through; }
      .et-task-chip { background: none; border: 1px solid var(--line-strong); border-radius: 99px; font-family: var(--font-mono); font-size: 0.68rem; color: var(--ink-faint); padding: 0.1rem 0.5rem; cursor: pointer; }
      .et-task-chip[data-on="true"] { border-color: var(--color-iris); color: var(--color-iris); }
      .et-task-due { font-family: var(--font-mono); font-size: 0.72rem; color: var(--ink-soft); white-space: nowrap; }
      .et-task-due[data-late="true"] { color: var(--color-amber); }
      .et-task-note, .et-task-by { font-family: var(--font-mono); font-size: 0.7rem; color: var(--ink-faint); text-decoration: none; }
      .et-task-note:hover { color: var(--color-iris); }
      .et-task-act { background: none; border: none; color: var(--ink-faint); cursor: pointer; font-size: 1rem; padding: 0 0.25rem; opacity: 0.4; }
      .et-task:hover .et-task-act, .et-task-act:focus-visible { opacity: 1; }
      @media (hover: none) { .et-task-act { opacity: 1; } }
      .et-task-sub input { width: 100%; background: none; border: none; border-bottom: 1px dashed var(--line-strong); font: inherit; font-size: 0.9rem; padding: 0.4rem 0; color: var(--ink); }
      .et-task-sub input:focus { outline: none; border-bottom-color: var(--color-iris); }
      .et-task-toggle { margin-top: 1rem; background: none; border: none; color: var(--ink-faint); font: inherit; font-size: 0.85rem; cursor: pointer; padding: 0; }
    `}</style>
  );
}
