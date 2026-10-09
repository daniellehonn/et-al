"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, flattenTree, type NoteNode, type Proposal, type Source } from "@/lib/api";

// The inbox: what is waiting on you. Insights the extractor drew from your
// saved links come first — nothing it writes is real until you keep it — then
// the captures themselves, to file into a note or clear.
export function InboxView() {
  const qc = useQueryClient();
  const { data: inbox, isLoading } = useQuery({
    queryKey: ["inbox"],
    queryFn: () => api.get<Source[]>("/inbox"),
    // Links are fetched on the queue, so one arrives bare and fills in a moment
    // later. Poll only while a fetch is actually pending.
    refetchInterval: (q) => (q.state.data?.some((s) => s.fetch_status === "pending") ? 2000 : false),
  });
  const { data: tree } = useQuery({ queryKey: ["tree"], queryFn: () => api.get<NoteNode[]>("/notes/tree") });
  const notes = flattenTree(tree ?? []);
  const [capture, setCapture] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["inbox"] }); qc.invalidateQueries({ queryKey: ["proposals"] }); };

  const captureMut = useMutation({
    // /share rather than /capture: it pulls a link out of pasted text into `url`,
    // which is what gets it fetched.
    mutationFn: (text: string) => api.post("/share", { text }),
    onSuccess: () => { setCapture(""); refresh(); },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => api.patch(`/sources/${id}`, patch),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/sources/${id}`), onSuccess: refresh });

  return (
    <div className="et-inbox-page">
      <header className="et-inbox-head">
        <div className="eyebrow">Waiting on you</div>
        <h1 className="serif">Inbox</h1>
        <p className="et-inbox-sub">Everything you save lands here first. Links are read in the background, and anything worth keeping from them is suggested below for you to keep or discard.</p>
      </header>

      <form className="et-capture" onSubmit={(e) => { e.preventDefault(); if (capture.trim()) captureMut.mutate(capture.trim()); }}>
        <input id="et-inbox-capture" value={capture} onChange={(e) => setCapture(e.target.value)} placeholder="Capture a thought or link…" aria-label="Quick capture" />
        <button type="submit" disabled={!capture.trim() || captureMut.isPending}>{captureMut.isPending ? "Saving…" : "Capture"}</button>
      </form>

      <InsightQueue />

      <div className="eyebrow et-inbox-label">Captured</div>
      <div className="et-inbox-list">
        {(inbox ?? []).map((s) => (
          <div key={s.id} className="et-inbox-item">
            <div className="et-inbox-main">
              {s.image && <img className="et-inbox-thumb" src={s.image} alt="" loading="lazy" />}
              <div className="et-inbox-body">
                <a className="et-inbox-title" href={`/source/?id=${s.id}`}>{s.title || s.url || "(untitled)"}</a>
                {s.description && <div className="et-inbox-desc">{s.description}</div>}
                {s.text && s.text !== s.title && <div className="et-inbox-desc">{s.text}</div>}
                {s.url && <a className="et-inbox-link" href={s.url} target="_blank" rel="noopener noreferrer">{s.site ?? s.url}</a>}
                {s.fetch_status === "pending" && <div className="et-inbox-status">Reading the link…</div>}
                {s.fetch_status === "failed" && <div className="et-inbox-status" data-bad>Couldn&rsquo;t read the link: {s.fetch_error}</div>}
              </div>
            </div>
            <div className="et-inbox-actions">
              <select id={`et-file-${s.id}`} defaultValue="" aria-label="File into a note"
                onChange={(e) => { if (e.target.value) update.mutate({ id: s.id, patch: { note_id: e.target.value } }); }}>
                <option value="" disabled>File into…</option>
                {notes.map((n) => <option key={n.id} value={n.id}>{n.title || "Untitled"}</option>)}
              </select>
              <button className="et-clear" onClick={() => update.mutate({ id: s.id, patch: { status: "done" } })}>Done</button>
              <button className="et-clear et-delete" onClick={() => remove.mutate(s.id)}>Delete</button>
            </div>
          </div>
        ))}
        {!isLoading && (inbox?.length ?? 0) === 0 && <div className="et-empty">Inbox zero. Nothing waiting.</div>}
      </div>

      <InboxStyles />
    </div>
  );
}

/** Insights extracted from saved links are reviewed with everything else
 *  proposed; the inbox just says they are waiting. */
function InsightQueue() {
  const { data: proposals } = useQuery({ queryKey: ["proposals"], queryFn: () => api.get<Proposal[]>("/proposals"), refetchInterval: 15000 });
  const n = (proposals ?? []).filter((p) => p.kind === "insight").length;
  if (!n) return null;
  return (
    <a className="et-insights-link" href="/review/">
      {n} insight{n === 1 ? "" : "s"} suggested from your links — review {n === 1 ? "it" : "them"} →
    </a>
  );
}

function InboxStyles() {
  return (
    <style>{`
      .et-inbox-page { max-width: 48rem; margin: 0 auto; padding: 3.5rem 2.5rem 6rem; }
      .et-inbox-head h1 { font-size: 2.4rem; margin: 0.3rem 0 0.5rem; }
      .et-inbox-sub { color: var(--ink-soft); font-size: 0.92rem; max-width: 38rem; margin: 0 0 2rem; }
      .et-inbox-label { margin: 2rem 0 0.6rem; }
      .et-capture { display: flex; gap: 0.6rem; }
      .et-capture input { flex: 1; min-width: 0; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 9px; padding: 0.7rem 0.9rem; font: inherit; color: var(--ink); }
      .et-capture input:focus { outline: none; border-color: var(--color-iris); }
      .et-capture button { background: var(--color-iris); color: #fff; border: none; border-radius: 9px; padding: 0 1.3rem; font: inherit; font-weight: 500; cursor: pointer; }
      .et-capture button:disabled { opacity: 0.4; }
      .et-insights-link { display: block; margin-top: 1.4rem; border: 1px solid var(--color-sage); border-radius: 9px; padding: 0.7rem 0.9rem; color: var(--color-sage); text-decoration: none; font-size: 0.9rem; }
      .et-inbox-list { display: flex; flex-direction: column; }
      .et-inbox-item { display: grid; grid-template-columns: 1fr auto; gap: 1rem; align-items: center; padding: 0.95rem 0; border-bottom: 1px solid var(--line); }
      .et-inbox-main { display: flex; gap: 0.8rem; align-items: flex-start; min-width: 0; }
      .et-inbox-body { min-width: 0; }
      /* Fetched titles are arbitrary length; clamp so one capture can't dominate. */
      .et-inbox-title { font-size: 0.95rem; color: var(--ink); text-decoration: none; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .et-inbox-thumb { width: 3rem; height: 3rem; object-fit: cover; border-radius: 7px; flex: none; border: 1px solid var(--line); background: var(--paper-raised); }
      .et-inbox-desc { font-size: 0.85rem; color: var(--ink-soft); margin-top: 0.15rem; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .et-inbox-link { font-family: var(--font-mono); font-size: 0.72rem; color: var(--color-iris); text-decoration: none; display: inline-block; margin-top: 0.25rem; overflow-wrap: anywhere; }
      .et-inbox-status { font-size: 0.78rem; color: var(--ink-faint); font-style: italic; margin-top: 0.2rem; }
      .et-inbox-status[data-bad] { color: var(--color-amber); font-style: normal; }
      .et-inbox-actions { display: flex; gap: 0.5rem; align-items: center; flex: none; }
      .et-inbox-actions select { background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 7px; padding: 0.35rem 0.5rem; font: inherit; font-size: 0.82rem; color: var(--ink-soft); max-width: 11rem; }
      .et-clear { background: none; border: none; color: var(--ink-faint); font: inherit; font-size: 0.82rem; cursor: pointer; padding: 0.35rem 0.4rem; }
      .et-clear:hover { color: var(--ink); }
      .et-delete:hover { color: #c0392b; }
      @media (max-width: 860px) {
        .et-inbox-page { padding: 3.5rem 1.1rem 5rem; }
        .et-inbox-item { grid-template-columns: 1fr; gap: 0.5rem; }
        .et-inbox-actions { justify-content: flex-end; }
        .et-inbox-actions select { flex: 1; min-width: 0; max-width: none; }
        .et-capture { flex-direction: column; }
        .et-capture button { padding: 0.7rem 1.3rem; }
      }
    `}</style>
  );
}
