"use client";
// The note-level actions behind ••• : move, history, and the trash. History is
// how an accepted agent patch gets undone, block by block.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { actorLabel, api, type HistoryEntry, type Note, type NoteNode } from "@/lib/api";

export function NoteMenu({ note }: { note: Note }) {
  const qc = useQueryClient();
  const [panel, setPanel] = useState<"none" | "history" | "move">("none");

  const close = (e: React.MouseEvent) => {
    const d = (e.currentTarget as HTMLElement).closest("details") as HTMLDetailsElement | null;
    if (d) d.open = false;
  };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["tree"] });
    qc.invalidateQueries({ queryKey: ["note", note.id] });
  };

  return (
    <>
      <div className="et-pagemenu-row">
        <details className="et-pagemenu">
          <summary aria-label="Note options">···</summary>
          <div className="et-pagemenu-list">
            <button onClick={(e) => { close(e); setPanel("move"); }}>Move to…</button>
            <button onClick={(e) => { close(e); setPanel("history"); }}>History</button>
            <button className="et-pagemenu-del" onClick={async (e) => {
              close(e);
              if (!confirm(`Move "${note.title || "Untitled"}" to the trash? Everything inside goes with it.`)) return;
              await api.del(`/notes/${note.id}`);
              qc.invalidateQueries({ queryKey: ["tree"] });
              window.location.href = "/";
            }}>Move to trash</button>
          </div>
        </details>
      </div>

      {panel === "move" && <MovePanel note={note} onDone={() => { setPanel("none"); refresh(); }} />}
      {panel === "history" && <HistoryPanel noteId={note.id} onDone={() => setPanel("none")} />}
      <PageMenuStyles />
    </>
  );
}

/** Every note in the tree, flattened, leaving out `exclude` and everything
 *  under it: a note cannot move inside itself, and offering a move that will
 *  certainly fail is worse than not offering it. */
function flatten(nodes: NoteNode[], exclude: string, out: NoteNode[] = []): NoteNode[] {
  for (const n of nodes) {
    if (n.id === exclude) continue;
    out.push(n);
    flatten(n.children, exclude, out);
  }
  return out;
}

function MovePanel({ note, onDone }: { note: Note; onDone: () => void }) {
  const { data: tree } = useQuery({ queryKey: ["tree"], queryFn: () => api.get<NoteNode[]>("/notes/tree") });
  const [q, setQ] = useState("");
  const options = flatten(tree ?? [], note.id)
    .filter((n) => n.id !== note.parent_id && n.title.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 20);

  const move = async (parent: string | null) => {
    try { await api.post(`/notes/${note.id}/move`, { parent_id: parent }); }
    catch (e) { alert(e instanceof Error ? e.message : "Could not move that note"); }
    onDone();
  };

  return (
    <div className="et-panel">
      <div className="et-panel-head">Move to<button onClick={onDone}>×</button></div>
      <input id="et-move-search" className="et-panel-search" placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {note.parent_id && <button className="et-panel-row" onClick={() => move(null)}>↑ Top level</button>}
      {options.map((n) => (
        <button key={n.id} className="et-panel-row" onClick={() => move(n.id)}>{n.title || "Untitled"}</button>
      ))}
    </div>
  );
}

/** Edit history, per block: what each edit replaced and who wrote it. This is
 *  where an accepted agent patch is undone. */
function HistoryPanel({ noteId, onDone }: { noteId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: history } = useQuery({
    queryKey: ["history", noteId],
    queryFn: () => api.get<HistoryEntry[]>(`/notes/${noteId}/history`),
  });

  const textOf = (json: string) => {
    try { return String((JSON.parse(json) as { text?: string }).text ?? "").slice(0, 90); } catch { return ""; }
  };

  return (
    <div className="et-panel">
      <div className="et-panel-head">History<button onClick={onDone}>×</button></div>
      {history?.length === 0 && <div className="et-panel-empty">No earlier versions yet.</div>}
      {(history ?? []).map((h) => (
        <div key={h.id} className="et-panel-hist">
          <div className="et-panel-hist-meta">
            {new Date(h.created_at).toLocaleString()} · written by {actorLabel(h.actor)}
          </div>
          <div className="et-panel-hist-text">{textOf(h.content_json) || <em>(empty)</em>}</div>
          <button onClick={async () => {
            await api.post(`/revisions/${h.id}/restore`);
            qc.invalidateQueries({ queryKey: ["blocks", noteId] });
            qc.invalidateQueries({ queryKey: ["history", noteId] });
          }}>Restore this version</button>
        </div>
      ))}
    </div>
  );
}

/** The trash: what was trashed, with restore and permanent delete. */
export function TrashPanel({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { data: trash } = useQuery({ queryKey: ["trash"], queryFn: () => api.get<Note[]>("/trash") });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["trash"] });
    qc.invalidateQueries({ queryKey: ["tree"] });
  };

  return (
    <div className="et-panel">
      <div className="et-panel-head">Trash<button onClick={onDone}>×</button></div>
      {trash?.length === 0 && <div className="et-panel-empty">Nothing in the trash.</div>}
      {(trash ?? []).map((p) => (
        <div key={p.id} className="et-panel-hist">
          <div className="et-panel-hist-text">{p.title || "Untitled"}</div>
          <div className="et-panel-hist-meta">trashed {p.trashed_at ? new Date(p.trashed_at).toLocaleString() : ""}</div>
          <button onClick={async () => { await api.post(`/notes/${p.id}/restore`); refresh(); }}>Restore</button>
          <button className="et-pagemenu-del" onClick={async () => {
            if (!confirm(`Permanently delete "${p.title || "Untitled"}"? This cannot be undone.`)) return;
            await api.del(`/trash/${p.id}`);
            refresh();
          }}>Delete forever</button>
        </div>
      ))}
      <PageMenuStyles />
    </div>
  );
}

function PageMenuStyles() {
  return (
    <style jsx global>{`
      .et-pagemenu-row { display: inline-flex; align-items: center; gap: 0.4rem; }
      .et-pagemenu { position: relative; }
      .et-pagemenu summary { list-style: none; cursor: pointer; color: var(--ink-faint); font-size: 0.95rem; padding: 0 0.25rem; }
      .et-pagemenu summary::-webkit-details-marker { display: none; }
      .et-pagemenu-list { position: absolute; z-index: 40; left: 0; top: 1.5rem; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 8px; padding: 0.25rem; display: flex; flex-direction: column; min-width: 10rem; box-shadow: 0 8px 24px rgba(0,0,0,0.16); }
      .et-pagemenu-list button { text-align: left; background: none; border: none; font: inherit; font-size: 0.85rem; color: var(--ink-soft); padding: 0.32rem 0.5rem; border-radius: 5px; cursor: pointer; white-space: nowrap; }
      .et-pagemenu-list button:hover { background: var(--color-iris-soft); color: var(--ink); }
      .et-pagemenu-del:hover { color: var(--color-rust, #b4462e); }
      .et-panel { border: 1px solid var(--rule); border-radius: 9px; margin: 0.8rem 0; max-height: 22rem; overflow-y: auto; background: var(--surface); }
      .et-panel-head { display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-faint); padding: 0.5rem 0.7rem; border-bottom: 1px solid var(--rule); position: sticky; top: 0; background: var(--surface); }
      .et-panel-head button { background: none; border: none; color: var(--ink-faint); cursor: pointer; font-size: 1rem; }
      .et-panel-search { width: 100%; border: none; border-bottom: 1px solid var(--rule); background: none; font: inherit; font-size: 0.88rem; padding: 0.45rem 0.7rem; color: inherit; }
      .et-panel-search:focus { outline: none; }
      .et-panel-row { display: block; width: 100%; text-align: left; background: none; border: none; border-bottom: 1px solid var(--rule); font: inherit; font-size: 0.86rem; color: inherit; padding: 0.4rem 0.7rem; cursor: pointer; }
      .et-panel-row:hover { background: var(--surface-2); }
      .et-panel-empty { padding: 0.8rem; color: var(--ink-faint); font-size: 0.85rem; }
      .et-panel-hist { padding: 0.5rem 0.7rem; border-bottom: 1px solid var(--rule); display: flex; flex-direction: column; gap: 0.2rem; align-items: flex-start; }
      .et-panel-hist-meta { font-size: 0.72rem; color: var(--ink-faint); }
      .et-panel-hist-text { font-size: 0.86rem; }
      .et-panel-hist button { background: none; border: 1px solid var(--rule); border-radius: 5px; font: inherit; font-size: 0.76rem; color: inherit; padding: 0.15rem 0.45rem; cursor: pointer; margin-right: 0.3rem; }
      .et-panel-hist button:hover { border-color: var(--color-iris); color: var(--color-iris); }
    `}</style>
  );
}
