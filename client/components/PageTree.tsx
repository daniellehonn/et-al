"use client";
// The sidebar: one nestable page tree, which is the whole navigation model now.
// v7 had a workspace spine plus per-workspace tabs plus separate Knowledge and
// Inbox screens — four ways of getting somewhere. There is one now.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type PageNode } from "@/lib/api";

export function PageTree({ activeId }: { activeId?: string }) {
  const qc = useQueryClient();
  const { data: tree } = useQuery({ queryKey: ["tree"], queryFn: () => api.get<PageNode[]>("/tree") });

  const addRoot = async () => {
    const page = await api.post<{ id: string }>("/pages", { title: "Untitled" });
    qc.invalidateQueries({ queryKey: ["tree"] });
    window.location.href = `/page/?id=${page.id}`;
  };

  return (
    <nav className="et-tree">
      <a className="et-tree-home" href="/">et al.</a>
      <div className="et-tree-body">
        {(tree ?? []).map((n) => <TreeNode key={n.id} node={n} depth={0} activeId={activeId} />)}
      </div>
      <button className="et-tree-new" onClick={addRoot}>+ New page</button>
      <a className="et-tree-link" href="/search/">Search</a>
      <TreeStyles />
    </nav>
  );
}

function TreeNode({ node, depth, activeId }: { node: PageNode; depth: number; activeId?: string }) {
  const qc = useQueryClient();
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

  return (
    <div className="et-tree-node">
      <div className="et-tree-row" data-active={node.id === activeId} style={{ paddingLeft: `${0.4 + depth * 0.85}rem` }}>
        <button className="et-tree-caret" data-has={hasKids} aria-label={open ? "Collapse" : "Expand"}
          onClick={() => setOpen((v) => !v)}>{hasKids ? (open ? "▾" : "▸") : "·"}</button>
        <a className="et-tree-name" href={`/page/?id=${node.id}`}>
          <span className="et-tree-icon">{node.icon ?? "📄"}</span>
          <span className="et-tree-label">{node.title || "Untitled"}</span>
        </a>
        <button className="et-tree-add" title="Add a page inside" onClick={addChild}>+</button>
      </div>
      {open && node.children.map((k) => <TreeNode key={k.id} node={k} depth={depth + 1} activeId={activeId} />)}
    </div>
  );
}

function contains(node: PageNode, id?: string): boolean {
  if (!id) return false;
  return node.children.some((k) => k.id === id || contains(k, id));
}

function TreeStyles() {
  return (
    <style jsx global>{`
      .et-tree { width: 15rem; min-width: 15rem; border-right: 1px solid var(--rule); height: 100vh; position: sticky; top: 0; display: flex; flex-direction: column; padding: 0.7rem 0.3rem; gap: 0.2rem; overflow-y: auto; background: var(--surface-2); }
      .et-tree-home { font-weight: 600; padding: 0.2rem 0.6rem 0.6rem; color: var(--ink); text-decoration: none; }
      .et-tree-body { flex: 1; min-height: 0; }
      .et-tree-row { display: flex; align-items: center; gap: 0.15rem; border-radius: 5px; padding-right: 0.25rem; }
      .et-tree-row:hover { background: var(--surface-3, rgba(128,128,128,0.12)); }
      .et-tree-row[data-active="true"] { background: var(--surface-3, rgba(128,128,128,0.18)); font-weight: 500; }
      .et-tree-caret { background: none; border: none; color: var(--ink-faint); cursor: pointer; width: 1.1rem; font-size: 0.7rem; padding: 0; }
      .et-tree-caret[data-has="false"] { opacity: 0.25; cursor: default; }
      .et-tree-name { flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.35rem; padding: 0.3rem 0; color: inherit; text-decoration: none; font-size: 0.88rem; }
      .et-tree-icon { flex: none; }
      /* Long page names truncate rather than widening the sidebar. */
      .et-tree-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .et-tree-add { opacity: 0; background: none; border: none; color: var(--ink-faint); cursor: pointer; font-size: 0.9rem; padding: 0 0.2rem; }
      .et-tree-row:hover .et-tree-add { opacity: 1; }
      .et-tree-new, .et-tree-link { background: none; border: none; text-align: left; font: inherit; font-size: 0.85rem; color: var(--ink-faint); cursor: pointer; padding: 0.35rem 0.6rem; text-decoration: none; border-radius: 5px; }
      .et-tree-new:hover, .et-tree-link:hover { background: var(--surface-3, rgba(128,128,128,0.12)); color: var(--ink); }
    `}</style>
  );
}
