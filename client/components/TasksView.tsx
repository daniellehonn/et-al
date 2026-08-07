"use client";
// The task system.
//
// One kind of thing, nested three deep: a goal is a task with a deadline and
// children, a subtask is a task with a parent. That was a deliberate choice over
// separate Goal and Task types — you described it as "a task with a deadline
// with smaller subtasks", and a second type would mean deciding which one you
// are making before you know.
//
// Sections group the top level and are inherited downward, so a goal doubles as
// the subsection within its section.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Page, type RoleRow } from "@/lib/api";

interface TaskNode extends RoleRow {
  children: TaskNode[];
  progress: { done: number; total: number };
  pressing: "overdue" | "soon" | null;
}
interface Group { section: string; tasks: TaskNode[] }

// Mirrors RECURRENCES in src/store/collections.ts.
const RECURRENCES = ["daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"] as const;

const DAY = 86_400_000;

function dueLabel(ts: unknown): { text: string; tone: string } | null {
  const n = Number(ts);
  if (!n) return null;
  const days = Math.floor((n - Date.now()) / DAY);
  if (days < 0) return { text: `${-days}d late`, tone: "overdue" };
  if (days === 0) return { text: "today", tone: "soon" };
  if (days === 1) return { text: "tomorrow", tone: "soon" };
  if (days <= 7) return { text: `${days}d`, tone: "soon" };
  return { text: new Date(n).toLocaleDateString(undefined, { month: "short", day: "numeric" }), tone: "later" };
}

const toInput = (ts: unknown) => {
  const n = Number(ts);
  return n ? new Date(n).toISOString().slice(0, 10) : "";
};

export function TasksView() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<{ section: string; parent: string | null } | null>(null);
  const [newSection, setNewSection] = useState(false);
  // Two-step rather than a confirm(): a modal for something this reversible is
  // heavy, and the second click is where the consequence gets spelled out.
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const { data: groups, isLoading } = useQuery({
    queryKey: ["task-tree"],
    queryFn: () => api.get<Group[]>("/tasks/tree"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["task-tree"] });
    qc.invalidateQueries({ queryKey: ["home"] });
  };

  const add = async (section: string, parent: string | null, title: string, due: string) => {
    if (!title.trim()) return;
    await api.post("/tasks", {
      title: title.trim(),
      section: section || undefined,
      parent_id: parent ?? undefined,
      // Midday avoids a date landing on the previous day in western zones.
      due_date: due ? new Date(`${due}T12:00:00`).getTime() : undefined,
    });
    refresh();
  };

  // The section goes; its tasks do not. The server clears `section` on every
  // row that used it, and taskTree gathers those into the trailing unsectioned
  // group — so nothing disappears, it just loses its label.
  const removeSection = async (name: string) => {
    await api.del(`/tasks/sections/${encodeURIComponent(name)}`);
    setConfirmDel(null);
    refresh();
  };

  if (isLoading) return <div className="et-tv-empty">Loading…</div>;
  const total = (groups ?? []).reduce((n, g) => n + g.tasks.reduce((m, t) => m + t.progress.total, 0), 0);

  return (
    <div className="et-tv">
      <div className="et-tv-head">
        <h1>Tasks</h1>
        <span className="et-tv-count">{total} open</span>
      </div>

      {(groups ?? []).map((g) => (
        <section key={g.section || "_none"} className="et-tv-section">
          <div className="et-tv-section-head">
            <span className="et-tv-section-name">{g.section || "unsectioned"}</span>
            <span className="et-tv-section-count">{g.tasks.length}</span>
            {/* The unsectioned group is not a section — it is where deleted
                sections' tasks land, so it has nothing to delete. */}
            {g.section && (confirmDel === g.section ? (
              <span className="et-tv-confirm">
                {g.tasks.length
                  ? `Delete? ${g.tasks.length} task${g.tasks.length > 1 ? "s" : ""} move to unsectioned`
                  : "Delete?"}
                <button className="et-tv-yes" onClick={() => removeSection(g.section)}>Yes</button>
                <button className="et-tv-no" onClick={() => setConfirmDel(null)}>Cancel</button>
              </span>
            ) : (
              <button className="et-tv-section-del" title="Delete section"
                onClick={() => setConfirmDel(g.section)}>×</button>
            ))}
          </div>

          {g.tasks.map((t) => (
            <TaskRow key={t.id} node={t} depth={0} section={g.section}
              adding={adding} setAdding={setAdding} onAdd={add} onChanged={refresh} />
          ))}

          <AddRow
            open={adding?.section === g.section && adding.parent === null}
            onOpen={() => setAdding({ section: g.section, parent: null })}
            onClose={() => setAdding(null)}
            onSubmit={(title, due) => add(g.section, null, title, due)}
            label="+ Add"
          />
        </section>
      ))}

      {newSection ? (
        <input className="et-tv-add-input" autoFocus placeholder="New section name…"
          onKeyDown={async (e) => {
            if (e.key === "Escape") setNewSection(false);
            if (e.key === "Enter") {
              const v = (e.target as HTMLInputElement).value.trim();
              (e.target as HTMLInputElement).value = "";
              setNewSection(false);
              if (v) { await api.post("/tasks/sections", { name: v }); refresh(); }
            }
          }}
          onBlur={() => setNewSection(false)} />
      ) : (
        <button className="et-tv-newsection" onClick={() => setNewSection(true)}>+ New section</button>
      )}

      <TasksStyles />
    </div>
  );
}

function TaskRow({ node, depth, section, adding, setAdding, onAdd, onChanged }: {
  node: TaskNode; depth: number; section: string;
  adding: { section: string; parent: string | null } | null;
  setAdding: (v: { section: string; parent: string | null } | null) => void;
  onAdd: (section: string, parent: string | null, title: string, due: string) => Promise<void>;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const due = dueLabel(node.props.due_date);
  const hasKids = node.children.length > 0;
  // A parent shows subtree progress; a leaf has nothing to summarise.
  const showProgress = hasKids && node.progress.total > 1;
  // Three levels is the ceiling, so the deepest row cannot add beneath it.
  const canNest = depth < 2;
  const repeat = typeof node.props.recurrence === "string" ? node.props.recurrence : "";
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const complete = async () => {
    qc.setQueryData<Group[]>(["task-tree"], (old) => old); // keep the list stable while the write lands
    await api.patch(`/tasks/${node.id}`, { status: "done" });
    onChanged();
  };

  const setDue = async (v: string) => {
    await api.patch(`/pages/${node.id}`, {
      properties: { due_date: v ? new Date(`${v}T12:00:00`).getTime() : null },
    });
    onChanged();
  };

  const setRepeat = async (v: string) => {
    await api.patch(`/tasks/${node.id}`, { recurrence: v || null });
    onChanged();
  };

  // Renaming in place. A task is a line of text, so opening a document just to
  // fix a typo in its title is the wrong amount of ceremony.
  const rename = async (v: string) => {
    setEditing(false);
    const title = v.trim();
    if (!title || title === node.title) return;
    await api.patch(`/tasks/${node.id}`, { title });
    onChanged();
  };

  const remove = async () => {
    await api.del(`/tasks/${node.id}`);
    setConfirmDel(false);
    onChanged();
  };

  return (
    <>
      <div className="et-tv-row" style={{ paddingLeft: `${depth * 1.35}rem` }} data-depth={depth}>
        <button className="et-tv-check" aria-label="Complete" onClick={complete} />
        {editing ? (
          <input className="et-tv-title-edit" autoFocus defaultValue={node.title}
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(false);
            }} />
        ) : (
          // A span, not a link: clicking a task edits it. The page behind it is
          // storage, not a destination, and is reachable via ↗ when there are
          // actually notes to write.
          <span className="et-tv-title" onClick={() => setEditing(true)}
            data-goal={depth === 0 && hasKids ? "" : undefined}>
            {node.title || "Untitled"}
          </span>
        )}
        {repeat && <span className="et-tv-repeat" title={`Repeats ${repeat}`}>↻</span>}
        {showProgress && (
          <span className="et-tv-prog" title={`${node.progress.done} of ${node.progress.total} done`}>
            {node.progress.done}/{node.progress.total}
          </span>
        )}
        {node.props.source_page ? <SourceChip pageId={String(node.props.source_page)} /> : null}
        <input className="et-tv-date" type="date" defaultValue={toInput(node.props.due_date)}
          onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
        {due && <span className="et-tv-due" data-tone={due.tone}>{due.text}</span>}
        <select className="et-tv-rep-sel" value={repeat} aria-label="Repeat"
          data-set={repeat ? "" : undefined}
          onChange={(e) => setRepeat(e.target.value)}>
          <option value="">Once</option>
          {RECURRENCES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {canNest && (
          <button className="et-tv-sub" title="Break this down"
            onClick={() => setAdding({ section, parent: node.id })}>+</button>
        )}
        <a className="et-tv-open" href={`/page/?id=${node.id}`} title="Open notes">↗</a>
        {confirmDel ? (
          <span className="et-tv-confirm">
            {hasKids ? `Delete with ${node.progress.total - 1} subtask${node.progress.total > 2 ? "s" : ""}?` : "Delete?"}
            <button className="et-tv-yes" onClick={remove}>Yes</button>
            <button className="et-tv-no" onClick={() => setConfirmDel(false)}>Cancel</button>
          </span>
        ) : (
          <button className="et-tv-del" title="Delete task" onClick={() => setConfirmDel(true)}>×</button>
        )}
      </div>

      {node.children.map((k) => (
        <TaskRow key={k.id} node={k} depth={depth + 1} section={section}
          adding={adding} setAdding={setAdding} onAdd={onAdd} onChanged={onChanged} />
      ))}

      {adding?.parent === node.id && (
        <div style={{ paddingLeft: `${(depth + 1) * 1.35}rem` }}>
          <AddRow open onOpen={() => {}} onClose={() => setAdding(null)}
            onSubmit={(title, d) => onAdd(section, node.id, title, d)} label="" />
        </div>
      )}
    </>
  );
}

/** Title plus an optional deadline, so a goal can be created in one go rather
 *  than made and then edited. */
function AddRow({ open, onOpen, onClose, onSubmit, label }: {
  open: boolean; onOpen: () => void; onClose: () => void;
  onSubmit: (title: string, due: string) => void | Promise<void>; label: string;
}) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  if (!open) return <button className="et-tv-add" onClick={onOpen}>{label}</button>;
  const submit = () => { if (title.trim()) { void onSubmit(title, due); setTitle(""); setDue(""); } onClose(); };
  return (
    <div className="et-tv-addrow">
      <input className="et-tv-add-input" autoFocus placeholder="What needs doing?"
        value={title} onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }} />
      <input className="et-tv-add-date" type="date" value={due}
        onChange={(e) => setDue(e.target.value)} title="Deadline (optional)" />
      <button className="et-tv-add-go" onClick={submit}>Add</button>
    </div>
  );
}

function SourceChip({ pageId }: { pageId: string }) {
  const { data } = useQuery({ queryKey: ["page", pageId], queryFn: () => api.get<Page>(`/pages/${pageId}`) });
  if (!data) return null;
  return <a className="et-tv-src" href={`/page/?id=${pageId}`}>{data.icon ?? "📄"} {data.title || "Untitled"}</a>;
}

function TasksStyles() {
  return (
    <style jsx global>{`
      .et-tv { max-width: 50rem; margin: 0 auto; padding: 2.5rem 3rem 6rem; }
      .et-tv-head { display: flex; align-items: baseline; gap: 0.7rem; margin-bottom: 1.8rem; }
      .et-tv-head h1 { font-size: 2.2rem; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
      .et-tv-count { font-size: 0.85rem; color: var(--ink-faint); }
      .et-tv-empty { color: var(--ink-faint); font-size: 0.9rem; padding: 2rem 3rem; }
      .et-tv-section { margin-bottom: 1.9rem; }
      .et-tv-section-head { display: flex; align-items: center; gap: 0.5rem; padding-bottom: 0.4rem;
        border-bottom: 1px solid var(--rule); margin-bottom: 0.3rem; }
      .et-tv-section-name { font-family: var(--font-mono); font-size: 0.7rem; text-transform: uppercase;
        letter-spacing: 0.07em; color: var(--ink-faint); }
      .et-tv-section-count { font-size: 0.7rem; color: var(--line-strong); }
      /* Hidden until the row is hovered: deleting a section is rare, and a
         permanent × next to every heading reads as clutter. */
      .et-tv-section-del { margin-left: auto; background: none; border: 0; cursor: pointer;
        font: inherit; font-size: 0.95rem; line-height: 1; padding: 0 0.25rem;
        color: var(--line-strong); opacity: 0; transition: opacity 0.12s, color 0.12s; }
      .et-tv-section-head:hover .et-tv-section-del { opacity: 1; }
      .et-tv-section-del:hover { color: var(--ink); }
      /* Keyboard users never hover, so focus has to reveal it too. */
      .et-tv-section-del:focus-visible { opacity: 1; color: var(--ink); }
      .et-tv-confirm { margin-left: auto; display: flex; align-items: center; gap: 0.5rem;
        font-size: 0.7rem; text-transform: none; letter-spacing: 0; color: var(--ink-faint); }
      .et-tv-yes, .et-tv-no { background: none; border: 0; cursor: pointer; font: inherit;
        font-size: 0.7rem; padding: 0; }
      .et-tv-yes { color: #c0392b; }
      .et-tv-no { color: var(--line-strong); }
      .et-tv-yes:hover, .et-tv-no:hover { text-decoration: underline; }
      .et-tv-row { display: flex; align-items: center; gap: 0.55rem; padding: 0.34rem 0; min-width: 0; }
      .et-tv-row:hover .et-tv-sub, .et-tv-row:hover .et-tv-date,
      .et-tv-row:hover .et-tv-del, .et-tv-row:hover .et-tv-open,
      .et-tv-row:hover .et-tv-rep-sel { opacity: 1; }
      /* Clicking the title edits it, so it has to read as editable text
         rather than as a link. */
      .et-tv-title { cursor: text; }
      .et-tv-title-edit { flex: 1; min-width: 0; font: inherit; font-size: 0.92rem;
        color: var(--ink); background: none; border: none; border-bottom: 1px solid var(--color-iris);
        padding: 0; outline: none; }
      .et-tv-repeat { flex: none; font-size: 0.72rem; color: var(--color-iris); }
      /* Kept in the layout when set, so a repeating task shows its rule
         without needing a hover to discover it. */
      .et-tv-rep-sel { flex: none; opacity: 0; font: inherit; font-size: 0.7rem;
        background: none; border: none; color: var(--ink-faint); cursor: pointer;
        max-width: 5.5rem; transition: opacity 0.12s; }
      .et-tv-rep-sel[data-set] { opacity: 1; color: var(--color-iris); }
      .et-tv-rep-sel:focus { opacity: 1; outline: none; }
      .et-tv-open { flex: none; opacity: 0; text-decoration: none; font-size: 0.75rem;
        color: var(--ink-faint); transition: opacity 0.12s, color 0.12s; }
      .et-tv-open:hover { color: var(--color-iris); }
      .et-tv-del { flex: none; opacity: 0; background: none; border: none; cursor: pointer;
        font: inherit; font-size: 0.9rem; line-height: 1; padding: 0 0.15rem;
        color: var(--ink-faint); transition: opacity 0.12s, color 0.12s; }
      .et-tv-del:hover { color: #c0392b; }
      .et-tv-del:focus-visible, .et-tv-open:focus-visible, .et-tv-rep-sel:focus-visible { opacity: 1; }
      .et-tv-check { flex: none; width: 15px; height: 15px; border: 1.5px solid var(--line-strong);
        border-radius: 4px; background: none; cursor: pointer; padding: 0; }
      .et-tv-check:hover { border-color: var(--color-sage); background: var(--color-sage); }
      .et-tv-title { flex: 1; min-width: 0; font-size: 0.92rem; color: inherit; text-decoration: none;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      /* A goal — a top-level item with work under it — reads heavier. */
      .et-tv-title[data-goal] { font-weight: 600; }
      .et-tv-title:hover { color: var(--color-iris); }
      .et-tv-prog { flex: none; font-family: var(--font-mono); font-size: 0.68rem; color: var(--ink-faint);
        background: var(--surface-2); padding: 0.08rem 0.35rem; border-radius: 4px; }
      .et-tv-src { flex: none; font-size: 0.73rem; color: var(--ink-faint); text-decoration: none;
        max-width: 9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .et-tv-date { flex: none; opacity: 0; width: 1.6rem; border: none; background: none; color: var(--ink-faint);
        font: inherit; font-size: 0.7rem; cursor: pointer; }
      .et-tv-date:focus { opacity: 1; width: auto; outline: none; }
      .et-tv-due { flex: none; font-family: var(--font-mono); font-size: 0.68rem; padding: 0.1rem 0.4rem;
        border-radius: 4px; color: var(--ink-faint); white-space: nowrap; }
      .et-tv-due[data-tone="overdue"] { color: #b4462e; background: rgba(180,70,46,.12); }
      .et-tv-due[data-tone="soon"] { color: var(--color-amber); background: rgba(217,138,61,.14); }
      .et-tv-sub { flex: none; opacity: 0; background: none; border: none; color: var(--ink-faint);
        font-size: 0.95rem; cursor: pointer; padding: 0 0.2rem; }
      .et-tv-sub:hover { color: var(--color-iris); }
      .et-tv-add { background: none; border: none; font: inherit; font-size: 0.82rem; color: var(--line-strong);
        cursor: pointer; padding: 0.3rem 0; }
      .et-tv-add:hover { color: var(--color-iris); }
      .et-tv-addrow { display: flex; align-items: center; gap: 0.4rem; padding: 0.2rem 0; }
      .et-tv-add-input { flex: 1; min-width: 0; border: none; border-bottom: 1px solid var(--color-iris);
        background: none; font: inherit; font-size: 0.92rem; color: inherit; padding: 0.3rem 0; }
      .et-tv-add-input:focus { outline: none; }
      .et-tv-add-date { flex: none; border: 1px solid var(--rule); border-radius: 5px; background: none;
        font: inherit; font-size: 0.78rem; color: var(--ink-soft); padding: 0.2rem 0.3rem; }
      .et-tv-add-go { flex: none; background: var(--color-iris); color: #fff; border: none; border-radius: 5px;
        font: inherit; font-size: 0.8rem; padding: 0.28rem 0.7rem; cursor: pointer; }
      .et-tv-newsection { background: none; border: 1px dashed var(--rule); border-radius: 7px; font: inherit;
        font-size: 0.82rem; color: var(--ink-faint); padding: 0.35rem 0.8rem; cursor: pointer; margin-top: 0.5rem; }
      .et-tv-newsection:hover { color: var(--ink); border-color: var(--ink-faint); }
    `}</style>
  );
}
