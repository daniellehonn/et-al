"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Home } from "@/lib/api";

const GREETING = () => {
  const h = new Date().getHours();
  return h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

const DATE_LABEL = () =>
  new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

export default function HomePage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["home"], queryFn: () => api.get<Home>("/home") });
  const [capture, setCapture] = useState("");

  const captureMut = useMutation({
    // /share rather than /capture: it pulls any link out of the pasted text into
    // the `url` column, which is what triggers enrichment (title, description,
    // site). /capture is the strict typed API and would file the link as opaque
    // `raw` text, leaving the inbox row showing a bare URL forever.
    mutationFn: (text: string) => api.post("/share", { text }),
    onSuccess: () => { setCapture(""); qc.invalidateQueries({ queryKey: ["home"] }); },
  });

  const d3 = data?.daily3;
  const healthByScore = [...(data?.health ?? [])].sort((a, b) => b.score - a.score);

  return (
    <div className="et-home">
      {/* Header */}
      <header className="et-home-head">
        <div>
          <div className="eyebrow">{DATE_LABEL()}</div>
          <h1 className="serif et-hello">{GREETING()}.</h1>
        </div>
        {d3 && (
          <div className="et-streak" title="Consecutive confirmed days">
            <span className="et-streak-num serif">{d3.streak}</span>
            <span className="eyebrow">day{d3.streak === 1 ? "" : "s"}<br />streak</span>
          </div>
        )}
      </header>

      {error && <div className="et-error">Couldn&apos;t reach the runtime. Is the Worker running? <code>{String((error as Error).message)}</code></div>}

      {/* Daily 3 — the hero */}
      <section className="et-daily3">
        <div className="et-section-label"><span className="eyebrow">The Daily 3</span>
          {d3 && <span className="et-lock">{d3.confirmed ? "Locked for today" : "Not yet confirmed"}</span>}
        </div>
        <div className="et-d3-grid">
          {[1, 2, 3].map((slot) => {
            const s = d3?.slots.find((x) => x.slot === slot);
            const done = s?.status === "done" || s?.task?.status === "done";
            return (
              <div key={slot} className="et-d3-slot" data-filled={!!s?.task} data-done={done}>
                <span className="serif et-d3-num">{slot}</span>
                {s?.task ? (
                  <span className="et-d3-title" style={done ? { textDecoration: "line-through", color: "var(--ink-faint)" } : {}}>{s.task.title}</span>
                ) : (
                  <span className="et-d3-empty">{isLoading ? "…" : "Nothing committed yet"}</span>
                )}
              </div>
            );
          })}
        </div>
        <p className="et-d3-note">Three things. No more. Ask an agent to <em>suggest_daily3</em>, or set them yourself — once confirmed, the set is locked. Finishing early doesn&apos;t grant more; tomorrow is a fresh set.</p>
      </section>

      {/* Quick capture */}
      <section className="et-capture">
        <span className="eyebrow">Quick capture</span>
        <form onSubmit={(e) => { e.preventDefault(); if (capture.trim()) captureMut.mutate(capture.trim()); }}>
          <input value={capture} onChange={(e) => setCapture(e.target.value)}
            placeholder="A thought, a link, an idea — sorted later" aria-label="Quick capture" />
          <button type="submit" disabled={!capture.trim() || captureMut.isPending}>
            {captureMut.isPending ? "Saving…" : "Capture"}
          </button>
        </form>
      </section>

      <div className="et-two-col">
        {/* Workspace health */}
        <section>
          <div className="et-section-label"><span className="eyebrow">Page Health</span></div>
          <div className="et-health">
            {healthByScore.map((h) => {
              const w = data?.root_pages.find((x: { id: string }) => x.id === h.page_id);
              if (!w) return null;
              return (
                <div key={h.page_id} className="et-health-row">
                  <span className="et-health-name">{w.title}</span>
                  <span className="et-health-bar"><span style={{ width: `${h.score}%`, background: h.score >= 60 ? "var(--color-sage)" : h.score >= 30 ? "var(--color-amber)" : "var(--color-line-strong)" }} /></span>
                  <span className="et-health-num eyebrow">{h.score}</span>
                </div>
              );
            })}
            {!isLoading && healthByScore.length === 0 && <div className="et-empty">No active workspaces yet.</div>}
          </div>
        </section>

        {/* Recent activity + inbox */}
        <section>
          <div className="et-section-label"><span className="eyebrow">Activity</span>
            {!!data?.inbox_count && <span className="et-inbox-pill">{data.inbox_count} in inbox</span>}
          </div>
          <div className="et-activity">
            {(data?.recent_activity ?? []).slice(0, 8).map((e) => (
              <div key={e.id} className="et-act-row">
                <span className="et-act-actor" data-ai={e.actor.startsWith("ai:")}>{e.actor.startsWith("ai:") ? "&" : "·"}</span>
                <span className="et-act-text">{e.action} <span className="et-act-type">{e.entity_type}</span></span>
                <span className="et-act-time eyebrow">{timeAgo(e.created_at)}</span>
              </div>
            ))}
            {!isLoading && (data?.recent_activity.length ?? 0) === 0 && <div className="et-empty">Nothing yet. Capture something above.</div>}
          </div>
        </section>
      </div>

      <HomeStyles />
    </div>
  );
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function HomeStyles() {
  return (
    <style>{`
      .et-home { max-width: 60rem; margin: 0 auto; padding: 3.5rem 2.5rem 6rem; }
      .et-home-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2.75rem; }
      .et-hello { font-size: 2.9rem; line-height: 1.05; margin: 0.3rem 0 0; }
      .et-streak { display: flex; align-items: center; gap: 0.55rem; padding-top: 0.4rem; }
      .et-streak-num { font-size: 2.4rem; color: var(--color-amber); line-height: 1; }
      .et-error { background: color-mix(in srgb, var(--color-amber) 14%, transparent); border: 1px solid var(--color-amber); color: var(--ink); padding: 0.7rem 0.9rem; border-radius: 8px; margin-bottom: 1.5rem; font-size: 0.9rem; }
      .et-error code { font-family: var(--font-mono); font-size: 0.8em; }

      .et-section-label { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.9rem; }
      .et-lock, .et-inbox-pill { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.06em; color: var(--ink-faint); }
      .et-inbox-pill { color: var(--color-iris); }

      .et-daily3 { margin-bottom: 2.75rem; }
      .et-d3-grid { display: flex; flex-direction: column; border-top: 1px solid var(--line); }
      .et-d3-slot { display: flex; align-items: baseline; gap: 1.1rem; padding: 1.05rem 0.2rem; border-bottom: 1px solid var(--line); }
      .et-d3-num { font-size: 2rem; color: var(--color-iris); width: 1.6rem; flex: none; line-height: 1; opacity: 0.9; }
      .et-d3-slot[data-filled="false"] .et-d3-num { color: var(--line-strong); }
      .et-d3-title { font-size: 1.15rem; color: var(--ink); }
      .et-d3-empty { font-size: 1.05rem; color: var(--ink-faint); font-style: italic; }
      .et-d3-note { font-size: 0.85rem; color: var(--ink-faint); margin: 1rem 0 0; max-width: 42rem; }
      .et-d3-note em { font-family: var(--font-mono); font-style: normal; font-size: 0.9em; color: var(--ink-soft); }

      .et-capture { margin-bottom: 2.75rem; display: flex; flex-direction: column; gap: 0.55rem; }
      .et-capture form { display: flex; gap: 0.6rem; }
      .et-capture input {
        flex: 1; min-width: 0; background: var(--paper-raised); border: 1px solid var(--line-strong);
        border-radius: 9px; padding: 0.7rem 0.9rem; font: inherit; color: var(--ink);
      }
      .et-capture input:focus { outline: none; border-color: var(--color-iris); }
      .et-capture button {
        background: var(--color-iris); color: #fff; border: none; border-radius: 9px;
        padding: 0 1.3rem; font: inherit; font-weight: 500; cursor: pointer; transition: opacity 0.12s;
      }
      .et-capture button:disabled { opacity: 0.4; cursor: default; }

      .et-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 2.75rem; }
      @media (max-width: 760px) { .et-two-col { grid-template-columns: 1fr; } }

      .et-health-row { display: grid; grid-template-columns: 6.5rem 1fr 1.8rem; align-items: center; gap: 0.7rem; padding: 0.4rem 0; }
      .et-health-name { font-size: 0.9rem; color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .et-health-bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; }
      .et-health-bar span { display: block; height: 100%; border-radius: 3px; transition: width 0.4s ease; }
      .et-health-num { text-align: right; }

      .et-activity { display: flex; flex-direction: column; }
      .et-act-row { display: grid; grid-template-columns: 1rem 1fr auto; align-items: baseline; gap: 0.6rem; padding: 0.4rem 0; border-bottom: 1px solid var(--line); font-size: 0.88rem; }
      .et-act-actor { font-family: var(--font-display); color: var(--ink-faint); text-align: center; }
      .et-act-actor[data-ai="true"] { color: var(--color-iris); }
      .et-act-text { color: var(--ink-soft); }
      .et-act-type { color: var(--ink); }
      .et-act-time { color: var(--ink-faint); }

      .et-empty { color: var(--ink-faint); font-size: 0.88rem; padding: 0.6rem 0; font-style: italic; }

      @media (max-width: 860px) {
        /* The display sizes are tuned for a 60rem column; scale them to a phone
           so the greeting and streak still fit on one line each. */
        .et-hello { font-size: 2rem; }
        .et-streak-num { font-size: 1.7rem; }
        .et-home-head { margin-bottom: 1.8rem; }
        .et-daily3, .et-capture { margin-bottom: 2rem; }
        .et-d3-num { font-size: 1.5rem; width: 1.2rem; }
        .et-d3-title { font-size: 1.02rem; }
        .et-d3-slot { gap: 0.8rem; padding: 0.85rem 0; }
        .et-two-col { gap: 2rem; }
        /* Stack the capture field above its button — side by side, the button
           squeezes the input below a usable width. */
        .et-capture form { flex-direction: column; }
        .et-capture button { padding: 0.7rem 1.3rem; }
        .et-health-row { grid-template-columns: 5rem 1fr 1.8rem; }
      }
    `}</style>
  );
}
