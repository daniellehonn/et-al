"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
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

  // Collapsible rail — persisted across sessions. Desktop only; on mobile the
  // rail is an off-canvas drawer driven by `drawer` instead.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(localStorage.getItem("et-spine-collapsed") === "1"); }, []);

  // Mobile drawer. Never persisted — it should always start closed, and it
  // closes on navigation so a tapped workspace link doesn't leave it covering
  // the page it just opened.
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [pathname]);
  useEffect(() => {
    // Lock the page behind the drawer so touch-scrolling doesn't move both.
    document.body.style.overflow = drawer ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [drawer]);
  const toggleCollapsed = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem("et-spine-collapsed", n ? "1" : "0"); } catch { /* ignore */ } return n; });

  // Which tree nodes are collapsed (default: everything expanded). Persisted.
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
  useEffect(() => { try { setCollapsedNodes(new Set(JSON.parse(localStorage.getItem("et-tree-collapsed") || "[]"))); } catch { /* ignore */ } }, []);
  const toggleNode = (wid: string) => setCollapsedNodes((prev) => {
    const n = new Set(prev); n.has(wid) ? n.delete(wid) : n.add(wid);
    try { localStorage.setItem("et-tree-collapsed", JSON.stringify([...n])); } catch { /* ignore */ }
    return n;
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
  const byId = new Map<string, Workspace>();
  for (const w of workspaces ?? []) {
    byId.set(w.id, w);
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
      {(byParent.get(parent) ?? []).map((w) => {
        const hasKids = (byParent.get(w.id) ?? []).length > 0;
        const open = !collapsedNodes.has(w.id);
        return (
        <div key={w.id}>
          <div className="et-ws-row" style={{ paddingLeft: `${depth * 0.85 + 0.3}rem` }}
            draggable
            data-dragging={dragId === w.id || undefined}
            data-drop={dropId === w.id || undefined}
            onDragStart={(e) => { setDragId(w.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragEnd={() => { setDragId(null); setDropId(undefined); }}
            onDragOver={(e) => { if (dragId && dragId !== w.id) { e.preventDefault(); setDropId(w.id); } }}
            onDragLeave={() => setDropId((cur) => (cur === w.id ? undefined : cur))}
            onDrop={(e) => { e.preventDefault(); drop(w.id); }}>
            {hasKids
              ? <button className="et-ws-caret" onClick={(e) => { e.preventDefault(); toggleNode(w.id); }} aria-label={open ? "Collapse" : "Expand"}>{open ? "▾" : "▸"}</button>
              : <span className="et-ws-caret et-ws-caret-empty" />}
            {/* Closes the drawer explicitly: workspace links only vary by query
                string, so the pathname-driven close above never fires for them. */}
            <a href={`/workspace/?id=${w.id}`} className="et-ws" onClick={() => setDrawer(false)}>
              {w.icon ? <span className="et-ws-icon">{w.icon}</span> : <span className="et-ws-dot" data-type={w.type} />}
              {w.title}
            </a>
            <button className="et-ws-add" title="Add sub-workspace"
              onClick={(e) => { e.preventDefault(); setTitle(""); setCreating(w.id); }}>+</button>
          </div>
          {hasKids && open && renderTree(w.id, depth + 1)}
          {creating === w.id && newInput(w.id, depth + 1)}
        </div>
        );
      })}
    </>
  );

  // The mobile header — hidden above the breakpoint by CSS. It is the only way
  // to reach the workspace tree on a phone, so it renders in both rail states.
  const mobileBar = (
    <header className="et-mobilebar">
      <button className="et-burger" onClick={() => setDrawer(true)} aria-label="Open navigation" aria-expanded={drawer}>
        <span /><span /><span />
      </button>
      <a href="/" className="et-mobilebrand" aria-label="et al. home">
        <span className="serif">et al.</span><span className="et-amp">&amp;</span>
      </a>
    </header>
  );

  // Tapping the scrim is the primary dismiss gesture on touch.
  const scrim = drawer ? <div className="et-scrim" onClick={() => setDrawer(false)} aria-hidden /> : null;

  // One rail, always fully rendered. `data-collapsed` is a purely presentational
  // desktop state that CSS narrows to an icon strip; below the breakpoint the
  // media query undoes it, so a rail collapsed on desktop still opens as a full
  // drawer on a phone without duplicating this markup.
  return (
    <>
    {mobileBar}
    {scrim}
    <aside className="et-spine" data-collapsed={collapsed || undefined} data-drawer={drawer || undefined}>
      <div className="et-spine-top">
        <a href="/" className="et-brand" aria-label="et al. home">
          <span className="serif">et al.</span><span className="et-amp">&amp;</span>
        </a>
        <a href="/" className="et-amp-only serif" aria-label="et al. home">&amp;</a>
        <button className="et-collapse" onClick={toggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>{collapsed ? "»" : "«"}</button>
        <button className="et-drawer-close" onClick={() => setDrawer(false)} aria-label="Close navigation">×</button>
      </div>

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
        {/* Appears only while dragging: drop here to pull a workspace out to root. */}
        {dragId && (byId.get(dragId)?.parent_id) && (
          <div className="et-root-drop" data-drop={dropId === null || undefined}
            onDragOver={(e) => { e.preventDefault(); setDropId(null); }}
            onDragLeave={() => setDropId((cur) => (cur === null ? undefined : cur))}
            onDrop={(e) => { e.preventDefault(); drop(null); }}>
            ↑ Move to top level
          </div>
        )}
        {renderTree(null, 0)}
        {creating === null && newInput(null, 0)}
      </div>

      <style>{spineCss}</style>
    </aside>
    </>
  );
}

const spineCss = `
        .et-spine {
          width: 15rem;
          border-right: 1px solid var(--line);
          padding: 1.4rem 0.7rem 2rem;
          display: flex; flex-direction: column; gap: 0.35rem;
          position: sticky; top: 0; height: 100vh; overflow-y: auto;
          background: var(--paper);
        }
        /* Collapsed: an icon strip. Everything but the mark and the toggle is
           hidden rather than unmounted, so mobile can restore it (see below). */
        .et-spine[data-collapsed] { width: 3rem; padding: 1.4rem 0.4rem; align-items: center; gap: 0.8rem; }
        .et-spine[data-collapsed] .et-spine-top { flex-direction: column-reverse; gap: 0.6rem; }
        .et-spine[data-collapsed] .et-brand,
        .et-spine[data-collapsed] .et-nav,
        .et-spine[data-collapsed] .et-spine-label,
        .et-spine[data-collapsed] .et-tree { display: none; }
        .et-spine-top { display: flex; align-items: center; justify-content: space-between; }
        .et-amp-only, .et-drawer-close { display: none; }
        .et-spine[data-collapsed] .et-amp-only { display: block; }
        .et-collapse { background: none; border: none; color: var(--ink-faint); font-size: 1.05rem; line-height: 1; cursor: pointer; padding: 0.1rem 0.35rem; border-radius: 6px; }
        .et-collapse:hover { color: var(--ink); background: var(--paper-raised); }
        .et-amp-only { color: var(--color-iris); font-size: 1.5rem; text-decoration: none; }
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
        .et-ws-caret { background: none; border: none; color: var(--ink-faint); cursor: pointer; font-size: 0.58rem; line-height: 1; width: 1rem; flex: none; padding: 0.2rem 0; text-align: center; border-radius: 4px; }
        .et-ws-caret:hover { color: var(--ink); background: var(--paper-raised); }
        .et-ws-caret-empty { visibility: hidden; cursor: default; }
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
        .et-root-drop { margin: 0 0.6rem 0.4rem; padding: 0.4rem 0.6rem; border: 1px dashed var(--line-strong); border-radius: 7px; font-size: 0.8rem; color: var(--ink-faint); text-align: center; }
        .et-root-drop[data-drop="true"] { border-color: var(--color-iris); border-style: solid; background: var(--color-iris-soft); color: var(--color-iris); }
        .et-ws-row { border-radius: 6px; }
        .et-ws-row[data-drop="true"] { background: var(--color-iris-soft); box-shadow: inset 0 0 0 1px var(--color-iris); }
        .et-ws-row[data-dragging="true"] { opacity: 0.4; }
        .et-ws { cursor: grab; }
        .et-spine-label[data-drop="true"] { color: var(--color-iris); }
        .et-ws-icon { font-size: 0.92rem; line-height: 1; flex: none; width: 1.05rem; text-align: center; margin-right: 0.1rem; }
        .et-ws-dot { width: 6px; height: 6px; border-radius: 2px; background: var(--ink-faint); flex: none; }
        .et-ws-dot[data-type="project"] { background: var(--color-iris); }
        .et-ws-dot[data-type="area"] { background: var(--color-sage); }
        .et-ws-dot[data-type="course"] { background: var(--color-amber); }

        /* ── Mobile: the rail becomes an off-canvas drawer ──────────────────── */
        .et-mobilebar, .et-scrim { display: none; }

        @media (max-width: 860px) {
          .et-mobilebar {
            display: flex; align-items: center; gap: 0.7rem;
            position: sticky; top: 0; z-index: 40;
            padding: 0.55rem 0.9rem; padding-top: max(0.55rem, env(safe-area-inset-top));
            background: color-mix(in srgb, var(--paper) 88%, transparent);
            backdrop-filter: blur(10px);
            border-bottom: 1px solid var(--line);
          }
          .et-mobilebrand { display: flex; align-items: baseline; gap: 0.15rem; text-decoration: none; color: var(--ink); font-size: 1.2rem; letter-spacing: -0.02em; }
          .et-burger {
            display: flex; flex-direction: column; justify-content: center; gap: 4px;
            width: 40px; height: 40px; margin-left: -0.5rem; padding: 0 0.6rem;
            background: none; border: none; cursor: pointer; border-radius: 8px;
          }
          .et-burger span { display: block; height: 1.5px; width: 100%; background: var(--ink-soft); border-radius: 2px; }

          .et-scrim { display: block; position: fixed; inset: 0; z-index: 49; background: rgba(0,0,0,0.42); }

          /* Always the full rail on mobile, regardless of the desktop collapse. */
          .et-spine, .et-spine[data-collapsed] {
            position: fixed; top: 0; left: 0; bottom: 0; z-index: 50;
            width: min(19rem, 84vw); height: 100dvh;
            padding: 1.1rem 0.7rem calc(2rem + env(safe-area-inset-bottom));
            align-items: stretch; gap: 0.35rem;
            transform: translateX(-100%); transition: transform 0.22s ease;
            box-shadow: 0 0 40px rgba(0,0,0,0.18);
            overscroll-behavior: contain;
          }
          .et-spine[data-drawer], .et-spine[data-collapsed][data-drawer] { transform: translateX(0); }
          .et-spine[data-collapsed] .et-spine-top { flex-direction: row; }
          .et-spine[data-collapsed] .et-brand,
          .et-spine[data-collapsed] .et-nav,
          .et-spine[data-collapsed] .et-spine-label,
          .et-spine[data-collapsed] .et-tree { display: flex; }
          .et-spine[data-collapsed] .et-spine-label { display: flex; }

          /* The desktop collapse toggle is meaningless here; offer close instead. */
          .et-collapse, .et-spine[data-collapsed] .et-amp-only { display: none; }
          .et-drawer-close { display: block; background: none; border: none; color: var(--ink-faint); font-size: 1.6rem; line-height: 1; cursor: pointer; padding: 0 0.4rem; }

          /* Touch targets: the tree is the densest surface in the app. */
          .et-ws { padding: 0.55rem 0.6rem; font-size: 0.95rem; }
          .et-ws-caret { width: 1.8rem; padding: 0.5rem 0; font-size: 0.7rem; }
          .et-nav-item { padding: 0.55rem 0.6rem; font-size: 0.98rem; }
          .et-ws-add { opacity: 1; padding: 0.35rem 0.5rem; }
          .et-ws-new input, .et-ws-new select { font-size: 16px; }
        }

        @media (prefers-reduced-motion: reduce) { .et-spine { transition: none; } }
`;
