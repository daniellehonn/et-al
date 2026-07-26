"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, blockText, type Block, type BlockOp, type DocumentPatch, type Workspace, type Document } from "@/lib/api";
import { EditableText, DeleteButton } from "./Editable";
import { WidgetBlock, TableWidget, WidgetStyles } from "./Overview";
import { useDragReorder } from "@/lib/dnd";

const WIDGET_TYPES = new Set(["tasks", "deadlines", "child_progress", "objective_progress", "progress", "backlinks", "metric", "links", "career_summary"]);
function parseContent(json: string): Record<string, unknown> { try { return JSON.parse(json); } catch { return {}; } }

// A Notion-style editor over the block model. Each block is an auto-growing
// textarea (robust cursor handling; blocks store plain text). Humans write
// blocks directly via /blocks; agents propose patches, surfaced here as
// Accept/Reject. Text edits debounce-save; structural ops refetch to learn the
// server-assigned ids.
const TYPE_MENU: Array<{ type: string; label: string; kw?: string }> = [
  { type: "paragraph", label: "Text" },
  { type: "heading", label: "Heading", kw: "h1 title" },
  { type: "bullet", label: "Bulleted list", kw: "ul" },
  { type: "numbered", label: "Numbered list", kw: "ol" },
  { type: "todo", label: "To-do", kw: "checkbox task" },
  { type: "quote", label: "Quote" },
  { type: "code", label: "Code" },
  { type: "callout", label: "Callout", kw: "note info box" },
  { type: "toggle", label: "Toggle", kw: "collapse expand accordion" },
  { type: "columns", label: "Columns", kw: "layout side" },
  { type: "divider", label: "Divider", kw: "hr line" },
  { type: "table", label: "Table" },
  { type: "image", label: "Image", kw: "picture photo" },
  { type: "embed", label: "Embed", kw: "iframe url video" },
  { type: "toc", label: "Table of contents", kw: "outline headings" },
  // Live widgets
  { type: "tasks", label: "Tasks (live)", kw: "widget todo" },
  { type: "deadlines", label: "Deadlines (live)", kw: "widget due" },
  { type: "progress", label: "Progress bar (live)", kw: "widget completion" },
  { type: "objective_progress", label: "Objective progress (live)", kw: "widget" },
  { type: "child_progress", label: "Sub-workspace progress (live)", kw: "widget children" },
  { type: "metric", label: "Metric (live)", kw: "widget number" },
  { type: "links", label: "Links (live)", kw: "widget bookmarks" },
  { type: "backlinks", label: "Backlinks (live)", kw: "widget references" },
  { type: "career_summary", label: "Career summary (live)", kw: "widget resume" },
  // Career blocks
  { type: "accomplishment", label: "Accomplishment (STAR)", kw: "career star result" },
  { type: "resume_bullet", label: "Resume bullet", kw: "career cv" },
  { type: "role", label: "Role / experience", kw: "career job cv" },
  { type: "project", label: "Project highlight", kw: "career portfolio" },
];
const CAREER_TYPES = new Set(["accomplishment", "resume_bullet", "role", "project"]);

// The ⋮⋮ "turn into" menu only offers text-like conversions — not media, tables,
// or live widgets (those are inserted fresh via the "/" menu).
const TURN_INTO = new Set(["paragraph", "heading", "bullet", "numbered", "todo", "quote", "code", "callout", "divider", "toggle", "columns"]);

// The default content a block gets when its type changes.
function defaultContentFor(type: string, keepText: string): Record<string, unknown> {
  if (type === "table") return { columns: [{ id: "c1", name: "Name", type: "text" }, { id: "c2", name: "Status", type: "status" }], rows: [] };
  if (type === "embed") return { url: "" };
  if (type === "image") return { url: "", caption: "" };
  if (type === "toggle") return { text: keepText, body: "" };
  if (type === "columns") return { cols: [keepText, ""] };
  if (type === "metric") return { title: "Metric", value: "0", caption: "" };
  if (type === "links") return { title: "Links", items: [] };
  if (type === "accomplishment") return { situation: "", task: "", action: "", result: "", bullet: "" };
  if (type === "resume_bullet") return { text: keepText, skills: "", date: "" };
  if (type === "role") return { company: "", title: "", start: "", end: "", location: "", bullets: [] };
  if (type === "project") return { name: "", role: "", tech: "", outcome: "", link: "" };
  if (WIDGET_TYPES.has(type)) return { title: keepText || undefined };
  if (type === "divider" || type === "toc") return { text: "" };
  return { text: keepText };
}

// Render inline markdown: **bold**, *italic*/_italic_, `code`, [text](url).
// Bold is matched before italic so ** wins over *.
function renderInline(src: string): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  // …markdown link, then a bare URL (so pasted links become clickable).
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)]+[^\s).,;])/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) nodes.push(src.slice(last, m.index));
    if (m[1]) nodes.push(<strong key={k++}>{m[2]}</strong>);
    else if (m[3]) nodes.push(<em key={k++}>{m[4]}</em>);
    else if (m[5]) nodes.push(<code key={k++} className="et-inline-code">{m[5]}</code>);
    else if (m[6]) nodes.push(<a key={k++} href={m[7]} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{m[6]}</a>);
    else if (m[8]) nodes.push(<a key={k++} href={m[8]} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{m[8]}</a>);
    last = re.lastIndex;
  }
  if (last < src.length) nodes.push(src.slice(last));
  return nodes;
}

function embedUrl(contentJson: string): string { try { return String(JSON.parse(contentJson).url ?? ""); } catch { return ""; } }

// ── Career blocks — structured career capital, recyclable into a resume ──────
function AccomplishmentBlock({ contentJson, onSave }: { contentJson: string; onSave: (c: Record<string, unknown>) => void }) {
  const c = parseContent(contentJson) as Record<string, string>;
  const field = (k: string, label: string) => (
    <div className="et-star-field">
      <span className="et-star-label">{label}</span>
      <EditableText multiline value={c[k] ?? ""} placeholder={`${label}…`} onSave={(v) => onSave({ ...c, [k]: v })}
        render={c[k] ? <span className="et-inline-wrap">{renderInline(c[k])}</span> : undefined} />
    </div>
  );
  return (
    <div className="et-career et-star">
      <div className="et-career-badge">⭐ Accomplishment</div>
      {field("situation", "Situation")}
      {field("task", "Task")}
      {field("action", "Action")}
      {field("result", "Result")}
      <div className="et-star-bullet">{field("bullet", "Resume bullet")}</div>
    </div>
  );
}

function ResumeBulletBlock({ contentJson, onSave }: { contentJson: string; onSave: (c: Record<string, unknown>) => void }) {
  const c = parseContent(contentJson) as Record<string, string>;
  return (
    <div className="et-career et-rbullet">
      <span className="et-rbullet-dot">•</span>
      <div className="et-rbullet-body">
        <EditableText multiline value={c.text ?? ""} placeholder="Resume bullet — a strong, quantified line…" onSave={(v) => onSave({ ...c, text: v })}
          render={c.text ? <span className="et-inline-wrap">{renderInline(c.text)}</span> : undefined} />
        <div className="et-rbullet-meta">
          <EditableText value={c.skills ?? ""} placeholder="skills" onSave={(v) => onSave({ ...c, skills: v })} />
          <EditableText value={c.date ?? ""} placeholder="date / range" onSave={(v) => onSave({ ...c, date: v })} />
        </div>
      </div>
    </div>
  );
}

function ProjectBlock({ contentJson, onSave }: { contentJson: string; onSave: (c: Record<string, unknown>) => void }) {
  const c = parseContent(contentJson) as Record<string, string>;
  const field = (k: string, label: string) => (
    <div className="et-star-field">
      <span className="et-star-label">{label}</span>
      <EditableText multiline value={c[k] ?? ""} placeholder={`${label}…`} onSave={(v) => onSave({ ...c, [k]: v })}
        render={c[k] ? <span className="et-inline-wrap">{k === "link" ? renderInline(c[k]) : renderInline(c[k])}</span> : undefined} />
    </div>
  );
  return (
    <div className="et-career et-project-block">
      <div className="et-career-badge">🚀 Project</div>
      <div className="et-role-head">
        <EditableText className="et-role-title" value={c.name ?? ""} placeholder="Project name" onSave={(v) => onSave({ ...c, name: v })} />
        {c.role && <span className="et-role-at">·</span>}
        <EditableText className="et-role-company" value={c.role ?? ""} placeholder="your role" onSave={(v) => onSave({ ...c, role: v })} />
      </div>
      <div className="et-star-field">
        <span className="et-star-label">Tech</span>
        <EditableText multiline value={c.tech ?? ""} placeholder="Tech… (comma separated)" onSave={(v) => onSave({ ...c, tech: v })}
          render={c.tech ? (
            <span className="et-pills">
              {c.tech.split(",").map((t) => t.trim()).filter(Boolean).map((t, i) => (
                <span key={i} className="et-pill">{t}</span>
              ))}
            </span>
          ) : undefined} />
      </div>
      {field("outcome", "Outcome")}
      <div className="et-star-field">
        <span className="et-star-label">Link</span>
        <EditableText value={c.link ?? ""} placeholder="https://…" onSave={(v) => onSave({ ...c, link: v })}
          render={c.link ? (
            <a className="et-project-link" href={/^https?:\/\//.test(c.link) ? c.link : `https://${c.link}`}
              target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{c.link}</a>
          ) : undefined} />
      </div>
    </div>
  );
}

function RoleBlock({ contentJson, onSave }: { contentJson: string; onSave: (c: Record<string, unknown>) => void }) {
  const c = parseContent(contentJson) as { company?: string; title?: string; start?: string; end?: string; location?: string; bullets?: string[] };
  const bullets = c.bullets ?? [];
  return (
    <div className="et-career et-role-block">
      <div className="et-career-badge">💼 Role</div>
      <div className="et-role-head">
        <EditableText className="et-role-title" value={c.title ?? ""} placeholder="Title" onSave={(v) => onSave({ ...c, title: v })} />
        <span className="et-role-at">at</span>
        <EditableText className="et-role-company" value={c.company ?? ""} placeholder="Company" onSave={(v) => onSave({ ...c, company: v })} />
      </div>
      <div className="et-role-meta">
        <EditableText value={c.start ?? ""} placeholder="Start" onSave={(v) => onSave({ ...c, start: v })} /> – <EditableText value={c.end ?? ""} placeholder="End" onSave={(v) => onSave({ ...c, end: v })} /> · <EditableText value={c.location ?? ""} placeholder="Location" onSave={(v) => onSave({ ...c, location: v })} />
      </div>
      <ul className="et-role-bullets">
        {bullets.map((b, i) => (
          <li key={i}>
            <EditableText value={b} placeholder="Bullet…" onSave={(v) => onSave({ ...c, bullets: bullets.map((x, ix) => (ix === i ? v : x)) })}
              render={b ? <span className="et-inline-wrap">{renderInline(b)}</span> : undefined} />
          </li>
        ))}
      </ul>
      <button className="et-role-addb" onClick={() => onSave({ ...c, bullets: [...bullets, ""] })}>+ bullet</button>
    </div>
  );
}

// A collapsible toggle: an editable summary + a collapsible markdown body.
function ToggleBlock({ contentJson, onSave }: { contentJson: string; onSave: (content: Record<string, unknown>) => void }) {
  let c: { text?: string; body?: string }; try { c = JSON.parse(contentJson); } catch { c = {}; }
  const [open, setOpen] = useState(false);
  const body = c.body ?? "";
  return (
    <div className="et-toggle">
      <div className="et-toggle-head">
        <button className="et-toggle-caret" onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse" : "Expand"}>{open ? "▾" : "▸"}</button>
        <EditableText className="et-toggle-summary" value={c.text ?? ""} placeholder="Toggle" onSave={(t) => onSave({ ...c, text: t })} />
      </div>
      {open && (
        <div className="et-toggle-body">
          <EditableText multiline value={body} placeholder="Empty. Click to add content." onSave={(t) => onSave({ ...c, body: t })}
            render={body ? <span className="et-inline-wrap">{renderInline(body)}</span> : undefined} />
        </div>
      )}
    </div>
  );
}

// Side-by-side markdown columns.
function ColumnsBlock({ contentJson, onSave }: { contentJson: string; onSave: (content: Record<string, unknown>) => void }) {
  let c: { cols?: string[] }; try { c = JSON.parse(contentJson); } catch { c = {}; }
  const cols = c.cols ?? ["", ""];
  const setCol = (i: number, v: string) => onSave({ ...c, cols: cols.map((x, ix) => (ix === i ? v : x)) });
  return (
    <div className="et-columns-wrap">
      <div className="et-columns" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
        {cols.map((col, i) => (
          <div key={i} className="et-column">
            <EditableText multiline value={col} placeholder="Empty column" onSave={(v) => setCol(i, v)}
              render={col ? <span className="et-inline-wrap">{renderInline(col)}</span> : undefined} />
          </div>
        ))}
      </div>
      <div className="et-columns-ctl">
        {cols.length < 4 && <button onClick={() => onSave({ ...c, cols: [...cols, ""] })}>+ column</button>}
        {cols.length > 1 && <button onClick={() => onSave({ ...c, cols: cols.slice(0, -1) })}>− column</button>}
      </div>
    </div>
  );
}

// Table of contents: links to the document's heading blocks.
function TocBlock({ blocks }: { blocks: Block[] }) {
  const heads = blocks.filter((b) => b.type === "heading" && blockText(b).trim());
  if (heads.length === 0) return <div className="et-toc-empty">Add headings to build a table of contents.</div>;
  return (
    <nav className="et-toc">
      {heads.map((h) => (
        <button key={h.id} className="et-toc-item" onClick={() => document.getElementById(`hb-${h.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{blockText(h)}</button>
      ))}
    </nav>
  );
}

export function BlockEditor({ documentId }: { documentId: string }) {
  const qc = useQueryClient();
  const { data: blocks } = useQuery({
    queryKey: ["blocks", documentId],
    queryFn: () => api.get<Block[]>(`/documents/${documentId}/blocks`),
  });
  const { data: patches } = useQuery({
    queryKey: ["patches", documentId],
    queryFn: () => api.get<DocumentPatch[]>(`/documents/${documentId}/patches?status=pending`),
    refetchInterval: 8000, // agents may propose while you work
  });
  // The document's workspace — widget blocks compute against it.
  const { data: doc } = useQuery({ queryKey: ["document", documentId], queryFn: () => api.get<Document>(`/documents/${documentId}`) });
  const workspaceId = doc?.workspace_id;

  // Local text mirror so typing is instant; server save is debounced.
  const [text, setText] = useState<Record<string, string>>({});
  // Which block is in raw-edit mode. Others render formatted markdown.
  const [editingId, setEditingId] = useState<string | null>(null);
  const focusAfter = useRef<{ afterId: string | null } | null>(null);
  const debounce = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    if (!blocks) return;
    setText((prev) => {
      const next = { ...prev };
      for (const b of blocks) if (next[b.id] === undefined) next[b.id] = blockText(b);
      return next;
    });
    // After a structural op, put the newly-focused block into edit mode.
    if (focusAfter.current && blocks.length) {
      const { afterId } = focusAfter.current;
      const idx = afterId ? blocks.findIndex((b) => b.id === afterId) : -1;
      const target = blocks[idx + 1] ?? blocks[blocks.length - 1];
      focusAfter.current = null;
      setEditingId(target.id);
    }
  }, [blocks]);

  // Focus the textarea whenever a block enters edit mode.
  useEffect(() => {
    if (editingId) requestAnimationFrame(() => {
      const el = document.getElementById(`blk-${editingId}`) as HTMLTextAreaElement | null;
      if (el) { el.focus(); el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
    });
  }, [editingId]);

  // A failed write is never silent: surface it and re-check auth so the Unlock
  // banner reappears if the session lapsed (the usual cause of "nothing happens").
  const onWriteError = useCallback((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    qc.invalidateQueries({ queryKey: ["session"] });
    alert(/unauthor/i.test(msg) ? "You're in read-only mode — click Unlock at the top and enter your API key, then try again." : `Couldn't save: ${msg}`);
  }, [qc]);

  const applyOps = useCallback(async (ops: BlockOp[]) => {
    try { await api.post(`/documents/${documentId}/blocks`, { ops }); }
    catch (e) { onWriteError(e); }
    finally { qc.invalidateQueries({ queryKey: ["blocks", documentId] }); }
  }, [documentId, qc, onWriteError]);

  // Drag a block by its ⣿ handle to drop it before another block.
  const dnd = useDragReorder();
  const moveBefore = useCallback((dragId: string, targetId: string) => {
    if (!blocks) return;
    const ids = blocks.map((b) => b.id);
    const to = ids.indexOf(targetId);
    if (to < 0) return;
    const after = to === 0 ? null : ids[to - 1] === dragId ? (to >= 2 ? ids[to - 2] : null) : ids[to - 1];
    applyOps([{ op: "move", id: dragId, after }]);
  }, [blocks, applyOps]);

  // Delete a block reliably: remove it from the cache immediately (optimistic),
  // then persist. The block vanishes on click regardless of any re-render.
  const deleteBlock = useCallback((id: string) => {
    qc.setQueryData<Block[]>(["blocks", documentId], (old) => (old ?? []).filter((b) => b.id !== id));
    api.post(`/documents/${documentId}/blocks`, { ops: [{ op: "delete", id }] })
      .catch(onWriteError)
      .finally(() => qc.invalidateQueries({ queryKey: ["blocks", documentId] }));
  }, [documentId, qc, onWriteError]);

  const saveText = useCallback((b: Block, value: string) => {
    clearTimeout(debounce.current[b.id]);
    debounce.current[b.id] = setTimeout(() => {
      // Per-keystroke: don't alert, but refresh auth so the read-only banner shows.
      api.post(`/documents/${documentId}/blocks`, {
        ops: [{ op: "update", id: b.id, type: b.type, content: { text: value } }],
      }).catch(() => qc.invalidateQueries({ queryKey: ["session"] }));
    }, 500);
  }, [documentId, qc]);

  // Persist a block immediately (on blur), cancelling any pending debounce.
  const flush = useCallback((b: Block) => {
    clearTimeout(debounce.current[b.id]);
    api.post(`/documents/${documentId}/blocks`, {
      ops: [{ op: "update", id: b.id, type: b.type, content: { text: text[b.id] ?? "" } }],
    }).catch(onWriteError);
  }, [documentId, text, onWriteError]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, b: Block) => {
    const value = text[b.id] ?? "";
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      focusAfter.current = { afterId: b.id };
      // Flush the current block, then insert a fresh paragraph after it.
      applyOps([
        { op: "update", id: b.id, type: b.type, content: { text: value } },
        { op: "insert", after: b.id, type: "paragraph", content: { text: "" } },
      ]);
    } else if (e.key === "Backspace" && value === "" && (blocks?.length ?? 0) > 1) {
      e.preventDefault();
      const idx = blocks!.findIndex((x) => x.id === b.id);
      focusAfter.current = { afterId: blocks![idx - 2]?.id ?? null };
      applyOps([{ op: "delete", id: b.id }]);
    }
  };

  const changeType = (b: Block, type: string) => {
    applyOps([{ op: "update", id: b.id, type, content: defaultContentFor(type, text[b.id] ?? "") }]);
    if (["divider", "table", "embed", "toc", "toggle", "columns"].includes(type) || WIDGET_TYPES.has(type) || CAREER_TYPES.has(type)) setEditingId(null);
  };

  // Slash menu: typing "/" at the start of an empty-ish block opens a type picker.
  const [slash, setSlash] = useState<{ id: string; query: string } | null>(null);
  const slashOptions = (q: string) => TYPE_MENU.filter((t) => `${t.label} ${t.type} ${t.kw ?? ""}`.toLowerCase().includes(q.toLowerCase()));

  // @-mention: typing "@" links another workspace and records a backlink edge.
  const { data: allWorkspaces } = useQuery({ queryKey: ["workspaces"], queryFn: () => api.get<Workspace[]>("/workspaces") });
  const [mention, setMention] = useState<{ id: string; query: string } | null>(null);
  const mentionOptions = (q: string) => (allWorkspaces ?? []).filter((w) => w.title.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  const pickMention = (b: Block, w: Workspace) => {
    const cur = text[b.id] ?? "";
    const next = cur.replace(/@[^\s@]*$/, `[${w.title}](/workspace/?id=${w.id}) `);
    setText((s) => ({ ...s, [b.id]: next }));
    void api.post(`/documents/${documentId}/blocks`, { ops: [{ op: "update", id: b.id, type: b.type, content: { text: next } }] });
    void api.post("/relate", { source_type: "document", source_id: documentId, target_type: "workspace", target_id: w.id, type: "references" });
    setMention(null);
  };
  const pickType = (b: Block, type: string) => {
    setSlash(null);
    setText((s) => ({ ...s, [b.id]: "" }));
    applyOps([{ op: "update", id: b.id, type, content: defaultContentFor(type, "") }]);
    if (["divider", "table", "embed"].includes(type)) setEditingId(null);
  };

  const resolvePatch = async (p: DocumentPatch, accept: boolean) => {
    await api.post(`/patches/${p.id}/resolve`, { accept });
    qc.invalidateQueries({ queryKey: ["patches", documentId] });
    qc.invalidateQueries({ queryKey: ["blocks", documentId] });
  };

  const addFirst = () => { focusAfter.current = { afterId: null }; applyOps([{ op: "insert", after: null, type: "paragraph", content: { text: "" } }]); };

  return (
    <div className="et-editor">
      {(patches?.length ?? 0) > 0 && (
        <div className="et-patches">
          {patches!.map((p) => (
            <div key={p.id} className="et-patch">
              <span className="et-patch-mark serif">&amp;</span>
              <div className="et-patch-body">
                <div className="eyebrow">{p.actor} proposes</div>
                <div className="et-patch-summary">{p.summary}</div>
              </div>
              <div className="et-patch-actions">
                <button onClick={() => resolvePatch(p, true)} className="et-btn-accept">Accept</button>
                <button onClick={() => resolvePatch(p, false)} className="et-btn-reject">Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {blocks?.length === 0 && (
        <button className="et-add-first" onClick={addFirst}>Start writing…</button>
      )}

      {blocks?.map((b) => (
        <div key={b.id} className="et-block" data-type={b.type} data-ai={!!b.is_ai}
          data-dragging={dnd.dragId === b.id || undefined}
          {...dnd.dropProps(b.id, (dragId) => moveBefore(dragId, b.id))}>
          <div className="et-block-gutter">
            <details className="et-type-menu">
              <summary aria-label="Reorder, or open block menu" title="Drag to move · click for options"
                {...dnd.dragProps(b.id)}>⋮⋮</summary>
              <div className="et-type-list">
                <div className="et-type-heading">Turn into</div>
                {TYPE_MENU.filter((t) => TURN_INTO.has(t.type)).map((t) => <button key={t.type} onClick={(e) => { changeType(b, t.type); (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>{t.label}</button>)}
                <button className="et-type-del" onClick={(e) => { (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; if (editingId === b.id) setEditingId(null); deleteBlock(b.id); }}>Delete</button>
              </div>
            </details>
          </div>
          {b.type === "divider" ? (
            <hr className="et-hr" />
          ) : b.type === "table" ? (
            <><TableWidget config={parseContent(b.content_json)} onChange={(content) => applyOps([{ op: "update", id: b.id, type: "table", content }])} /><WidgetStyles /></>
          ) : b.type === "embed" ? (
            editingId === b.id ? (
              <input className="et-embed-url" defaultValue={embedUrl(b.content_json)} autoFocus placeholder="Paste a URL to embed…"
                onBlur={(e) => { applyOps([{ op: "update", id: b.id, type: "embed", content: { url: e.target.value.trim() } }]); setEditingId(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }} />
            ) : embedUrl(b.content_json) ? (
              <div className="et-embed">
                <iframe src={embedUrl(b.content_json)} className="et-embed-iframe" title="embed" loading="lazy" allow="fullscreen" />
                <button className="et-embed-edit-btn" onClick={() => setEditingId(b.id)}>edit URL</button>
              </div>
            ) : (
              <div className="et-block-render" data-empty onClick={() => setEditingId(b.id)}>Empty embed — click to add a URL</div>
            )
          ) : b.type === "image" ? (
            editingId === b.id ? (
              <input className="et-embed-url" defaultValue={embedUrl(b.content_json)} autoFocus placeholder="Paste an image URL…"
                onBlur={(e) => { applyOps([{ op: "update", id: b.id, type: "image", content: { url: e.target.value.trim() } }]); setEditingId(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }} />
            ) : embedUrl(b.content_json) ? (
              <div className="et-img-block"><img src={embedUrl(b.content_json)} alt="" className="et-img-el" /><button className="et-embed-edit-btn" onClick={() => setEditingId(b.id)}>edit URL</button></div>
            ) : (
              <div className="et-block-render" data-empty onClick={() => setEditingId(b.id)}>Empty image — click to add a URL</div>
            )
          ) : b.type === "toc" ? (
            <TocBlock blocks={blocks ?? []} />
          ) : b.type === "toggle" ? (
            <ToggleBlock contentJson={b.content_json} onSave={(content) => applyOps([{ op: "update", id: b.id, type: "toggle", content }])} />
          ) : b.type === "columns" ? (
            <ColumnsBlock contentJson={b.content_json} onSave={(content) => applyOps([{ op: "update", id: b.id, type: "columns", content }])} />
          ) : b.type === "accomplishment" ? (
            <AccomplishmentBlock contentJson={b.content_json} onSave={(content) => applyOps([{ op: "update", id: b.id, type: "accomplishment", content }])} />
          ) : b.type === "resume_bullet" ? (
            <ResumeBulletBlock contentJson={b.content_json} onSave={(content) => applyOps([{ op: "update", id: b.id, type: "resume_bullet", content }])} />
          ) : b.type === "role" ? (
            <RoleBlock contentJson={b.content_json} onSave={(content) => applyOps([{ op: "update", id: b.id, type: "role", content }])} />
          ) : b.type === "project" ? (
            <ProjectBlock contentJson={b.content_json} onSave={(content) => applyOps([{ op: "update", id: b.id, type: "project", content }])} />
          ) : WIDGET_TYPES.has(b.type) ? (
            workspaceId
              ? <WidgetBlock type={b.type} workspaceId={workspaceId} config={parseContent(b.content_json)} onChange={(content) => applyOps([{ op: "update", id: b.id, type: b.type, content }])} />
              : <div className="et-block-render" data-empty>Loading widget…</div>
          ) : editingId === b.id ? (
            <>
              <textarea
                id={`blk-${b.id}`}
                className="et-block-input"
                rows={1}
                value={text[b.id] ?? ""}
                placeholder={b.type === "heading" ? "Heading" : "Type '/' for blocks, or ⋮⋮. **bold**, *italic*, `code`"}
                onChange={(e) => {
                  const v = e.target.value;
                  setText((s) => ({ ...s, [b.id]: v }));
                  saveText(b, v);
                  if (v.startsWith("/")) setSlash({ id: b.id, query: v.slice(1) });
                  else if (slash?.id === b.id) setSlash(null);
                  const mm = v.match(/@([^\s@]*)$/);
                  if (mm) setMention({ id: b.id, query: mm[1] });
                  else if (mention?.id === b.id) setMention(null);
                  e.target.style.height = "auto";
                  e.target.style.height = `${e.target.scrollHeight}px`;
                }}
                onKeyDown={(e) => {
                  if (slash?.id === b.id) {
                    if (e.key === "Escape") { e.preventDefault(); setSlash(null); return; }
                    if (e.key === "Enter") { e.preventDefault(); const opts = slashOptions(slash.query); if (opts[0]) pickType(b, opts[0].type); return; }
                  }
                  if (mention?.id === b.id) {
                    if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
                    if (e.key === "Enter") { e.preventDefault(); const opts = mentionOptions(mention.query); if (opts[0]) pickMention(b, opts[0]); return; }
                  }
                  onKeyDown(e, b);
                }}
                onBlur={() => { flush(b); setEditingId(null); setSlash(null); setMention(null); }}
              />
              {slash?.id === b.id && slashOptions(slash.query).length > 0 && (
                <div className="et-slash-menu">
                  {slashOptions(slash.query).map((t) => (
                    <button key={t.type} onMouseDown={(e) => { e.preventDefault(); pickType(b, t.type); }}>{t.label}</button>
                  ))}
                </div>
              )}
              {mention?.id === b.id && mentionOptions(mention.query).length > 0 && (
                <div className="et-slash-menu">
                  {mentionOptions(mention.query).map((w) => (
                    <button key={w.id} onMouseDown={(e) => { e.preventDefault(); pickMention(b, w); }}>{w.icon ? `${w.icon} ` : "↗ "}{w.title}</button>
                  ))}
                </div>
              )}
            </>
          ) : b.type === "code" ? (
            <pre className="et-block-render et-render-code" onClick={() => setEditingId(b.id)}>{text[b.id] || ""}</pre>
          ) : (
            <div className="et-block-render" id={b.type === "heading" ? `hb-${b.id}` : undefined}
              data-empty={!text[b.id] || undefined} onClick={() => setEditingId(b.id)}>
              {text[b.id] ? renderInline(text[b.id]) : " "}
            </div>
          )}
        </div>
      ))}

      <EditorStyles />
    </div>
  );
}

// A markdown table rendered as a real, editable table inside a document.
function DocTableBlock({ contentJson, onSave }: { contentJson: string; onSave: (content: { columns: string[]; rows: string[][] }) => void }) {
  let data: { columns: string[]; rows: string[][] };
  try { const p = JSON.parse(contentJson); data = { columns: p.columns ?? [], rows: p.rows ?? [] }; }
  catch { data = { columns: [], rows: [] }; }
  const { columns, rows } = data;

  const setCell = (r: number, c: number, v: string) => onSave({ columns, rows: rows.map((row, ri) => ri === r ? row.map((cell, ci) => ci === c ? v : cell) : row) });
  const setHeader = (c: number, v: string) => onSave({ columns: columns.map((h, ci) => ci === c ? v : h), rows });
  const addRow = () => onSave({ columns, rows: [...rows, columns.map(() => "")] });
  const addCol = () => onSave({ columns: [...columns, "Column"], rows: rows.map((row) => [...row, ""]) });
  const delRow = (r: number) => onSave({ columns, rows: rows.filter((_, ri) => ri !== r) });
  const delCol = (c: number) => onSave({ columns: columns.filter((_, ci) => ci !== c), rows: rows.map((row) => row.filter((_, ci) => ci !== c)) });

  return (
    <div className="et-doctable-wrap">
      <table className="et-doctable">
        <thead>
          <tr>
            {columns.map((h, c) => (
              <th key={c}>
                <span className="et-doctable-th">
                  <EditableText value={h} onSave={(v) => setHeader(c, v)} />
                  <DeleteButton onDelete={() => delCol(c)} />
                </span>
              </th>
            ))}
            <th className="et-doctable-plus"><button onClick={addCol} title="Add column">+</button></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {columns.map((_, c) => (
                <td key={c}><EditableText value={row[c] ?? ""} placeholder="—" onSave={(v) => setCell(r, c, v)} /></td>
              ))}
              <td className="et-doctable-del"><DeleteButton onDelete={() => delRow(r)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="et-doctable-addrow" onClick={addRow}>+ Add row</button>
    </div>
  );
}

function EditorStyles() {
  return (
    <style>{`
      .et-doctable-wrap { overflow-x: auto; padding: 0.2rem 0; }
      .et-doctable { border-collapse: collapse; font-size: 0.9rem; min-width: 100%; }
      .et-doctable th, .et-doctable td { border: 1px solid var(--line-strong); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
      .et-doctable th { background: var(--paper-raised); font-weight: 500; font-size: 0.84rem; }
      .et-doctable-th { display: flex; align-items: center; gap: 0.3rem; justify-content: space-between; }
      .et-doctable-plus, .et-doctable-del { width: 1.6rem; text-align: center; }
      .et-doctable-plus button { background: none; border: none; color: var(--ink-faint); font-size: 1rem; cursor: pointer; }
      .et-doctable-addrow { margin-top: 0.4rem; background: none; border: none; color: var(--ink-soft); font: inherit; font-size: 0.84rem; cursor: pointer; }
      .et-doctable-addrow:hover { color: var(--color-iris); }
      .et-editor { max-width: 44rem; }
      .et-patches { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 1.5rem; }
      .et-patch {
        display: grid; grid-template-columns: 1.4rem 1fr auto; gap: 0.7rem; align-items: center;
        background: var(--color-iris-soft); border: 1px solid color-mix(in srgb, var(--color-iris) 30%, transparent);
        border-radius: 10px; padding: 0.7rem 0.9rem;
      }
      @media (prefers-color-scheme: dark) { .et-patch { background: color-mix(in srgb, var(--color-iris) 16%, transparent); } }
      .et-patch-mark { color: var(--color-iris); font-size: 1.2rem; text-align: center; }
      .et-patch-summary { font-size: 0.92rem; margin-top: 0.1rem; }
      .et-patch-actions { display: flex; gap: 0.4rem; }
      .et-btn-accept, .et-btn-reject { border: none; border-radius: 7px; padding: 0.35rem 0.75rem; font: inherit; font-size: 0.85rem; cursor: pointer; }
      .et-btn-accept { background: var(--color-iris); color: #fff; }
      .et-btn-reject { background: transparent; color: var(--ink-soft); }
      .et-btn-reject:hover { color: var(--ink); }

      .et-add-first { background: none; border: none; color: var(--ink-faint); font: inherit; font-style: italic; cursor: text; padding: 0.4rem 0; }

      .et-block { display: grid; grid-template-columns: 1.4rem 1fr; align-items: start; position: relative; }
      .et-slash-menu { position: absolute; z-index: 30; left: 1.4rem; margin-top: 0.1rem; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 9px; padding: 0.3rem; display: flex; flex-direction: column; min-width: 10rem; box-shadow: 0 8px 24px rgba(0,0,0,0.16); max-height: 16rem; overflow-y: auto; }
      .et-slash-menu button { text-align: left; background: none; border: none; font: inherit; font-size: 0.88rem; color: var(--ink-soft); padding: 0.34rem 0.5rem; border-radius: 6px; cursor: pointer; }
      .et-slash-menu button:hover, .et-slash-menu button:first-child { background: var(--color-iris-soft); color: var(--ink); }
      .et-embed { position: relative; margin: 0.4rem 0; }
      .et-embed-iframe { width: 100%; height: 24rem; border: 1px solid var(--line); border-radius: 10px; background: var(--paper-raised); }
      .et-embed-edit-btn { position: absolute; top: 0.5rem; right: 0.5rem; background: var(--paper); border: 1px solid var(--line-strong); border-radius: 6px; font: inherit; font-size: 0.75rem; color: var(--ink-soft); padding: 0.15rem 0.5rem; cursor: pointer; opacity: 0; transition: opacity 0.12s; }
      .et-embed:hover .et-embed-edit-btn { opacity: 1; }
      .et-embed-url { width: 100%; background: var(--paper-raised); border: 1px solid var(--color-iris); border-radius: 8px; padding: 0.5rem 0.7rem; font: inherit; font-size: 0.9rem; color: var(--ink); }
      .et-embed-url:focus { outline: none; }
      .et-img-block { position: relative; margin: 0.4rem 0; }
      .et-img-el { max-width: 100%; border-radius: 10px; display: block; }
      .et-block[data-type="callout"] .et-block-render, .et-block[data-type="callout"] .et-block-input {
        background: var(--color-iris-soft); border-radius: 10px; padding: 0.7rem 0.9rem 0.7rem 2.2rem; position: relative; }
      .et-block[data-type="callout"] { position: relative; }
      .et-block[data-type="callout"]::after { content: "💡"; position: absolute; left: 2rem; top: 0.7rem; font-size: 0.95rem; z-index: 1; }
      .et-toc { display: flex; flex-direction: column; border-left: 2px solid var(--line-strong); padding-left: 0.8rem; margin: 0.3rem 0; }
      .et-toc-item { text-align: left; background: none; border: none; font: inherit; font-size: 0.9rem; color: var(--ink-soft); padding: 0.2rem 0; cursor: pointer; }
      .et-toc-item:hover { color: var(--color-iris); }
      .et-toc-empty { color: var(--ink-faint); font-style: italic; font-size: 0.88rem; padding: 0.3rem 0; }
      .et-toggle { margin: 0.15rem 0; }
      .et-toggle-head { display: flex; align-items: baseline; gap: 0.4rem; }
      .et-toggle-caret { background: none; border: none; color: var(--ink-soft); cursor: pointer; font-size: 0.75rem; padding: 0.1rem; line-height: 1.6; }
      .et-toggle-summary { flex: 1; font-weight: 500; }
      .et-toggle-body { margin: 0.2rem 0 0.2rem 1.3rem; padding-left: 0.6rem; border-left: 2px solid var(--line); color: var(--ink-soft); white-space: pre-wrap; }
      .et-columns-wrap { margin: 0.3rem 0; }
      .et-columns { display: grid; gap: 1rem; }
      .et-column { min-width: 0; border: 1px dashed var(--line); border-radius: 8px; padding: 0.5rem 0.6rem; white-space: pre-wrap; }
      .et-columns-ctl { display: flex; gap: 0.6rem; margin-top: 0.3rem; opacity: 0; transition: opacity 0.12s; }
      .et-block:hover .et-columns-ctl { opacity: 1; }
      .et-columns-ctl button { background: none; border: none; color: var(--ink-faint); font: inherit; font-size: 0.78rem; cursor: pointer; }
      .et-columns-ctl button:hover { color: var(--color-iris); }
      .et-inline-wrap { white-space: pre-wrap; }
      .et-career { border: 1px solid var(--line); border-left: 3px solid var(--color-iris); border-radius: 10px; padding: 0.8rem 1rem; margin: 0.4rem 0; background: var(--paper-raised); }
      .et-career-badge { font-family: var(--font-mono); font-size: 0.72rem; letter-spacing: 0.04em; color: var(--color-iris); margin-bottom: 0.5rem; }
      .et-star-field { display: grid; grid-template-columns: 5rem 1fr; gap: 0.6rem; padding: 0.25rem 0; align-items: baseline; }
      .et-star-label { font-family: var(--font-mono); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-faint); }
      .et-star-bullet { margin-top: 0.4rem; padding-top: 0.4rem; border-top: 1px solid var(--line); }
      .et-star-bullet .et-star-label { color: var(--color-iris); }
      .et-pills { display: flex; flex-wrap: wrap; gap: 0.35rem; }
      .et-pill { display: inline-block; padding: 0.1rem 0.5rem; font-size: 0.8rem; border-radius: 999px; background: var(--surface-sunk, rgba(120,120,140,0.12)); border: 1px solid var(--line); color: var(--ink); white-space: nowrap; }
      .et-project-link { color: var(--color-iris); word-break: break-all; }
      .et-rbullet { display: flex; gap: 0.5rem; }
      .et-rbullet-dot { color: var(--color-iris); font-size: 1.1rem; line-height: 1.4; }
      .et-rbullet-body { flex: 1; min-width: 0; }
      .et-rbullet-meta { display: flex; gap: 0.8rem; margin-top: 0.3rem; font-size: 0.78rem; color: var(--ink-faint); }
      .et-role-head { display: flex; align-items: baseline; gap: 0.4rem; flex-wrap: wrap; }
      .et-role-title { font-weight: 600; font-size: 1.05rem; }
      .et-role-at { color: var(--ink-faint); font-size: 0.9rem; }
      .et-role-company { font-weight: 500; color: var(--color-iris); }
      .et-role-meta { font-size: 0.82rem; color: var(--ink-soft); margin: 0.2rem 0 0.5rem; display: flex; gap: 0.35rem; align-items: baseline; flex-wrap: wrap; }
      .et-role-bullets { margin: 0; padding-left: 1.2rem; }
      .et-role-bullets li { margin: 0.15rem 0; }
      .et-role-addb { background: none; border: none; color: var(--ink-faint); font: inherit; font-size: 0.8rem; cursor: pointer; margin-top: 0.3rem; }
      .et-role-addb:hover { color: var(--color-iris); }
      .et-block-gutter { opacity: 0; transition: opacity 0.12s; padding-top: 0.35rem; }
      .et-block:hover .et-block-gutter, .et-block:focus-within .et-block-gutter { opacity: 1; }
      /* Keep the menu visible (and clickable) while it's open, even if the block loses hover. */
      .et-block:has(.et-type-menu[open]) .et-block-gutter { opacity: 1; }
      .et-type-menu summary { padding: 0.1rem 0.15rem; }
      .et-block-gutter { display: flex; flex-direction: column; align-items: center; gap: 0.1rem; }
      .et-type-menu summary:active { cursor: grabbing; }
      .et-block[data-dragging] { opacity: 0.4; }
      .et-block[data-over] { box-shadow: inset 0 2px 0 0 var(--color-iris); }
      .et-block-del { background: none; border: none; color: var(--ink-faint); font-size: 1.05rem; line-height: 1; cursor: pointer; padding: 0 0.1rem; border-radius: 4px; }
      .et-block-del:hover { color: #c0392b; background: color-mix(in srgb, #c0392b 12%, transparent); }
      .et-type-menu { position: relative; }
      .et-type-menu summary { list-style: none; cursor: grab; color: var(--ink-faint); font-size: 0.7rem; user-select: none; line-height: 1; letter-spacing: -1px; }
      .et-type-menu summary::-webkit-details-marker { display: none; }
      .et-type-list { position: absolute; z-index: 10; top: 1.2rem; left: 0; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 9px; padding: 0.3rem; display: flex; flex-direction: column; min-width: 8rem; max-height: 60vh; overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
      .et-type-list button { text-align: left; background: none; border: none; font: inherit; font-size: 0.88rem; color: var(--ink-soft); padding: 0.32rem 0.5rem; border-radius: 6px; cursor: pointer; }
      .et-type-list button:hover { background: var(--color-iris-soft); color: var(--ink); }
      .et-type-heading { font-family: var(--font-mono); font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-faint); padding: 0.2rem 0.5rem 0.15rem; }
      .et-type-del { margin-top: 0.2rem; border-top: 1px solid var(--line) !important; border-radius: 0 !important; color: #c0392b !important; }
      .et-type-del:hover { background: color-mix(in srgb, #c0392b 12%, transparent) !important; color: #c0392b !important; }
      .et-type-del { border-top: 1px solid var(--line) !important; margin-top: 0.2rem; color: #c0392b !important; }
      .et-type-del:hover { background: color-mix(in srgb, #c0392b 12%, transparent) !important; }

      .et-block-render { width: 100%; line-height: 1.6; padding: 0.28rem 0; cursor: text; white-space: pre-wrap; word-break: break-word; min-height: 1.4em; }
      .et-block-render[data-empty] { color: var(--line-strong); font-style: italic; }
      .et-block-render a { color: var(--color-iris); }
      .et-block-render strong { font-weight: 650; }
      .et-inline-code { font-family: var(--font-mono); font-size: 0.85em; background: var(--paper-raised); padding: 0.05em 0.32em; border-radius: 4px; }
      .et-block[data-type="heading"] .et-block-render { font-family: var(--font-display); font-size: 1.7rem; line-height: 1.2; padding-top: 0.6rem; }
      .et-block[data-type="quote"] .et-block-render { border-left: 2px solid var(--color-iris); padding-left: 0.9rem; color: var(--ink-soft); font-style: italic; }
      .et-block[data-type="bullet"] .et-block-render, .et-block[data-type="todo"] .et-block-render, .et-block[data-type="numbered"] .et-block-render { padding-left: 1.1rem; }
      .et-render-code { font-family: var(--font-mono); font-size: 0.85rem; background: var(--paper-raised); border-radius: 7px; padding: 0.6rem 0.8rem; margin: 0.28rem 0; white-space: pre-wrap; cursor: text; }
      .et-block-input {
        width: 100%; border: none; background: none; resize: none; overflow: hidden;
        font: inherit; color: var(--ink); line-height: 1.6; padding: 0.28rem 0; margin: 0;
      }
      .et-block-input:focus { outline: none; }
      .et-block-input::placeholder { color: var(--line-strong); }
      .et-block[data-type="heading"] .et-block-input { font-family: var(--font-display); font-size: 1.7rem; line-height: 1.2; padding-top: 0.6rem; }
      .et-block[data-type="quote"] .et-block-input { border-left: 2px solid var(--color-iris); padding-left: 0.9rem; color: var(--ink-soft); font-style: italic; }
      .et-block[data-type="code"] .et-block-input { font-family: var(--font-mono); font-size: 0.85rem; background: var(--paper-raised); border-radius: 7px; padding: 0.6rem 0.8rem; }
      .et-block[data-type="bullet"] .et-block-input { padding-left: 1.1rem; }
      .et-block[data-type="bullet"] { position: relative; }
      .et-block[data-type="bullet"]::before { content: "•"; position: absolute; left: 1.4rem; top: 0.28rem; color: var(--ink-faint); }
      .et-block[data-type="todo"] .et-block-input { padding-left: 1.1rem; }
      .et-block[data-type="todo"]::before { content: "☐"; position: absolute; left: 1.4rem; top: 0.24rem; color: var(--ink-faint); }
      .et-block[data-type="todo"] { position: relative; }
      .et-block[data-ai="true"] .et-block-input { border-left: 2px solid color-mix(in srgb, var(--color-iris) 45%, transparent); padding-left: 0.7rem; }
      .et-hr { border: none; border-top: 1px solid var(--line-strong); margin: 0.8rem 0; }
    `}</style>
  );
}
