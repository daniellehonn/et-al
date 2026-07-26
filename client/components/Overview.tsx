"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Workspace, type Task, type Health } from "@/lib/api";
import { EditableText, DeleteButton } from "./Editable";

const FINITE_TYPES = ["project", "course"];

export interface OverviewBlock { id: string; workspace_id: string; type: string; config_json: string; position: number }
type Config = Record<string, unknown>;
const parse = (b: OverviewBlock): Config => { try { return JSON.parse(b.config_json); } catch { return {}; } };

// ── the page ────────────────────────────────────────────────────────────────
export function OverviewView({ id, workspace, setTab }: { id: string; workspace: Workspace; setTab: (t: string) => void }) {
  const qc = useQueryClient();
  const { data: blocks } = useQuery({ queryKey: ["overview", id], queryFn: () => api.get<OverviewBlock[]>(`/workspaces/${id}/overview`) });
  const add = useMutation({
    mutationFn: (type: string) => api.post(`/workspaces/${id}/overview`, { type }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["overview", id] }),
  });
  const reorder = useMutation({
    mutationFn: ({ bid, position }: { bid: string; position: number }) => api.patch(`/overview/${bid}`, { position }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["overview", id] }),
  });
  const finite = FINITE_TYPES.includes(workspace.type);
  const custom = blocks ?? [];

  // Drag a widget by its handle and drop before another (or onto the end zone).
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dropBefore = (targetId: string | null) => {
    if (dragId) {
      let position: number;
      if (targetId === null) {
        position = (custom[custom.length - 1]?.position ?? 0) + 1; // end
      } else {
        const idx = custom.findIndex((b) => b.id === targetId);
        const prev = custom[idx - 1];
        position = prev ? (prev.position + custom[idx].position) / 2 : custom[idx].position - 1;
      }
      if (targetId !== dragId) reorder.mutate({ bid: dragId, position });
    }
    setDragId(null); setOverId(null);
  };

  const addable: Array<[string, string]> = [
    ["table", "Table"],
    ["child_progress", "Child progress"],
    ["tasks", "Tasks"],
    ["text", "Text"],
    ...(finite ? ([["progress", "Progress"]] as Array<[string, string]>) : []),
  ];

  return (
    <div className="et-ov">
      {custom.length > 0 ? (
        <>
          {custom.map((b) => (
            <div key={b.id} className="et-widget-wrap" data-over={overId === b.id || undefined} data-dragging={dragId === b.id || undefined}
              onDragOver={(e) => { if (dragId && dragId !== b.id) { e.preventDefault(); setOverId(b.id); } }}
              onDragLeave={() => setOverId((c) => (c === b.id ? null : c))}
              onDrop={(e) => { e.preventDefault(); dropBefore(b.id); }}>
              <Widget block={b} workspace={workspace} setTab={setTab}
                drag={{ onStart: () => setDragId(b.id), onEnd: () => { setDragId(null); setOverId(null); } }} />
            </div>
          ))}
          {dragId && (
            <div className="et-widget-endzone" data-over={overId === "__end" || undefined}
              onDragOver={(e) => { e.preventDefault(); setOverId("__end"); }}
              onDragLeave={() => setOverId((c) => (c === "__end" ? null : c))}
              onDrop={(e) => { e.preventDefault(); dropBefore(null); }}>
              Drop here to move to the end
            </div>
          )}
        </>
      ) : (
        // No custom layout yet — show a smart default for the type, read-only.
        <div className="et-ov-default">
          {finite
            ? <WidgetBody type="progress" config={{ title: "Progress toward done" }} workspace={workspace} setTab={setTab} />
            : <WidgetBody type="child_progress" config={{ title: `Inside this ${workspace.type}` }} workspace={workspace} setTab={setTab} />}
          <WidgetBody type="tasks" config={{ title: "Next up" }} workspace={workspace} setTab={setTab} />
          <p className="et-ov-hint">This is the default overview. Add widgets below to customize it.</p>
        </div>
      )}

      <div className="et-ov-add">
        <span className="eyebrow">Add widget</span>
        {addable.map(([t, label]) => (
          <button key={t} onClick={() => add.mutate(t)} disabled={add.isPending}>+ {label}</button>
        ))}
      </div>
      <OverviewStyles />
    </div>
  );
}

// ── a persisted, editable widget (title + remove + body) ─────────────────────
function Widget({ block, workspace, setTab, drag }: { block: OverviewBlock; workspace: Workspace; setTab: (t: string) => void; drag?: { onStart: () => void; onEnd: () => void } }) {
  const qc = useQueryClient();
  const config = parse(block);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["overview", block.workspace_id] });
  const save = useMutation({ mutationFn: (next: Config) => api.patch(`/overview/${block.id}`, { config: next }), onSuccess: invalidate });
  const del = useMutation({ mutationFn: () => api.del(`/overview/${block.id}`), onSuccess: invalidate });
  const setConfig = (next: Config) => save.mutate(next);

  return (
    <section className="et-widget">
      <div className="et-widget-head">
        {drag && <span className="et-widget-drag" draggable onDragStart={drag.onStart} onDragEnd={drag.onEnd} title="Drag to reorder">⠿</span>}
        <EditableText className="et-widget-title" value={String(config.title ?? "")} placeholder="Untitled widget"
          onSave={(title) => setConfig({ ...config, title })} />
        <DeleteButton onDelete={() => del.mutate()} confirm label="Remove widget" />
      </div>
      <WidgetBody type={block.type} config={config} workspace={workspace} setTab={setTab} onConfigChange={setConfig} />
    </section>
  );
}

// ── the body renderers, by type ──────────────────────────────────────────────
function WidgetBody({ type, config, workspace, setTab, onConfigChange }: {
  type: string; config: Config; workspace: Workspace; setTab: (t: string) => void; onConfigChange?: (c: Config) => void;
}) {
  if (type === "table") return <TableWidget config={config} onChange={onConfigChange} />;
  if (type === "child_progress") return <ChildProgressWidget workspaceId={workspace.id} type={workspace.type} />;
  if (type === "tasks") return <TasksWidget workspaceId={workspace.id} setTab={setTab} />;
  if (type === "text") return <TextWidget config={config} onChange={onConfigChange} />;
  if (type === "progress") return <ProgressWidget workspaceId={workspace.id} workspace={workspace} />;
  return null;
}

// ── Table: the club application tracker etc. ─────────────────────────────────
interface Col { id: string; name: string }
interface Row { id: string; cells: Record<string, string> }
function TableWidget({ config, onChange }: { config: Config; onChange?: (c: Config) => void }) {
  const cols = (config.columns as Col[]) ?? [];
  const rows = (config.rows as Row[]) ?? [];
  const readOnly = !onChange;
  const update = (patch: Partial<{ columns: Col[]; rows: Row[] }>) => onChange?.({ ...config, ...patch });
  const rid = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

  const addRow = () => update({ rows: [...rows, { id: rid(), cells: {} }] });
  const addCol = () => update({ columns: [...cols, { id: rid(), name: "Column" }] });
  const setCell = (r: Row, colId: string, v: string) => update({ rows: rows.map((x) => x.id === r.id ? { ...x, cells: { ...x.cells, [colId]: v } } : x) });
  const renameCol = (colId: string, name: string) => update({ columns: cols.map((c) => c.id === colId ? { ...c, name } : c) });
  const delRow = (r: Row) => update({ rows: rows.filter((x) => x.id !== r.id) });
  const delCol = (colId: string) => update({ columns: cols.filter((c) => c.id !== colId), rows: rows.map((r) => { const { [colId]: _, ...rest } = r.cells; return { ...r, cells: rest }; }) });

  return (
    <div className="et-table-wrap">
      <table className="et-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.id}>
                <span className="et-th">
                  {readOnly ? c.name : <EditableText value={c.name} onSave={(n) => renameCol(c.id, n)} />}
                  {!readOnly && <DeleteButton onDelete={() => delCol(c.id)} />}
                </span>
              </th>
            ))}
            {!readOnly && <th className="et-th-add"><button onClick={addCol} title="Add column">+</button></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {cols.map((c) => (
                <td key={c.id}>
                  {readOnly ? (r.cells[c.id] ?? "") : <EditableText value={r.cells[c.id] ?? ""} placeholder="—" onSave={(v) => setCell(r, c.id, v)} />}
                </td>
              ))}
              {!readOnly && <td className="et-td-del"><DeleteButton onDelete={() => delRow(r)} /></td>}
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={cols.length + 1} className="et-empty">No rows yet.</td></tr>}
        </tbody>
      </table>
      {!readOnly && <button className="et-table-addrow" onClick={addRow}>+ Add row</button>}
    </div>
  );
}

// ── Child progress: a bar per sub-workspace ──────────────────────────────────
function ChildProgressWidget({ workspaceId, type }: { workspaceId: string; type: string }) {
  const { data: workspaces } = useQuery({ queryKey: ["workspaces"], queryFn: () => api.get<Workspace[]>("/workspaces") });
  const { data: health } = useQuery({ queryKey: ["health-scores"], queryFn: () => api.get<Health[]>("/health-scores") });
  const children = (workspaces ?? []).filter((w) => w.parent_id === workspaceId);
  const byId = new Map((health ?? []).map((h) => [h.workspace_id, h]));
  if (children.length === 0) return <div className="et-empty">Nothing inside this {type} yet.</div>;
  return (
    <div className="et-childprog">
      {children.map((w) => {
        const h = byId.get(w.id);
        const total = (h?.open_tasks ?? 0) + (h?.done_tasks ?? 0);
        const pct = total ? Math.round(((h?.done_tasks ?? 0) / total) * 100) : 0;
        return (
          <a key={w.id} href={`/workspace/?id=${w.id}`} className="et-childprog-row">
            <span className="et-childprog-name">{w.title}</span>
            <span className="et-childprog-bar"><span style={{ width: `${w.status === "completed" ? 100 : pct}%` }} data-done={w.status === "completed" || undefined} /></span>
            <span className="eyebrow et-childprog-pct">{w.status === "completed" ? "✓" : total ? `${pct}%` : "—"}</span>
          </a>
        );
      })}
    </div>
  );
}

function TasksWidget({ workspaceId, setTab }: { workspaceId: string; setTab: (t: string) => void }) {
  const { data: tasks } = useQuery({ queryKey: ["tasks", workspaceId], queryFn: () => api.get<Task[]>(`/workspaces/${workspaceId}/tasks`) });
  const open = (tasks ?? []).filter((t) => t.status !== "done");
  if (open.length === 0) return <div className="et-empty">No open tasks. <button className="et-link" onClick={() => setTab("Tasks")}>Add one →</button></div>;
  return (
    <div className="et-taskswidget">
      {open.slice(0, 6).map((t) => <div key={t.id} className="et-tw-row"><span className="et-prio" data-p={t.priority} />{t.title}</div>)}
      {open.length > 6 && <button className="et-link" onClick={() => setTab("Tasks")}>+{open.length - 6} more →</button>}
    </div>
  );
}

function TextWidget({ config, onChange }: { config: Config; onChange?: (c: Config) => void }) {
  if (!onChange) return <div className="et-textwidget">{String(config.text ?? "")}</div>;
  return <EditableText multiline className="et-textwidget" value={String(config.text ?? "")} placeholder="Write anything…" onSave={(text) => onChange({ ...config, text })} />;
}

function ProgressWidget({ workspaceId, workspace }: { workspaceId: string; workspace: Workspace }) {
  const { data: tasks } = useQuery({ queryKey: ["tasks", workspaceId], queryFn: () => api.get<Task[]>(`/workspaces/${workspaceId}/tasks`) });
  const all = tasks ?? [];
  const done = all.filter((t) => t.status === "done").length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  if (workspace.status === "completed") return <div className="et-complete-note"><span className="serif et-complete-check">✓</span> Complete.</div>;
  return (
    <div>
      <div className="et-progress-head"><span className="eyebrow">Toward done</span><span className="et-progress-frac">{done} / {all.length} tasks</span></div>
      <div className="et-progress-bar"><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function OverviewStyles() {
  return (
    <style>{`
      .et-ov { display: flex; flex-direction: column; gap: 1.2rem; }
      .et-ov-default { display: flex; flex-direction: column; gap: 1.4rem; }
      .et-ov-hint { color: var(--ink-faint); font-size: 0.85rem; font-style: italic; margin: 0.2rem 0 0; }
      .et-widget-wrap { border-radius: 12px; transition: box-shadow 0.1s; }
      .et-widget-wrap[data-dragging="true"] { opacity: 0.4; }
      .et-widget-wrap[data-over="true"] { box-shadow: 0 -3px 0 -1px var(--color-iris); }
      .et-widget { border: 1px solid var(--line); border-radius: 12px; padding: 1.1rem 1.2rem; background: var(--paper-raised); }
      .et-widget-head { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.8rem; }
      .et-widget-drag { cursor: grab; color: var(--ink-faint); font-size: 0.95rem; line-height: 1; user-select: none; }
      .et-widget-drag:hover { color: var(--ink); }
      .et-widget-title { font-weight: 500; font-size: 1rem; flex: 1; }
      .et-widget-endzone { border: 1px dashed var(--line-strong); border-radius: 10px; padding: 0.7rem; text-align: center; color: var(--ink-faint); font-size: 0.82rem; }
      .et-widget-endzone[data-over="true"] { border-color: var(--color-iris); border-style: solid; background: var(--color-iris-soft); color: var(--color-iris); }
      .et-ov-add { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; padding-top: 0.4rem; }
      .et-ov-add button { background: none; border: 1px dashed var(--line-strong); border-radius: 8px; color: var(--ink-soft); font: inherit; font-size: 0.82rem; padding: 0.3rem 0.7rem; cursor: pointer; }
      .et-ov-add button:hover { border-color: var(--color-iris); color: var(--color-iris); border-style: solid; }

      .et-table-wrap { overflow-x: auto; }
      .et-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
      .et-table th, .et-table td { border: 1px solid var(--line); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
      .et-table th { background: var(--paper); font-weight: 500; font-size: 0.82rem; }
      .et-th { display: flex; align-items: center; gap: 0.3rem; justify-content: space-between; }
      .et-th-add, .et-td-del { width: 1.5rem; text-align: center; }
      .et-th-add button { background: none; border: none; color: var(--ink-faint); font-size: 1rem; cursor: pointer; }
      .et-table-addrow { margin-top: 0.5rem; background: none; border: none; color: var(--ink-soft); font: inherit; font-size: 0.85rem; cursor: pointer; }
      .et-table-addrow:hover { color: var(--color-iris); }

      .et-childprog { display: flex; flex-direction: column; }
      .et-childprog-row { display: grid; grid-template-columns: 9rem 1fr 2.4rem; align-items: center; gap: 0.7rem; padding: 0.4rem 0; text-decoration: none; color: var(--ink); border-bottom: 1px solid var(--line); }
      .et-childprog-row:hover .et-childprog-name { color: var(--color-iris); }
      .et-childprog-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.9rem; }
      .et-childprog-bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; }
      .et-childprog-bar span { display: block; height: 100%; background: var(--color-iris); border-radius: 3px; }
      .et-childprog-bar span[data-done] { background: var(--color-sage); }
      .et-childprog-pct { text-align: right; }

      .et-taskswidget, .et-tw-row { display: flex; }
      .et-taskswidget { flex-direction: column; }
      .et-tw-row { align-items: center; gap: 0.55rem; padding: 0.35rem 0; border-bottom: 1px solid var(--line); font-size: 0.9rem; }
      .et-textwidget { white-space: pre-wrap; color: var(--ink-soft); font-size: 0.92rem; min-height: 1.5rem; }
      .et-link { background: none; border: none; color: var(--color-iris); font: inherit; cursor: pointer; padding: 0; }
      .et-progress-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.5rem; }
      .et-progress-frac { font-size: 0.85rem; color: var(--ink-soft); }
      .et-progress-bar { height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
      .et-progress-bar span { display: block; height: 100%; background: var(--color-sage); border-radius: 4px; transition: width 0.4s; }
      .et-complete-note { display: flex; align-items: center; gap: 0.5rem; }
      .et-complete-check { color: var(--color-sage); font-size: 1.4rem; }
      .et-empty { color: var(--ink-faint); font-style: italic; font-size: 0.9rem; padding: 0.4rem 0; }
    `}</style>
  );
}
