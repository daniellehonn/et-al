"use client";

// Identity Studio (spec §3.10) — not a profile page.
//
// Everything shown is evidence already in the system: completed projects,
// applied knowledge, adopted tools, published output. The most useful section is
// the one listing what is MISSING — finished work that produced nothing, goals
// with no project behind them, Areas with no completed work. Those gaps are the
// point, so they are shown first and not softened.

import { useEffect, useState } from "react";
import { getIdentity, writeSnapshot, type IdentityStudio } from "@/lib/api";

export default function IdentityPage() {
  const [data, setData] = useState<IdentityStudio | null>(null);
  const [days, setDays] = useState(180);
  const [snapshot, setSnapshot] = useState<string | null>(null);

  useEffect(() => { setData(null); getIdentity(days).then(setData).catch(() => {}); }, [days]);

  async function backup() {
    setSnapshot("writing…");
    try {
      const r = await writeSnapshot();
      setSnapshot(`${r.files} files written to ${r.prefix}`);
    } catch { setSnapshot("snapshot failed"); }
  }

  return (
    <>
      <h1>Identity</h1>
      <p style={{ color: "var(--ink-2)", margin: "4px 0 16px" }}>
        What your work actually demonstrates — drawn only from evidence, never claimed.
      </p>

      <div className="pick" style={{ marginBottom: 18 }}>
        {[90, 180, 365].map((d) => (
          <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>
            {d === 365 ? "1 year" : `${d} days`}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={backup}>Write backup snapshot</button>
      </div>
      {snapshot && <p className="sync" style={{ marginTop: -10, marginBottom: 14 }}>{snapshot}</p>}

      {!data && <div className="card"><div className="skeleton" /><div className="skeleton" /></div>}

      {data && (
        <>
          {data.gaps.length > 0 && (
            <section className="section">
              <div className="section-head"><span className="kicker">Gaps</span></div>
              <div className="card">
                {data.gaps.map((g, i) => (
                  <div className="row" key={i}>
                    <div className="lead"><div className="title" style={{ fontWeight: 500 }}>{g}</div></div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="section">
            <div className="section-head">
              <span className="kicker">Portfolio queue</span>
              <span className="count">{data.portfolio_queue.length}</span>
            </div>
            <div className="card">
              {data.portfolio_queue.length === 0 ? (
                <div className="empty">
                  <strong>Nothing waiting</strong>
                  Completed work that has produced no case study, demo, or content shows up here.
                </div>
              ) : data.portfolio_queue.map((p) => (
                <div className="row" key={p.id}>
                  <div className="lead">
                    <div className="title">{p.title}</div>
                    <div className="meta">{p.reason}</div>
                  </div>
                  <a className="btn" href={`/content/`}>Create seed</a>
                </div>
              ))}
            </div>
          </section>

          <section className="section">
            <div className="section-head"><span className="kicker">Recurring themes</span></div>
            <div className="card">
              {data.themes.filter((t) => t.projects || t.outputs).length === 0 ? (
                <div className="empty">
                  <strong>No themes yet</strong>
                  A theme is an Area with finished work behind it — not one with things filed under it.
                </div>
              ) : data.themes.filter((t) => t.projects || t.outputs).map((t) => (
                <div className="row" key={t.area}>
                  <div className="lead"><div className="title">{t.area}</div>
                    <div className="meta">{t.projects} completed · {t.outputs} output(s)</div></div>
                </div>
              ))}
            </div>
          </section>

          <Evidence title="Completed projects" items={data.evidence.completed_projects.map((p) => ({
            id: p.id, title: p.title, meta: `${p.outputs} output(s)` }))} />
          <Evidence title="Applied knowledge" items={data.evidence.applied_knowledge.map((n) => ({
            id: n.id, title: n.title, meta: `used in ${n.used_in} project(s)` }))} />
          <Evidence title="Adopted tools" items={data.evidence.adopted_tools.map((t) => ({
            id: t.id, title: t.name, meta: t.verdict ?? "" }))} />
          <Evidence title="Published" items={data.evidence.published.map((c) => ({
            id: c.id, title: c.title, meta: c.channel ?? "" }))} />
        </>
      )}
    </>
  );
}

function Evidence({ title, items }: { title: string; items: Array<{ id: string; title: string; meta: string }> }) {
  return (
    <section className="section">
      <div className="section-head"><span className="kicker">{title}</span><span className="count">{items.length}</span></div>
      <div className="card">
        {items.length === 0
          ? <div className="empty">Nothing yet.</div>
          : items.map((i) => (
              <div className="row" key={i.id}>
                <div className="lead"><div className="title">{i.title}</div>
                  {i.meta && <div className="meta">{i.meta}</div>}</div>
              </div>
            ))}
      </div>
    </section>
  );
}
