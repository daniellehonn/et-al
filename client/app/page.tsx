"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";
import { actorLabel, api, describeEvent, type RecentEvent, type Source } from "@/lib/api";

const GREETING = () => {
  const h = new Date().getHours();
  return h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

const DATE_LABEL = () =>
  new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

export default function HomePage() {
  const qc = useQueryClient();
  const activity = useQuery({ queryKey: ["agent-activity"], queryFn: () => api.get<RecentEvent[]>("/agent-activity") });
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => api.get<Source[]>("/inbox") });
  const [capture, setCapture] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const captureMut = useMutation({
    // /share rather than /capture: it pulls any link out of the pasted text into
    // the `url` column, which is what triggers enrichment (title, description,
    // site). /capture is the strict typed API and would file the link as opaque
    // `raw` text, leaving the inbox row showing a bare URL forever.
    mutationFn: (text: string) => api.post<Source & { already_captured?: boolean }>("/share", { text }),
    onSuccess: (s) => {
      setCapture("");
      setSaved(s.already_captured ? "Already in your inbox." : "Saved to your inbox.");
      qc.invalidateQueries({ queryKey: ["inbox"] });
    },
  });

  const error = activity.error ?? inbox.error;
  const events = activity.data ?? [];

  return (
    <div className="et-home">
      <header className="et-home-head">
        <div>
          <div className="eyebrow">{DATE_LABEL()}</div>
          <h1 className="serif et-hello">{GREETING()}.</h1>
        </div>
      </header>

      {error && <div className="et-error">Couldn&apos;t reach the runtime. Is the Worker running? <code>{String((error as Error).message)}</code></div>}

      {/* Quick capture */}
      <section className="et-capture">
        <span className="eyebrow">Quick capture</span>
        <form onSubmit={(e) => { e.preventDefault(); if (capture.trim()) captureMut.mutate(capture.trim()); }}>
          <input id="et-capture" value={capture} onChange={(e) => setCapture(e.target.value)}
            placeholder="A thought, a link, an idea — sorted later" aria-label="Quick capture" />
          <button type="submit" disabled={!capture.trim() || captureMut.isPending}>
            {captureMut.isPending ? "Saving…" : "Capture"}
          </button>
        </form>
        {saved && <span className="et-capture-saved" role="status">{saved}</span>}
      </section>

      {/* What agents and the extractor have written. Every machine write is
          attributed, so this is the audit trail made visible. */}
      <section>
        <div className="et-section-label"><span className="eyebrow">Agent activity</span>
          {!!inbox.data?.length && <Link href="/inbox" className="et-inbox-pill">{inbox.data.length} in inbox</Link>}
        </div>
        <div className="et-activity">
          {events.slice(0, 12).map((e) => {
            const { text, subject, href } = describeEvent(e);
            return (
              <div key={e.id} className="et-act-row">
                <span className="et-act-actor">{actorLabel(e.actor)}</span>
                <span className="et-act-text">
                  {text}{subject && <>: {href ? <a className="et-act-type" href={href}>{subject}</a> : <span className="et-act-type">{subject}</span>}</>}
                </span>
                <span className="et-act-time eyebrow">{timeAgo(e.created_at)}</span>
              </div>
            );
          })}
          {!activity.isLoading && events.length === 0 && <div className="et-empty">No agent has written anything yet. Connect one over MCP, or save a link for the extractor to read.</div>}
        </div>
      </section>

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
      .et-error { background: color-mix(in srgb, var(--color-amber) 14%, transparent); border: 1px solid var(--color-amber); color: var(--ink); padding: 0.7rem 0.9rem; border-radius: 8px; margin-bottom: 1.5rem; font-size: 0.9rem; }
      .et-error code { font-family: var(--font-mono); font-size: 0.8em; }

      .et-section-label { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.9rem; }
      .et-inbox-pill { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.06em; color: var(--color-iris); text-decoration: none; }

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
      .et-capture-saved { font-size: 0.82rem; color: var(--ink-faint); }

      .et-activity { display: flex; flex-direction: column; }
      .et-act-row { display: grid; grid-template-columns: 4.5rem 1fr auto; align-items: baseline; gap: 0.6rem; padding: 0.4rem 0; border-bottom: 1px solid var(--line); font-size: 0.88rem; }
      .et-act-actor { font-family: var(--font-mono); font-size: 0.78rem; color: var(--color-iris); }
      .et-act-text { color: var(--ink-soft); }
      .et-act-type { color: var(--ink); text-decoration: none; }
      a.et-act-type:hover { color: var(--color-iris); }
      .et-act-time { color: var(--ink-faint); }

      .et-empty { color: var(--ink-faint); font-size: 0.88rem; padding: 0.6rem 0; font-style: italic; }

      @media (max-width: 860px) {
        /* The display sizes are tuned for a 60rem column; scale them to a phone
           so the greeting still fits on one line. */
        .et-hello { font-size: 2rem; }
        .et-home-head { margin-bottom: 1.8rem; }
        .et-capture { margin-bottom: 2rem; }
        /* Stack the capture field above its button — side by side, the button
           squeezes the input below a usable width. */
        .et-capture form { flex-direction: column; }
        .et-capture button { padding: 0.7rem 1.3rem; }
      }
    `}</style>
  );
}
