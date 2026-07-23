"use client";

// Home — answers three questions and nothing else (spec §4.2):
//   What matters now? What should I do next? What requires review?
//
// It is a single `/api/home` request rather than six, because the Worker already
// assembles the answer. Everything on this page is an action, not a statistic.

import { useCallback, useEffect, useState } from "react";
import { getHome, createCapture, ApiError, type HomeData } from "@/lib/api";

export default function HomePage() {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capture, setCapture] = useState("");
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await getHome());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onCapture(event: React.FormEvent) {
    event.preventDefault();
    const value = capture.trim();
    if (!value) return;
    setSaving(true);
    try {
      await createCapture(value);
      // Confirm the save immediately; processing continues in the background
      // (spec §3.1 — the capture is durable before any fetch is attempted).
      setCapture("");
      setFlash("Captured — processing in the background");
      setTimeout(() => setFlash(null), 2600);
      load();
    } catch (e) {
      // A 401 raises the global unlock prompt via AuthGate; anything else is
      // this page's problem to report.
      if (!(e instanceof ApiError && e.status === 401)) {
        setError(e instanceof Error ? e.message : "Could not save");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1>Today</h1>
      <p style={{ color: "var(--ink-2)", margin: "4px 0 20px" }}>
        What matters now, what to do next, and what needs review.
      </p>

      <form className="capture" onSubmit={onCapture}>
        <input
          value={capture}
          onChange={(e) => setCapture(e.target.value)}
          placeholder="Capture a thought or paste a link…"
          aria-label="Capture"
        />
        <button className="btn primary" type="submit" disabled={saving || !capture.trim()}>
          {saving ? "Saving…" : "Capture"}
        </button>
      </form>
      {flash && <p style={{ color: "var(--accent)", fontSize: 13, marginTop: -16 }}>{flash}</p>}

      {data && isEmpty(data) && (
        <div className="orient">
          <h2>How this works</h2>
          <ol>
            <li><b>Capture</b> anything above — a thought or a link. Links are fetched
              automatically. Nothing needs to be filed straight away.</li>
            <li><b>Projects</b> are things you are actually doing. One becomes
              &ldquo;active&rdquo; only when you can name the next physical step.</li>
            <li><b>Knowledge</b> is what you can explain. Write it in your own words;
              mastery moves up when you can, not when you saved it.</li>
            <li><b>Library</b> holds tools to test — each needs a verdict before it
              counts as tested.</li>
            <li><b>Content</b> and <b>Identity</b> turn finished work into things
              worth sharing.</li>
          </ol>
        </div>
      )}

      {error && <div className="error-box" style={{ marginBottom: 20 }}>{error}</div>}
      {!data && !error && <Loading />}

      {data && (
        <>
          <Section kicker="Active projects" count={data.active_projects.length}>
            {data.active_projects.length === 0 ? (
              <Empty
                title="No active projects"
                body="A project becomes active once it has a next action — the next physical, visible step."
              />
            ) : (
              data.active_projects.map((p) => (
                <div className="row" key={p.id}>
                  <div className="lead">
                    <div className="title">{p.title}</div>
                    {p.next_action ? (
                      <div className="next-action">
                        <div className="label">Next action</div>
                        <div className="text">{p.next_action}</div>
                      </div>
                    ) : (
                      <div className="meta">No next action set</div>
                    )}
                  </div>
                </div>
              ))
            )}
          </Section>

          {data.stale_projects.length > 0 && (
            <Section kicker="Stalled" count={data.stale_projects.length}>
              {data.stale_projects.map((p) => (
                <div className="row" key={p.id}>
                  <div className="lead">
                    <div className="title">{p.title}</div>
                    <div className="meta">No activity recently</div>
                  </div>
                  <span className="chip warn">stale</span>
                </div>
              ))}
            </Section>
          )}

          <Section kicker="Inbox" count={data.inbox_count}>
            {data.inbox.length === 0 ? (
              <Empty title="Inbox is clear" body="Captured links and thoughts land here until you decide where they belong." />
            ) : (
              data.inbox.map((c) => (
                <div className="row" key={c.id}>
                  <div className="lead">
                    <div className="title">{c.raw_input.slice(0, 90)}</div>
                    <div className="meta">{c.input_type}</div>
                  </div>
                  <ProcessingChip status={c.processing_status} />
                </div>
              ))
            )}
          </Section>

          <Section kicker="Test queue" count={data.test_queue.length}>
            {data.test_queue.length === 0 ? (
              <Empty title="Nothing under test" body="Saved tools move through testing so the library does not become a link graveyard." />
            ) : (
              data.test_queue.map((t) => (
                <div className="row" key={t.id}>
                  <div className="lead"><div className="title">{t.name}</div>
                    <div className="meta">Needs a written verdict</div></div>
                  <span className="chip warn">{t.status}</span>
                </div>
              ))
            )}
          </Section>

          <Section kicker="Recent learning" count={data.recent_learning.length}>
            {data.recent_learning.length === 0 ? (
              <Empty title="No notes yet" body="Knowledge notes track mastery from captured through to applied." />
            ) : (
              data.recent_learning.map((n) => (
                <div className="row" key={n.id}>
                  <div className="lead"><div className="title">{n.title}</div></div>
                  <span className={`chip ${n.mastery === "applied" ? "ok" : ""}`}>{n.mastery}</span>
                </div>
              ))
            )}
          </Section>
        </>
      )}
    </>
  );
}

/** True while nothing has been created — drives the first-run orientation. */
function isEmpty(d: HomeData): boolean {
  return d.active_projects.length === 0 && d.inbox_count === 0 &&
    d.recent_learning.length === 0 && d.test_queue.length === 0;
}

function Section({ kicker, count, children }: { kicker: string; count: number; children: React.ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <span className="kicker">{kicker}</span>
        <span className="count">{count}</span>
      </div>
      <div className="card">{children}</div>
    </section>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  // Empty states explain what belongs here and why (spec §4.7).
  return <div className="empty"><strong>{title}</strong>{body}</div>;
}

function Loading() {
  // Skeletons match the destination layout rather than a generic spinner.
  return (
    <div className="card" aria-busy="true" aria-label="Loading">
      {[0, 1, 2].map((i) => <div className="skeleton" key={i} />)}
    </div>
  );
}

function ProcessingChip({ status }: { status: string }) {
  if (status === "failed") return <span className="chip err">failed</span>;
  if (status === "ready") return <span className="chip ok">ready</span>;
  return <span className="chip">{status}</span>;
}

