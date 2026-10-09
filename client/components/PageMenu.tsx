"use client";
// The page-level actions behind ••• : move, history, and the trash. History is
// how an accepted agent patch gets undone, block by block.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, blockContent, type Page } from "@/lib/api";

export function PageMenu({ page, onChanged }: { page: Page; onChanged: () => void }) {
  const qc = useQueryClient();
  const [panel, setPanel] = useState<"none" | "history" | "move">("none");

  const close = (e: React.MouseEvent) => {
    const d = (e.currentTarget as HTMLElement).closest("details") as HTMLDetailsElement | null;
    if (d) d.open = false;
  };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["tree"] });
    qc.invalidateQueries({ queryKey: ["page", page.id] });
    onChanged();
  };

  return (
    <>
      <div className="et-pagemenu-row">
        <details className="et-pagemenu">
          <summary>···</summary>
          <div className="et-pagemenu-list">
            <button onClick={(e) => { close(e); setPanel("move"); }}>Move to…</button>
            <button onClick={(e) => { close(e); setPanel("history"); }}>History</button>
            <button className="et-pagemenu-del" onClick={async (e) => {
              close(e);
              if (!confirm(`Move "${page.title || "Untitled"}" to the trash? Everything inside goes with it.`)) return;
              await api.del(`/pages/${page.id}`);
              qc.invalidateQueries({ queryKey: ["tree"] });
              window.location.href = "/";
            }}>Move to trash</button>
          </div>
        </details>
      </div>

      {panel === "move" && <MovePanel page={page} onDone={() => { setPanel("none"); refresh(); }} />}
      {panel === "history" && <HistoryPanel pageId={page.id} onDone={() => { setPanel("none"); refresh(); }} />}
      <PageMenuStyles />
    </>
  );
}

/** Move-to: pick a destination from the flat page list. Descendants of the page
 *  are filtered out here as well as refused server-side — offering a move that
 *  will certainly fail is worse than not offering it. */
function MovePanel({ page, onDone }: { page: Page; onDone: () => void }) {
  const { data: pages } = useQuery({ queryKey: ["all-pages"], queryFn: () => api.get<Page[]>("/pages") });
  const [q, setQ] = useState("");
  const options = (pages ?? [])
    .filter((p) => p.id !== page.id && p.id !== page.parent_page_id)
    .filter((p) => p.title.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 20);

  const move = async (parent: string | null) => {
    try { await api.post(`/pages/${page.id}/move`, { new_parent_page_id: parent }); }
    catch (e) { alert(e instanceof Error ? e.message : "Could not move that page"); }
    onDone();
  };

  return (
    <div className="et-panel">
      <div className="et-panel-head">Move to<button onClick={onDone}>×</button></div>
      <input className="et-panel-search" placeholder="Search pages…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <button className="et-panel-row" onClick={() => move(null)}>↑ Top level</button>
      {options.map((p) => (
        <button key={p.id} className="et-panel-row" onClick={() => move(p.id)}>{p.icon ?? "📄"} {p.title || "Untitled"}</button>
      ))}
    </div>
  );
}

interface HistoryEntry {
  id: string; block_id: string; content_json: string; version: number;
  actor: string; created_at: number; block_type: string | null; current_content: string | null;
}

/** Edit history. block_revision has been recording every prior version since v7;
 *  this is the first thing that reads it. Restoring is per block rather than
 *  whole-page, because that is the granularity the revisions were written at. */
function HistoryPanel({ pageId, onDone }: { pageId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: history } = useQuery({
    queryKey: ["history", pageId],
    queryFn: () => api.get<HistoryEntry[]>(`/pages/${pageId}/history`),
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
            {new Date(h.created_at).toLocaleString()} · {h.actor}
          </div>
          <div className="et-panel-hist-text">{textOf(h.content_json) || <em>(empty)</em>}</div>
          <button onClick={async () => {
            await api.post(`/revisions/${h.id}/restore`);
            qc.invalidateQueries({ queryKey: ["blocks", pageId] });
            qc.invalidateQueries({ queryKey: ["history", pageId] });
          }}>Restore this version</button>
        </div>
      ))}
    </div>
  );
}

/** The trash: what was deleted, with restore and permanent delete. */
export function TrashPanel({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { data: trash } = useQuery({ queryKey: ["trash"], queryFn: () => api.get<Page[]>("/trash") });
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
          <div className="et-panel-hist-text">{p.icon ?? "📄"} {p.title || "Untitled"}</div>
          <div className="et-panel-hist-meta">deleted {p.trashed_at ? new Date(p.trashed_at).toLocaleString() : ""}</div>
          <button onClick={async () => { await api.post(`/pages/${p.id}/restore`); refresh(); }}>Restore</button>
          <button className="et-pagemenu-del" onClick={async () => {
            if (!confirm(`Permanently delete "${p.title || "Untitled"}"? This cannot be undone.`)) return;
            await api.del(`/pages/${p.id}?permanent=1`);
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
