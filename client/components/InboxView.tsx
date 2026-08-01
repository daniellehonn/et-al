"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, awaitingEnrichment, linkMeta, props, type Page, type RoleRow } from "@/lib/api";

// The inbox: captured material not yet processed. Humans can file a capture to a
// workspace or clear it; the deeper move — turning it into Insights — is an
// agent's job (process_inbox), which is why the hint points there.
export function InboxView() {
  const qc = useQueryClient();
  const { data: inbox, isLoading } = useQuery({
    queryKey: ["inbox"],
    queryFn: () => api.get<RoleRow[]>("/inbox"),
    // Enrichment happens on the queue, so a freshly pasted link arrives bare and
    // fills in a moment later. Poll only while something is actually pending —
    // once every link has its metadata the interval switches off.
    refetchInterval: (q) => (q.state.data?.some(awaitingEnrichment) ? 2000 : false),
  });
  const { data: workspaces } = useQuery({ queryKey: ["all-pages"], queryFn: () => api.get<Page[]>("/pages") });
  const [capture, setCapture] = useState("");

  const captureMut = useMutation({
    // See the note on Home's capture: /share extracts the link so it can be
    // enriched, /capture would store it as opaque text.
    mutationFn: (text: string) => api.post("/share", { text }),
    onSuccess: () => { setCapture(""); qc.invalidateQueries({ queryKey: ["inbox"] }); },
  });
  const fileMut = useMutation({
    mutationFn: ({ id, workspace_id }: { id: string; workspace_id: string }) => api.patch(`/sources/${id}`, { page_id: workspace_id, status: "processed" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inbox"] }),
  });
  const clearMut = useMutation({
    mutationFn: (id: string) => api.patch(`/sources/${id}`, { status: "processed" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inbox"] }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.del(`/sources/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inbox"] }),
  });

  return (
    <div className="et-inbox-page">
      <header className="et-inbox-head">
        <div className="eyebrow">Unprocessed</div>
        <h1 className="serif">Inbox</h1>
        <p className="et-inbox-sub">Everything lands here first. File it to a workspace, clear it, or ask an agent to <em>process_inbox</em> and turn it into knowledge.</p>
      </header>

      <form className="et-capture" onSubmit={(e) => { e.preventDefault(); if (capture.trim()) captureMut.mutate(capture.trim()); }}>
        <input value={capture} onChange={(e) => setCapture(e.target.value)} placeholder="Capture a thought or link…" aria-label="Quick capture" />
        <button type="submit" disabled={!capture.trim() || captureMut.isPending}>{captureMut.isPending ? "Saving…" : "Capture"}</button>
      </form>

      <div className="et-inbox-list">
        {(inbox ?? []).map((s) => {
          const meta = linkMeta(s);
          const pending = awaitingEnrichment(s);
          // The raw paste is only worth showing when it says something the title
          // doesn't: for a bare link it repeats the URL, and for a short note
          // /share seeds the title from the text itself.
            return (
          <div key={s.id} className="et-inbox-item">
            <div className="et-inbox-main">
              <span className="et-kind" data-kind={String(s.props.kind)}>{String(s.props.kind)}</span>
              {meta?.image && <img className="et-inbox-thumb" src={meta.image} alt="" loading="lazy" />}
              <div className="et-inbox-body">
                <div className="et-inbox-title">{s.title || String(s.props.url ?? "(untitled)")}</div>
                {meta?.description && <div className="et-inbox-desc">{meta.description}</div>}
                {!!s.props.url && (
                  <a className="et-inbox-link" href={String(s.props.url)} target="_blank" rel="noopener noreferrer">
                    {meta?.site ?? String(s.props.url)}
                  </a>
                )}
                {pending && <div className="et-inbox-pending">Fetching link details…</div>}
              </div>
            </div>
            <div className="et-inbox-actions">
              <select defaultValue="" aria-label="File to workspace"
                onChange={(e) => { if (e.target.value) fileMut.mutate({ id: s.id, workspace_id: e.target.value }); }}>
                <option value="" disabled>File to…</option>
                {(workspaces ?? []).map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
              </select>
              <button className="et-clear" onClick={() => clearMut.mutate(s.id)} aria-label="Mark processed">Clear</button>
              <button className="et-clear et-delete" onClick={() => deleteMut.mutate(s.id)} aria-label="Delete capture">Delete</button>
            </div>
          </div>
          );
        })}
        {!isLoading && (inbox?.length ?? 0) === 0 && <div className="et-empty">Inbox zero. Nothing waiting.</div>}
      </div>

      <style>{`
        .et-inbox-page { max-width: 48rem; margin: 0 auto; padding: 3.5rem 2.5rem 6rem; }
        .et-inbox-head h1 { font-size: 2.4rem; margin: 0.3rem 0 0.5rem; }
        .et-inbox-sub { color: var(--ink-soft); font-size: 0.92rem; max-width: 38rem; margin: 0 0 2rem; }
        .et-inbox-sub em { font-family: var(--font-mono); font-style: normal; font-size: 0.9em; color: var(--ink); }
        .et-capture { display: flex; gap: 0.6rem; margin-bottom: 2rem; }
        .et-capture input { flex: 1; min-width: 0; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 9px; padding: 0.7rem 0.9rem; font: inherit; color: var(--ink); }
        .et-capture input:focus { outline: none; border-color: var(--color-iris); }
        .et-capture button { background: var(--color-iris); color: #fff; border: none; border-radius: 9px; padding: 0 1.3rem; font: inherit; font-weight: 500; cursor: pointer; }
        .et-capture button:disabled { opacity: 0.4; }
        .et-inbox-list { display: flex; flex-direction: column; }
        .et-inbox-item { display: grid; grid-template-columns: 1fr auto; gap: 1rem; align-items: center; padding: 0.95rem 0; border-bottom: 1px solid var(--line); }
        .et-inbox-main { display: flex; gap: 0.8rem; align-items: baseline; min-width: 0; }
        .et-kind { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; padding: 0.15rem 0.45rem; border-radius: 5px; background: var(--paper-raised); border: 1px solid var(--line); color: var(--ink-soft); flex: none; }
        .et-kind[data-kind="idea"] { color: var(--color-amber); }
        .et-kind[data-kind="url"], .et-kind[data-kind="youtube"] { color: var(--color-iris); }
        .et-inbox-body { min-width: 0; }
        /* Page titles are arbitrary length and some sites stuff the whole
           description in there; clamp so one capture can't dominate the queue. */
        .et-inbox-title {
          font-size: 0.95rem;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        }
        .et-inbox-raw { font-size: 0.85rem; color: var(--ink-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 0.15rem; }
        /* Enriched link detail. The thumbnail is small on purpose — this is a
           triage queue, not a feed; it aids recognition without inviting reading. */
        .et-inbox-thumb { width: 3rem; height: 3rem; object-fit: cover; border-radius: 7px; flex: none; border: 1px solid var(--line); background: var(--paper-raised); }
        .et-inbox-desc {
          font-size: 0.85rem; color: var(--ink-soft); margin-top: 0.15rem;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        }
        .et-inbox-link { font-family: var(--font-mono); font-size: 0.72rem; letter-spacing: 0.04em; color: var(--color-iris); text-decoration: none; display: inline-block; margin-top: 0.25rem; overflow-wrap: anywhere; }
        .et-inbox-link:hover { text-decoration: underline; }
        .et-inbox-pending { font-size: 0.78rem; color: var(--ink-faint); font-style: italic; margin-top: 0.2rem; }
        .et-inbox-actions { display: flex; gap: 0.5rem; align-items: center; flex: none; }
        .et-inbox-actions select { background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 7px; padding: 0.35rem 0.5rem; font: inherit; font-size: 0.82rem; color: var(--ink-soft); }
        .et-clear { background: none; border: none; color: var(--ink-faint); font: inherit; font-size: 0.82rem; cursor: pointer; padding: 0.35rem 0.4rem; }
        .et-clear:hover { color: var(--ink); }
        .et-delete:hover { color: #c0392b; }
        /* .et-empty moved to globals.css */
        @media (max-width: 860px) {
          /* Each item becomes two rows — content, then its triage controls —
             so the route/dismiss controls keep a full-width tap target. */
          .et-inbox-item { grid-template-columns: 1fr; gap: 0.5rem; }
          .et-inbox-actions { justify-content: flex-end; }
          .et-inbox-actions select { flex: 1; min-width: 0; }
          /* .et-capture is itself the form here (unlike Home's wrapper). */
          .et-capture { flex-direction: column; }
          .et-capture button { padding: 0.7rem 1.3rem; }
        }
      `}</style>
    </div>
  );
}
