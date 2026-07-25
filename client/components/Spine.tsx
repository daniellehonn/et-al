"use client";
import { useQuery } from "@tanstack/react-query";
import { api, type Workspace } from "@/lib/api";

// The Spine: the workspace tree IS the navigation and the AI's context boundary,
// so it lives permanently on the left. The & mark anchors the top.
export function Spine() {
  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.get<Workspace[]>("/workspaces"),
  });

  const byParent = new Map<string | null, Workspace[]>();
  for (const w of workspaces ?? []) {
    const key = w.parent_id;
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(w);
  }

  const renderTree = (parent: string | null, depth: number): React.ReactNode =>
    (byParent.get(parent) ?? []).map((w) => (
      <div key={w.id}>
        <a href={`/workspace/?id=${w.id}`} style={{ paddingLeft: `${depth * 0.85 + 0.9}rem` }} className="et-ws">
          <span className="et-ws-dot" data-type={w.type} />
          {w.title}
        </a>
        {renderTree(w.id, depth + 1)}
      </div>
    ));

  return (
    <aside className="et-spine">
      <a href="/" className="et-brand" aria-label="et al. home">
        <span className="serif">et al.</span><span className="et-amp">&amp;</span>
      </a>

      <nav className="et-nav">
        <a href="/" className="et-nav-item" data-active>Home</a>
        <a href="#" className="et-nav-item">Inbox</a>
        <a href="#" className="et-nav-item">Search</a>
        <a href="#" className="et-nav-item">Knowledge</a>
      </nav>

      <div className="et-spine-label eyebrow">Workspaces</div>
      <div className="et-tree">{renderTree(null, 0)}</div>

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
        .et-spine-label { padding: 0.9rem 0.6rem 0.4rem; }
        .et-tree { display: flex; flex-direction: column; }
        .et-ws {
          display: flex; align-items: center; gap: 0.5rem;
          text-decoration: none; color: var(--ink-soft);
          padding: 0.26rem 0.6rem; border-radius: 6px; font-size: 0.88rem;
          transition: background 0.12s, color 0.12s;
        }
        .et-ws:hover { background: var(--paper-raised); color: var(--ink); }
        .et-ws-dot { width: 6px; height: 6px; border-radius: 2px; background: var(--ink-faint); flex: none; }
        .et-ws-dot[data-type="project"] { background: var(--color-iris); }
        .et-ws-dot[data-type="area"] { background: var(--color-sage); }
        .et-ws-dot[data-type="course"] { background: var(--color-amber); }
      `}</style>
    </aside>
  );
}
