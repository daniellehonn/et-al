"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { api, type Workspace } from "@/lib/api";

// The Spine: the workspace tree IS the navigation and the AI's context boundary,
// so it lives permanently on the left. The & mark anchors the top.
const NAV = [
  { href: "/", label: "Home" },
  { href: "/inbox/", label: "Inbox" },
  { href: "/search/", label: "Search" },
  { href: "/knowledge/", label: "Knowledge" },
];
const WORKSPACE_TYPES = ["area", "project", "course", "organization"];

export function Spine() {
  const pathname = usePathname();
  const qc = useQueryClient();
  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.get<Workspace[]>("/workspaces"),
  });

  // `creating` holds the parent id we're adding under; null = root; false = idle.
  const [creating, setCreating] = useState<string | null | false>(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState("area");
  const create = useMutation({
    mutationFn: (parent_id: string | null) => api.post<Workspace>("/workspaces", { parent_id, type, title }),
    onSuccess: () => { setTitle(""); setType("area"); setCreating(false); qc.invalidateQueries({ queryKey: ["workspaces"] }); },
  });

  // Drag a workspace onto another to re-parent it; onto the header to make it a
  // root. The server rejects cycles; surface that rather than failing silently.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null | undefined>(undefined); // undefined=none, null=root
  const move = useMutation({
    mutationFn: ({ id, parent }: { id: string; parent: string | null }) => api.post(`/workspaces/${id}/move`, { new_parent_id: parent }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspaces"] }),
    onError: (e) => alert((e as Error).message),
  });
  const drop = (parent: string | null) => {
    setDropId(undefined);
    if (dragId && dragId !== parent) move.mutate({ id: dragId, parent });
    setDragId(null);
  };

  const byParent = new Map<string | null, Workspace[]>();
  for (const w of workspaces ?? []) {
    const key = w.parent_id;
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(w);
  }

  const newInput = (parent: string | null, depth: number) => (
    <form className="et-ws-new" style={{ paddingLeft: `${depth * 0.85 + 0.9}rem` }}
      onSubmit={(e) => { e.preventDefault(); if (title.trim()) create.mutate(parent); }}>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { setTitle(""); setCreating(false); } }}
        placeholder={parent ? "Sub-workspace…" : "Workspace…"} />
      <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Workspace type">
        {WORKSPACE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    </form>
  );

  const renderTree = (parent: string | null, depth: number): React.ReactNode => (
    <>
      {(byParent.get(parent) ?? []).map((w) => (
        <div key={w.id}>
          <div className="et-ws-row" style={{ paddingLeft: `${depth * 0.85 + 0.9}rem` }}
            draggable
            data-dragging={dragId === w.id || undefined}
            data-drop={dropId === w.id || undefined}
            onDragStart={(e) => { setDragId(w.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragEnd={() => { setDragId(null); setDropId(undefined); }}
            onDragOver={(e) => { if (dragId && dragId !== w.id) { e.preventDefault(); setDropId(w.id); } }}
            onDragLeave={() => setDropId((cur) => (cur === w.id ? undefined : cur))}
            onDrop={(e) => { e.preventDefault(); drop(w.id); }}>
            <a href={`/workspace/?id=${w.id}`} className="et-ws">
              <span className="et-ws-dot" data-type={w.type} />
              {w.title}
            </a>
            <button className="et-ws-add" title="Add sub-workspace"
              onClick={(e) => { e.preventDefault(); setTitle(""); setCreating(w.id); }}>+</button>
          </div>
          {renderTree(w.id, depth + 1)}
          {creating === w.id && newInput(w.id, depth + 1)}
        </div>
      ))}
    </>
  );

  return (
    <aside className="et-spine">
      <a href="/" className="et-brand" aria-label="et al. home">
        <span className="serif">et al.</span><span className="et-amp">&amp;</span>
      </a>

      <nav className="et-nav">
        {NAV.map((n) => (
          <a key={n.href} href={n.href} className="et-nav-item"
            {...((n.href === "/" ? pathname === "/" : pathname.startsWith(n.href)) ? { "data-active": true } : {})}>
            {n.label}
          </a>
        ))}
      </nav>

      <div className="et-spine-label eyebrow">
        Workspaces
        <button className="et-ws-add-root" title="New workspace" onClick={() => { setTitle(""); setCreating(null); }}>+</button>
      </div>
      <div className="et-tree">
        {renderTree(null, 0)}
        {creating === null && newInput(null, 0)}
      </div>

      <style>{`
        .et-spine {
          border-right: 1px solid var(--line);
          padding: 1.4rem 0.7rem 2rem;
          display: flex; flex-direction: column; gap: 0.35rem;
          position: sticky; top: 0; height: 100vh; overflow-y: auto;
          background: var(--paper);
        }
        .et-brand {
          display: flex; align-items: baseline; gap: 0.15rem;
          text-decoration: none; color: var(--ink);
          font-size: 1.5rem; padding: 0 0.5rem 0.4rem; letter-spacing: -0.02em;
        }
        .et-amp { color: var(--color-iris); font-family: var(--font-display); font-size: 1.5rem; }
        .et-nav { display: flex; flex-direction: column; margin: 0.6rem 0 0.4rem; }
        .et-nav-item {
          text-decoration: none; color: var(--ink-soft);
          padding: 0.32rem 0.6rem; border-radius: 6px; font-size: 0.9rem;
          transition: background 0.12s, color 0.12s;
        }
        .et-nav-item:hover { background: var(--paper-raised); color: var(--ink); }
        .et-nav-item[data-active] { color: var(--ink); font-weight: 500; background: var(--color-iris-soft); }
        @media (prefers-color-scheme: dark) { .et-nav-item[data-active] { background: color-mix(in srgb, var(--color-iris) 22%, transparent); } }
        .et-spine-label { padding: 0.9rem 0.6rem 0.4rem; display: flex; align-items: center; justify-content: space-between; }
        .et-tree { display: flex; flex-direction: column; }
        .et-ws-row { display: flex; align-items: center; }
        .et-ws {
          flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.5rem;
          text-decoration: none; color: var(--ink-soft);
          padding: 0.26rem 0.6rem; border-radius: 6px; font-size: 0.88rem;
          transition: background 0.12s, color 0.12s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .et-ws:hover { background: var(--paper-raised); color: var(--ink); }
        .et-ws-add, .et-ws-add-root { background: none; border: none; color: var(--ink-faint); font-size: 1rem; line-height: 1; cursor: pointer; padding: 0 0.4rem; border-radius: 5px; }
        .et-ws-add { opacity: 0; }
        .et-ws-row:hover .et-ws-add { opacity: 1; }
        .et-ws-add:hover, .et-ws-add-root:hover { color: var(--color-iris); background: var(--paper-raised); }
        .et-ws-new { padding: 0.2rem 0.6rem; display: flex; gap: 0.3rem; }
        .et-ws-new input { flex: 1; min-width: 0; background: var(--paper-raised); border: 1px solid var(--color-iris); border-radius: 6px; padding: 0.28rem 0.5rem; font: inherit; font-size: 0.86rem; color: var(--ink); }
        .et-ws-new input:focus { outline: none; }
        .et-ws-new select { background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 6px; font: inherit; font-size: 0.75rem; color: var(--ink-soft); padding: 0 0.1rem; }
        .et-ws-row { border-radius: 6px; }
        .et-ws-row[data-drop="true"] { background: var(--color-iris-soft); box-shadow: inset 0 0 0 1px var(--color-iris); }
        .et-ws-row[data-dragging="true"] { opacity: 0.4; }
        .et-ws { cursor: grab; }
        .et-spine-label[data-drop="true"] { color: var(--color-iris); }
        .et-ws-dot { width: 6px; height: 6px; border-radius: 2px; background: var(--ink-faint); flex: none; }
        .et-ws-dot[data-type="project"] { background: var(--color-iris); }
        .et-ws-dot[data-type="area"] { background: var(--color-sage); }
        .et-ws-dot[data-type="course"] { background: var(--color-amber); }
      `}</style>
    </aside>
  );
}
