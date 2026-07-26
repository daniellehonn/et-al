"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Workspace, type Task, type Health, type Objective, type Document, type Relationship } from "@/lib/api";
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
    ["objective_progress", "Objective progress"],
    ["tasks", "Tasks"],
    ["deadlines", "Deadlines"],
    ["links", "Links"],
    ["text", "Text"],
    ["metric", "Metric"],
    ["image", "Image"],
    ["backlinks", "Backlinks"],
    ...(finite ? ([["progress", "Progress"]] as Array<[string, string]>) : []),
  ];

  return (
    <div className="et-ov">
      {custom.length > 0 ? (
        <div className="et-ov-grid">
          {custom.map((b) => (
            <div key={b.id} className="et-widget-wrap" data-width={parse(b).width === "half" ? "half" : undefined}
              data-over={overId === b.id || undefined} data-dragging={dragId === b.id || undefined}
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
        </div>
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
        <button className="et-widget-width" title={config.width === "half" ? "Make full width" : "Make half width"}
          onClick={() => setConfig({ ...config, width: config.width === "half" ? "full" : "half" })}>{config.width === "half" ? "▭" : "◧"}</button>
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
  if (type === "child_progress") return <ChildProgressWidget workspaceId={workspace.id} type={workspace.type} config={config} onChange={onConfigChange} />;
  if (type === "objective_progress") return <ObjectiveProgressWidget workspaceId={workspace.id} />;
  if (type === "tasks") return <TasksWidget workspaceId={workspace.id} setTab={setTab} config={config} onChange={onConfigChange} />;
  if (type === "text") return <TextWidget config={config} onChange={onConfigChange} />;
  if (type === "progress") return <ProgressWidget workspaceId={workspace.id} workspace={workspace} />;
  if (type === "deadlines") return <DeadlinesWidget workspaceId={workspace.id} setTab={setTab} />;
  if (type === "links") return <LinksWidget config={config} onChange={onConfigChange} />;
  if (type === "metric") return <MetricWidget config={config} onChange={onConfigChange} />;
  if (type === "image") return <ImageWidget config={config} onChange={onConfigChange} />;
  if (type === "backlinks") return <BacklinksWidget workspaceId={workspace.id} />;
  return null;
}

// ── Table: typed columns — the club application tracker etc. ─────────────────
type ColType = "text" | "status" | "date" | "checkbox" | "number";
interface Col { id: string; name: string; type?: ColType }
interface Row { id: string; cells: Record<string, string> }
const COL_TYPES: Array<[ColType, string]> = [["text", "Text"], ["status", "Status"], ["date", "Date"], ["checkbox", "Checkbox"], ["number", "Number"]];
const PILL_COLORS = ["#5D57E4", "#D98A3D", "#4E9E7F", "#c0392b", "#3a86ff", "#8b5cf6", "#0891b2", "#65758b"];
// Stable color per status value, so the same label is always the same colour.
function pillColor(v: string): string {
  let h = 0;
  for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) >>> 0;
  return PILL_COLORS[h % PILL_COLORS.length];
}

// Normalize legacy simple tables ({columns:string[], rows:string[][]}) to the
// rich typed-column format, so one renderer handles both.
function normalizeTable(config: Config): { columns: Col[]; rows: Row[] } {
  const rawCols = config.columns as unknown[];
  if (Array.isArray(rawCols) && typeof rawCols[0] === "string") {
    const columns: Col[] = (rawCols as string[]).map((name, i) => ({ id: `c${i}`, name, type: "text" }));
    const rows: Row[] = ((config.rows as string[][]) ?? []).map((r, ri) => ({ id: `r${ri}`, cells: Object.fromEntries(columns.map((c, ci) => [c.id, r[ci] ?? ""])) }));
    return { columns, rows };
  }
  return { columns: (config.columns as Col[]) ?? [], rows: (config.rows as Row[]) ?? [] };
}

export function TableWidget({ config, onChange }: { config: Config; onChange?: (c: Config) => void }) {
  const { columns: cols, rows } = normalizeTable(config);
  const readOnly = !onChange;
  // Always write back the normalized (rich) columns/rows, so legacy tables upgrade on edit.
  const update = (patch: Partial<{ columns: Col[]; rows: Row[] }>) => onChange?.({ ...config, columns: cols, rows, ...patch });
  const rid = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

  const addRow = () => update({ rows: [...rows, { id: rid(), cells: {} }] });
  const addCol = () => update({ columns: [...cols, { id: rid(), name: "Column", type: "text" }] });
  const setCell = (r: Row, colId: string, v: string) => update({ rows: rows.map((x) => x.id === r.id ? { ...x, cells: { ...x.cells, [colId]: v } } : x) });
  const renameCol = (colId: string, name: string) => update({ columns: cols.map((c) => c.id === colId ? { ...c, name } : c) });
  const setColType = (colId: string, type: ColType) => update({ columns: cols.map((c) => c.id === colId ? { ...c, type } : c) });
  const delRow = (r: Row) => update({ rows: rows.filter((x) => x.id !== r.id) });
  const delCol = (colId: string) => update({ columns: cols.filter((c) => c.id !== colId), rows: rows.map((r) => { const { [colId]: _, ...rest } = r.cells; return { ...r, cells: rest }; }) });
  const [dragCol, setDragCol] = useState<string | null>(null);
  const moveCol = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const arr = [...cols];
    const from = arr.findIndex((c) => c.id === fromId), to = arr.findIndex((c) => c.id === toId);
    if (from < 0 || to < 0) return;
    const [m] = arr.splice(from, 1); arr.splice(to, 0, m);
    update({ columns: arr });
  };

  return (
    <div className="et-table-wrap">
      <table className="et-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.id} data-dragover={dragCol && dragCol !== c.id ? undefined : undefined}
                onDragOver={(e) => { if (dragCol && dragCol !== c.id) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (dragCol) moveCol(dragCol, c.id); setDragCol(null); }}>
                <span className="et-th">
                  {!readOnly && <span className="et-th-drag" draggable onDragStart={() => setDragCol(c.id)} onDragEnd={() => setDragCol(null)} title="Drag to reorder column">⠿</span>}
                  {readOnly ? c.name : <EditableText value={c.name} onSave={(n) => renameCol(c.id, n)} />}
                  {!readOnly && (
                    <details className="et-col-menu">
                      <summary title="Column type">{{ text: "T", status: "◍", date: "☷", checkbox: "☑", number: "#" }[c.type ?? "text"]}</summary>
                      <div className="et-col-list">
                        {COL_TYPES.map(([t, label]) => <button key={t} data-on={(c.type ?? "text") === t || undefined} onClick={(e) => { setColType(c.id, t); (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>{label}</button>)}
                        <button className="et-col-del" onClick={(e) => { delCol(c.id); (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>Delete column</button>
                      </div>
                    </details>
                  )}
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
                <td key={c.id} data-type={c.type ?? "text"}>
                  <Cell type={c.type ?? "text"} value={r.cells[c.id] ?? ""} readOnly={readOnly} onSave={(v) => setCell(r, c.id, v)} />
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

function Cell({ type, value, readOnly, onSave }: { type: ColType; value: string; readOnly: boolean; onSave: (v: string) => void }) {
  if (type === "checkbox") {
    return <input type="checkbox" className="et-cell-check" checked={value === "true"} disabled={readOnly} onChange={(e) => onSave(String(e.target.checked))} />;
  }
  if (type === "date") {
    if (readOnly) return <>{value || "—"}</>;
    return <input type="date" className="et-cell-date" value={value} onChange={(e) => onSave(e.target.value)} />;
  }
  if (type === "number") {
    return <EditableText value={value} placeholder="—" inputClassName="et-cell-num" onSave={onSave} />;
  }
  if (type === "status") {
    const pill = value ? <span className="et-pill" style={{ background: `${pillColor(value)}22`, color: pillColor(value), boxShadow: `inset 0 0 0 1px ${pillColor(value)}55` }}>{value}</span> : <span className="et-pill-empty">—</span>;
    if (readOnly) return pill;
    return <EditableText value={value} placeholder="—" onSave={onSave} render={pill} />;
  }
  return readOnly ? <>{value || ""}</> : <EditableText value={value} placeholder="—" onSave={onSave} />;
}

// ── Child progress: a bar per sub-workspace ──────────────────────────────────
function ChildProgressWidget({ workspaceId, type, config, onChange }: { workspaceId: string; type: string; config?: Config; onChange?: (c: Config) => void }) {
  const { data: workspaces } = useQuery({ queryKey: ["workspaces"], queryFn: () => api.get<Workspace[]>("/workspaces") });
  const { data: health } = useQuery({ queryKey: ["health-scores"], queryFn: () => api.get<Health[]>("/health-scores") });
  const byId = new Map((health ?? []).map((h) => [h.workspace_id, h]));
  const pctOf = (id: string) => { const h = byId.get(id); const total = (h?.open_tasks ?? 0) + (h?.done_tasks ?? 0); return total ? Math.round(((h?.done_tasks ?? 0) / total) * 100) : 0; };
  const sort = String(config?.sort ?? "name");
  const children = (workspaces ?? []).filter((w) => w.parent_id === workspaceId).sort((a, b) =>
    sort === "least" ? pctOf(a.id) - pctOf(b.id) : sort === "most" ? pctOf(b.id) - pctOf(a.id) : a.title.localeCompare(b.title));
  if (children.length === 0) return <div className="et-empty">Nothing inside this {type} yet.</div>;
  return (
    <div className="et-childprog">
      {onChange && (
        <div className="et-w-opts">
          <select value={sort} onChange={(e) => onChange({ ...config, sort: e.target.value })} aria-label="Sort">
            <option value="name">A–Z</option><option value="least">Least done</option><option value="most">Most done</option>
          </select>
        </div>
      )}
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

function TasksWidget({ workspaceId, setTab, config, onChange }: { workspaceId: string; setTab: (t: string) => void; config?: Config; onChange?: (c: Config) => void }) {
  const { data: tasks } = useQuery({ queryKey: ["tasks", workspaceId], queryFn: () => api.get<Task[]>(`/workspaces/${workspaceId}/tasks`) });
  const { data: objectives } = useQuery({ queryKey: ["objectives", workspaceId], queryFn: () => api.get<Objective[]>(`/workspaces/${workspaceId}/objectives`) });
  const filter = String(config?.status_filter ?? "open");
  const objFilter = String(config?.objective_id ?? "");
  const shown = (tasks ?? [])
    .filter((t) => filter === "all" ? true : filter === "done" ? t.status === "done" : t.status !== "done")
    .filter((t) => !objFilter || (objFilter === "none" ? !t.objective_id : t.objective_id === objFilter));
  const opts = onChange && (
    <div className="et-w-opts">
      <select value={filter} onChange={(e) => onChange({ ...config, status_filter: e.target.value })} aria-label="Filter">
        <option value="open">Open</option><option value="all">All</option><option value="done">Done</option>
      </select>
      <select value={objFilter} onChange={(e) => onChange({ ...config, objective_id: e.target.value })} aria-label="Objective">
        <option value="">Any objective</option>
        <option value="none">No objective</option>
        {(objectives ?? []).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
      </select>
    </div>
  );
  if (shown.length === 0) return <div className="et-taskswidget">{opts}<div className="et-empty">No {filter === "open" ? "open " : ""}tasks. <button className="et-link" onClick={() => setTab("Tasks")}>Add one →</button></div></div>;
  return (
    <div className="et-taskswidget">
      {opts}
      {shown.slice(0, 6).map((t) => <div key={t.id} className="et-tw-row" data-done={t.status === "done" || undefined}><span className="et-prio" data-p={t.priority} />{t.title}</div>)}
      {shown.length > 6 && <button className="et-link" onClick={() => setTab("Tasks")}>+{shown.length - 6} more →</button>}
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

// A progress bar per objective, from its tasks' completion.
function ObjectiveProgressWidget({ workspaceId }: { workspaceId: string }) {
  const { data: objectives } = useQuery({ queryKey: ["objectives", workspaceId], queryFn: () => api.get<Objective[]>(`/workspaces/${workspaceId}/objectives`) });
  const { data: tasks } = useQuery({ queryKey: ["tasks", workspaceId], queryFn: () => api.get<Task[]>(`/workspaces/${workspaceId}/tasks`) });
  if ((objectives ?? []).length === 0) return <div className="et-empty">No objectives yet.</div>;
  return (
    <div className="et-childprog">
      {(objectives ?? []).map((o) => {
        const ts = (tasks ?? []).filter((t) => t.objective_id === o.id);
        const done = ts.filter((t) => t.status === "done").length;
        const pct = ts.length ? Math.round((done / ts.length) * 100) : 0;
        return (
          <div key={o.id} className="et-childprog-row" style={{ cursor: "default" }}>
            <span className="et-childprog-name">{o.title}</span>
            <span className="et-childprog-bar"><span style={{ width: `${pct}%`, background: pct === 100 ? "var(--color-sage)" : "var(--color-iris)" }} /></span>
            <span className="eyebrow et-childprog-pct">{ts.length ? `${pct}%` : "—"}</span>
          </div>
        );
      })}
    </div>
  );
}

// Upcoming task due dates across the workspace.
function DeadlinesWidget({ workspaceId, setTab }: { workspaceId: string; setTab: (t: string) => void }) {
  const { data: tasks } = useQuery({ queryKey: ["tasks", workspaceId], queryFn: () => api.get<Task[]>(`/workspaces/${workspaceId}/tasks`) });
  const due = (tasks ?? []).filter((t) => t.due_date && t.status !== "done").sort((a, b) => (a.due_date ?? 0) - (b.due_date ?? 0));
  if (due.length === 0) return <div className="et-empty">No upcoming deadlines. <button className="et-link" onClick={() => setTab("Tasks")}>Set due dates →</button></div>;
  const now = Date.now();
  return (
    <div className="et-deadlines">
      {due.slice(0, 8).map((t) => (
        <div key={t.id} className="et-dl-row" data-overdue={(t.due_date ?? 0) < now || undefined}>
          <span className="et-dl-date">{new Date(t.due_date!).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
          <span className="et-dl-title">{t.title}</span>
        </div>
      ))}
    </div>
  );
}

interface LinkItem { label: string; url: string }
function LinksWidget({ config, onChange }: { config: Config; onChange?: (c: Config) => void }) {
  const items = (config.items as LinkItem[]) ?? [];
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const add = () => { onChange?.({ ...config, items: [...items, { label: label.trim() || url, url: url.trim() }] }); setLabel(""); setUrl(""); };
  return (
    <div className="et-links">
      {items.map((it, i) => (
        <div key={i} className="et-link-row">
          <a href={it.url} target="_blank" rel="noreferrer">{it.label || it.url}</a>
          {onChange && <DeleteButton onDelete={() => onChange({ ...config, items: items.filter((_, ix) => ix !== i) })} />}
        </div>
      ))}
      {items.length === 0 && !onChange && <div className="et-empty">No links.</div>}
      {onChange && (
        <form className="et-link-add" onSubmit={(e) => { e.preventDefault(); if (url.trim()) add(); }}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          <button type="submit" disabled={!url.trim()}>Add</button>
        </form>
      )}
    </div>
  );
}

function MetricWidget({ config, onChange }: { config: Config; onChange?: (c: Config) => void }) {
  return (
    <div className="et-metric">
      <EditableText as="div" className="et-metric-value serif" value={String(config.value ?? "")} placeholder="0" onSave={(v) => onChange?.({ ...config, value: v })} />
      <EditableText className="et-metric-caption" value={String(config.caption ?? "")} placeholder="add a caption" onSave={(v) => onChange?.({ ...config, caption: v })} />
    </div>
  );
}

function ImageWidget({ config, onChange }: { config: Config; onChange?: (c: Config) => void }) {
  const url = String(config.url ?? "");
  return (
    <div className="et-image">
      {url ? <img src={url} alt={String(config.caption ?? "")} className="et-image-img" /> : <div className="et-empty">No image set.</div>}
      {onChange && <input className="et-image-url" value={url} onChange={(e) => onChange({ ...config, url: e.target.value })} placeholder="Image URL" />}
      {url && <EditableText className="et-image-cap" value={String(config.caption ?? "")} placeholder="caption" onSave={(v) => onChange?.({ ...config, caption: v })} />}
    </div>
  );
}

// What references this workspace (documents that @-mention it, etc.).
function BacklinksWidget({ workspaceId }: { workspaceId: string }) {
  const { data: links } = useQuery({ queryKey: ["backlinks", workspaceId], queryFn: () => api.get<Relationship[]>(`/backlinks?type=workspace&id=${workspaceId}`) });
  const rels = links ?? [];
  if (rels.length === 0) return <div className="et-empty">Nothing links here yet. @-mention this workspace in a document.</div>;
  return (
    <div className="et-backlinks">
      {rels.map((r) => <BacklinkRow key={r.id} rel={r} />)}
    </div>
  );
}

function BacklinkRow({ rel }: { rel: Relationship }) {
  const isDoc = rel.source_type === "document";
  const { data: doc } = useQuery({ queryKey: ["document", rel.source_id], queryFn: () => api.get<Document>(`/documents/${rel.source_id}`), enabled: isDoc });
  const { data: workspaces } = useQuery({ queryKey: ["workspaces"], queryFn: () => api.get<Workspace[]>("/workspaces"), enabled: !isDoc });
  if (isDoc) {
    if (!doc) return <div className="et-backlink-row et-empty">…</div>;
    return <a className="et-backlink-row" href={`/workspace/?id=${doc.workspace_id}&tab=Documents&doc=${doc.id}`}><span className="et-doc-icon serif">¶</span>{doc.title}</a>;
  }
  const w = (workspaces ?? []).find((x) => x.id === rel.source_id);
  return <a className="et-backlink-row" href={`/workspace/?id=${rel.source_id}`}>{w?.icon ?? "↗"} {w?.title ?? rel.source_id}</a>;
}

// Renders any live widget block inside the document editor. Self-contained
// (carries its styles) so it works anywhere a block is rendered.
export function WidgetBlock({ type, workspaceId, config, onChange }: { type: string; workspaceId: string; config: Config; onChange?: (c: Config) => void }) {
  const { data: workspace } = useQuery({ queryKey: ["workspace", workspaceId], queryFn: () => api.get<Workspace>(`/workspaces/${workspaceId}`) });
  const goTasks = () => { window.location.href = `/workspace/?id=${workspaceId}&tab=Tasks`; };
  let inner: React.ReactNode = null;
  if (type === "tasks") inner = <TasksWidget workspaceId={workspaceId} setTab={goTasks} config={config} onChange={onChange} />;
  else if (type === "deadlines") inner = <DeadlinesWidget workspaceId={workspaceId} setTab={goTasks} />;
  else if (type === "child_progress") inner = <ChildProgressWidget workspaceId={workspaceId} type={workspace?.type ?? "area"} config={config} onChange={onChange} />;
  else if (type === "objective_progress") inner = <ObjectiveProgressWidget workspaceId={workspaceId} />;
  else if (type === "progress") inner = workspace ? <ProgressWidget workspaceId={workspaceId} workspace={workspace} /> : null;
  else if (type === "backlinks") inner = <BacklinksWidget workspaceId={workspaceId} />;
  else if (type === "metric") inner = <MetricWidget config={config} onChange={onChange} />;
  else if (type === "links") inner = <LinksWidget config={config} onChange={onChange} />;
  return <>{inner}<OverviewStyles /></>;
}

// Exported so blocks rendered outside the Overview (e.g. a table in a document)
// still get the widget CSS.
export function WidgetStyles() { return <OverviewStyles />; }

function OverviewStyles() {
  return (
    <style>{`
      .et-backlinks { display: flex; flex-direction: column; }
      .et-backlink-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0; border-bottom: 1px solid var(--line); text-decoration: none; color: var(--ink); font-size: 0.9rem; }
      .et-backlink-row:hover { color: var(--color-iris); }
      .et-doc-icon { color: var(--color-iris); }
      .et-ov { display: flex; flex-direction: column; gap: 1.2rem; }
      .et-ov-grid { display: flex; flex-flow: row wrap; gap: 1.2rem; align-items: flex-start; }
      .et-widget-wrap { flex: 1 1 100%; min-width: 0; }
      .et-widget-wrap[data-width="half"] { flex-basis: calc(50% - 0.6rem); }
      @media (max-width: 720px) { .et-widget-wrap[data-width="half"] { flex-basis: 100%; } }
      .et-widget-endzone { flex-basis: 100%; }
      .et-widget-width { background: none; border: none; color: var(--ink-faint); cursor: pointer; font-size: 0.9rem; line-height: 1; padding: 0 0.2rem; }
      .et-widget-width:hover { color: var(--ink); }
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
      .et-th-drag { cursor: grab; color: var(--ink-faint); font-size: 0.72rem; opacity: 0; }
      .et-table th:hover .et-th-drag { opacity: 1; }
      .et-th-add, .et-td-del { width: 1.5rem; text-align: center; }
      .et-th-add button { background: none; border: none; color: var(--ink-faint); font-size: 1rem; cursor: pointer; }
      .et-table-addrow { margin-top: 0.5rem; background: none; border: none; color: var(--ink-soft); font: inherit; font-size: 0.85rem; cursor: pointer; }
      .et-table-addrow:hover { color: var(--color-iris); }
      .et-col-menu { position: relative; }
      .et-col-menu summary { list-style: none; cursor: pointer; color: var(--ink-faint); font-size: 0.7rem; width: 1.1rem; height: 1.1rem; display: inline-grid; place-items: center; border-radius: 4px; }
      .et-col-menu summary::-webkit-details-marker { display: none; }
      .et-col-menu summary:hover { background: var(--paper); color: var(--ink); }
      .et-col-list { position: absolute; z-index: 20; top: 1.4rem; right: 0; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 9px; padding: 0.3rem; display: flex; flex-direction: column; min-width: 8rem; box-shadow: 0 8px 24px rgba(0,0,0,0.14); }
      .et-col-list button { text-align: left; background: none; border: none; font: inherit; font-size: 0.85rem; color: var(--ink-soft); padding: 0.3rem 0.5rem; border-radius: 6px; cursor: pointer; }
      .et-col-list button:hover { background: var(--color-iris-soft); color: var(--ink); }
      .et-col-list button[data-on] { color: var(--color-iris); }
      .et-col-del { border-top: 1px solid var(--line) !important; margin-top: 0.2rem; color: #c0392b !important; }
      .et-pill { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.78rem; font-weight: 500; }
      .et-pill-empty { color: var(--ink-faint); }
      .et-table td[data-type="checkbox"], .et-table td[data-type="number"] { text-align: center; }
      .et-cell-check { width: 15px; height: 15px; cursor: pointer; accent-color: var(--color-sage); }
      .et-cell-date { background: none; border: none; font: inherit; font-size: 0.85rem; color: var(--ink); color-scheme: light dark; }
      .et-cell-date:focus { outline: none; }
      .et-cell-num { text-align: right; }

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
      .et-tw-row[data-done] { color: var(--ink-faint); text-decoration: line-through; }
      .et-w-opts { display: flex; gap: 0.4rem; margin-bottom: 0.6rem; }
      .et-w-opts select { background: var(--paper); border: 1px solid var(--line-strong); border-radius: 7px; font: inherit; font-size: 0.78rem; color: var(--ink-soft); padding: 0.2rem 0.4rem; cursor: pointer; }
      .et-textwidget { white-space: pre-wrap; color: var(--ink-soft); font-size: 0.92rem; min-height: 1.5rem; }
      .et-link { background: none; border: none; color: var(--color-iris); font: inherit; cursor: pointer; padding: 0; }
      .et-progress-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.5rem; }
      .et-progress-frac { font-size: 0.85rem; color: var(--ink-soft); }
      .et-progress-bar { height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
      .et-progress-bar span { display: block; height: 100%; background: var(--color-sage); border-radius: 4px; transition: width 0.4s; }
      .et-complete-note { display: flex; align-items: center; gap: 0.5rem; }
      .et-complete-check { color: var(--color-sage); font-size: 1.4rem; }
      .et-empty { color: var(--ink-faint); font-style: italic; font-size: 0.9rem; padding: 0.4rem 0; }

      .et-deadlines { display: flex; flex-direction: column; }
      .et-dl-row { display: grid; grid-template-columns: 3.6rem 1fr; align-items: baseline; gap: 0.6rem; padding: 0.38rem 0; border-bottom: 1px solid var(--line); font-size: 0.9rem; }
      .et-dl-date { font-family: var(--font-mono); font-size: 0.78rem; color: var(--ink-soft); }
      .et-dl-row[data-overdue] .et-dl-date { color: #c0392b; }
      .et-links { display: flex; flex-direction: column; gap: 0.1rem; }
      .et-link-row { display: flex; align-items: center; justify-content: space-between; padding: 0.3rem 0; border-bottom: 1px solid var(--line); }
      .et-link-row a { color: var(--color-iris); text-decoration: none; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .et-link-row a:hover { text-decoration: underline; }
      .et-link-add { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
      .et-link-add input { flex: 1; min-width: 0; background: var(--paper); border: 1px solid var(--line-strong); border-radius: 7px; padding: 0.35rem 0.55rem; font: inherit; font-size: 0.85rem; color: var(--ink); }
      .et-link-add input:focus { outline: none; border-color: var(--color-iris); }
      .et-link-add button { background: var(--color-iris); color: #fff; border: none; border-radius: 7px; padding: 0 0.8rem; font: inherit; font-size: 0.85rem; cursor: pointer; }
      .et-link-add button:disabled { opacity: 0.4; }
      .et-metric { display: flex; flex-direction: column; gap: 0.1rem; }
      .et-metric-value { font-size: 2.6rem; line-height: 1; color: var(--color-iris); }
      .et-metric-caption { font-size: 0.85rem; color: var(--ink-soft); }
      .et-image-img { max-width: 100%; border-radius: 8px; display: block; }
      .et-image-url { width: 100%; margin-top: 0.5rem; background: var(--paper); border: 1px solid var(--line-strong); border-radius: 7px; padding: 0.35rem 0.55rem; font: inherit; font-size: 0.82rem; color: var(--ink); }
      .et-image-cap { font-size: 0.82rem; color: var(--ink-soft); margin-top: 0.3rem; display: inline-block; }
    `}</style>
  );
}
