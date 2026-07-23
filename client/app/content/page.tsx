"use client";

// Content — the work-to-content pipeline.
//
// An idea is not a publication (spec §2.10), so the status ladder is explicit.
// Publishing requires a URL: the store rejects `published` without one, because
// claiming something shipped without evidence is exactly the drift this whole
// system is designed to prevent.

import { useCallback, useEffect, useState } from "react";
import BodyEditor from "@/components/BodyEditor";
import DeleteButton from "@/components/DeleteButton";
import { getContent, createContent, updateContent, deleteContent, ApiError, type ContentItem } from "@/lib/api";

const STATUSES = ["idea", "draft", "review", "scheduled", "published", "archived"] as const;
const FORMATS = ["short-post", "thread", "video", "article", "newsletter", "case-study"] as const;

export default function ContentPage() {
  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");

  const load = useCallback((status?: string) => {
    getContent(status ? { status } : {}).then((r) => setItems(r.content)).catch(() => setItems([]));
  }, []);

  useEffect(() => {
    setSelectedId(new URLSearchParams(window.location.search).get("id"));
    load();
  }, [load]);

  function select(id: string | null) {
    setSelectedId(id);
    window.history.pushState({}, "", id ? `?id=${encodeURIComponent(id)}` : window.location.pathname);
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    const created = await createContent({ title: title.trim() });
    setTitle("");
    load(filter || undefined);
    select(created.id);
  }

  return (
    <>
      <h1>Content</h1>
      <p style={{ color: "var(--ink-2)", margin: "4px 0 16px" }}>
        Drafts grounded in work you actually did, rather than a blank page.
      </p>

      <div className="pick" style={{ marginBottom: 16 }}>
        <button className={filter === "" ? "on" : ""}
          onClick={() => { setFilter(""); setItems(null); load(); }}>All</button>
        {STATUSES.map((s) => (
          <button key={s} className={filter === s ? "on" : ""}
            onClick={() => { setFilter(s); setItems(null); load(s); }}>{s}</button>
        ))}
      </div>

      <div className="split">
        <div className="list-pane">
          <form className="capture" style={{ marginBottom: 0 }} onSubmit={add}>
            <input value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="New content idea…" aria-label="New content" />
            <button className="btn" disabled={!title.trim()}>Add</button>
          </form>
          <div className="card">
            {!items && <><div className="skeleton" /><div className="skeleton" /></>}
            {items?.length === 0 && (
              <div className="empty">
                <strong>Nothing drafted</strong>
                Tested tools, project logs, and notes are the raw material — seeds
                created from them keep a link back to the work.
              </div>
            )}
            {items?.map((c) => (
              <button key={c.id} className={`row selectable ${selectedId === c.id ? "selected" : ""}`}
                onClick={() => select(c.id)}>
                <div className="lead">
                  <div className="title">{c.title}</div>
                  <div className="meta">{[c.format, c.channel].filter(Boolean).join(" · ") || "no format yet"}</div>
                </div>
                <span className={`chip ${c.status === "published" ? "ok" : ""}`}>{c.status}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="detail-pane">
          {selectedId
            ? <ContentDetail id={selectedId} items={items ?? []} onSaved={() => load(filter || undefined)}
                onDeleted={() => { select(null); load(filter || undefined); }} />
            : <div className="card"><div className="empty">
                <strong>Select an item</strong>Its draft and publishing details live here.
              </div></div>}
        </div>
      </div>
    </>
  );
}

function ContentDetail({
  id, items, onSaved, onDeleted,
}: { id: string; items: ContentItem[]; onSaved: () => void; onDeleted: () => void }) {
  const [item, setItem] = useState<ContentItem | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const found = items.find((c) => c.id === id) ?? null;
    setItem(found);
    setUrl(found?.published_url ?? "");
    setError(null);
  }, [id, items]);

  async function patch(body: Partial<ContentItem>) {
    setError(null);
    try {
      setItem(await updateContent(id, body));
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not update");
    }
  }

  if (!item) return <div className="card"><div className="skeleton" /></div>;

  return (
    <>
      <input className="title-field" value={item.title}
        onChange={(e) => setItem({ ...item, title: e.target.value })}
        onBlur={(e) => e.target.value && patch({ title: e.target.value })}
        aria-label="Content title" />

      <div className="pick" style={{ margin: "10px 0 8px" }}>
        {STATUSES.map((s) => (
          <button key={s} className={item.status === s ? "on" : ""}
            onClick={() => patch({ status: s })}>{s}</button>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <DeleteButton what="this item"
          onDelete={async () => { await deleteContent(id); onDeleted(); }} />
      </div>
      <div className="pick" style={{ marginBottom: 10 }}>
        {FORMATS.map((f) => (
          <button key={f} className={item.format === f ? "on" : ""}
            onClick={() => patch({ format: item.format === f ? null : f })}>{f}</button>
        ))}
      </div>

      {error && <div className="error-box" style={{ marginBottom: 10 }}>{error}</div>}

      <input className="field" value={url} onChange={(e) => setUrl(e.target.value)}
        onBlur={() => url !== (item.published_url ?? "") && patch({ published_url: url || null })}
        placeholder="Published URL — required to mark this published"
        aria-label="Published URL" />

      <BodyEditor resource="content" subjectType="content_item" id={id} title={item.title} />
    </>
  );
}
