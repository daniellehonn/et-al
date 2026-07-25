"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, blockText, type Block, type BlockOp, type DocumentPatch } from "@/lib/api";

// A Notion-style editor over the block model. Each block is an auto-growing
// textarea (robust cursor handling; blocks store plain text). Humans write
// blocks directly via /blocks; agents propose patches, surfaced here as
// Accept/Reject. Text edits debounce-save; structural ops refetch to learn the
// server-assigned ids.
const TYPE_MENU: Array<{ type: string; label: string }> = [
  { type: "paragraph", label: "Text" },
  { type: "heading", label: "Heading" },
  { type: "bullet", label: "Bulleted" },
  { type: "todo", label: "To-do" },
  { type: "quote", label: "Quote" },
  { type: "code", label: "Code" },
  { type: "divider", label: "Divider" },
];

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
  const focusAfter = useRef<{ afterId: string | null } | null>(null);
  const debounce = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    if (!blocks) return;
    setText((prev) => {
      const next = { ...prev };
      for (const b of blocks) if (next[b.id] === undefined) next[b.id] = blockText(b);
      return next;
    });
    // Focus the block created by the last structural op.
    if (focusAfter.current && blocks.length) {
      const { afterId } = focusAfter.current;
      const idx = afterId ? blocks.findIndex((b) => b.id === afterId) : -1;
      const target = blocks[idx + 1] ?? blocks[blocks.length - 1];
      focusAfter.current = null;
      requestAnimationFrame(() => document.getElementById(`blk-${target.id}`)?.focus());
    }
  }, [blocks]);

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
    if (type === "divider") {
      applyOps([{ op: "update", id: b.id, type, content: { text: "" } }]);
    } else {
      applyOps([{ op: "update", id: b.id, type, content: { text: text[b.id] ?? "" } }]);
    }
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
              </div>
            </details>
          </div>
          {b.type === "divider" ? (
            <hr className="et-hr" />
          ) : (
            <textarea
              id={`blk-${b.id}`}
              className="et-block-input"
              rows={1}
              value={text[b.id] ?? ""}
              placeholder={b.type === "heading" ? "Heading" : "Type, or ⋮⋮ to change type"}
              onChange={(e) => {
                const v = e.target.value;
                setText((s) => ({ ...s, [b.id]: v }));
                saveText(b, v);
                e.target.style.height = "auto";
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              onKeyDown={(e) => onKeyDown(e, b)}
              ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }}
            />
          )}
        </div>
      ))}

      <EditorStyles />
    </div>
  );
}

function EditorStyles() {
  return (
    <style>{`
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

      .et-block { display: grid; grid-template-columns: 1.4rem 1fr; align-items: start; }
      .et-block-gutter { opacity: 0; transition: opacity 0.12s; padding-top: 0.35rem; }
      .et-block:hover .et-block-gutter, .et-block:focus-within .et-block-gutter { opacity: 1; }
      .et-type-menu { position: relative; }
      .et-type-menu summary { list-style: none; cursor: grab; color: var(--ink-faint); font-size: 0.7rem; user-select: none; line-height: 1; letter-spacing: -1px; }
      .et-type-menu summary::-webkit-details-marker { display: none; }
      .et-type-list { position: absolute; z-index: 10; top: 1.2rem; left: 0; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 9px; padding: 0.3rem; display: flex; flex-direction: column; min-width: 8rem; box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
      .et-type-list button { text-align: left; background: none; border: none; font: inherit; font-size: 0.88rem; color: var(--ink-soft); padding: 0.32rem 0.5rem; border-radius: 6px; cursor: pointer; }
      .et-type-list button:hover { background: var(--color-iris-soft); color: var(--ink); }

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
