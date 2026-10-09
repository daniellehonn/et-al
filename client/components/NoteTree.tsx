"use client";
// The sidebar: the note tree, plus the three other places — inbox, tasks, search.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type NoteNode, type Proposal } from "@/lib/api";
import { TrashPanel } from "./NoteMenu";

export function NoteTree() {
  const qc = useQueryClient();
  // Drag state lives at the tree root so a drag can cross between branches.
  const [dragId, setDragId] = useState<string | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  // The tree lives in the layout, so it cannot be handed the current note as a
  // prop. Read it from the URL instead — these routes are statically exported,
  // and useSearchParams would force a Suspense boundary around the whole shell.
  const [activeId, setActiveId] = useState<string | undefined>();
  useEffect(() => {
    const read = () => setActiveId(new URLSearchParams(window.location.search).get("id") ?? undefined);
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const { data: tree } = useQuery({ queryKey: ["tree"], queryFn: () => api.get<NoteNode[]>("/notes/tree") });
  const { data: pending } = useQuery({ queryKey: ["proposals"], queryFn: () => api.get<Proposal[]>("/proposals"), refetchInterval: 30000 });

  // Below 860px the tree is an off-canvas drawer rather than a column. It used
  // to be one when the sidebar was Spine.tsx; the replacement dropped it, which
  // left a 240px-wide full-height block sitting on top of every phone screen.
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setNavOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  const addRoot = async () => {
    const note = await api.post<{ id: string }>("/notes", { title: "Untitled" });
    qc.invalidateQueries({ queryKey: ["tree"] });
    window.location.href = `/note/?id=${note.id}`;
  };

  return (
    <>
      {/* Hidden above the breakpoint; the drawer's only way open on a phone. */}
      <button className="et-tree-toggle" aria-label="Menu" aria-expanded={navOpen}
        onClick={() => setNavOpen((v) => !v)}>{navOpen ? "✕" : "☰"}</button>
      {navOpen && <div className="et-tree-scrim" onClick={() => setNavOpen(false)} />}
    <nav className="et-tree" data-open={navOpen ? "" : undefined}>
      <a className="et-tree-home" href="/">et al.</a>
      <div className="et-tree-body"
        // Dropping on the empty space below the tree promotes a note to a root.
        onDragOver={(e) => { if (dragId) e.preventDefault(); }}
        onDrop={async (e) => {
          if (!dragId || e.defaultPrevented) return;
          await api.post(`/notes/${dragId}/move`, { parent_id: null });
          setDragId(null);
          qc.invalidateQueries({ queryKey: ["tree"] });
        }}>
        {(tree ?? []).map((n) => (
          <TreeNode key={n.id} node={n} depth={0} activeId={activeId} dragId={dragId} setDragId={setDragId} />
        ))}
      </div>
      <button className="et-tree-new" onClick={addRoot}>+ New note</button>
      <a className="et-tree-link" href="/review/">Review{!!pending?.length && <span className="et-tree-count">{pending.length}</span>}</a>
      <a className="et-tree-link" href="/inbox/">Inbox</a>
      <a className="et-tree-link" href="/tasks/">Tasks</a>
      <a className="et-tree-link" href="/search/">Search</a>
      <button className="et-tree-new" onClick={() => setShowTrash((v) => !v)}>Trash</button>
      {showTrash && <TrashPanel onDone={() => setShowTrash(false)} />}
      <TreeStyles />
    </nav>
    </>
  );
}

function TreeNode({ node, depth, activeId, dragId, setDragId }: {
  node: NoteNode; depth: number; activeId?: string;
  dragId: string | null; setDragId: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  // "inside" nests under this page; "before"/"after" reorder among its siblings.
  const [dropAt, setDropAt] = useState<"inside" | "before" | "after" | null>(null);
  // Ancestors of the active note start open, so deep-linking to a nested note
  // does not land you in a sidebar that looks collapsed and empty.
  const [open, setOpen] = useState(() => depth === 0 || contains(node, activeId));
  const hasKids = node.children.length > 0;

  const addChild = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const note = await api.post<{ id: string }>("/notes", { parent_id: node.id, title: "Untitled" });
    qc.invalidateQueries({ queryKey: ["tree"] });
    setOpen(true);
    window.location.href = `/note/?id=${note.id}`;
  };

  const rename = async (e: React.MouseEvent) => {
    e.preventDefault();
    (e.currentTarget.closest("details") as HTMLDetailsElement).open = false;
    const title = prompt("Rename note", node.title);
    if (title == null) return;
    await api.patch(`/notes/${node.id}`, { title });
    qc.invalidateQueries({ queryKey: ["tree"] });
    qc.invalidateQueries({ queryKey: ["note", node.id] });
  };

  // Trashing a note takes everything under it, so the count is spelled out
  // rather than left as a generic "are you sure?".
  const remove = async (e: React.MouseEvent) => {
    e.preventDefault();
    (e.currentTarget.closest("details") as HTMLDetailsElement).open = false;
    const kids = countDescendants(node);
    const detail = kids ? ` and ${kids} note${kids === 1 ? "" : "s"} inside it` : "";
    if (!confirm(`Move "${node.title || "Untitled"}"${detail} to the trash?`)) return;
    await api.del(`/notes/${node.id}`);
    qc.invalidateQueries({ queryKey: ["tree"] });
    if (node.id === activeId) window.location.href = "/";
  };

  return (
    <div className="et-tree-node">
      <div className="et-tree-row" data-active={node.id === activeId} data-drop={dropAt ?? undefined}
        draggable
        onDragStart={(e) => { e.stopPropagation(); setDragId(node.id); }}
        onDragEnd={() => { setDragId(null); setDropAt(null); }}
        onDragOver={(e) => {
          if (!dragId || dragId === node.id) return;
          e.preventDefault();
          e.stopPropagation();
          // The top and bottom quarters reorder; the middle nests. Without the
          // bands there is no way to express "put it next to" versus "put it in".
          const box = e.currentTarget.getBoundingClientRect();
          const y = (e.clientY - box.top) / box.height;
          setDropAt(y < 0.25 ? "before" : y > 0.75 ? "after" : "inside");
        }}
        onDragLeave={() => setDropAt(null)}
        onDrop={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const where = dropAt;
          setDropAt(null);
          if (!dragId || dragId === node.id || !where) return;
          const body = where === "inside"
            ? { parent_id: node.id }
            // Sitting beside this node means sharing its parent; the position is
            // nudged off this node's own so the order is unambiguous.
            : { parent_id: node.parent_id, position: node.position + (where === "before" ? -0.5 : 0.5) };
          try {
            await api.post(`/notes/${dragId}/move`, body);
          } catch (err) {
            // The server refuses a move that would make a note its own ancestor.
            alert(err instanceof Error ? err.message : "Could not move that note");
          }
          setDragId(null);
          qc.invalidateQueries({ queryKey: ["tree"] });
        }}
        style={{ paddingLeft: `${0.4 + depth * 0.85}rem` }}>
        <button className="et-tree-caret" data-has={hasKids} aria-label={open ? "Collapse" : "Expand"}
          onClick={() => setOpen((v) => !v)}>{hasKids ? (open ? "▾" : "▸") : "·"}</button>
        <a className="et-tree-name" href={`/note/?id=${node.id}`}>
          <span className="et-tree-label">{node.title || "Untitled"}</span>
        </a>
        <button className="et-tree-add" title="Add a note inside" onClick={addChild}>+</button>
        <details className="et-tree-menu">
          <summary title="Note options" aria-label="Note options">···</summary>
          <div className="et-tree-menu-list">
            <button onClick={rename}>Rename</button>
            <button className="et-tree-del" onClick={remove}>Move to trash</button>
          </div>
        </details>
      </div>
      {open && node.children.map((k) => (
        <TreeNode key={k.id} node={k} depth={depth + 1} activeId={activeId} dragId={dragId} setDragId={setDragId} />
      ))}
    </div>
  );
}

function countDescendants(node: NoteNode): number {
  return node.children.reduce((n, k) => n + 1 + countDescendants(k), 0);
}

function contains(node: NoteNode, id?: string): boolean {
  if (!id) return false;
  return node.children.some((k) => k.id === id || contains(k, id));
}

function TreeStyles() {
  return (
    <style jsx global>{`
      .et-tree { width: 15rem; min-width: 15rem; border-right: 1px solid var(--rule); height: 100vh; position: sticky; top: 0; display: flex; flex-direction: column; padding: 0.7rem 0.3rem; gap: 0.2rem; overflow: hidden; background: var(--surface-2); }
      /* Desktop: no toggle, no scrim. */
      .et-tree-toggle { display: none; }
      .et-tree-scrim { display: none; }

      @media (max-width: 860px) {
        /* Out of flow entirely, so main gets the whole width. */
        .et-tree { position: fixed; top: 0; left: 0; z-index: 70; height: 100dvh;
          transform: translateX(-100%); transition: transform 0.22s ease;
          box-shadow: 0 0 24px rgba(0,0,0,0.18); }
        .et-tree[data-open] { transform: none; }
        .et-tree-toggle { display: flex; align-items: center; justify-content: center;
          position: fixed; top: 0.55rem; left: 0.55rem; z-index: 80;
          width: 2.1rem; height: 2.1rem; border-radius: 8px; cursor: pointer;
          border: 1px solid var(--rule); background: var(--surface-2); color: var(--ink);
          font-size: 0.95rem; line-height: 1; padding: 0; }
        .et-tree-scrim { display: block; position: fixed; inset: 0; z-index: 65;
          background: rgba(0,0,0,0.35); }
      }
      @media (prefers-reduced-motion: reduce) { .et-tree { transition: none; } }

      .et-tree-home { font-weight: 600; padding: 0.2rem 0.6rem 0.6rem; color: var(--ink); text-decoration: none; }
      .et-tree-body { flex: 1; min-height: 0; overflow-y: auto; }
      .et-tree-row { display: flex; align-items: center; gap: 0.15rem; border-radius: 5px; padding-right: 0.25rem; }
      .et-tree-row:hover { background: var(--surface-3, rgba(128,128,128,0.12)); }
      .et-tree-row[data-active="true"] { background: var(--surface-3, rgba(128,128,128,0.18)); font-weight: 500; }
      .et-tree-row[data-drop="inside"] { background: var(--color-iris-soft); box-shadow: inset 0 0 0 1px var(--color-iris); }
      .et-tree-row[data-drop="before"] { box-shadow: inset 0 2px 0 0 var(--color-iris); }
      .et-tree-row[data-drop="after"] { box-shadow: inset 0 -2px 0 0 var(--color-iris); }
      .et-tree-caret { background: none; border: none; color: var(--ink-faint); cursor: pointer; width: 1.1rem; font-size: 0.7rem; padding: 0; }
      .et-tree-caret[data-has="false"] { opacity: 0.25; cursor: default; }
      .et-tree-name { flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.35rem; padding: 0.3rem 0; color: inherit; text-decoration: none; font-size: 0.88rem; }
            /* Long titles truncate rather than widening the sidebar. */
      .et-tree-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .et-tree-add { opacity: 0; background: none; border: none; color: var(--ink-faint); cursor: pointer; font-size: 0.9rem; padding: 0 0.2rem; }
      .et-tree-row:hover .et-tree-add, .et-tree-row:hover .et-tree-menu { opacity: 1; }
      .et-tree-menu { opacity: 0; position: relative; }
      .et-tree-menu summary { list-style: none; cursor: pointer; color: var(--ink-faint); font-size: 0.85rem; padding: 0 0.15rem; }
      .et-tree-menu summary::-webkit-details-marker { display: none; }
      .et-tree-menu[open] { opacity: 1; }
      .et-tree-menu-list { position: absolute; z-index: 40; right: 0; top: 1.3rem; background: var(--paper-raised); border: 1px solid var(--line-strong); border-radius: 8px; padding: 0.25rem; display: flex; flex-direction: column; min-width: 8rem; box-shadow: 0 8px 24px rgba(0,0,0,0.16); }
      .et-tree-menu-list button { text-align: left; background: none; border: none; font: inherit; font-size: 0.85rem; color: var(--ink-soft); padding: 0.32rem 0.5rem; border-radius: 5px; cursor: pointer; }
      .et-tree-menu-list button:hover { background: var(--color-iris-soft); color: var(--ink); }
      .et-tree-del:hover { color: var(--color-rust, #b4462e); }
      .et-tree-new, .et-tree-link { background: none; border: none; text-align: left; font: inherit; font-size: 0.85rem; color: var(--ink-faint); cursor: pointer; padding: 0.35rem 0.6rem; text-decoration: none; border-radius: 5px; }
      .et-tree-count { margin-left: 0.4rem; font-family: var(--font-mono); font-size: 0.7rem; color: #fff; background: var(--color-iris); border-radius: 99px; padding: 0 0.4rem; }
      .et-tree-new:hover, .et-tree-link:hover { background: var(--surface-3, rgba(128,128,128,0.12)); color: var(--ink); }
    `}</style>
  );
}
