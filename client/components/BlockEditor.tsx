"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, blockText, type Block, type BlockOp, type DocumentPatch } from "@/lib/api";
import { EditableText, DeleteButton } from "./Editable";

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
  { type: "divider", label: "Divider", kw: "hr line" },
  { type: "table", label: "Table" },
  { type: "embed", label: "Embed", kw: "iframe url video" },
];

// The default content a block gets when its type changes.
function defaultContentFor(type: string, keepText: string): Record<string, unknown> {
  if (type === "table") return { columns: [{ id: "c1", name: "Name", type: "text" }, { id: "c2", name: "Status", type: "status" }], rows: [] };
  if (type === "embed") return { url: "" };
  if (type === "divider") return { text: "" };
  return { text: keepText };
}

// Render inline markdown: **bold**, *italic*/_italic_, `code`, [text](url).
// Bold is matched before italic so ** wins over *.
function renderInline(src: string): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) nodes.push(src.slice(last, m.index));
    if (m[1]) nodes.push(<strong key={k++}>{m[2]}</strong>);
    else if (m[3]) nodes.push(<em key={k++}>{m[4]}</em>);
    else if (m[5]) nodes.push(<code key={k++} className="et-inline-code">{m[5]}</code>);
    else if (m[6]) nodes.push(<a key={k++} href={m[7]} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{m[6]}</a>);
    last = re.lastIndex;
  }
  if (last < src.length) nodes.push(src.slice(last));
  return nodes;
}

function embedUrl(contentJson: string): string { try { return String(JSON.parse(contentJson).url ?? ""); } catch { return ""; } }

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

  const applyOps = useCallback(async (ops: BlockOp[]) => {
    await api.post(`/documents/${documentId}/blocks`, { ops });
    qc.invalidateQueries({ queryKey: ["blocks", documentId] });
  }, [documentId, qc]);

  const saveText = useCallback((b: Block, value: string) => {
    clearTimeout(debounce.current[b.id]);
    debounce.current[b.id] = setTimeout(() => {
      api.post(`/documents/${documentId}/blocks`, {
        ops: [{ op: "update", id: b.id, type: b.type, content: { text: value } }],
      });
    }, 500);
  }, [documentId]);

  // Persist a block immediately (on blur), cancelling any pending debounce.
  const flush = useCallback((b: Block) => {
    clearTimeout(debounce.current[b.id]);
    void api.post(`/documents/${documentId}/blocks`, {
      ops: [{ op: "update", id: b.id, type: b.type, content: { text: text[b.id] ?? "" } }],
    });
  }, [documentId, text]);

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
    if (["divider", "table", "embed"].includes(type)) setEditingId(null);
  };

  // Slash menu: typing "/" at the start of an empty-ish block opens a type picker.
  const [slash, setSlash] = useState<{ id: string; query: string } | null>(null);
  const slashOptions = (q: string) => TYPE_MENU.filter((t) => `${t.label} ${t.type} ${t.kw ?? ""}`.toLowerCase().includes(q.toLowerCase()));
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
        <div key={b.id} className="et-block" data-type={b.type} data-ai={!!b.is_ai}>
          <div className="et-block-gutter">
            <details className="et-type-menu">
              <summary aria-label="Change block type">⋮⋮</summary>
              <div className="et-type-list">
                {TYPE_MENU.map((t) => <button key={t.type} onClick={(e) => { changeType(b, t.type); (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>{t.label}</button>)}
                <button className="et-type-del" onClick={(e) => { applyOps([{ op: "delete", id: b.id }]); (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>Delete block</button>
              </div>
            </details>
          </div>
          {b.type === "divider" ? (
            <hr className="et-hr" />
          ) : b.type === "table" ? (
            <DocTableBlock contentJson={b.content_json}
              onSave={(content) => applyOps([{ op: "update", id: b.id, type: "table", content }])} />
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
                  e.target.style.height = "auto";
                  e.target.style.height = `${e.target.scrollHeight}px`;
                }}
                onKeyDown={(e) => {
                  if (slash?.id === b.id) {
                    if (e.key === "Escape") { e.preventDefault(); setSlash(null); return; }
                    if (e.key === "Enter") { e.preventDefault(); const opts = slashOptions(slash.query); if (opts[0]) pickType(b, opts[0].type); return; }
                  }
                  onKeyDown(e, b);
                }}
                onBlur={() => { flush(b); setEditingId(null); setSlash(null); }}
              />
              {slash?.id === b.id && slashOptions(slash.query).length > 0 && (
                <div className="et-slash-menu">
                  {slashOptions(slash.query).map((t) => (
                    <button key={t.type} onMouseDown={(e) => { e.preventDefault(); pickType(b, t.type); }}>{t.label}</button>
                  ))}
                </div>
              )}
            </>
          ) : b.type === "code" ? (
            <pre className="et-block-render et-render-code" onClick={() => setEditingId(b.id)}>{text[b.id] || ""}</pre>
          ) : (
            <div className="et-block-render" data-empty={!text[b.id] || undefined} onClick={() => setEditingId(b.id)}>
              {text[b.id] ? renderInline(text[b.id]) : "Empty — click to edit"}
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
      .et-block-gutter { opacity: 0; transition: opacity 0.12s; padding-top: 0.35rem; }
      .et-block:hover .et-block-gutter, .et-block:focus-within .et-block-gutter { opacity: 1; }
      .et-type-menu { position: relative; }
      .et-type-menu summary { list-style: none; cursor: grab; color: var(--ink-faint); font-size: 0.7rem; user-select: none; line-height: 1; letter-spacing: -1px; }
      .et-type-menu summary::-webkit-details-marker { display: none; }
      .et-type-list { position: absolute; z-index: 10; top: 1.2rem; left: 0; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 9px; padding: 0.3rem; display: flex; flex-direction: column; min-width: 8rem; box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
      .et-type-list button { text-align: left; background: none; border: none; font: inherit; font-size: 0.88rem; color: var(--ink-soft); padding: 0.32rem 0.5rem; border-radius: 6px; cursor: pointer; }
      .et-type-list button:hover { background: var(--color-iris-soft); color: var(--ink); }
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
