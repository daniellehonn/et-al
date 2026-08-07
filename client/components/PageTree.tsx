"use client";
// The sidebar: one nestable page tree, which is the whole navigation model now.
// v7 had a workspace spine plus per-workspace tabs plus separate Knowledge and
// Inbox screens — four ways of getting somewhere. There is one now.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type PageNode } from "@/lib/api";
import { TrashPanel } from "./PageMenu";

export function PageTree() {
  const qc = useQueryClient();
  // Drag state lives at the tree root so a drag can cross between branches.
  const [dragId, setDragId] = useState<string | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  // The tree lives in the layout, so it cannot be handed the current page as a
  // prop. Read it from the URL instead — these routes are statically exported,
  // and useSearchParams would force a Suspense boundary around the whole shell.
  const [activeId, setActiveId] = useState<string | undefined>();
  useEffect(() => {
    const read = () => setActiveId(new URLSearchParams(window.location.search).get("id") ?? undefined);
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const { data: tree } = useQuery({ queryKey: ["tree"], queryFn: () => api.get<PageNode[]>("/tree") });

  const addRoot = async () => {
    const page = await api.post<{ id: string }>("/pages", { title: "Untitled" });
    qc.invalidateQueries({ queryKey: ["tree"] });
    window.location.href = `/page/?id=${page.id}`;
  };

  return (
    <nav className="et-tree">
      <a className="et-tree-home" href="/">et al.</a>
      <div className="et-tree-body"
        // Dropping on the empty space below the tree promotes a page to a root.
        onDragOver={(e) => { if (dragId) e.preventDefault(); }}
        onDrop={async (e) => {
          if (!dragId || e.defaultPrevented) return;
          await api.post(`/pages/${dragId}/move`, { new_parent_page_id: null });
          setDragId(null);
          qc.invalidateQueries({ queryKey: ["tree"] });
        }}>
        {(tree ?? []).map((n) => (
          <TreeNode key={n.id} node={n} depth={0} activeId={activeId} dragId={dragId} setDragId={setDragId} />
        ))}
      </div>
      <button className="et-tree-new" onClick={addRoot}>+ New page</button>
      <a className="et-tree-link" href="/tasks/">Tasks</a>
      <a className="et-tree-link" href="/search/">Search</a>
      <button className="et-tree-new" onClick={() => setShowTrash((v) => !v)}>Trash</button>
      {showTrash && <TrashPanel onDone={() => setShowTrash(false)} />}
      <TreeStyles />
    </nav>
  );
}

function TreeNode({ node, depth, activeId, dragId, setDragId }: {
  node: PageNode; depth: number; activeId?: string;
  dragId: string | null; setDragId: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  // "inside" nests under this page; "before"/"after" reorder among its siblings.
  const [dropAt, setDropAt] = useState<"inside" | "before" | "after" | null>(null);
  // Ancestors of the active page start open, so deep-linking to a nested page
  // does not land you in a sidebar that looks collapsed and empty.
  const [open, setOpen] = useState(() => depth === 0 || contains(node, activeId));
  const hasKids = node.children.length > 0;

  const addChild = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const page = await api.post<{ id: string }>("/pages", { parent_page_id: node.id, title: "Untitled" });
    qc.invalidateQueries({ queryKey: ["tree"] });
    setOpen(true);
    window.location.href = `/page/?id=${page.id}`;
  };

  const rename = async (e: React.MouseEvent) => {
    e.preventDefault();
    (e.currentTarget.closest("details") as HTMLDetailsElement).open = false;
    const title = prompt("Rename page", node.title);
    if (title == null) return;
    await api.patch(`/pages/${node.id}`, { title });
    qc.invalidateQueries({ queryKey: ["tree"] });
    qc.invalidateQueries({ queryKey: ["page", node.id] });
  };

  // Deleting a page takes everything under it, so the count is spelled out
  // rather than left as a generic "are you sure?".
  const remove = async (e: React.MouseEvent) => {
    e.preventDefault();
    (e.currentTarget.closest("details") as HTMLDetailsElement).open = false;
    const kids = countDescendants(node);
    const detail = kids ? ` and ${kids} page${kids === 1 ? "" : "s"} inside it` : "";
    if (!confirm(`Delete "${node.title || "Untitled"}"${detail}? This cannot be undone.`)) return;
    await api.del(`/pages/${node.id}`);
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
            ? { new_parent_page_id: node.id }
            // Sitting beside this node means sharing its parent; the position is
            // nudged off this node's own so the order is unambiguous.
            : { new_parent_page_id: node.parent_page_id, position: node.position + (where === "before" ? -0.5 : 0.5) };
          try {
            await api.post(`/pages/${dragId}/move`, body);
          } catch (err) {
            // The server refuses a move that would make a page its own ancestor.
            alert(err instanceof Error ? err.message : "Could not move that page");
          }
          setDragId(null);
          qc.invalidateQueries({ queryKey: ["tree"] });
        }}
        style={{ paddingLeft: `${0.4 + depth * 0.85}rem` }}>
        <button className="et-tree-caret" data-has={hasKids} aria-label={open ? "Collapse" : "Expand"}
          onClick={() => setOpen((v) => !v)}>{hasKids ? (open ? "▾" : "▸") : "·"}</button>
        <a className="et-tree-name" href={`/page/?id=${node.id}`}>
          <span className="et-tree-icon">{node.icon ?? "📄"}</span>
          <span className="et-tree-label">{node.title || "Untitled"}</span>
        </a>
        <button className="et-tree-add" title="Add a page inside" onClick={addChild}>+</button>
        <details className="et-tree-menu">
          <summary title="Page options" aria-label="Page options">···</summary>
          <div className="et-tree-menu-list">
            <button onClick={rename}>Rename</button>
            <button className="et-tree-del" onClick={remove}>Delete</button>
          </div>
        </details>
      </div>
      {open && node.children.map((k) => (
        <TreeNode key={k.id} node={k} depth={depth + 1} activeId={activeId} dragId={dragId} setDragId={setDragId} />
      ))}
    </div>
  );
}

function countDescendants(node: PageNode): number {
  return node.children.reduce((n, k) => n + 1 + countDescendants(k), 0);
}

function contains(node: PageNode, id?: string): boolean {
  if (!id) return false;
  return node.children.some((k) => k.id === id || contains(k, id));
}

function TreeStyles() {
  return (
    <style jsx global>{`
      .et-tree { width: 15rem; min-width: 15rem; border-right: 1px solid var(--rule); height: 100vh; position: sticky; top: 0; display: flex; flex-direction: column; padding: 0.7rem 0.3rem; gap: 0.2rem; overflow: hidden; background: var(--surface-2); }
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
      .et-tree-icon { flex: none; }
      /* Long page names truncate rather than widening the sidebar. */
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
      .et-tree-new:hover, .et-tree-link:hover { background: var(--surface-3, rgba(128,128,128,0.12)); color: var(--ink); }
    `}</style>
  );
}
